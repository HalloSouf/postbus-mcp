import { gmail, type gmail_v1 } from "@googleapis/gmail";
import {
  PostbusError,
  type AttachmentInfo,
  type GmailApiAccount,
  type MailProvider,
  type MessageDetail,
  type MessageSummary,
  type SearchResult,
  type SendOptions,
  type SendResult,
  type BatchResult,
  type DraftResult,
  type FlagChange,
  type FolderInfo,
  type ForwardOptions,
  type ReplyOptions,
  type LabelColorInput,
} from "../../types.js";
import { stripHtml } from "../imap/parse.js";
import { mapLimit, normalizeDate } from "../../util.js";
import { createClientForRefreshToken } from "./auth.js";
import { buildMimeMessage, toBase64Url } from "./mime.js";
import {
  allDone,
  assertNotSystemLabel,
  labelChangeFor,
  resolveLabelIds,
  toFolderInfo,
  type GmailLabel,
} from "./actions.js";
import { buildForward, buildReply } from "../imap/reply.js";
import { resolveLabelColor } from "./colors.js";

const METADATA_HEADERS = ["From", "To", "Cc", "Subject", "Date"];
const MAX_PARALLEL_FETCHES = 5;
const MAX_THREAD_MESSAGES = 50;

// Optional second provider. IMAP with an app password does the same job without
// a Google Cloud project, so this is only for mailboxes where IMAP is blocked.
export class GmailApiProvider implements MailProvider<GmailApiAccount> {
  readonly id = "gmail-api" as const;

  async verify(account: GmailApiAccount): Promise<void> {
    await call(() => this.client(account).users.getProfile({ userId: "me" }));
  }

  async search(account: GmailApiAccount, query: string, maxResults: number): Promise<SearchResult> {
    const gmail = this.client(account);
    const limit = Math.min(Math.max(1, maxResults), 100);

    // Without q Gmail returns everything it has — archived, sent, drafts —
    // while the tool promises "the newest messages in the inbox".
    const list = await call(() =>
      gmail.users.messages.list({ userId: "me", q: query || "in:inbox", maxResults: limit }),
    );

    const refs = list.data.messages ?? [];
    // Gmail gets the query verbatim, so there is nothing this provider had to
    // drop and nothing to warn about.
    if (refs.length === 0) return { messages: [], notes: [] };

    const messages = await mapLimit(refs, MAX_PARALLEL_FETCHES, async (ref) => {
      const detail = await call(() =>
        gmail.users.messages.get({
          userId: "me",
          id: ref.id as string,
          format: "metadata",
          metadataHeaders: METADATA_HEADERS,
        }),
      );
      return toSummary(detail.data);
    });

    return { messages, notes: [] };
  }

  async getMessage(account: GmailApiAccount, messageId: string): Promise<MessageDetail> {
    const response = await call(() =>
      this.client(account).users.messages.get({ userId: "me", id: messageId, format: "full" }),
    );

    return toDetail(response.data);
  }

  async getThread(account: GmailApiAccount, threadId: string): Promise<MessageDetail[]> {
    const response = await call(() =>
      this.client(account).users.threads.get({ userId: "me", id: threadId, format: "full" }),
    );

    const messages = response.data.messages ?? [];
    if (messages.length === 0) {
      throw new PostbusError("No messages found in this conversation.");
    }

    // Keep the tail, not the head: the IMAP provider keeps the newest and the
    // recent half of a long conversation is the half anyone asks about.
    const kept = messages.slice(-MAX_THREAD_MESSAGES).map(toDetail);
    const ordered = kept.sort((a, b) => a.date.localeCompare(b.date));

    if (messages.length > kept.length && ordered[0]) {
      ordered[0] = {
        ...ordered[0],
        body: `[… only the ${ordered.length} most recent messages in this conversation are shown]\n\n${ordered[0].body}`,
      };
    }

    return ordered;
  }

  async send(
    account: GmailApiAccount,
    to: string,
    subject: string,
    body: string,
    options: SendOptions = {},
  ): Promise<SendResult> {
    const built = await buildMimeMessage({
      from: { name: account.displayName, address: account.email },
      to,
      subject,
      body,
      cc: options.cc,
      bcc: options.bcc,
      replyTo: options.replyTo,
      html: options.html,
      inReplyTo: options.inReplyTo,
      references: options.references,
    });

    await call(() =>
      this.client(account).users.messages.send({
        userId: "me",
        requestBody: { raw: toBase64Url(built.raw) },
      }),
    );

    // Report the RFC 5322 Message-ID, not Gmail's own message id. The IMAP
    // provider returns the former, both used to be labelled "Message-ID", and
    // only one of them is what a reply threads against.
    return { messageId: built.messageId, notes: [] };
  }

