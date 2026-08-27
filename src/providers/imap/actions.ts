import type { ListResponse } from "imapflow";
import {
  forgetMailboxes,
  listMailboxes,
  resolveMailbox,
  translateImapError,
  withImap,
  type ImapContext,
} from "./connection.js";
import { decodeMessageId } from "./ids.js";
import {
  PostbusError,
  type BatchResult,
  type FlagChange,
  type FolderInfo,
  type ImapAccount,
} from "../../types.js";

function assertMessageIds(messageIds: string[]): void {
  if (messageIds.length === 0) {
    throw new PostbusError("No message ids given.", "Pass at least one id from search_emails.");
  }
}

interface MessageGroup {
  mailbox: string;
  uidValidity: string;
  entries: Array<{ id: string; uid: number }>;
}

// Ids carry their own mailbox, so one call can span folders. Group first and
// open each mailbox once instead of reselecting per message.
function groupByMailbox(messageIds: string[]): {
  groups: MessageGroup[];
  failed: BatchResult["failed"];
} {
  const groups = new Map<string, MessageGroup>();
  const failed: BatchResult["failed"] = [];

  for (const id of messageIds) {
    try {
      const ref = decodeMessageId(id);
      const key = `${ref.mailbox} ${ref.uidValidity}`;
      const group = groups.get(key) ?? {
        mailbox: ref.mailbox,
        uidValidity: ref.uidValidity,
        entries: [],
      };

      group.entries.push({ id, uid: ref.uid });
      groups.set(key, group);
    } catch (error) {
      failed.push({ id, reason: (error as Error).message });
    }
  }

  return { groups: [...groups.values()], failed };
}

/** Runs one operation per mailbox and reports what worked and what did not. */
export async function actOnMessages(
  account: ImapAccount,
  messageIds: string[],
  action: (context: ImapContext, group: MessageGroup, uids: number[]) => Promise<void>,
): Promise<BatchResult> {
  assertMessageIds(messageIds);

  const { groups, failed } = groupByMailbox(messageIds);
  const done: string[] = [];
  const notes: string[] = [];

  await withImap(account, async (context) => {
    for (const group of groups) {
      const lock = await context.client.getMailboxLock(group.mailbox);

      try {
        const mailbox = context.client.mailbox;

        // A changed UIDVALIDITY means these uids point at other messages now.
        if (mailbox && String(mailbox.uidValidity) !== group.uidValidity) {
          for (const entry of group.entries) {
            failed.push({ id: entry.id, reason: "id expired, search again" });
          }
          continue;
        }

        await action(
          context,
          group,
          group.entries.map((entry) => entry.uid),
        );
        done.push(...group.entries.map((entry) => entry.id));
      } catch (error) {
        const reason = translateImapError(error).message;
        for (const entry of group.entries) failed.push({ id: entry.id, reason });
      } finally {
        lock.release();
      }
    }
  });

  return { done, failed, notes };
}

export async function moveMessages(
  account: ImapAccount,
  messageIds: string[],
  target: string,
): Promise<BatchResult> {
  assertMessageIds(messageIds);

  // Resolved up front: a missing folder is one problem with the call, not a
  // separate failure per message with the hint flattened out of it.
  const path = await withImap(account, (context) => requireFolder(account.id, context, target));

  const result = await actOnMessages(account, messageIds, async (context, group, uids) => {
    if (path === group.mailbox) return;
    await context.client.messageMove(uids, path, { uid: true });
  });

  result.notes.push(`Moved to "${path}".`);
  return result;
}

export function archiveMessages(account: ImapAccount, messageIds: string[]): Promise<BatchResult> {
  return moveToSpecial(account, messageIds, "archive");
}

export function trashMessages(account: ImapAccount, messageIds: string[]): Promise<BatchResult> {
  return moveToSpecial(account, messageIds, "trash");
}

async function moveToSpecial(
  account: ImapAccount,
  messageIds: string[],
  kind: "archive" | "trash",
): Promise<BatchResult> {
  assertMessageIds(messageIds);

  const path = await withImap(account, async (context) => {
    // Gmail archives by moving out of the inbox into "all mail"; every other
    // server has a real Archive folder.
    const hint = kind === "archive" && context.gmail ? "all" : kind;
    const resolved = await resolveMailbox(account.id, context, hint);
    if (resolved) return resolved;

    const folders = (await listMailboxes(account.id, context)).map((box) => box.path);
    throw new PostbusError(
      `This mailbox has no ${kind} folder.`,
      `Use move_messages with one of: ${folders.slice(0, 15).join(", ")}.`,
      "not_found",
    );
  });

  const result = await actOnMessages(account, messageIds, async (context, group, uids) => {
    if (path === group.mailbox) return;
    await context.client.messageMove(uids, path, { uid: true });
  });

  result.notes.push(`Moved to "${path}".`);
  return result;
}

