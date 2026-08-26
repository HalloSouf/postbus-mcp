import type { SearchObject } from "imapflow";

export type MailboxHint = "inbox" | "sent" | "drafts" | "archive" | "all" | "trash" | "junk";

export interface ParsedQuery {
  criteria: SearchObject;
  raw: string;
  mailbox?: MailboxHint;
  requireAttachments: boolean;
  ignored: string[];
}

// Gmail servers get the query verbatim via X-GM-RAW; everything else is
// translated to IMAP criteria, which are a lot coarser.
const TOKEN = /(-?)([a-z_]+):("[^"]*"|\S+)|"([^"]+)"|(\S+)/gi;

const MAILBOX_ALIASES: Record<string, MailboxHint> = {
  inbox: "inbox",
  sent: "sent",
  sentmail: "sent",
  drafts: "drafts",
  draft: "drafts",
  archive: "archive",
  all: "all",
  anywhere: "all",
  trash: "trash",
  bin: "trash",
  spam: "junk",
  junk: "junk",
};

export function parseQuery(query: string): ParsedQuery {
  const criteria: SearchObject = {};
  const freeText: string[] = [];
  const ignored: string[] = [];
  let mailbox: MailboxHint | undefined;
  let requireAttachments = false;

  for (const match of query.matchAll(TOKEN)) {
    const [, negated, key, rawValue, quoted, bare] = match;

    if (quoted !== undefined) {
      freeText.push(quoted);
      continue;
    }

    if (bare !== undefined) {
      freeText.push(bare);
      continue;
    }

    const value = unquote(rawValue ?? "");
    const not = negated === "-";

    switch (key?.toLowerCase()) {
      case "from":
        assign(criteria, "from", value, not);
        break;
      case "to":
        assign(criteria, "to", value, not);
        break;
      case "cc":
        assign(criteria, "cc", value, not);
        break;
      case "bcc":
        assign(criteria, "bcc", value, not);
        break;
      case "subject":
        assign(criteria, "subject", value, not);
        break;
      case "body":
        assign(criteria, "body", value, not);
        break;

      case "is":
      case "in":
      case "label": {
        const applied = applyStateOrMailbox(key.toLowerCase(), value.toLowerCase(), criteria, not);
        if (applied.mailbox) mailbox = applied.mailbox;
        if (!applied.handled) ignored.push(`${key}:${value}`);
        break;
      }

      case "has":
        if (value.toLowerCase() === "attachment") requireAttachments = true;
        else ignored.push(`has:${value}`);
        break;

      case "newer_than":
      case "newer":
        applyRelativeDate(criteria, value, "since", ignored);
        break;
      case "older_than":
      case "older":
        applyRelativeDate(criteria, value, "before", ignored);
        break;

      case "after":
      case "since":
        applyAbsoluteDate(criteria, value, "since", ignored);
        break;
      case "before":
        applyAbsoluteDate(criteria, value, "before", ignored);
        break;
      case "on":
        applyAbsoluteDate(criteria, value, "on", ignored);
        break;

      case "larger":
        applySize(criteria, value, "larger", ignored);
        break;
      case "smaller":
        applySize(criteria, value, "smaller", ignored);
        break;

      default:
        ignored.push(match[0]);
    }
  }

  // IMAP supports a single TEXT term, so loose words become one search string.
  if (freeText.length > 0) criteria.text = freeText.join(" ");
  if (Object.keys(criteria).length === 0) criteria.all = true;

  return { criteria, raw: query.trim(), mailbox, requireAttachments, ignored };
}

function assign(criteria: SearchObject, field: keyof SearchObject, value: string, not: boolean) {
  if (not) {
    criteria.not = { ...(criteria.not ?? {}), [field]: value };
    return;
  }
  (criteria as Record<string, unknown>)[field] = value;
}

function applyStateOrMailbox(
  key: string,
  value: string,
  criteria: SearchObject,
  not: boolean,
): { handled: boolean; mailbox?: MailboxHint } {
  if (key === "in" || key === "label") {
    const mailbox = MAILBOX_ALIASES[value];
    if (mailbox) return { handled: true, mailbox };
    return { handled: true, mailbox: undefined };
  }

  const flip = (state: boolean) => (not ? !state : state);

  switch (value) {
    case "unread":
    case "unseen":
      criteria.seen = flip(false);
      return { handled: true };
    case "read":
    case "seen":
      criteria.seen = flip(true);
      return { handled: true };
    case "starred":
    case "flagged":
      criteria.flagged = flip(true);
      return { handled: true };
    case "unstarred":
    case "unflagged":
      criteria.flagged = flip(false);
      return { handled: true };
    case "answered":
      criteria.answered = flip(true);
      return { handled: true };
    case "unanswered":
      criteria.answered = flip(false);
      return { handled: true };
    case "draft":
      criteria.draft = flip(true);
      return { handled: true };
    default:
      return { handled: false };
  }
}

const DURATION = /^(\d+)\s*([dwmyh])$/i;

function applyRelativeDate(
  criteria: SearchObject,
  value: string,
  field: "since" | "before",
  ignored: string[],
): void {
  const match = DURATION.exec(value.trim());
  if (!match) {
    ignored.push(`${field === "since" ? "newer_than" : "older_than"}:${value}`);
    return;
  }

  const amount = Number.parseInt(match[1] ?? "0", 10);
  const days =
    { h: amount / 24, d: amount, w: amount * 7, m: amount * 30, y: amount * 365 }[
      (match[2] ?? "d").toLowerCase()
    ] ?? amount;

  criteria[field] = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function applyAbsoluteDate(
  criteria: SearchObject,
  value: string,
  field: "since" | "before" | "on",
  ignored: string[],
): void {
  const parsed = new Date(value.replace(/\//g, "-"));
  if (Number.isNaN(parsed.getTime())) {
    ignored.push(`${field}:${value}`);
    return;
  }
  criteria[field] = parsed;
}

const SIZE = /^(\d+)([kmg]?)b?$/i;

function applySize(
  criteria: SearchObject,
  value: string,
  field: "larger" | "smaller",
  ignored: string[],
): void {
  const match = SIZE.exec(value.trim());
  if (!match) {
    ignored.push(`${field}:${value}`);
    return;
  }

  const amount = Number.parseInt(match[1] ?? "0", 10);
  const multiplier =
    { "": 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[(match[2] ?? "").toLowerCase()] ?? 1;

  criteria[field] = amount * multiplier;
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}
