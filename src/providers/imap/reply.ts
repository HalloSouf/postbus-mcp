import type { MessageDetail, ForwardOptions, ReplyOptions } from "../../types.js";

/** Everything composeMail needs to build a reply or a forward. */
export interface Composed {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  inReplyTo?: string;
  references?: string;
}

const MAX_QUOTED_CHARS = 4_000;

export function buildReply(
  original: MessageDetail,
  body: string,
  selfEmail: string,
  options: ReplyOptions = {},
): Composed {
  // Reply-To exists precisely so the answer does not go to the From address.
  const to = original.replyTo?.trim() || original.from;

  const cc = options.cc?.trim()
    ? options.cc
    : options.all
      ? dropSelf([original.to, original.cc], [selfEmail, ...addresses(to)]).join(", ")
      : undefined;

  return {
    to,
    cc: cc || undefined,
    subject: prefixOnce(original.subject, "Re:"),
    body: `${body.trimEnd()}\n\n${quote(original)}`,
    inReplyTo: original.messageId,
    references: [original.references, original.messageId].filter(Boolean).join(" ") || undefined,
  };
}

export function buildForward(
  original: MessageDetail,
  to: string,
  options: ForwardOptions = {},
): Composed {
  const note = options.note?.trim();

  return {
    to,
    cc: options.cc,
    subject: prefixOnce(original.subject, "Fwd:"),
    body: `${note ? `${note}\n\n` : ""}${header(original)}\n\n${truncateBody(original.body)}`,
  };
}

/** "Re: Re: x" helps nobody, and some clients thread on the exact subject. */
function prefixOnce(subject: string, prefix: string): string {
  const trimmed = subject.trim();
  const already = new RegExp(`^${prefix.replace(":", "")}\\s*:`, "i").test(trimmed);
  return already ? trimmed : `${prefix} ${trimmed}`;
}

function quote(original: MessageDetail): string {
  const when = original.date ? new Date(original.date).toUTCString() : "an earlier message";
  const lines = truncateBody(original.body)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");

  return `On ${when}, ${original.from} wrote:\n${lines}`;
}

function header(original: MessageDetail): string {
  return [
    "---------- Forwarded message ----------",
    `From: ${original.from}`,
    `Date: ${original.date || "unknown"}`,
    `Subject: ${original.subject}`,
    `To: ${original.to}`,
    original.cc ? `Cc: ${original.cc}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

// The original also travels along as a message/rfc822 attachment, so cutting
// the quoted copy loses nothing that cannot be opened.
function truncateBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= MAX_QUOTED_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_QUOTED_CHARS)}\n[… truncated]`;
}

/** Bare email addresses out of a "Name <a@b>, c@d" header. */
export function addresses(value: string | undefined): string[] {
  if (!value) return [];

  return value
    .split(",")
    .map((entry) => {
      const match = /<([^>]+)>/.exec(entry);
      return (match?.[1] ?? entry).trim().toLowerCase();
    })
    .filter((entry) => entry.includes("@"));
}

/** Reply-all should not mail the sender twice, nor the account itself. */
function dropSelf(headers: Array<string | undefined>, exclude: string[]): string[] {
  const skip = new Set(exclude.map((entry) => entry.toLowerCase()));
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const header of headers) {
    for (const entry of header?.split(",") ?? []) {
      const trimmed = entry.trim();
      if (!trimmed) continue;

      const bare = addresses(trimmed)[0];
      if (!bare || skip.has(bare) || seen.has(bare)) continue;

      seen.add(bare);
      kept.push(trimmed);
    }
  }

  return kept;
}