const FLAGS: Record<FlagChange, { flag: string; add: boolean }> = {
  read: { flag: "\\Seen", add: true },
  unread: { flag: "\\Seen", add: false },
  star: { flag: "\\Flagged", add: true },
  unstar: { flag: "\\Flagged", add: false },
};

export async function markMessages(
  account: ImapAccount,
  messageIds: string[],
  change: FlagChange,
): Promise<BatchResult> {
  const { flag, add } = FLAGS[change];

  const result = await actOnMessages(account, messageIds, async (context, _group, uids) => {
    if (add) {
      await context.client.messageFlagsAdd(uids, [flag], { uid: true });
    } else {
      await context.client.messageFlagsRemove(uids, [flag], { uid: true });
    }
  });

  result.notes.push(`Marked as ${change}.`);
  return result;
}

export async function labelMessages(
  account: ImapAccount,
  messageIds: string[],
  add: string[],
  remove: string[],
): Promise<BatchResult> {
  if (add.length === 0 && remove.length === 0) {
    throw new PostbusError("Nothing to add or remove.", "Pass at least one label.");
  }

  assertMessageIds(messageIds);

  // Whether the server does labels at all is one answer for the whole call.
  await withImap(account, async (context) => {
    if (context.gmail) return;

    throw new PostbusError(
      "This server has folders, not labels.",
      "Only Gmail supports labels. Use move_messages to put a message in a folder, " +
        "or create_folder to make a new one.",
      "invalid_input",
    );
  });

  const result = await actOnMessages(account, messageIds, async (context, _group, uids) => {
    if (add.length > 0) {
      await context.client.messageFlagsAdd(uids, add, { uid: true, useLabels: true });
    }
    if (remove.length > 0) {
      await context.client.messageFlagsRemove(uids, remove, { uid: true, useLabels: true });
    }
  });

  if (add.length > 0) result.notes.push(`Added: ${add.join(", ")}.`);
  if (remove.length > 0) result.notes.push(`Removed: ${remove.join(", ")}.`);
  return result;
}

export function listFolders(account: ImapAccount): Promise<FolderInfo[]> {
  return withImap(account, async (context) => {
    const mailboxes = await listMailboxes(account.id, context);
    return mailboxes.map(toFolderInfo).sort((a, b) => a.path.localeCompare(b.path));
  });
}

export function createFolder(account: ImapAccount, path: string): Promise<string> {
  return withImap(account, async (context) => {
    const created = await context.client.mailboxCreate(path);
    forgetMailboxes(account.id);
    return created.path;
  });
}

export function renameFolder(account: ImapAccount, path: string, newPath: string): Promise<string> {
  return withImap(account, async (context) => {
    const resolved = await requireFolder(account.id, context, path);
    const renamed = await context.client.mailboxRename(resolved, newPath);
    forgetMailboxes(account.id);
    return renamed.newPath;
  });
}

export async function deleteFolder(account: ImapAccount, path: string): Promise<void> {
  await withImap(account, async (context) => {
    const resolved = await requireFolder(account.id, context, path);
    const mailboxes = await listMailboxes(account.id, context);
    const folder = mailboxes.find((box) => box.path === resolved);

    // Deleting Sent or Trash loses mail in a way nobody asked for.
    if (folder?.specialUse) {
      throw new PostbusError(
        `"${resolved}" is a special folder (${folder.specialUse}) and will not be deleted.`,
        "Move the messages you want gone instead.",
        "invalid_input",
      );
    }

    await context.client.mailboxDelete(resolved);
    forgetMailboxes(account.id);
  });
}

/** Accepts a full path, a folder name, or a hint like "sent". */
async function requireFolder(
  accountId: string,
  context: ImapContext,
  wanted: string,
): Promise<string> {
  const resolved = await resolveMailbox(accountId, context, wanted);
  if (resolved) return resolved;

  const folders = (await listMailboxes(accountId, context)).map((box) => box.path);
  throw new PostbusError(
    `This mailbox has no folder called "${wanted}".`,
    `Available: ${folders.slice(0, 20).join(", ")}. Use list_folders for the full list.`,
    "not_found",
  );
}

function toFolderInfo(box: ListResponse): FolderInfo {
  return {
    path: box.path,
    name: box.name,
    specialUse: box.specialUse,
    selectable: !box.flags?.has("\\Noselect"),
  };
}