  async reply(
    account: GmailApiAccount,
    messageId: string,
    body: string,
    options: ReplyOptions = {},
  ): Promise<SendResult> {
    const original = await this.getMessage(account, messageId);
    const composed = buildReply(original, body, account.email, options);

    const result = await this.send(account, composed.to, composed.subject, composed.body, {
      cc: composed.cc,
      bcc: options.bcc,
      html: options.html,
      inReplyTo: composed.inReplyTo,
      references: composed.references,
    });

    await this.modify(account, [messageId], [], ["UNREAD"]).catch(() => undefined);
    return result;
  }

  async createDraft(
    account: GmailApiAccount,
    to: string,
    subject: string,
    body: string,
    options: SendOptions = {},
  ): Promise<DraftResult> {
    const built = await buildMimeMessage({
      from: { name: account.displayName, address: account.email },
      to,
      subject,
      body,
      cc: options.cc,
      bcc: options.bcc,
      replyTo: options.replyTo,
      html: options.html,
      inReplyTo: options.inReplyTo,
      references: options.references,
    });

    return this.storeDraft(account, built);
  }

  async createReplyDraft(
    account: GmailApiAccount,
    messageId: string,
    body: string,
    options: ReplyOptions = {},
  ): Promise<DraftResult> {
    const original = await this.getMessage(account, messageId);
    const composed = buildReply(original, body, account.email, options);

    const built = await buildMimeMessage({
      from: { name: account.displayName, address: account.email },
      to: composed.to,
      subject: composed.subject,
      body: composed.body,
      cc: composed.cc,
      bcc: options.bcc,
      html: options.html,
      inReplyTo: composed.inReplyTo,
      references: composed.references,
    });

    // Without the threadId Gmail files the draft as a new conversation, so the
    // user sees their answer sitting next to the mail it answers.
    return this.storeDraft(account, built, original.threadId);
  }

