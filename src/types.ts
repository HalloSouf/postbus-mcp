export type ProviderId = "imap" | "gmail-api";

export interface User {
  id: string;
  label: string;
  createdAt: string;
  disabled: boolean;
}

interface MailAccountBase {
  id: string;
  userId: string;
  alias: string;
  email: string;
  displayName?: string;
  createdAt: string;
}

export interface ImapAccount extends MailAccountBase {
  provider: "imap";
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  /** Decrypted in memory; stored encrypted. */
  password: string;
}

export interface GmailApiAccount extends MailAccountBase {
  provider: "gmail-api";
  /** Decrypted in memory; stored encrypted. */
  refreshToken: string;
}

export type MailAccount = ImapAccount | GmailApiAccount;

export interface AccountInfo {
  alias: string;
  email: string;
  provider: ProviderId;
  displayName?: string;
  createdAt: string;
  server?: string;
}

/** Opaque ids: only meaningful within the account they came from. */
export interface MessageSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  hasAttachments: boolean;
  mailbox: string;
  labels?: string[];
}

export interface AttachmentInfo {
  filename: string;
  mimeType: string;
  size?: number;
}

export interface MessageDetail extends MessageSummary {
  cc?: string;
  bcc?: string;
  replyTo?: string;
  messageId?: string;
  /** Raw References header, so a reply can extend the chain. */
  references?: string;
  body: string;
  bodyFormat: "text" | "html";
  attachments: AttachmentInfo[];
}

/** Search results plus anything the provider could not honour verbatim. */
export interface SearchResult {
  messages: MessageSummary[];
  /** Query terms this provider dropped. Never swallow these silently. */
  notes: string[];
}

/** What was sent, plus anything that went sideways after it left. */
export interface FolderInfo {
  path: string;
  name: string;
  /** \Sent, \Trash, \Archive … when the server declares one. */
  specialUse?: string;
  /** Whether the folder can hold messages, or is only a parent. */
  selectable: boolean;
}

/** A colour by name, or an explicit pair from Gmail's palette. */
export interface LabelColorInput {
  color?: string;
  backgroundColor?: string;
  textColor?: string;
}

/** What a mark_messages call changes. */
export type FlagChange = "read" | "unread" | "star" | "unstar";

// Batch actions are partial by nature: a message may have moved between the
// search and the action. Report both halves instead of failing the whole call.
export interface BatchResult {
  done: string[];
  failed: Array<{ id: string; reason: string }>;
  notes: string[];
}

export interface ReplyOptions {
  /** Reply to everyone on the original, not just the sender. */
  all?: boolean;
  cc?: string;
  bcc?: string;
  html?: boolean;
}

export interface ForwardOptions {
  /** Text placed above the forwarded message. */
  note?: string;
  cc?: string;
  bcc?: string;
}

export interface SendResult {
  /** The RFC 5322 Message-ID, which is what a reply threads against. */
  messageId: string;
  notes: string[];
}

/** A draft that was filed in the mailbox. Nothing has been sent. */
export interface DraftResult {
  /** Usable with get_message. Absent when the server reports no uid for the append. */
  id?: string;
  messageId: string;
  /** Where the draft was filed, so the user knows where to open it. */
  folder: string;
  notes: string[];
}

/** An outgoing attachment. */
export interface Attachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendOptions {
  cc?: string;
  bcc?: string;
  replyTo?: string;
  html?: boolean;
  /** Message-ID of the message being answered, so clients thread the reply. */
  inReplyTo?: string;
  references?: string;
  /** Only used internally, by forward. Not exposed as a tool argument. */
  attachments?: Attachment[];
}

// Providers receive a fully resolved account. Alias lookup happens in the tool
// layer, so a provider can never reach outside the session's user.
export interface MailProvider<A extends MailAccount = MailAccount> {
  readonly id: ProviderId;

  verify(account: A): Promise<void>;

  search(account: A, query: string, maxResults: number): Promise<SearchResult>;

  getMessage(account: A, messageId: string): Promise<MessageDetail>;

  getThread(account: A, threadId: string): Promise<MessageDetail[]>;

  send(
    account: A,
    to: string,
    subject: string,
    body: string,
    options?: SendOptions,
  ): Promise<SendResult>;

  reply(account: A, messageId: string, body: string, options?: ReplyOptions): Promise<SendResult>;

  createDraft(
    account: A,
    to: string,
    subject: string,
    body: string,
    options?: SendOptions,
  ): Promise<DraftResult>;

  createReplyDraft(
    account: A,
    messageId: string,
    body: string,
    options?: ReplyOptions,
  ): Promise<DraftResult>;

  forward(account: A, messageId: string, to: string, options?: ForwardOptions): Promise<SendResult>;

  listFolders(account: A): Promise<FolderInfo[]>;

  createFolder(account: A, path: string): Promise<string>;

  renameFolder(account: A, path: string, newPath: string): Promise<string>;

  deleteFolder(account: A, path: string): Promise<void>;

  moveMessages(account: A, messageIds: string[], target: string): Promise<BatchResult>;

  archiveMessages(account: A, messageIds: string[]): Promise<BatchResult>;

  trashMessages(account: A, messageIds: string[]): Promise<BatchResult>;

  markMessages(account: A, messageIds: string[], change: FlagChange): Promise<BatchResult>;

  labelMessages(
    account: A,
    messageIds: string[],
    add: string[],
    remove: string[],
  ): Promise<BatchResult>;

  setLabelColor(account: A, label: string, color: LabelColorInput): Promise<string>;
}

/**
 * What kind of problem this is. The tool layer turns it into advice for the
 * model ("retry" vs "call list_accounts" vs "tell the operator").
 */
export type ErrorKind =
  "not_found" | "invalid_input" | "auth" | "transient" | "upstream" | "config" | "internal";

export class PostbusError extends Error {
  readonly kind: ErrorKind;

  constructor(
    message: string,
    readonly hint?: string,
    kind: ErrorKind = "invalid_input",
  ) {
    super(message);
    this.name = "PostbusError";
    this.kind = kind;
  }
}
