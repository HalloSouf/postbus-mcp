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
export interface SendResult {
  /** The RFC 5322 Message-ID, which is what a reply threads against. */
  messageId: string;
  notes: string[];
}

export interface SendOptions {
  cc?: string;
  bcc?: string;
  replyTo?: string;
  html?: boolean;
  /** Message-ID of the message being answered, so clients thread the reply. */
  inReplyTo?: string;
  references?: string;
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
