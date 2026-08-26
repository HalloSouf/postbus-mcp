import { describe, expect, it } from "vitest";
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