  async forward(
    account: GmailApiAccount,
    messageId: string,
    to: string,
    options: ForwardOptions = {},
  ): Promise<SendResult> {
    const original = await this.getMessage(account, messageId);
    const composed = buildForward(original, to, options);
    const raw = await this.rawMessage(account, messageId);

    const built = await buildMimeMessage({
      from: { name: account.displayName, address: account.email },
      to: composed.to,
      subject: composed.subject,
      body: composed.body,
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

    await call(() =>
      this.client(account).users.messages.send({
        userId: "me",
        requestBody: { raw: toBase64Url(built.raw) },
      }),
    );

    return { messageId: built.messageId, notes: [] };
  }

  async listFolders(account: GmailApiAccount): Promise<FolderInfo[]> {
    const labels = await this.labels(account);
    return labels.map(toFolderInfo).sort((a, b) => a.path.localeCompare(b.path));
  }

  async createFolder(account: GmailApiAccount, path: string): Promise<string> {
    const response = await call(() =>
      this.client(account).users.labels.create({ userId: "me", requestBody: { name: path } }),
    );

    return response.data.name ?? path;
  }

  async renameFolder(account: GmailApiAccount, path: string, newPath: string): Promise<string> {
    const label = await this.requireLabel(account, path);
    assertNotSystemLabel(label);

    const response = await call(() =>
      this.client(account).users.labels.patch({
        userId: "me",
        id: label.id as string,
        requestBody: { name: newPath },
      }),
    );

    return response.data.name ?? newPath;
  }

  async deleteFolder(account: GmailApiAccount, path: string): Promise<void> {
    const label = await this.requireLabel(account, path);
    assertNotSystemLabel(label);

    await call(() =>
      this.client(account).users.labels.delete({ userId: "me", id: label.id as string }),
    );
  }

  // A folder move in Gmail is a label swap: put the target on, take the inbox off.
  async moveMessages(
    account: GmailApiAccount,
    messageIds: string[],
    target: string,
  ): Promise<BatchResult> {
    const [labelId] = resolveLabelIds([target], await this.labels(account));
    await this.modify(account, messageIds, [labelId as string], ["INBOX"]);

    return allDone(messageIds, [`Moved to "${target}".`]);
  }

  async archiveMessages(account: GmailApiAccount, messageIds: string[]): Promise<BatchResult> {
    await this.modify(account, messageIds, [], ["INBOX"]);
    return allDone(messageIds, ["Removed from the inbox."]);
  }

  async trashMessages(account: GmailApiAccount, messageIds: string[]): Promise<BatchResult> {
    await mapLimit(messageIds, MAX_PARALLEL_FETCHES, (id) =>
      call(() => this.client(account).users.messages.trash({ userId: "me", id })),
    );

    return allDone(messageIds, ["Moved to the trash."]);
  }

  async markMessages(
    account: GmailApiAccount,
    messageIds: string[],
    change: FlagChange,
  ): Promise<BatchResult> {
    const { add, remove } = labelChangeFor(change);
    await this.modify(account, messageIds, add, remove);

    return allDone(messageIds, [`Marked as ${change}.`]);
  }

  async labelMessages(
    account: GmailApiAccount,
    messageIds: string[],
    add: string[],
    remove: string[],
  ): Promise<BatchResult> {
    if (add.length === 0 && remove.length === 0) {
      throw new PostbusError("Nothing to add or remove.", "Pass at least one label.");
    }

    const labels = await this.labels(account);
    await this.modify(
      account,
      messageIds,
      resolveLabelIds(add, labels),
      resolveLabelIds(remove, labels),
    );

    const notes: string[] = [];
    if (add.length > 0) notes.push(`Added: ${add.join(", ")}.`);
    if (remove.length > 0) notes.push(`Removed: ${remove.join(", ")}.`);
    return allDone(messageIds, notes);
  }

  async setLabelColor(
    account: GmailApiAccount,
    label: string,
    color: LabelColorInput,
  ): Promise<string> {
    const resolved = await this.requireLabel(account, label);
    assertNotSystemLabel(resolved);

    const response = await call(() =>
      this.client(account).users.labels.patch({
        userId: "me",
        id: resolved.id as string,
        requestBody: { color: resolveLabelColor(color) },
      }),
    );

    return response.data.name ?? label;
  }

  /** Stores a composed message as a draft; Gmail sends nothing until asked. */
  private async storeDraft(
    account: GmailApiAccount,
    built: { raw: Buffer; messageId: string },
    threadId?: string,
  ): Promise<DraftResult> {
    const response = await call(() =>
      this.client(account).users.drafts.create({
        userId: "me",
        requestBody: {
          message: { raw: toBase64Url(built.raw), ...(threadId ? { threadId } : {}) },
        },
      }),
    );

    // The message id, not the draft id: that is the one get_message accepts.
    return {
      id: response.data.message?.id ?? undefined,
      messageId: built.messageId,
      folder: "DRAFTS",
      notes: [],
    };
  }

  private async modify(
    account: GmailApiAccount,
    messageIds: string[],
    addLabelIds: string[],
    removeLabelIds: string[],
  ): Promise<void> {
    if (messageIds.length === 0) {
      throw new PostbusError("No message ids given.", "Pass at least one id from search_emails.");
    }

    await call(() =>
      this.client(account).users.messages.batchModify({
        userId: "me",
        requestBody: { ids: messageIds, addLabelIds, removeLabelIds },
      }),
    );
  }

  private async labels(account: GmailApiAccount): Promise<GmailLabel[]> {
    const response = await call(() => this.client(account).users.labels.list({ userId: "me" }));
    return response.data.labels ?? [];
  }

  private async requireLabel(account: GmailApiAccount, path: string): Promise<GmailLabel> {
    const labels = await this.labels(account);
    const [id] = resolveLabelIds([path], labels);

    return labels.find((label) => label.id === id) as GmailLabel;
  }

  private async rawMessage(
    account: GmailApiAccount,
    messageId: string,
  ): Promise<Buffer | undefined> {
    try {
      const response = await call(() =>
        this.client(account).users.messages.get({ userId: "me", id: messageId, format: "raw" }),
      );

      const raw = response.data.raw;
      return raw ? Buffer.from(raw, "base64url") : undefined;
    } catch {
      return undefined;
    }
  }

  private client(account: GmailApiAccount): gmail_v1.Gmail {
    return gmail({ version: "v1", auth: createClientForRefreshToken(account.refreshToken) });
  }
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw translateGoogleError(error);
  }
}

function translateGoogleError(error: unknown): Error {
  const err = error as { message?: string; code?: number | string };
  const message = err?.message ?? String(error);

  if (/invalid_grant/i.test(message)) {
    return new PostbusError(
      "The refresh token is no longer valid (invalid_grant).",
      'Link this mailbox again. While the OAuth consent screen is on "Testing", refresh tokens ' +
        "expire after 7 days — an IMAP mailbox with an app password does not have that problem.",
    );
  }

  if (/insufficient|ACCESS_TOKEN_SCOPE/i.test(message)) {
    return new PostbusError(
      "Insufficient OAuth scopes for this action.",
      "Link the mailbox again so the new scopes are granted.",
    );
  }

  if (String(err?.code) === "404") return new PostbusError("Message not found in this mailbox.");
  return new PostbusError(`Gmail API error: ${message}`);
}

function header(
  payload: gmail_v1.Schema$MessagePart | undefined,
  name: string,
): string | undefined {
  const found = payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return found?.value ?? undefined;
}

export function toSummary(message: gmail_v1.Schema$Message): MessageSummary {
  const labels = message.labelIds ?? [];

  return {
    id: message.id ?? "",
    threadId: message.threadId ?? message.id ?? "",
    from: header(message.payload, "From") ?? "",
    to: header(message.payload, "To") ?? "",
    subject: header(message.payload, "Subject") ?? "(no subject)",
    date: normalizeDate(header(message.payload, "Date"), message.internalDate),
    snippet: decodeEntities(message.snippet ?? ""),
    unread: labels.includes("UNREAD"),
    hasAttachments: collectAttachments(message.payload).length > 0,
    mailbox: gmailFolder(labels),
    labels,
  };
}

// Gmail has labels, not folders. Reporting everything without a SENT label as
// "INBOX" told the model that archived mail was sitting in the inbox.
export function gmailFolder(labels: string[]): string {
  for (const [label, folder] of [
    ["INBOX", "INBOX"],
    ["SENT", "SENT"],
    ["DRAFT", "DRAFTS"],
    ["TRASH", "TRASH"],
    ["SPAM", "SPAM"],
  ] as const) {
    if (labels.includes(label)) return folder;
  }

  return "ARCHIVE";
}

export function toDetail(message: gmail_v1.Schema$Message): MessageDetail {
  const summary = toSummary(message);
  const { body, bodyFormat } = extractBody(message.payload);

  return {
    ...summary,
    cc: header(message.payload, "Cc"),
    bcc: header(message.payload, "Bcc"),
    replyTo: header(message.payload, "Reply-To"),
    messageId: header(message.payload, "Message-ID"),
    body,
    bodyFormat,
    attachments: collectAttachments(message.payload),
  };
}

export function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): {
  body: string;
  bodyFormat: "text" | "html";
} {
  const plain = findPart(payload, "text/plain");
  if (plain) return { body: decodePartData(plain), bodyFormat: "text" };

  // The IMAP provider runs everything through mailparser, which turns a
  // 200 KB newsletter into a few readable lines. Handing back raw markup here
  // meant max_body_chars was spent on <table style=...> instead of the text.
  const html = findPart(payload, "text/html");
  if (html) return { body: stripHtml(decodePartData(html)).trim(), bodyFormat: "text" };

  if (payload?.body?.data) {
    const isHtml = (payload.mimeType ?? "").includes("html");
    const decoded = decodePartData(payload);

    return {
      body: isHtml ? stripHtml(decoded).trim() : decoded,
      bodyFormat: "text",
    };
  }

  return { body: "", bodyFormat: "text" };
}

