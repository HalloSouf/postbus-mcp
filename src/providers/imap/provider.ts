import {
  ImapFlow,
  type FetchMessageObject,
  type FetchQueryObject,
  type MailboxObject,
  type SearchObject,
} from "imapflow";
import { MAIL_TIMEOUT_MS, MAX_MESSAGE_BYTES } from "../../config.js";
import { logEvent } from "../../log.js";
import {
  PostbusError,
  type ImapAccount,
  type MailProvider,
  type MessageDetail,
  type SearchResult,
  type SendOptions,
  type SendResult,
  type BatchResult,
  type DraftResult,
  type FlagChange,
  type FolderInfo,
  type ForwardOptions,
  type ReplyOptions,
} from "../../types.js";
import {
  imapTlsOptions,
  resolveMailbox,
  threadMailboxes,
  translateImapError,
  withImap,
  type ImapContext,
} from "./connection.js";
import { decodeMessageId, decodeThreadId, encodeMessageId } from "./ids.js";
import { hasAttachments, makeSnippetFromSource, toDetail, toSummary } from "./parse.js";
import { parseQuery, type MailboxHint } from "./query.js";
import { composeMail, sendComposed, verifySmtp, type ComposedMail } from "./smtp.js";
import {
  archiveMessages,
  createFolder,
  deleteFolder,
  labelMessages,
  listFolders,
  markMessages,
  moveMessages,
  renameFolder,
  trashMessages,
} from "./actions.js";
import { buildForward, buildReply } from "./reply.js";

const SNIPPET_BYTES = 4096;

const MAX_THREAD_MESSAGES = 50;

// Gmail servers get X-GM-RAW search and X-GM-THRID threading; every other
// server gets translated criteria and References-based threads.
export class ImapSmtpProvider implements MailProvider<ImapAccount> {
  readonly id = "imap" as const;

  async verify(account: ImapAccount): Promise<void> {
    const client = new ImapFlow({
      host: account.imapHost,
      port: account.imapPort,
      secure: account.imapSecure,
      ...imapTlsOptions(account),
      auth: { user: account.username, pass: account.password },
      logger: false,
      verifyOnly: true,
      connectionTimeout: MAIL_TIMEOUT_MS,
      greetingTimeout: MAIL_TIMEOUT_MS,
      socketTimeout: MAIL_TIMEOUT_MS,
      clientInfo: { name: "postbus-mcp" },
    });

    try {
      await client.connect();
    } catch (error) {
      throw translateImapError(error);
    } finally {
      client.close();
    }

    await verifySmtp(account);
  }

  async search(account: ImapAccount, query: string, maxResults: number): Promise<SearchResult> {
    const parsed = parseQuery(query);
    const limit = Math.min(Math.max(1, maxResults), 100);

    const { selection, notes } = await withImap(account, async (context) => {
      const { path, note } = await pickSearchMailbox(account.id, context, parsed.mailbox, query);

      // On a Gmail server the raw query goes through untouched, so nothing was
      // dropped; elsewhere say which terms this server cannot express.
      const notes = note ? [note] : [];
      if (!context.gmail && parsed.ignored.length > 0) {
        notes.push(
          `This server cannot search on: ${parsed.ignored.join(", ")}. ` +
            "Those terms were left out, so the results are wider than the query asks for.",
        );
      }

      const lock = await context.client.getMailboxLock(path);

      try {
        const mailbox = requireMailbox(context.client.mailbox, path);
        const criteria: SearchObject =
          context.gmail && parsed.raw ? { gmraw: parsed.raw } : parsed.criteria;

        const uids = (await context.client.search(criteria, { uid: true })) || [];
        if (uids.length === 0) return { selection: undefined, notes };

        // IMAP cannot search on attachments, so fetch extra and filter after.
        const overshoot = parsed.requireAttachments && !context.gmail ? 4 : 1;
        const selected = uids.slice(-Math.min(uids.length, limit * overshoot)).reverse();

        const messages = await context.client.fetchAll(
          selected,
          fetchQuery(context, { source: { maxLength: SNIPPET_BYTES } }),
          { uid: true },
        );

        const byUid = new Map(messages.map((message) => [message.uid, message]));
        const wanted: FetchMessageObject[] = [];

        for (const uid of selected) {
          const message = byUid.get(uid);
          if (!message) continue;
          if (parsed.requireAttachments && !hasAttachments(message.bodyStructure)) continue;

          wanted.push(message);
          if (wanted.length >= limit) break;
        }

        return {
          selection: { wanted, path, uidValidity: String(mailbox.uidValidity) },
          notes,
        };
      } finally {
        lock.release();
      }
    });

    if (!selection) return { messages: [], notes };

    // Parsed after the lock and the connection are back. Each snippet is a
    // full MIME parse on the event loop, so a hundred results used to hold the
    // mailbox — and every other tenant's request — for a hundred of them.
    const messages = await Promise.all(
      selection.wanted.map(async (message) =>
        toSummary(
          message,
          { mailbox: selection.path, uidValidity: selection.uidValidity },
          await makeSnippetFromSource(message.source),
        ),
      ),
    );

    return { messages, notes };
  }

