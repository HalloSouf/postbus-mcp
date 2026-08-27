import { PostbusError, type BatchResult, type FlagChange, type FolderInfo } from "../../types.js";

/** A Gmail label as the API returns it. */
export interface GmailLabel {
  id?: string | null;
  name?: string | null;
  type?: string | null;
}

// Gmail has no folders, only labels, and the tool layer talks folders. Map the
// system labels onto the names people recognise and pass the rest through.
const SYSTEM_FOLDERS: Record<string, string> = {
  INBOX: "\\Inbox",
  SENT: "\\Sent",
  DRAFT: "\\Drafts",
  TRASH: "\\Trash",
  SPAM: "\\Junk",
  STARRED: "\\Flagged",
};

export function toFolderInfo(label: GmailLabel): FolderInfo {
  const name = label.name ?? label.id ?? "";

  return {
    path: name,
    name: name.split("/").pop() ?? name,
    specialUse: SYSTEM_FOLDERS[label.id ?? ""],
    selectable: true,
  };
}

/** Which labels a mark_messages change adds and removes. */
export function labelChangeFor(change: FlagChange): { add: string[]; remove: string[] } {
  switch (change) {
    case "read":
      return { add: [], remove: ["UNREAD"] };
    case "unread":
      return { add: ["UNREAD"], remove: [] };
    case "star":
      return { add: ["STARRED"], remove: [] };
    case "unstar":
      return { add: [], remove: ["STARRED"] };
  }
}

/**
 * Turns label names into the ids the API wants. System labels are matched
 * case-insensitively so "inbox" and "INBOX" both land on the same one.
 */
export function resolveLabelIds(wanted: string[], labels: GmailLabel[]): string[] {
  return wanted.map((entry) => {
    const trimmed = entry.trim();
    const match = labels.find(
      (label) =>
        label.name?.toLowerCase() === trimmed.toLowerCase() ||
        label.id?.toLowerCase() === trimmed.toLowerCase(),
    );

    if (!match?.id) {
      const known = labels
        .map((label) => label.name)
        .filter(Boolean)
        .slice(0, 20);

      throw new PostbusError(
        `This mailbox has no label called "${entry}".`,
        `Available: ${known.join(", ")}. Use create_folder to make a new one.`,
        "not_found",
      );
    }

    return match.id;
  });
}

/** Gmail refuses to delete or rename its own labels, and so do we. */
export function assertNotSystemLabel(label: GmailLabel): void {
  if (label.type !== "system") return;

  throw new PostbusError(
    `"${label.name}" is a system label and cannot be changed.`,
    "Only labels you created yourself can be renamed or deleted.",
    "invalid_input",
  );
}

/** Every id succeeded, which is what the batch endpoints report. */
export function allDone(messageIds: string[], notes: string[]): BatchResult {
  return { done: [...messageIds], failed: [], notes };
}
