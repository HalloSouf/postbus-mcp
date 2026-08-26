import MailComposer from "nodemailer/lib/mail-composer/index.js";

export interface MimeAddress {
  name?: string | undefined;
  address: string;
}

export interface MimeMessage {
  from: MimeAddress;
  to: string;
  subject: string;
  body: string;
  cc?: string | undefined;
  bcc?: string | undefined;
  replyTo?: string | undefined;
  html?: boolean | undefined;
  inReplyTo?: string | undefined;
  references?: string | undefined;
}

// Composed by nodemailer, exactly like the IMAP/SMTP path: it parses addresses
// with quotes and commas correctly, folds long headers, encodes non-ASCII per
// RFC 2047 and strips CR/LF from every value. Hand-rolling this let a recipient
// containing "\r\nBcc: ..." inject its own headers.
export async function buildMimeMessage(message: MimeMessage): Promise<Buffer> {
  const composer = new MailComposer({
    from: message.from.name
      ? { name: message.from.name, address: message.from.address }
      : message.from.address,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    replyTo: message.replyTo,
    inReplyTo: message.inReplyTo,
    references: message.references,
    subject: message.subject,
    ...(message.html ? { html: message.body } : { text: message.body }),
  });

  const node = composer.compile();
  // Unlike SMTP there is no envelope here, so Bcc has to travel in the headers.
  // Gmail delivers to those recipients and drops the header itself.
  node.keepBcc = true;

  return node.build();
}

export function toBase64Url(value: Buffer): string {
  return value.toString("base64url");
}
