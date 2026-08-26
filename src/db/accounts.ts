import { decryptSecret, encryptSecret } from "../crypto.js";
import { PostbusError, type AccountInfo, type MailAccount, type ProviderId } from "../types.js";
import { getDb } from "./index.js";
import { newId } from "./users.js";

interface AccountRow {
  id: string;
  user_id: string;
  alias: string;
  email: string;
  provider: string;
  display_name: string | null;
  imap_host: string | null;
  imap_port: number | null;
  imap_secure: number;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: number;
  username: string | null;
  encrypted_password: string;
  created_at: string;
}

const SELECT = `SELECT id, user_id, alias, email, provider, display_name,
                       imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
                       username, encrypted_password, created_at
                FROM mail_accounts`;

function toInfo(row: AccountRow): AccountInfo {
  return {
    alias: row.alias,
    email: row.email,
    provider: row.provider as ProviderId,
    displayName: row.display_name ?? undefined,
    createdAt: row.created_at,
    server:
      row.provider === "imap" && row.imap_host
        ? `${row.imap_host}:${row.imap_port ?? 993}`
        : "Gmail API",
  };
}

/**
 * What the stored secret is bound to. The row id never changes once written,
 * not even when a mailbox is relinked, so a blob stays readable in its own row
 * and nowhere else.
 */
function secretContext(userId: string, accountId: string): string {
  return `${userId}:${accountId}`;
}

// The only place secrets are decrypted.
function toAccount(row: AccountRow): MailAccount {
  const base = {
    id: row.id,
    userId: row.user_id,
    alias: row.alias,
    email: row.email,
    displayName: row.display_name ?? undefined,
    createdAt: row.created_at,
  };

  if (row.provider === "gmail-api") {
    return {
      ...base,
      provider: "gmail-api",
      refreshToken: decryptSecret(row.encrypted_password, secretContext(row.user_id, row.id)),
    };
  }

  if (!row.imap_host || !row.smtp_host) {
    throw new PostbusError(
      `Mailbox "${row.alias}" is missing IMAP/SMTP details in the database.`,
      "Remove it with remove_mail_account and add it again.",
      "config",
    );
  }

  return {
    ...base,
    provider: "imap",
    imapHost: row.imap_host,
    imapPort: row.imap_port ?? 993,
    imapSecure: row.imap_secure === 1,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port ?? 465,
    smtpSecure: row.smtp_secure === 1,
    username: row.username ?? row.email,
    password: decryptSecret(row.encrypted_password, secretContext(row.user_id, row.id)),
  };
}

export function listAccounts(userId: string): AccountInfo[] {
  return getDb()
    .prepare<[string], AccountRow>(`${SELECT} WHERE user_id = ? ORDER BY alias`)
    .all(userId)
    .map(toInfo);
}

// user_id is part of the query: someone else's alias simply does not exist here.
export function getAccount(userId: string, alias: string): MailAccount {
  const row = getDb()
    .prepare<[string, string], AccountRow>(`${SELECT} WHERE user_id = ? AND alias = ?`)
    .get(userId, alias.trim());

  if (!row) {
    const known = listAccounts(userId).map((a) => a.alias);
    throw new PostbusError(
      `Unknown mailbox "${alias}".`,
      known.length
        ? `Available aliases: ${known.join(", ")}.`
        : "No mailbox linked yet. Use add_mail_account.",
      "not_found",
    );
  }

  return toAccount(row);
}

export function accountExists(userId: string, alias: string): boolean {
  return (
    (getDb()
      .prepare<[string, string], { count: number }>(
        `SELECT COUNT(*) AS count FROM mail_accounts WHERE user_id = ? AND alias = ?`,
      )
      .get(userId, alias.trim())?.count ?? 0) > 0
  );
}

/** The saved mailbox plus its row id, which the caller needs to drop any
 * pooled connection still authenticated with the previous credentials. */
