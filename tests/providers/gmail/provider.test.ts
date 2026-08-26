import { describe, expect, it } from "vitest";
import { extractBody, gmailFolder, toSummary } from "../../../src/providers/gmail/provider.js";

function part(mimeType: string, body: string, charset?: string) {
  return {
    mimeType,
    body: {
      data: Buffer.from(body, charset === "iso-8859-1" ? "latin1" : "utf8").toString("base64url"),
    },
    headers: charset
      ? [{ name: "Content-Type", value: `${mimeType}; charset="${charset}"` }]
      : undefined,
  };
}

describe("gmailFolder", () => {
  // Gmail has labels, not folders. Everything without a SENT label used to be
  // reported as INBOX, so archived mail looked like it was still waiting.
  it("names the folder a label actually implies", () => {
    expect(gmailFolder(["INBOX", "UNREAD"])).toBe("INBOX");
    expect(gmailFolder(["SENT"])).toBe("SENT");
    expect(gmailFolder(["DRAFT"])).toBe("DRAFTS");
    expect(gmailFolder(["TRASH"])).toBe("TRASH");
    expect(gmailFolder(["SPAM"])).toBe("SPAM");
  });

  it("calls archived mail archived instead of inbox", () => {
    expect(gmailFolder(["CATEGORY_PERSONAL"])).toBe("ARCHIVE");
    expect(gmailFolder([])).toBe("ARCHIVE");
  });
});

describe("extractBody", () => {
  it("prefers the plain text part", () => {
    const result = extractBody({
      mimeType: "multipart/alternative",
      parts: [part("text/plain", "Plain text"), part("text/html", "<p>Markup</p>")],
    });

    expect(result).toEqual({ body: "Plain text", bodyFormat: "text" });
  });

  // The IMAP provider runs everything through mailparser and hands back a few
  // readable lines; this one used to return the raw markup, so a truncation
  // limit was spent on <table style=...> instead of the message.
  it("reduces an html-only message to readable text", () => {
    const result = extractBody({
      mimeType: "text/html",
      parts: [part("text/html", "<style>p{color:red}</style><p>Hello <b>there</b></p>")],
    });

    expect(result.body).not.toContain("<");
    expect(result.body).toContain("Hello");
    expect(result.body).toContain("there");
    expect(result.body).not.toContain("color:red");
  });

  it("honours the charset the sender declared", () => {
    const result = extractBody({
      mimeType: "text/plain",
      parts: [part("text/plain", "café", "iso-8859-1")],
    });

    expect(result.body).toBe("café");
    expect(result.body).not.toContain("�");
  });

  it("still reads a message with no declared charset as utf-8", () => {
    const result = extractBody({
      mimeType: "text/plain",
      parts: [part("text/plain", "café")],
    });

    expect(result.body).toBe("café");
  });

  it("returns nothing for a message with no body", () => {
    expect(extractBody(undefined)).toEqual({ body: "", bodyFormat: "text" });
  });
});

describe("toSummary", () => {
  it("reads the headers Gmail returns as metadata", () => {
    const summary = toSummary({
      id: "abc",
      threadId: "thr",
      labelIds: ["INBOX", "UNREAD"],
      snippet: "Tom &amp; Jerry",
      internalDate: "1787752052000",
      payload: {
        headers: [
          { name: "From", value: "Client <client@example.com>" },
          { name: "Subject", value: "March invoice" },
          { name: "Date", value: "Thu, 20 Aug 2026 09:00:00 +0000" },
        ],
      },
    });

    expect(summary.id).toBe("abc");
    expect(summary.threadId).toBe("thr");
    expect(summary.from).toBe("Client <client@example.com>");
    expect(summary.unread).toBe(true);
    expect(summary.mailbox).toBe("INBOX");
    expect(summary.snippet).toBe("Tom & Jerry");
    expect(summary.date).toBe("2026-08-20T09:00:00.000Z");
  });

  it("falls back to a readable subject when there is none", () => {
    expect(toSummary({ id: "a", payload: { headers: [] } }).subject).toBe("(no subject)");
  });
});
