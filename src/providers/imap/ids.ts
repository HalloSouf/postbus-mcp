import { PostbusError } from "../../types.js";

// A UID means nothing without its mailbox and UIDVALIDITY, so the id carries all three.
export interface MessageRef {
  mailbox: string;
  uidValidity: string;
  uid: number;
}

export function encodeMessageId(ref: MessageRef): string {
  return `${encodeURIComponent(ref.mailbox)}:${ref.uidValidity}:${ref.uid}`;
}

export function decodeMessageId(value: string): MessageRef {
  const parts = value.split(":");
  // parseInt("12abc") is 12, so an id like "INBOX:1:12abc" used to be accepted
  // and quietly read a different message than the one that was asked for.
  const uid = /^\d+$/.test(parts[2] ?? "") ? Number.parseInt(parts[2] as string, 10) : NaN;

  if (parts.length !== 3 || !parts[0] || !parts[1] || Number.isNaN(uid) || uid < 1) {
    throw new PostbusError(
      `"${value}" is not a valid message id.`,
      "Use an id from search_emails or get_thread.",
      "invalid_input",
    );
  }

  return { mailbox: decodeURIComponent(parts[0]), uidValidity: parts[1], uid };
}

// srv: the server hands out thread ids (Gmail X-GM-THRID, RFC 8474 THREADID).
// ref: reconstructed from Message-ID / In-Reply-To / References.
export type ThreadRef =
  { kind: "server"; id: string } | { kind: "references"; rootMessageId: string };

export function encodeServerThreadId(id: string): string {
  return `srv:${id}`;
}

export function encodeReferenceThreadId(rootMessageId: string): string {
  return `ref:${Buffer.from(rootMessageId, "utf8").toString("base64url")}`;
}

export function decodeThreadId(value: string): ThreadRef {
  if (value.startsWith("srv:")) {
    const id = value.slice(4);
    if (!id) throw new PostbusError(`"${value}" is not a valid thread id.`);
    return { kind: "server", id };
  }

  if (value.startsWith("ref:")) {
    const decoded = Buffer.from(value.slice(4), "base64url").toString("utf8");
    if (!decoded) throw new PostbusError(`"${value}" is not a valid thread id.`);
    return { kind: "references", rootMessageId: decoded };
  }

  throw new PostbusError(
    `"${value}" is not a valid thread id.`,
    "Use a threadId from search_emails.",
  );
}

export function normalizeMessageIdHeader(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const match = /<([^>]+)>/.exec(trimmed);
  return match?.[1] ? `<${match[1]}>` : `<${trimmed}>`;
}

export function parseReferences(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/<([^>]+)>/g)].map((match) => `<${match[1]}>`);
}
