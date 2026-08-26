import { describe, expect, it } from "vitest";
import { buildMimeMessage, toBase64Url } from "../../../src/providers/gmail/mime.js";

const FROM = { name: "Souf", address: "souf@postbus.test" };

// Headers only, so a word in the body cannot cause a false match.
function headersOf(raw: Buffer): string {
  return raw.toString("utf8").split("\r\n\r\n")[0] as string;
}

// The names of the header fields actually present. A CR/LF that survives
// folding shows up here as an extra field; one folded into a value does not.
function fieldNames(headerBlock: string): string[] {
  return headerBlock
    .split("\r\n")
    .filter((line) => !/^[ \t]/.test(line))
    .map((line) => line.slice(0, line.indexOf(":")).trim().toLowerCase())
    .filter(Boolean);
}

async function build(message: Partial<Parameters<typeof buildMimeMessage>[0]> = {}) {
  return buildMimeMessage({
    from: FROM,
    to: "client@example.com",
    subject: "Hello",
    body: "Text",
    ...message,
  });
}

async function headers(message: Partial<Parameters<typeof buildMimeMessage>[0]> = {}) {
  return headersOf((await build(message)).raw);
}

describe("buildMimeMessage", () => {
  it("puts sender and display name in the From header", async () => {
    expect(await headers()).toContain("From: Souf <souf@postbus.test>");
  });

  it("uses just the address when there is no display name", async () => {
    expect(await headers({ from: { address: "souf@postbus.test" } })).toContain(
      "From: souf@postbus.test",
    );
  });

  // A recipient is attacker-controlled whenever the model takes it from an
  // incoming email, so CR/LF must never reach the header block.
  it("refuses to let a recipient inject its own headers", async () => {
    const result = await headers({ to: "victim@example.com\r\nBcc: attacker@evil.com" });

    expect(fieldNames(result)).not.toContain("bcc");
  });

  // The blank line is what ends the header block, so a recipient carrying one
  // could otherwise dictate the entire body.
  it("refuses to let a recipient end the header block early", async () => {
    const { raw } = await build({ to: "a@example.com\r\n\r\nINJECTED BODY\r\nX: " });
    const [headerBlock = "", ...rest] = raw.toString("utf8").split("\r\n\r\n");

    expect(rest.join("\r\n\r\n").trim()).toBe("Text");
    expect(fieldNames(headerBlock)).toEqual([
      "from",
      "to",
      "subject",
      "message-id",
      "content-transfer-encoding",
      "date",
      "mime-version",
      "content-type",
    ]);
  });

  it("refuses to let a subject inject its own headers", async () => {
    const result = await headers({ subject: "Hi\r\nBcc: attacker@evil.com" });

    expect(fieldNames(result)).not.toContain("bcc");
  });

  // "Doe, John" is one recipient, not two.
  it("keeps a quoted display name with a comma in one address", async () => {
    const result = await headers({ to: '"Doe, John" <john@example.com>' });

    expect(result).toContain("john@example.com");
    expect(result).not.toContain('"Doe, John <john@example.com>');
  });

  it("still splits genuinely separate recipients", async () => {
    const result = await headers({ to: "a@example.com, b@example.com" });

    expect(result).toContain("a@example.com");
    expect(result).toContain("b@example.com");
  });

  // RFC 2047 caps an encoded word at 75 characters; nodemailer folds for us.
  it("folds a long non-ASCII subject instead of emitting one huge word", async () => {
    const subject =
      "Factuur — betreft de maandelijkse afrekening van augustus voor café De Zwarte Ruiter";
    const result = await headers({ subject });

    for (const line of result.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
  });

  it("keeps Bcc in the headers, because Gmail has no envelope to carry it", async () => {
    const result = await headers({ bcc: "quiet@example.com" });

    expect(fieldNames(result)).toContain("bcc");
    expect(result).toContain("quiet@example.com");
  });

  it("threads a reply with In-Reply-To and References", async () => {
    const result = await headers({
      inReplyTo: "<parent@example.com>",
      references: "<root@example.com> <parent@example.com>",
    });

    expect(result).toContain("In-Reply-To: <parent@example.com>");
    expect(result).toContain("References: <root@example.com> <parent@example.com>");
  });

  it("encodes the message for the Gmail raw field", async () => {
    const { raw } = await build();

    expect(Buffer.from(toBase64Url(raw), "base64url").toString("utf8")).toBe(raw.toString("utf8"));
  });

  // Reported back to the caller, so a reply has something to thread against.
  it("reports the Message-ID it generated", async () => {
    const built = await build();

    expect(built.messageId).toMatch(/^<.+@postbus\.test>$/);
    expect(headersOf(built.raw)).toContain(`Message-ID: ${built.messageId}`);
  });
});
