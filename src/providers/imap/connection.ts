import { ImapFlow, type ListResponse } from "imapflow";
import { MAIL_TIMEOUT_MS } from "../../config.js";
import { isLoopbackHost } from "../../net.js";
import { PostbusError, type ImapAccount } from "../../types.js";
import type { MailboxHint } from "./query.js";

// IMAP is stateful (one selected mailbox at a time), so every account gets at
// most one connection and one operation at a time. Sessions usually do several
// calls in a row, so the connection stays warm briefly instead of reconnecting.
const IDLE_TTL_MS = 60_000;

export interface ImapContext {
  client: ImapFlow;
  // Capabilities that decide how we search and how we thread.
  gmail: boolean;
  objectId: boolean;
  serverThreads: boolean;
}

interface PooledConnection {
  context: ImapContext;
  timer: NodeJS.Timeout;
  mailboxes?: ListResponse[];
}

const pool = new Map<string, PooledConnection>();

// Kept out of the pool so the very first connect is serialized too.
const queues = new Map<string, Promise<unknown>>();

export async function withImap<T>(
  account: ImapAccount,
  fn: (context: ImapContext) => Promise<T>,
): Promise<T> {
  const previous = queues.get(account.id) ?? Promise.resolve();

  const run = previous.then(
    () => execute(account, fn),
    () => execute(account, fn),
  );

  const tail = run.catch(() => undefined);
  queues.set(account.id, tail);
  void tail.then(() => {
    if (queues.get(account.id) === tail) queues.delete(account.id);
  });

  return run;
}

async function execute<T>(
  account: ImapAccount,
  fn: (context: ImapContext) => Promise<T>,
): Promise<T> {
  const connection = await acquire(account);

  try {
    return await fn(connection.context);
  } catch (error) {
    // Drop a broken connection so the next call reconnects.
    if (!connection.context.client.usable) release(account.id);
    throw translateImapError(error);
  } finally {
    touch(account.id);
  }
}

async function acquire(account: ImapAccount): Promise<PooledConnection> {
  const existing = pool.get(account.id);
  if (existing?.context.client.usable) return existing;
  if (existing) release(account.id);

  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    ...imapTlsOptions(account),
    auth: { user: account.username, pass: account.password },
    logger: false,
    disableAutoIdle: true,
    socketTimeout: MAIL_TIMEOUT_MS,
    greetingTimeout: MAIL_TIMEOUT_MS,
    connectionTimeout: MAIL_TIMEOUT_MS,
    clientInfo: { name: "postbus-mcp" },
  });

  client.on("error", () => release(account.id));

  try {
    await client.connect();
  } catch (error) {
    throw translateImapError(error);
  }

  const connection: PooledConnection = {
    context: {
      client,
      gmail: client.capabilities.has("X-GM-EXT-1"),
      objectId: client.capabilities.has("OBJECTID"),
      serverThreads: client.capabilities.has("X-GM-EXT-1") || client.capabilities.has("OBJECTID"),
    },
    timer: setTimeout(() => release(account.id), IDLE_TTL_MS),
  };
  connection.timer.unref?.();

  pool.set(account.id, connection);
  return connection;
}

function touch(accountId: string): void {
  const connection = pool.get(accountId);
  if (!connection) return;

  clearTimeout(connection.timer);
  connection.timer = setTimeout(() => release(accountId), IDLE_TTL_MS);
  connection.timer.unref?.();
}

/**
 * On a plain port imapflow upgrades with STARTTLS only when the server offers
 * it, and continues in the clear otherwise — an attacker who strips the
 * capability gets the app password. Demand the upgrade instead, except on a
 * local bridge where there is no network to intercept.
 */
export function imapTlsOptions(account: ImapAccount): { doSTARTTLS?: true } {
  if (account.imapSecure || isLoopbackHost(account.imapHost)) return {};
  return { doSTARTTLS: true };
}

export function release(accountId: string): void {
  const connection = pool.get(accountId);
  if (!connection) return;

  pool.delete(accountId);
  clearTimeout(connection.timer);
  void connection.context.client.logout().catch(() => connection.context.client.close());
}

export function closeAllConnections(): void {
  for (const accountId of [...pool.keys()]) release(accountId);
}

export async function listMailboxes(
  accountId: string,
  context: ImapContext,
): Promise<ListResponse[]> {
  const connection = pool.get(accountId);
  if (connection?.mailboxes) return connection.mailboxes;

  const mailboxes = await context.client.list();
  if (connection) connection.mailboxes = mailboxes;
  return mailboxes;
}

const SPECIAL_USE: Record<MailboxHint, string | undefined> = {
  inbox: undefined,
  sent: "\\Sent",
  drafts: "\\Drafts",
  archive: "\\Archive",
  all: "\\All",
  trash: "\\Trash",
  junk: "\\Junk",
};

// Servers name these folders anything they like ("[Gmail]/Sent Mail", "Sent
// Items"), so go by SPECIAL-USE first and fall back to the name.
export async function resolveMailbox(
  accountId: string,
  context: ImapContext,
  hint: MailboxHint | string,
): Promise<string | undefined> {
  const lower = hint.toLowerCase();
  if (lower === "inbox") return "INBOX";

  const mailboxes = await listMailboxes(accountId, context);
  const special = SPECIAL_USE[lower as MailboxHint];

  if (special) {
    const bySpecialUse = mailboxes.find((box) => box.specialUse === special);
    if (bySpecialUse) return bySpecialUse.path;
  }

  const byName = mailboxes.find(
    (box) => box.path.toLowerCase() === lower || box.name.toLowerCase() === lower,
  );

  return byName?.path;
}

// Gmail's "all mail" folder covers a whole thread; elsewhere a conversation is
// spread over Inbox, Sent and Archive.
export async function threadMailboxes(accountId: string, context: ImapContext): Promise<string[]> {
  const all = await resolveMailbox(accountId, context, "all");
  if (all) return [all];

  const candidates = await Promise.all(
    (["inbox", "sent", "archive"] as const).map((hint) => resolveMailbox(accountId, context, hint)),
  );

  return [...new Set(candidates.filter((path): path is string => Boolean(path)))];
}

export function translateImapError(error: unknown): Error {
  const err = error as { message?: string; authenticationFailed?: boolean; code?: string };
  const message = err?.message ?? String(error);

  if (err?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials/i.test(message)) {
    return new PostbusError(
      "The IMAP server rejected these credentials.",
      "Use an app password, not your normal password. For Gmail: turn on 2FA and create one at " +
        "https://myaccount.google.com/apppasswords. Still failing? Remove the mailbox and add it " +
        "again with add_mail_account.",
    );
  }

  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return new PostbusError(
      "The IMAP server cannot be found (DNS error).",
      "Check the hostname you passed to add_mail_account.",
    );
  }

  if (/wrong version number|SSL routines|ssl3_get_record/i.test(message)) {
    return new PostbusError(
      "TLS mismatch on the IMAP port.",
      "Port 993 is TLS from the first byte, port 143 starts plain and upgrades with STARTTLS. " +
        "If the port is right, pass imap_secure explicitly to add_mail_account.",
    );
  }

  if (/ECONNREFUSED|ETIMEDOUT|Socket timeout/i.test(message)) {
    return new PostbusError(
      "Could not connect to the IMAP server.",
      "Check host and port (usually 993 with TLS).",
    );
  }

  if (error instanceof PostbusError) return error;
  return new PostbusError(`IMAP error: ${message}`);
}