  async getMessage(account: ImapAccount, messageId: string): Promise<MessageDetail> {
    const ref = decodeMessageId(messageId);

    return withImap(account, async (context) => {
      const lock = await context.client.getMailboxLock(ref.mailbox);

      try {
        const mailbox = requireMailbox(context.client.mailbox, ref.mailbox);
        assertUidValidity(mailbox, ref.uidValidity);

        const message = await context.client.fetchOne(
          String(ref.uid),
          fetchQuery(context, { source: { maxLength: MAX_MESSAGE_BYTES } }),
          { uid: true },
        );

        if (!message || !message.source) {
          throw new PostbusError(
            "That message is no longer in this mailbox.",
            "Search again with search_emails; it may have been moved or deleted.",
            "not_found",
          );
        }

        return toDetail(
          message,
          { mailbox: ref.mailbox, uidValidity: String(mailbox.uidValidity) },
          message.source,
          (message.size ?? 0) > MAX_MESSAGE_BYTES,
        );
      } finally {
        lock.release();
      }
    });
  }

  async getThread(account: ImapAccount, threadId: string): Promise<MessageDetail[]> {
    const ref = decodeThreadId(threadId);

    return withImap(account, async (context) => {
      if (ref.kind === "server" && !context.serverThreads) {
        throw new PostbusError(
          "This server does not hand out thread ids.",
          "Search again with search_emails and use the threadId from those results.",
        );
      }

      const criteria: SearchObject =
        ref.kind === "server"
          ? { threadId: ref.id }
          : {
              or: [
                { header: { "message-id": ref.rootMessageId } },
                { header: { references: ref.rootMessageId } },
                { header: { "in-reply-to": ref.rootMessageId } },
              ],
            };

      const mailboxes = await threadMailboxes(account.id, context);
      const details: MessageDetail[] = [];
      let truncated = false;

      for (const path of mailboxes) {
        if (details.length >= MAX_THREAD_MESSAGES) break;

        const lock = await context.client.getMailboxLock(path);
        try {
          const mailbox = requireMailbox(context.client.mailbox, path);
          const uids = (await context.client.search(criteria, { uid: true })) || [];
          if (uids.length === 0) continue;

          // The tail of the uid list is the newest mail, which is the half of a
          // long conversation anyone actually asks about.
          const wanted = uids.slice(-(MAX_THREAD_MESSAGES - details.length));
          if (wanted.length < uids.length) truncated = true;

          const messages = await context.client.fetchAll(
            wanted,
            fetchQuery(context, { source: { maxLength: MAX_MESSAGE_BYTES } }),
            { uid: true },
          );

          for (const message of messages) {
            if (!message.source) continue;
            details.push(
              await toDetail(
                message,
                { mailbox: path, uidValidity: String(mailbox.uidValidity) },
                message.source,
                (message.size ?? 0) > MAX_MESSAGE_BYTES,
              ),
            );
          }
        } finally {
          lock.release();
        }
      }

      if (details.length === 0) {
        throw new PostbusError(
          "No messages found in this conversation.",
          "The threadId comes from search_emails; the messages may have been moved since.",
          "not_found",
        );
      }

      const ordered = dedupe(details).sort((a, b) => a.date.localeCompare(b.date));
      if (truncated && ordered[0]) {
        ordered[0] = {
          ...ordered[0],
          body: `[… only the ${ordered.length} most recent messages in this conversation are shown]\n\n${ordered[0].body}`,
        };
      }

      return ordered;
    });
  }

