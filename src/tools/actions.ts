import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FlagChange } from "../types.js";
import { resolveAccount, type ToolContext } from "./context.js";
import { formatBatchResult, formatFolders } from "./format.js";
import { guard } from "./guard.js";

const MAX_BATCH = 200;

const messageIds = z
  .array(z.string().min(1))
  .min(1)
  .max(MAX_BATCH)
  .describe("Message ids from search_emails or get_thread. Multiple ids in one call is fine.");

const account = z.string().min(1).describe('Mailbox alias, e.g. "personal" or "work".');

// Everything you would do in a mail client by dragging, clicking or replying.
// Ids may come from different folders in one call; the provider sorts that out.
export function registerActionTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "archive_messages",
    {
      title: "Archive messages",
      description:
        "Takes messages out of the inbox without deleting them. On Gmail this removes the " +
        "inbox label; on other servers the messages move to the Archive folder. " +
        "Nothing is lost and search still finds them.",
      inputSchema: { account, message_ids: messageIds },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ account: alias, message_ids }) =>
      guard("archive_messages", context.user, async () => {
        const { account: resolved, provider } = resolveAccount(context, alias);
        return formatBatchResult("Archived", await provider.archiveMessages(resolved, message_ids));
      }),
  );

  server.registerTool(
    "trash_messages",
    {
      title: "Move messages to the trash",
      description:
        "Moves messages to the trash folder. They stay recoverable until the user empties " +
        "the trash themselves; this tool cannot delete anything permanently. " +
        "To only get mail out of the way, prefer archive_messages.",
      inputSchema: { account, message_ids: messageIds },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ account: alias, message_ids }) =>
      guard("trash_messages", context.user, async () => {
        const { account: resolved, provider } = resolveAccount(context, alias);
        return formatBatchResult("Trashed", await provider.trashMessages(resolved, message_ids));
      }),
  );

  server.registerTool(
    "move_messages",
    {
      title: "Move messages to a folder",
      description:
        "Moves messages into another folder. The target can be a full path from list_folders " +
        '("[Gmail]/All Mail", "Projects/2026"), a plain folder name, or one of inbox, sent, ' +
        "archive, drafts, trash, junk. On Gmail the target is a label.",
      inputSchema: {
        account,
        message_ids: messageIds,
        target: z.string().min(1).describe("Destination folder, from list_folders."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ account: alias, message_ids, target }) =>
      guard("move_messages", context.user, async () => {
        const { account: resolved, provider } = resolveAccount(context, alias);
        return formatBatchResult(
          "Moved",
          await provider.moveMessages(resolved, message_ids, target),
        );
      }),
  );

  server.registerTool(
    "mark_messages",
    {
      title: "Mark messages read, unread or starred",
      description:
        "Changes the read and starred state of messages. Use this after reading something on " +
        "the user's behalf, so their inbox reflects what they have actually seen.",
      inputSchema: {
        account,
        message_ids: messageIds,
        change: z
          .enum(["read", "unread", "star", "unstar"])
          .describe("What to change: read, unread, star or unstar."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ account: alias, message_ids, change }) =>
      guard("mark_messages", context.user, async () => {
        const { account: resolved, provider } = resolveAccount(context, alias);
        return formatBatchResult(
          "Marked",
          await provider.markMessages(resolved, message_ids, change as FlagChange),
        );
      }),
  );

  server.registerTool(
    "label_messages",
    {
      title: "Add or remove Gmail labels",
      description:
        "Adds or removes labels on messages. Gmail only: a message can carry several labels " +
        "at once. Other IMAP servers have folders instead, so use move_messages there. " +
        "Labels have to exist already; create one with create_folder.",
      inputSchema: {
        account,
        message_ids: messageIds,
        add: z.array(z.string().min(1)).default([]).describe("Labels to add."),
        remove: z.array(z.string().min(1)).default([]).describe("Labels to remove."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ account: alias, message_ids, add, remove }) =>
      guard("label_messages", context.user, async () => {
        const { account: resolved, provider } = resolveAccount(context, alias);
        return formatBatchResult(
          "Relabelled",
          await provider.labelMessages(resolved, message_ids, add ?? [], remove ?? []),
        );
      }),
  );

  server.registerTool(
    "reply_to_message",
    {
      title: "Reply to a message",
      description:
        "Replies to a message, keeping it in the same conversation. Recipients, subject and " +
        "the quoted original are filled in automatically; you only write the new text. " +
        "Set reply_all to include everyone who was on the original. " +
        "This sends immediately, so confirm the text with the user first.",
      inputSchema: {
        account,
        message_id: z.string().min(1).describe("The message being answered."),
        body: z.string().describe("Your reply. The original is quoted below it automatically."),
        reply_all: z
          .boolean()
          .default(false)
          .describe("Also reply to everyone in To and Cc of the original."),
        cc: z.string().optional().describe("Extra Cc recipients, comma separated."),
        bcc: z.string().optional().describe("Bcc recipients, comma separated."),
        html: z.boolean().default(false).describe("Send the body as HTML."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ account: alias, message_id, body, reply_all, cc, bcc, html }) =>
      guard("reply_to_message", context.user, async () => {
        const { account: resolved, provider } = resolveAccount(context, alias);
        const result = await provider.reply(resolved, message_id, body, {
          all: reply_all ?? false,
          cc,
          bcc,
          html: html ?? false,
        });

        return [`Reply sent from "${alias}".`, `Message-ID: ${result.messageId}`, ...result.notes]
          .filter(Boolean)
          .join("\n");
      }),
  );

  server.registerTool(
    "forward_message",
    {
      title: "Forward a message",
      description:
        "Forwards a message to someone else. The original travels along as an attachment and " +
        "is quoted in the body, so nothing is lost. Add a note to explain why you are " +
        "forwarding it. This sends immediately, so confirm with the user first.",
      inputSchema: {
        account,
        message_id: z.string().min(1).describe("The message to forward."),
        to: z.string().min(1).describe("Recipient(s), comma separated."),
        note: z.string().optional().describe("Text placed above the forwarded message."),
        cc: z.string().optional().describe("Cc recipients, comma separated."),
        bcc: z.string().optional().describe("Bcc recipients, comma separated."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ account: alias, message_id, to, note, cc, bcc }) =>
      guard("forward_message", context.user, async () => {
        const { account: resolved, provider } = resolveAccount(context, alias);
        const result = await provider.forward(resolved, message_id, to, { note, cc, bcc });

        return [
          `Forwarded from "${alias}" to ${to}.`,
          `Message-ID: ${result.messageId}`,
          ...result.notes,
        ]
          .filter(Boolean)
          .join("\n");
      }),
  );
}

export function registerFolderTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "list_folders",
    {
      title: "List folders",
      description:
        "Lists the folders in a mailbox, with the special ones marked (Sent, Trash, Archive, " +
        "Junk). On Gmail these are labels. Use a path from here as the target for " +
        "move_messages.",
      inputSchema: { account },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ account: alias }) =>
      guard("list_folders", context.user, async () => {
        const { account: resolved, provider } = resolveAccount(context, alias);
        return formatFolders(alias, await provider.listFolders(resolved));
      }),
  );

  server.registerTool(
    "create_folder",
    {
      title: "Create a folder or label",
      description:
        "Creates a new folder. Nesting works with a separator the server understands, " +
        'usually a slash: "Projects/2026". On Gmail this creates a label.',
      inputSchema: {
        account,
        path: z.string().min(1).describe('Name or path of the new folder, e.g. "Projects/2026".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ account: alias, path }) =>
      guard("create_folder", context.user, async () => {
        const { account: resolved, provider } = resolveAccount(context, alias);
        return `Created folder "${await provider.createFolder(resolved, path)}".`;
      }),
  );

  server.registerTool(
    "rename_folder",
    {
      title: "Rename a folder or label",
      description:
        "Renames a folder, keeping its messages. Special folders such as Sent and Trash " +
        "cannot be renamed.",
      inputSchema: {
        account,
        path: z.string().min(1).describe("The folder to rename, from list_folders."),
        new_path: z.string().min(1).describe("The new name or path."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ account: alias, path, new_path }) =>
      guard("rename_folder", context.user, async () => {
        const { account: resolved, provider } = resolveAccount(context, alias);
        return `Renamed to "${await provider.renameFolder(resolved, path, new_path)}".`;
      }),
  );

  server.registerTool(
    "delete_folder",
    {
      title: "Delete a folder or label",
      description:
        "Deletes a folder. On most servers this also deletes the messages still in it, so " +
        "move anything worth keeping first. Special folders such as Sent and Trash are " +
        "refused. On Gmail the label is removed, which does not delete the messages.",
      inputSchema: {
        account,
        path: z.string().min(1).describe("The folder to delete, from list_folders."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ account: alias, path }) =>
      guard("delete_folder", context.user, async () => {
        const { account: resolved, provider } = resolveAccount(context, alias);
        await provider.deleteFolder(resolved, path);
        return `Deleted folder "${path}".`;
      }),
  );
}
