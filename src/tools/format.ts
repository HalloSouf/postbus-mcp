import type { AccountInfo, MessageDetail, MessageSummary } from "../types.js";

export function formatAccounts(accounts: AccountInfo[]): string {
  if (accounts.length === 0) {
    return [
      "You have no mailboxes linked yet.",
      "",
      "Link one with add_mail_account. For Gmail you only need your address and an",
      "app password (https://myaccount.google.com/apppasswords); host and port are",
      "filled in automatically for known providers.",
    ].join("\n");
  }

  const lines = accounts.map(
    (account) =>
      `- ${account.alias} — ${account.email}` +
      (account.server ? ` (${account.server})` : "") +
      (account.provider === "gmail-api" ? " [Gmail API]" : ""),
  );

  return [`Your mailboxes (${accounts.length}):`, "", ...lines].join("\n");
}

export function formatSearchResults(
  alias: string,
  query: string,
  messages: MessageSummary[],
  notes: string[] = [],
): string {
  const header = `Search in "${alias}" for: ${query || "(everything)"}`;

  if (messages.length === 0) {
    return [header, "", "No messages found.", ...notes].join("\n");
  }

  const blocks = messages.map((message, index) =>
    [
      `${index + 1}. ${message.unread ? "[UNREAD] " : ""}${message.subject}`,
      `   from:     ${message.from}`,
      `   date:     ${formatDate(message.date)}`,
      `   folder:   ${message.mailbox}${message.hasAttachments ? "  (has attachment)" : ""}`,
      `   id:       ${message.id}`,
      `   threadId: ${message.threadId}`,
      message.snippet ? `   preview:  ${message.snippet}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return [
    `${header}\n${messages.length} message(s):`,
    "",
    ...blocks,
    "",
    "get_message with `id` returns the full message; get_thread with `threadId` the whole conversation.",
    ...notes,
  ].join("\n");
}

export function formatMessage(alias: string, message: MessageDetail, body: string): string {
  return `${messageHeader(alias, message)}\n\n---\n\n${body.trim() || "(empty body)"}`;
}

export function formatThread(alias: string, messages: MessageDetail[], bodies: string[]): string {
  const subject = messages[0]?.subject ?? "(no subject)";

  const blocks = messages.map((message, index) => {
    const meta = [
      `[${index + 1}/${messages.length}] ${formatDate(message.date)}`,
      `from: ${message.from}`,
      `to:   ${message.to}`,
      message.cc ? `cc:   ${message.cc}` : undefined,
      message.subject !== subject ? `subject: ${message.subject}` : undefined,
      message.attachments.length
        ? `attachments: ${message.attachments.map((a) => a.filename).join(", ")}`
        : undefined,
      `id: ${message.id}`,
    ]
      .filter(Boolean)
      .join("\n");

    return `${meta}\n\n${(bodies[index] ?? "").trim() || "(empty body)"}`;
  });

  return [
    `Conversation in "${alias}": ${subject}`,
    `${messages.length} message(s), oldest first.`,
    "",
    blocks.join("\n\n────────────────────────\n\n"),
  ].join("\n");
}

function messageHeader(alias: string, message: MessageDetail): string {
  return [
    `Mailbox:    ${alias}`,
    `From:       ${message.from}`,
    `To:         ${message.to}`,
    message.cc ? `Cc:         ${message.cc}` : undefined,
    message.replyTo ? `Reply-To:   ${message.replyTo}` : undefined,
    `Subject:    ${message.subject}`,
    `Date:       ${formatDate(message.date)}`,
    `Folder:     ${message.mailbox}`,
    `Id:         ${message.id}`,
    `ThreadId:   ${message.threadId}`,
    message.labels?.length ? `Labels:     ${message.labels.join(", ")}` : undefined,
    message.attachments.length
      ? `Attachments: ${message.attachments
          .map((a) => `${a.filename}${a.size ? ` (${formatBytes(a.size)})` : ""}`)
          .join(", ")}`
      : undefined,
    `Body type:  ${message.bodyFormat}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDate(value: string): string {
  if (!value) return "(unknown)";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${parsed.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
