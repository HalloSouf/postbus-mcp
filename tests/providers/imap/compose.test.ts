import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { composeMail } from "../../../src/providers/imap/smtp.js";
import type { ImapAccount } from "../../../src/types.js";

const ACCOUNT: ImapAccount = {
  id: "acc1",
  userId: "user1",
  alias: "work",
  email: "souf@postbus.test",
  displayName: "Souf",
  createdAt: "2026-08-26T00:00:00.000Z",
  provider: "imap",
  imapHost: "imap.postbus.test",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "smtp.postbus.test",
  smtpPort: 465,
  smtpSecure: true,
  username: "souf@postbus.test",
  password: "app-password",
};

// Headers only, so a word in the body cannot cause a false match.
function headersOf(raw: Buffer): string {
  return raw.toString("utf8").split("\r\n\r\n")[0] as string;
}

describe("composeMail", () => {
  it("puts sender and display name in the From header", async () => {
    const mail = await composeMail(ACCOUNT, "client@example.com", "Hello", "Text");

    expect(headersOf(mail.raw)).toContain("From: Souf <souf@postbus.test>");
    expect(mail.envelope.from).toBe("souf@postbus.test");
  });

  it("uses just the address when there is no display name", async () => {
    const mail = await composeMail(
      { ...ACCOUNT, displayName: undefined },
      "client@example.com",
      "Hello",
      "Text",
    );

    expect(headersOf(mail.raw)).toContain("From: souf@postbus.test");
  });

  it("generates a Message-ID on the account's domain", async () => {
    const mail = await composeMail(ACCOUNT, "client@example.com", "Hello", "Text");

    expect(mail.messageId).toMatch(/^<.+@postbus\.test>$/);
    expect(headersOf(mail.raw)).toContain(`Message-ID: ${mail.messageId}`);
  });

  it("gives every message its own Message-ID", async () => {
    const first = await composeMail(ACCOUNT, "a@x.nl", "Hello", "Text");
    const second = await composeMail(ACCOUNT, "a@x.nl", "Hello", "Text");

    expect(first.messageId).not.toBe(second.messageId);
  });

  it("keeps bcc out of the headers but in the envelope", async () => {
    const mail = await composeMail(ACCOUNT, "client@example.com", "Hello", "Text", {
      cc: "colleague@example.com",
      bcc: "hidden@example.com",
    });

    const headers = headersOf(mail.raw);
    expect(headers).toContain("Cc: colleague@example.com");
    expect(headers).not.toContain("hidden@example.com");
    expect(mail.envelope.to).toContain("hidden@example.com");
    expect(mail.envelope.to).toContain("colleague@example.com");
  });

  // A draft is never handed to SMTP, so the envelope cannot carry its Bcc.
  it("keeps bcc in the headers when the message is kept as a draft", async () => {
    const mail = await composeMail(
      ACCOUNT,
      "client@example.com",
      "Hello",
      "Text",
      { bcc: "hidden@example.com" },
      true,
    );

    expect(headersOf(mail.raw)).toContain("Bcc: hidden@example.com");
  });

  it("picks up every recipient from a comma-separated list", async () => {
    const mail = await composeMail(ACCOUNT, "een@x.nl, twee@x.nl", "Hello", "Text");

    expect(mail.envelope.to).toContain("een@x.nl");
    expect(mail.envelope.to).toContain("twee@x.nl");
  });

  it("sends plain text by default and HTML on request", async () => {
    const text = await composeMail(ACCOUNT, "a@x.nl", "Hello", "Just text");
    const html = await composeMail(ACCOUNT, "a@x.nl", "Hello", "<p>Formatted</p>", { html: true });

    expect(headersOf(text.raw)).toContain("text/plain");
    expect(headersOf(html.raw)).toContain("text/html");
  });

  it("encodes an accented subject per RFC 2047", async () => {
    const mail = await composeMail(ACCOUNT, "a@x.nl", "Invoice — €50 café", "Text");
    const headers = headersOf(mail.raw);

    expect(headers).toMatch(/Subject: =\?UTF-8\?/);
    expect(headers).not.toContain("café");
  });

  it("puts a different reply address in Reply-To", async () => {
    const mail = await composeMail(ACCOUNT, "a@x.nl", "Hello", "Text", {
      replyTo: "reply@example.com",
    });

    expect(headersOf(mail.raw)).toContain("Reply-To: reply@example.com");
  });

  it("keeps a body with accents and emoji intact", async () => {
    const body = "Hi café ☕, all good!";
    const mail = await composeMail(ACCOUNT, "a@x.nl", "Hello", body);

    const raw = mail.raw.toString("utf8");
    const encoded = raw.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    const decoded = raw.includes("base64")
      ? Buffer.from(encoded, "base64").toString("utf8")
      : Buffer.from(encoded.replace(/=\r\n/g, ""), "utf8")
          .toString("utf8")
          .replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));

    expect(Buffer.from(decoded, "binary").toString("utf8")).toContain("café");
  });
});

describe("threading a reply", () => {
  // Without these headers a reply arrives as a loose message that no mail
  // client hangs under the conversation, however the subject reads.
  it("sets In-Reply-To and References when answering", async () => {
    const mail = await composeMail(ACCOUNT, "client@example.com", "Re: Invoice", "Sure", {
      inReplyTo: "<parent@example.com>",
      references: "<parent@example.com>",
    });

    expect(headersOf(mail.raw)).toContain("In-Reply-To: <parent@example.com>");
    expect(headersOf(mail.raw)).toContain("References: <parent@example.com>");
  });

  it("leaves them out of a fresh message", async () => {
    const mail = await composeMail(ACCOUNT, "client@example.com", "Hello", "Text");

    expect(headersOf(mail.raw)).not.toContain("In-Reply-To");
    expect(headersOf(mail.raw)).not.toContain("References");
  });
});

describe("attachments", () => {
  const inner = Buffer.from("From: a@x.com\r\nSubject: Inner\r\n\r\nInner body\r\n", "utf8");

  // Without an explicit disposition nodemailer marks a message/rfc822 part
  // inline, and mailparser then reports zero attachments: a forward arrived
  // looking like it carried nothing.
  it("marks a forwarded original as a real attachment", async () => {
    const mail = await composeMail(ACCOUNT, "a@x.com", "Fwd: Inner", "FYI", {
      attachments: [{ filename: "Inner.eml", content: inner, contentType: "message/rfc822" }],
    });

    const parsed = await simpleParser(mail.raw);

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe("Inner.eml");
    expect(parsed.attachments[0]?.contentType).toBe("message/rfc822");
  });

  it("keeps the original readable inside the attachment", async () => {
    const mail = await composeMail(ACCOUNT, "a@x.com", "Fwd: Inner", "FYI", {
      attachments: [{ filename: "Inner.eml", content: inner, contentType: "message/rfc822" }],
    });

    const parsed = await simpleParser(mail.raw);
    expect(parsed.attachments[0]?.content.toString("utf8")).toContain("Inner body");
  });
});
