import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type MimeNode from "nodemailer/lib/mime-node/index.js";
import { MAIL_TIMEOUT_MS } from "../../config.js";
import { isLoopbackHost } from "../../net.js";
import { PostbusError, type ImapAccount, type SendOptions } from "../../types.js";

function createTransport(account: ImapAccount) {
  return nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    // Port 465 is TLS from the first byte; 587 starts plain and does STARTTLS.
    secure: account.smtpSecure,
    // Without this nodemailer stays in the clear when a server does not
    // advertise STARTTLS, which is exactly what a downgrade attack arranges.
    // The Outlook and iCloud presets both use port 587, so this is the normal
    // path, not an edge case. A local bridge has no network to intercept.
    requireTLS: !account.smtpSecure && !isLoopbackHost(account.smtpHost),
    auth: { user: account.username, pass: account.password },
    connectionTimeout: MAIL_TIMEOUT_MS,
    greetingTimeout: MAIL_TIMEOUT_MS,
    socketTimeout: MAIL_TIMEOUT_MS,
  });
}

export async function verifySmtp(account: ImapAccount): Promise<void> {
  const transport = createTransport(account);
  try {
    await transport.verify();
  } catch (error) {
    throw translateSmtpError(error);
  } finally {
    transport.close();
  }
}

export interface ComposedMail {
  messageId: string;
  raw: Buffer;
  envelope: MimeNode.Envelope;
}

// Composed once, so the copy in Sent is byte-identical to what went out.
export async function composeMail(
  account: ImapAccount,
  to: string,
  subject: string,
  body: string,
  options: SendOptions = {},
): Promise<ComposedMail> {
  const domain = account.email.split("@")[1] || "postbus-mcp.local";
  const messageId = `<${randomUUID()}@${domain}>`;

  const composer = new MailComposer({
    from: account.displayName
      ? { name: account.displayName, address: account.email }
      : account.email,
    to,
    cc: options.cc,
    bcc: options.bcc,
    replyTo: options.replyTo,
    subject,
    messageId,
    ...(options.html ? { html: body } : { text: body }),
  });

  const node = composer.compile();
  // Bcc belongs in the envelope, not in the headers of the message itself.
  node.keepBcc = false;

  return { messageId, raw: await node.build(), envelope: node.getEnvelope() };
}

export async function sendComposed(account: ImapAccount, mail: ComposedMail): Promise<void> {
  const transport = createTransport(account);

  try {
    await transport.sendMail({ envelope: mail.envelope, raw: mail.raw });
  } catch (error) {
    throw translateSmtpError(error);
  } finally {
    transport.close();
  }
}

function translateSmtpError(error: unknown): Error {
  // First, not last: see translateImapError.
  if (error instanceof PostbusError) return error;

  const err = error as { message?: string; code?: string; responseCode?: number };
  const message = err?.message ?? String(error);

  if (err?.code === "EAUTH" || err?.responseCode === 535) {
    return new PostbusError(
      "The SMTP server rejected these credentials.",
      "Use the same app password as for IMAP. For Gmail, port 465 (TLS) or 587 (STARTTLS) both work.",
      "auth",
    );
  }

  if (/wrong version number|SSL routines|ssl3_get_record/i.test(message)) {
    return new PostbusError(
      "TLS mismatch on the SMTP port.",
      "Port 465 is TLS from the first byte, port 587 starts plain and upgrades with STARTTLS. " +
        "If the port is right, pass smtp_secure explicitly to add_mail_account.",
      "upstream",
    );
  }

  if (err?.code === "ESOCKET" || err?.code === "ECONNECTION" || err?.code === "ETIMEDOUT") {
    return new PostbusError(
      "Could not connect to the SMTP server.",
      "Check host and port. Note that 465 needs TLS and 587 does not (it uses STARTTLS).",
      "transient",
    );
  }

  if (err?.responseCode && err.responseCode >= 500) {
    return new PostbusError(
      `The SMTP server refused the message: ${message}`,
      undefined,
      "upstream",
    );
  }

  return new PostbusError(`SMTP error: ${message}`, undefined, "upstream");
}