function findPart(
  part: gmail_v1.Schema$MessagePart | undefined,
  mimeType: string,
): gmail_v1.Schema$MessagePart | undefined {
  if (!part) return undefined;

  if (!part.filename && part.mimeType === mimeType && part.body?.data) return part;

  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

// Gmail hands the part back exactly as it was sent, charset and all. Decoding
// everything as UTF-8 turned "café" in an ISO-8859-1 message into "caf\uFFFD".
function decodePartData(part: gmail_v1.Schema$MessagePart): string {
  const data = part.body?.data;
  if (!data) return "";

  const buffer = Buffer.from(data, "base64url");
  const charset = part.headers
    ?.find((header) => header.name?.toLowerCase() === "content-type")
    ?.value?.match(/charset\s*=\s*"?([\w-]+)"?/i)?.[1];

  return decodeBuffer(buffer, charset);
}

function decodeBuffer(buffer: Buffer, charset: string | undefined): string {
  const encoding = (charset ?? "utf-8").toLowerCase();
  if (!encoding || encoding === "utf-8" || encoding === "utf8" || encoding === "us-ascii") {
    return buffer.toString("utf8");
  }

  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    // An encoding Node does not know is better read as Latin-1 than as
    // replacement characters: every byte still maps to something.
    return buffer.toString("latin1");
  }
}

function collectAttachments(part: gmail_v1.Schema$MessagePart | undefined): AttachmentInfo[] {
  if (!part) return [];

  const found: AttachmentInfo[] = [];
  if (part.filename) {
    found.push({
      filename: part.filename,
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body?.size ?? undefined,
    });
  }

  for (const child of part.parts ?? []) found.push(...collectAttachments(child));
  return found;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
