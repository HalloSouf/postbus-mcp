import { simpleParser, type ParsedMail } from "mailparser";
import type { FetchMessageObject, MessageAddressObject, MessageStructureObject } from "imapflow";
import type { AttachmentInfo, MessageDetail, MessageSummary } from "../../types.js";
import {
  encodeMessageId,
  encodeReferenceThreadId,
  encodeServerThreadId,
  normalizeMessageIdHeader,
  parseReferences,
} from "./ids.js";

export interface ParseContext {
  mailbox: string;
  uidValidity: string;
}

export function formatAddresses(addresses: MessageAddressObject[] | undefined): string {
  if (!addresses?.length) return "";

  return addresses
    .map((address) => {
      if (address.name && address.address) return `${address.name} <${address.address}>`;
      return address.address ?? address.name ?? "";
    })
    .filter(Boolean)
    .join(", ");
}

// The first id in the References chain is the root of the conversation.
export function determineThreadId(
  serverThreadId: string | undefined,
  headers: RawHeaders,
  ownMessageId: string | undefined,
): string {
  if (serverThreadId) return encodeServerThreadId(serverThreadId);

  const references = parseReferences(headers.references);
  const inReplyTo = parseReferences(headers["in-reply-to"]);
  const own = normalizeMessageIdHeader(ownMessageId ?? headers["message-id"]);

  const root = references[0] ?? inReplyTo[0] ?? own;
  return encodeReferenceThreadId(root ?? `unknown-${Date.now()}`);
}

export type RawHeaders = Record<string, string | undefined>;

export function parseHeaderBuffer(buffer: Buffer | undefined): RawHeaders {
  if (!buffer) return {};

  const headers: RawHeaders = {};
  const unfolded = buffer.toString("utf8").replace(/\r?\n[ \t]+/g, " ");

  for (const line of unfolded.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;

    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers[key] = headers[key] ? `${headers[key]} ${value}` : value;
  }

  return headers;
}

export function hasAttachments(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;

  const disposition = node.disposition?.toLowerCase();
  if (disposition === "attachment") return true;
  if (node.dispositionParameters?.filename || node.parameters?.name) return true;

  return (node.childNodes ?? []).some(hasAttachments);
}

export function toSummary(
  message: FetchMessageObject,
  context: ParseContext,
  snippet: string,
): MessageSummary {
  const envelope = message.envelope;
  const headers = parseHeaderBuffer(message.headers);

  return {
    id: encodeMessageId({
      mailbox: context.mailbox,
      uidValidity: context.uidValidity,
      uid: message.uid,
    }),
    threadId: determineThreadId(message.threadId, headers, envelope?.messageId),
    from: formatAddresses(envelope?.from) || headers.from || "",
    to: formatAddresses(envelope?.to) || headers.to || "",
    subject: envelope?.subject || headers.subject || "(no subject)",
    date: toIso(envelope?.date ?? message.internalDate),
    snippet,
    unread: !message.flags?.has("\\Seen"),
    hasAttachments: hasAttachments(message.bodyStructure),
    mailbox: context.mailbox,
    labels: message.labels ? [...message.labels] : undefined,
  };
}

export async function toDetail(
  message: FetchMessageObject,
  context: ParseContext,
  source: Buffer,
): Promise<MessageDetail> {
  const parsed: ParsedMail = await simpleParser(source, {
    skipImageLinks: true,
    skipTextToHtml: true,
  });

  // mailparser always yields text, converting the HTML when there is no plain
  // part. That is what we want: a 200 KB newsletter becomes a few readable lines.
  const text = parsed.text?.trim();
  const html = typeof parsed.html === "string" ? parsed.html.trim() : "";
  const body = text || html;

  const headers: RawHeaders = {
    references: joinHeader(parsed.references),
    "in-reply-to": parsed.inReplyTo,
    "message-id": parsed.messageId,
  };

  const attachments: AttachmentInfo[] = parsed.attachments.map((attachment) => ({
    filename: attachment.filename ?? "(unnamed)",
    mimeType: attachment.contentType ?? "application/octet-stream",
    size: attachment.size,
  }));

  return {
    id: encodeMessageId({
      mailbox: context.mailbox,
      uidValidity: context.uidValidity,
      uid: message.uid,
    }),
    threadId: determineThreadId(message.threadId, headers, parsed.messageId),
    from: parsed.from?.text ?? "",
    to: addressText(parsed.to),
    cc: addressText(parsed.cc) || undefined,
    bcc: addressText(parsed.bcc) || undefined,
    replyTo: parsed.replyTo?.text || undefined,
    messageId: parsed.messageId,
    subject: parsed.subject || "(no subject)",
    date: toIso(parsed.date ?? message.internalDate),
    snippet: makeSnippet(body),
    unread: !message.flags?.has("\\Seen"),
    hasAttachments: attachments.length > 0,
    mailbox: context.mailbox,
    labels: message.labels ? [...message.labels] : undefined,
    body,
    bodyFormat: text ? "text" : "html",
    attachments,
  };
}

export async function makeSnippetFromSource(source: Buffer | undefined): Promise<string> {
  if (!source?.length) return "";

  try {
    const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
    const text = parsed.text?.trim();
    if (text) return makeSnippet(text);

    const html = typeof parsed.html === "string" ? parsed.html : "";
    return makeSnippet(stripHtml(html));
  } catch {
    return "";
  }
}

export function makeSnippet(value: string, max = 180): string {
  const collapsed = stripQuoted(value).replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max).trimEnd()}…`;
}

// Quoted replies and signatures say little in a preview.
function stripQuoted(value: string): string {
  const withoutQuotes = value
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");

  return withoutQuotes.split(/^-- $/m)[0] ?? withoutQuotes;
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function addressText(value: ParsedMail["to"]): string {
  if (!value) return "";
  return Array.isArray(value) ? value.map((entry) => entry.text).join(", ") : value.text;
}

function joinHeader(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value.join(" ") : value;
}

function toIso(value: Date | string | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
