import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { truncate } from "../util.js";
import { resolveAccount, type ToolContext } from "./context.js";
import { formatMessage, formatSearchResults, formatThread } from "./format.js";
import { guard } from "./guard.js";

const DEFAULT_BODY_LIMIT = 20_000;
const THREAD_BODY_LIMIT = 4_000;

// This layer knows no IMAP and no Gmail: it resolves the alias and hands the
// work to whichever provider that account belongs to.
export function registerMailTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "search_emails",
    {
      title: "Search messages",
      description:
        "Searches one of your mailboxes using Gmail-style syntax: " +
        "`from:boss@company.com is:unread newer_than:7d`, `subject:invoice has:attachment`, " +
        "`in:sent to:client@example.com`. For Gmail mailboxes the query goes to Gmail " +
        "unchanged; for other IMAP servers it is translated into IMAP search criteria. " +
        "Every result carries an `id` for get_message and a `threadId` for get_thread.",
      inputSchema: {
        account: z.string().min(1).describe('Mailbox alias, e.g. "personal" or "work".'),
        query: z
          .string()
          .default("")
          .describe("Search query. Empty returns the newest messages in the inbox."),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe("Maximum number of messages (1-100, default 10)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ account, query, max_results }) =>
      guard("search_emails", context.user, async () => {
        const { account: resolved, provider } = resolveAccount(context, account);
        const result = await provider.search(resolved, query ?? "", max_results ?? 10);

        // notes carries whatever the provider could not honour. Dropping it
        // here is what let a query search something other than what it said.
        return formatSearchResults(account, query ?? "", result.messages, result.notes);
      }),
  );

  server.registerTool(
    "get_message",
    {
      title: "Read one message",
      description:
        "Returns the full content of a single message: headers, body and attachment " +
        "metadata. The `id` comes from search_emails or get_thread.",
      inputSchema: {
        account: z.string().min(1).describe("Mailbox alias."),
        message_id: z.string().min(1).describe("The `id` from search_emails or get_thread."),
        max_body_chars: z
          .number()
          .int()
          .min(500)
          .max(200_000)
          .default(DEFAULT_BODY_LIMIT)
          .describe("Truncate the body at this many characters (default 20000)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ account, message_id, max_body_chars }) =>
      guard("get_message", context.user, async () => {
        const { account: resolved, provider } = resolveAccount(context, account);
        const message = await provider.getMessage(resolved, message_id);
        const body = truncate(message.body, max_body_chars ?? DEFAULT_BODY_LIMIT);
        return formatMessage(account, message, body);
      }),
  );

  server.registerTool(
    "get_thread",
    {
      title: "Read a whole conversation",
      description:
        "Returns every message in a conversation, oldest first, with sender, subject, " +
        "date and body per message. The `threadId` comes from search_emails. On Gmail this " +
        "uses the Gmail thread; on other IMAP servers the conversation is reconstructed " +
        "from the References headers.",
      inputSchema: {
        account: z.string().min(1).describe("Mailbox alias."),
        thread_id: z.string().min(1).describe("The `threadId` from search_emails."),
        max_body_chars: z
          .number()
          .int()
          .min(200)
          .max(50_000)
          .default(THREAD_BODY_LIMIT)
          .describe("Truncate each body at this many characters (default 4000)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ account, thread_id, max_body_chars }) =>
      guard("get_thread", context.user, async () => {
        const { account: resolved, provider } = resolveAccount(context, account);
        const messages = await provider.getThread(resolved, thread_id);
        const bodies = messages.map((message) =>
          truncate(message.body, max_body_chars ?? THREAD_BODY_LIMIT),
        );
        return formatThread(account, messages, bodies);
      }),
  );

  server.registerTool(
    "send_email",
    {
      title: "Send a message",
      description:
        "Sends a new message from one of your mailboxes straight away. There is no draft " +
        "step, so confirm the content with the user first. Separate multiple recipients " +
        "with commas.",
      inputSchema: {
        account: z.string().min(1).describe("Alias of the mailbox to send from."),
        to: z.string().min(1).describe("Recipient(s), comma separated."),
        subject: z.string().describe("Subject line."),
        body: z.string().describe("Message body."),
        cc: z.string().optional().describe("Cc recipients, comma separated."),
        bcc: z.string().optional().describe("Bcc recipients, comma separated."),
        reply_to: z.string().optional().describe("Reply-To address, if it differs."),
        html: z.boolean().default(false).describe("Send the body as HTML instead of plain text."),
      },
      // Sending cannot be undone and the content may have been steered by a
      // message the model just read, so clients must ask before calling this.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ account, to, subject, body, cc, bcc, reply_to, html }) =>
      guard("send_email", context.user, async () => {
        const { account: resolved, provider } = resolveAccount(context, account);
        const messageId = await provider.send(resolved, to, subject, body, {
          cc,
          bcc,
          replyTo: reply_to,
          html: html ?? false,
        });

        return [
          `Sent from "${account}" (${resolved.email}) to ${to}.`,
          cc ? `Cc: ${cc}` : undefined,
          `Message-ID: ${messageId}`,
        ]
          .filter(Boolean)
          .join("\n");
      }),
  );
}