  async send(
    account: ImapAccount,
    to: string,
    subject: string,
    body: string,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const mail = await composeMail(account, to, subject, body, options);
    await sendComposed(account, mail);

    const notes: string[] = [];

    // The message is out; a failed copy must not undo that. But swallowing the
    // failure silently left the user hunting for a mail in Sent that was never
    // put there, with nothing anywhere saying why.
    try {
      await withImap(account, async (context) => {
        // Gmail stores its own copy in Sent; other servers expect us to.
        if (context.gmail) return;

        const sent = await resolveMailbox(account.id, context, "sent");
        if (!sent) {
          notes.push("This server has no Sent folder, so no copy was filed there.");
          return;
        }

        await context.client.append(sent, mail.raw, ["\\Seen"]);
      });
    } catch (error) {
      logEvent({
        event: "sent_copy_failed",
        accountId: account.id,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      notes.push("The message was sent, but a copy could not be filed in Sent.");
    }

    return { messageId: mail.messageId, notes };
  }

  async reply(
    account: ImapAccount,
    messageId: string,
    body: string,
    options: ReplyOptions = {},
  ): Promise<SendResult> {
    const original = await this.getMessage(account, messageId);
    const composed = buildReply(original, body, account.email, options);

    const result = await this.deliver(account, composed, {
      cc: composed.cc,
      bcc: options.bcc,
      html: options.html,
      inReplyTo: composed.inReplyTo,
      references: composed.references,
    });

    // \\Answered is what mail clients use to draw the reply arrow.
    await markMessages(account, [messageId], "read").catch(() => undefined);
    await this.flagAnswered(account, messageId);

    return result;
  }

  async createDraft(
    account: ImapAccount,
    to: string,
    subject: string,
    body: string,
    options: SendOptions = {},
  ): Promise<DraftResult> {
    return this.appendDraft(account, await composeMail(account, to, subject, body, options, true));
  }

  async createReplyDraft(
    account: ImapAccount,
    messageId: string,
    body: string,
    options: ReplyOptions = {},
  ): Promise<DraftResult> {
    const original = await this.getMessage(account, messageId);
    const composed = buildReply(original, body, account.email, options);

    const mail = await composeMail(
      account,
      composed.to,
      composed.subject,
      composed.body,
      {
        cc: composed.cc,
        bcc: options.bcc,
        html: options.html,
        inReplyTo: composed.inReplyTo,
        references: composed.references,
      },
      true,
    );

    return this.appendDraft(account, mail);
  }

  async forward(
    account: ImapAccount,
    messageId: string,
    to: string,
    options: ForwardOptions = {},
  ): Promise<SendResult> {
    const original = await this.getMessage(account, messageId);
    const composed = buildForward(original, to, options);
    const raw = await this.rawMessage(account, messageId);

    return this.deliver(account, composed, {
      cc: options.cc,
      bcc: options.bcc,
      attachments: raw
        ? [
            {
              filename: `${original.subject.slice(0, 60) || "message"}.eml`,
              content: raw,
              contentType: "message/rfc822",
            },
          ]
        : undefined,
    });
  }

  listFolders(account: ImapAccount): Promise<FolderInfo[]> {
    return listFolders(account);
  }

  createFolder(account: ImapAccount, path: string): Promise<string> {
    return createFolder(account, path);
  }

  renameFolder(account: ImapAccount, path: string, newPath: string): Promise<string> {
    return renameFolder(account, path, newPath);
  }

  deleteFolder(account: ImapAccount, path: string): Promise<void> {
    return deleteFolder(account, path);
  }

  moveMessages(account: ImapAccount, messageIds: string[], target: string): Promise<BatchResult> {
    return moveMessages(account, messageIds, target);
  }

  archiveMessages(account: ImapAccount, messageIds: string[]): Promise<BatchResult> {
    return archiveMessages(account, messageIds);
  }

  trashMessages(account: ImapAccount, messageIds: string[]): Promise<BatchResult> {
    return trashMessages(account, messageIds);
  }

  markMessages(
    account: ImapAccount,
    messageIds: string[],
    change: FlagChange,
  ): Promise<BatchResult> {
    return markMessages(account, messageIds, change);
  }

  labelMessages(
    account: ImapAccount,
    messageIds: string[],
    add: string[],
    remove: string[],
  ): Promise<BatchResult> {
    return labelMessages(account, messageIds, add, remove);
  }

  setLabelColor(): Promise<string> {
    // No IMAP extension carries label colours; X-GM-LABELS is names only.
    throw new PostbusError(
      "IMAP cannot set label colours.",
      "Colours live in Gmail itself and are only reachable through the Gmail API provider. " +
        "Over IMAP a label is just a name.",
      "invalid_input",
    );
  }

  /** Sends a composed reply or forward and files the same bytes in Sent. */
  private async deliver(
    account: ImapAccount,
    composed: { to: string; subject: string; body: string },
    options: SendOptions,
  ): Promise<SendResult> {
    return this.send(account, composed.to, composed.subject, composed.body, options);
  }

  /** Files a composed message in Drafts, unsent, with the \Draft flag set. */
  private async appendDraft(account: ImapAccount, mail: ComposedMail): Promise<DraftResult> {
    return withImap(account, async (context) => {
      const drafts = await resolveMailbox(account.id, context, "drafts");

      if (!drafts) {
        throw new PostbusError(
          "This mailbox has no Drafts folder, so the draft could not be stored.",
          'Create one with create_folder ("Drafts"), or send the message directly with send_email.',
          "upstream",
        );
      }

      // \Seen as well: a draft the user wrote themselves is not new mail, and
      // without it every draft shows up in the unread count.
      const appended = await context.client.append(drafts, mail.raw, ["\\Draft", "\\Seen"]);

      // UIDPLUS is what makes the append addressable afterwards. Without it the
      // draft is filed correctly but there is no id to hand back.
      const id =
        appended && appended.uid && appended.uidValidity !== undefined
          ? encodeMessageId({
              mailbox: appended.destination ?? drafts,
              uidValidity: String(appended.uidValidity),
              uid: appended.uid,
            })
          : undefined;

      return {
        id,
        messageId: mail.messageId,
        folder: drafts,
        notes: id
          ? []
          : ["This server does not report ids for stored drafts, so this one has none here."],
      };
    });
  }

  /** The untouched source, so a forward carries the real original. */
  private async rawMessage(account: ImapAccount, messageId: string): Promise<Buffer | undefined> {
    const ref = decodeMessageId(messageId);

    return withImap(account, async (context) => {
      const lock = await context.client.getMailboxLock(ref.mailbox);
      try {
        const message = await context.client.fetchOne(
          String(ref.uid),
          { source: true },
          { uid: true },
        );
        return message ? (message.source ?? undefined) : undefined;
      } finally {
        lock.release();
      }
    }).catch(() => undefined);
  }

  private async flagAnswered(account: ImapAccount, messageId: string): Promise<void> {
    const ref = decodeMessageId(messageId);

    await withImap(account, async (context) => {
      const lock = await context.client.getMailboxLock(ref.mailbox);
      try {
        await context.client.messageFlagsAdd([ref.uid], ["\\Answered"], { uid: true });
      } finally {
        lock.release();
      }
    }).catch(() => undefined);
  }
}

function fetchQuery(context: ImapContext, extra: Partial<FetchQueryObject>): FetchQueryObject {
  return {
    uid: true,
    flags: true,
    envelope: true,
    bodyStructure: true,
    internalDate: true,
    size: true,
    threadId: context.serverThreads,
    labels: context.gmail,
    headers: context.serverThreads ? false : ["message-id", "references", "in-reply-to"],
    ...extra,
  };
}

async function pickSearchMailbox(
  accountId: string,
  context: ImapContext,
  hint: MailboxHint | string | undefined,
  query: string,
): Promise<{ path: string; note?: string }> {
  const wanted = hint ?? (context.gmail && /\b(in|label):/i.test(query) ? "all" : "inbox");
  const path = await resolveMailbox(accountId, context, wanted);

  if (path) return { path };

  // Falling back silently is how "label:invoices" turned into the whole inbox
  // while still being announced as a search for invoices.
  return {
    path: "INBOX",
    note:
      `This mailbox has no folder called "${wanted}", so the inbox was searched instead. ` +
      "Ask for the folder by its exact name if it exists under another one.",
  };
}

function requireMailbox(mailbox: MailboxObject | false, path: string): MailboxObject {
  if (!mailbox) throw new PostbusError(`Could not open mailbox "${path}".`);
  return mailbox;
}

// A changed UIDVALIDITY means old uids point at different messages now.
function assertUidValidity(mailbox: MailboxObject, expected: string): void {
  if (String(mailbox.uidValidity) === expected) return;

  throw new PostbusError(
    "This message id has expired: the mailbox was reindexed.",
    "Search again with search_emails to get a valid id.",
    "not_found",
  );
}

// The same message can sit in both Inbox and Sent.
function dedupe(messages: MessageDetail[]): MessageDetail[] {
  const seen = new Set<string>();

  return messages.filter((message) => {
    const key = message.messageId ?? message.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
