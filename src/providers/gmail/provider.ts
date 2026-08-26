import { google, type gmail_v1 } from "googleapis";
import {
  PostbusError,
  type AttachmentInfo,
  type GmailApiAccount,
  type MailProvider,
  type MessageDetail,
  type MessageSummary,
  type SendOptions,
} from "../../types.js";
import { mapLimit, normalizeDate } from "../../util.js";
import { createClientForRefreshToken } from "./auth.js";
import { buildMimeMessage, toBase64Url } from "./mime.js";

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

  async search(
    account: GmailApiAccount,
    query: string,
    maxResults: number,
  ): Promise<MessageSummary[]> {
    const gmail = this.client(account);
    const limit = Math.min(Math.max(1, maxResults), 100);

    const list = await call(() =>
      gmail.users.messages.list({ userId: "me", q: query || undefined, maxResults: limit }),
    );

    const refs = list.data.messages ?? [];
    if (refs.length === 0) return [];

    return mapLimit(refs, MAX_PARALLEL_FETCHES, async (ref) => {
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

    return messages
      .slice(0, MAX_THREAD_MESSAGES)
      .map(toDetail)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async send(
    account: GmailApiAccount,
    to: string,
    subject: string,
    body: string,
    options: SendOptions = {},
  ): Promise<string> {
    const raw = buildMimeMessage({
      from: account.displayName ? `${account.displayName} <${account.email}>` : account.email,
      to,
      subject,
      body,
      cc: options.cc,
      bcc: options.bcc,
      replyTo: options.replyTo,
      html: options.html,
    });

    const response = await call(() =>
      this.client(account).users.messages.send({
        userId: "me",
        requestBody: { raw: toBase64Url(raw) },
      }),
    );

    const id = response.data.id;
    if (!id) throw new PostbusError("Gmail returned no message id after sending.");
    return id;
  }

  private client(account: GmailApiAccount): gmail_v1.Gmail {
    return google.gmail({ version: "v1", auth: createClientForRefreshToken(account.refreshToken) });
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

function toSummary(message: gmail_v1.Schema$Message): MessageSummary {
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
    mailbox: labels.includes("SENT") ? "SENT" : "INBOX",
    labels,
  };
}

function toDetail(message: gmail_v1.Schema$Message): MessageDetail {
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

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): {
  body: string;
  bodyFormat: "text" | "html";
} {
  const plain = findPart(payload, "text/plain");
  if (plain) return { body: decodePartData(plain), bodyFormat: "text" };

  const html = findPart(payload, "text/html");
  if (html) return { body: decodePartData(html), bodyFormat: "html" };

  if (payload?.body?.data) {
    return {
      body: decodePartData(payload),
      bodyFormat: (payload.mimeType ?? "").includes("html") ? "html" : "text",
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

function decodePartData(part: gmail_v1.Schema$MessagePart): string {
  const data = part.body?.data;
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
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