export interface SavedAccount extends AccountInfo {
  id: string;
}

// An upsert keeps the existing primary key, and the secret is bound to it, so
// a relink has to reuse that id rather than mint one the row will not carry.
function existingOrNewId(userId: string, alias: string): string {
  return findAccountId(userId, alias) ?? newId();
}

export interface NewImapAccount {
  userId: string;
  alias: string;
  email: string;
  displayName?: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  password: string;
}

export function saveImapAccount(input: NewImapAccount): SavedAccount {
  const id = existingOrNewId(input.userId, input.alias);
  const row: AccountRow = {
    id,
    user_id: input.userId,
    alias: input.alias.trim(),
    email: input.email.trim(),
    provider: "imap",
    display_name: input.displayName?.trim() || null,
    imap_host: input.imapHost,
    imap_port: input.imapPort,
    imap_secure: input.imapSecure ? 1 : 0,
    smtp_host: input.smtpHost,
    smtp_port: input.smtpPort,
    smtp_secure: input.smtpSecure ? 1 : 0,
    username: input.username,
    encrypted_password: encryptSecret(input.password, secretContext(input.userId, id)),
    created_at: new Date().toISOString(),
  };

  upsert(row);
  return { ...toInfo(row), id };
}

export interface NewGmailApiAccount {
  userId: string;
  alias: string;
  email: string;
  refreshToken: string;
}

export function saveGmailApiAccount(input: NewGmailApiAccount): SavedAccount {
  const id = existingOrNewId(input.userId, input.alias);
  const row: AccountRow = {
    id,
    user_id: input.userId,
    alias: input.alias.trim(),
    email: input.email.trim(),
    provider: "gmail-api",
    display_name: null,
    imap_host: null,
    imap_port: null,
    imap_secure: 1,
    smtp_host: null,
    smtp_port: null,
    smtp_secure: 1,
    username: null,
    encrypted_password: encryptSecret(input.refreshToken, secretContext(input.userId, id)),
    created_at: new Date().toISOString(),
  };

  upsert(row);
  return { ...toInfo(row), id };
}

// Delete by primary key. A DELETE ... RETURNING read with .get() removes every
// matching row but reports only the first, so the caller could not clean up
// after the ones it never heard about.
export function removeAccount(userId: string, alias: string): string | undefined {
  const id = findAccountId(userId, alias);
  if (!id) return undefined;

  getDb().prepare(`DELETE FROM mail_accounts WHERE id = ?`).run(id);
  return id;
}

export function findAccountId(userId: string, alias: string): string | undefined {
  return getDb()
    .prepare<[string, string], { id: string }>(
      `SELECT id FROM mail_accounts WHERE user_id = ? AND alias = ?`,
    )
    .get(userId, alias.trim())?.id;
}

function upsert(row: AccountRow): void {
  getDb()
    .prepare(
      `INSERT INTO mail_accounts (id, user_id, alias, email, provider, display_name,
                                  imap_host, imap_port, imap_secure,
                                  smtp_host, smtp_port, smtp_secure,
                                  username, encrypted_password, created_at)
       VALUES (@id, @user_id, @alias, @email, @provider, @display_name,
               @imap_host, @imap_port, @imap_secure,
               @smtp_host, @smtp_port, @smtp_secure,
               @username, @encrypted_password, @created_at)
       ON CONFLICT (user_id, alias) DO UPDATE SET
         email              = excluded.email,
         provider           = excluded.provider,
         display_name       = excluded.display_name,
         imap_host          = excluded.imap_host,
         imap_port          = excluded.imap_port,
         imap_secure        = excluded.imap_secure,
         smtp_host          = excluded.smtp_host,
         smtp_port          = excluded.smtp_port,
         smtp_secure        = excluded.smtp_secure,
         username           = excluded.username,
         encrypted_password = excluded.encrypted_password`,
    )
    .run(row);
}
