import type { FetchMessageObject, MessageStructureObject } from "imapflow";
import { describe, expect, it } from "vitest";
import {
  determineThreadId,
  formatAddresses,
  hasAttachments,
  makeSnippet,
  makeSnippetFromSource,
  parseHeaderBuffer,
  toDetail,
  toSummary,
} from "../../../src/providers/imap/parse.js";
import { decodeThreadId } from "../../../src/providers/imap/ids.js";

const CONTEXT = { mailbox: "INBOX", uidValidity: "1787752052" };

function fetched(overrides: Partial<FetchMessageObject> = {}): FetchMessageObject {
  return {
    seq: 1,
    uid: 42,
    flags: new Set<string>(),
    internalDate: new Date("2026-08-20T09:00:00Z"),
    ...overrides,
  } as FetchMessageObject;
}

// A real message: text body, an attachment and a References chain.
const RAW_MESSAGE = Buffer.from(
  [
    "From: Client <client@example.com>",
    "To: Souf <souf@postbus.test>",
    "Cc: billing@example.com",
    "Subject: =?UTF-8?Q?March_invoice_=E2=82=AC?=",
    "Date: Thu, 20 Aug 2026 09:00:00 +0000",
    "Message-ID: <reply-1@example.com>",
    "In-Reply-To: <thread-root@example.com>",
    "References: <thread-root@example.com> <tussen@example.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="B1"',
    "",
    "--B1",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "Hi Souf,",
    "",
    "Here is the invoice for March.",
    "",
    "> Could you still send it?",
    "",
    "-- ",
    "Client Ltd",
    "--B1",
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0xLjQKJcfsj6IK",
    "--B1--",
    "",
  ].join("\r\n"),
  "utf8",
);

describe("parseHeaderBuffer", () => {
  it("unfolds continued header lines", () => {
    const buffer = Buffer.from(
      "References: <een@x.nl>\r\n <twee@x.nl>\r\nSubject: Hello\r\n",
      "utf8",
    );

    expect(parseHeaderBuffer(buffer).references).toBe("<een@x.nl> <twee@x.nl>");
    expect(parseHeaderBuffer(buffer).subject).toBe("Hello");
  });

  it("makes header names case-insensitive", () => {
    expect(parseHeaderBuffer(Buffer.from("MESSAGE-ID: <a@b>\r\n"))["message-id"]).toBe("<a@b>");
  });

  it("returns an empty object when there are no headers", () => {
    expect(parseHeaderBuffer(undefined)).toEqual({});
  });
});

describe("hasAttachments", () => {
  const attachment: MessageStructureObject = {
    part: "2",
    type: "application/pdf",
    disposition: "attachment",
  } as MessageStructureObject;

  const text: MessageStructureObject = { part: "1", type: "text/plain" } as MessageStructureObject;

  it("finds an attachment deep in a nested structure", () => {
    const tree = {
      type: "multipart/mixed",
      childNodes: [{ type: "multipart/alternative", childNodes: [text, attachment] }],
    } as MessageStructureObject;

    expect(hasAttachments(tree)).toBe(true);
  });

  it("does not mistake a plain text message for an attachment", () => {
    expect(hasAttachments(text)).toBe(false);
    expect(hasAttachments(undefined)).toBe(false);
  });

  it("also recognises a part that only carries a filename", () => {
    const named = { type: "image/png", parameters: { name: "logo.png" } } as MessageStructureObject;
    expect(hasAttachments(named)).toBe(true);
  });
});

describe("formatAddresses", () => {
  it("joins name and address, and leaves a bare address alone", () => {
    expect(formatAddresses([{ name: "Souf", address: "souf@x.nl" }])).toBe("Souf <souf@x.nl>");
    expect(formatAddresses([{ address: "souf@x.nl" }])).toBe("souf@x.nl");
  });

  it("separates multiple recipients with commas", () => {
    expect(formatAddresses([{ name: "A", address: "a@x.nl" }, { address: "b@x.nl" }])).toBe(
      "A <a@x.nl>, b@x.nl",
    );
  });

  it("falls back to an empty string instead of undefined", () => {
    expect(formatAddresses(undefined)).toBe("");
    expect(formatAddresses([])).toBe("");
  });
});

describe("determineThreadId", () => {
  it("uses the server's thread id when there is one", () => {
    const id = determineThreadId("1829384756", {}, "<eigen@x.nl>");
    expect(decodeThreadId(id)).toEqual({ kind: "server", id: "1829384756" });
  });

  it("takes the root of the References chain, not the last reply", () => {
    const id = determineThreadId(
      undefined,
      { references: "<wortel@x.nl> <tussen@x.nl>", "in-reply-to": "<tussen@x.nl>" },
      "<eigen@x.nl>",
    );

    expect(decodeThreadId(id)).toEqual({ kind: "references", rootMessageId: "<wortel@x.nl>" });
  });

  it("falls back to In-Reply-To when References is missing", () => {
    const id = determineThreadId(undefined, { "in-reply-to": "<wortel@x.nl>" }, "<eigen@x.nl>");
    expect(decodeThreadId(id)).toEqual({ kind: "references", rootMessageId: "<wortel@x.nl>" });
  });

  it("makes a message without a chain its own thread", () => {
    const id = determineThreadId(undefined, {}, "<eigen@x.nl>");
    expect(decodeThreadId(id)).toEqual({ kind: "references", rootMessageId: "<eigen@x.nl>" });
  });

  it("puts a message and its reply in the same thread", () => {
    const start = determineThreadId(undefined, {}, "<wortel@x.nl>");
    const reply = determineThreadId(undefined, { references: "<wortel@x.nl>" }, "<reply@x.nl>");

    expect(reply).toBe(start);
  });
});

describe("toSummary", () => {
  it("reads the envelope and marks unread mail", () => {
    const summary = toSummary(
      fetched({
        envelope: {
          date: new Date("2026-08-20T09:00:00Z"),
          subject: "March invoice",
          from: [{ name: "Client", address: "client@example.com" }],
          to: [{ address: "souf@postbus.test" }],
          messageId: "<reply-1@example.com>",
        },
      } as Partial<FetchMessageObject>),
      CONTEXT,
      "preview",
    );

    expect(summary.subject).toBe("March invoice");
    expect(summary.from).toBe("Client <client@example.com>");
    expect(summary.unread).toBe(true);
    expect(summary.mailbox).toBe("INBOX");
    expect(summary.id).toContain("INBOX");
  });

  it("sees a read message as read", () => {
    const summary = toSummary(fetched({ flags: new Set(["\\Seen"]) }), CONTEXT, "");
    expect(summary.unread).toBe(false);
  });

  it("makes up a subject when the header is missing", () => {
    expect(toSummary(fetched(), CONTEXT, "").subject).toBe("(no subject)");
  });
});

describe("toDetail", () => {
  it("takes a real MIME message apart", async () => {
    const detail = await toDetail(fetched(), CONTEXT, RAW_MESSAGE);

    expect(detail.subject).toBe("March invoice €");
    expect(detail.from).toContain("client@example.com");
    expect(detail.cc).toContain("billing@example.com");
    expect(detail.messageId).toBe("<reply-1@example.com>");
    expect(detail.bodyFormat).toBe("text");
    expect(detail.body).toContain("Here is the invoice for March.");
    expect(detail.date).toBe("2026-08-20T09:00:00.000Z");
  });

  it("carries attachments as metadata, without the content", async () => {
    const detail = await toDetail(fetched(), CONTEXT, RAW_MESSAGE);

    expect(detail.hasAttachments).toBe(true);
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0]?.filename).toBe("invoice.pdf");
    expect(detail.attachments[0]?.mimeType).toBe("application/pdf");
    expect(JSON.stringify(detail.attachments)).not.toContain("JVBERi");
  });

  it("threads on the root from References", async () => {
    const detail = await toDetail(fetched(), CONTEXT, RAW_MESSAGE);

    expect(decodeThreadId(detail.threadId)).toEqual({
      kind: "references",
      rootMessageId: "<thread-root@example.com>",
    });
  });

  it("turns an HTML-only message into readable text instead of HTML soup", async () => {
    const html = Buffer.from(
      [
        "From: a@x.nl",
        "To: b@x.nl",
        "Subject: HTML only",
        "MIME-Version: 1.0",
        'Content-Type: text/html; charset="UTF-8"',
        "",
        "<html><head><style>p{color:red}</style></head>",
        "<body><p>Hello <b>there</b></p><p>Regards</p></body></html>",
        "",
      ].join("\r\n"),
      "utf8",
    );

    const detail = await toDetail(fetched(), CONTEXT, html);

    expect(detail.body).toContain("Hello there");
    expect(detail.body).toContain("Regards");
    expect(detail.body).not.toContain("<b>");
    expect(detail.body).not.toContain("color:red");
    expect(detail.bodyFormat).toBe("text");
  });
});

describe("snippets", () => {
  it("leaves quotes and signature out of the preview", async () => {
    const snippet = await makeSnippetFromSource(RAW_MESSAGE);

    expect(snippet).toContain("Here is the invoice for March.");
    expect(snippet).not.toContain("Could you still send it?");
    expect(snippet).not.toContain("Client Ltd");
  });

  it("collapses whitespace and truncates long previews", () => {
    expect(makeSnippet("one\n\n  two\t\tthree")).toBe("one two three");

    const long = makeSnippet("x".repeat(500));
    expect(long.length).toBeLessThanOrEqual(181);
    expect(long.endsWith("…")).toBe(true);
  });

  it("does not trip over a truncated source (we only fetch 4 KB)", async () => {
    await expect(makeSnippetFromSource(RAW_MESSAGE.subarray(0, 200))).resolves.toBeTypeOf("string");
    await expect(makeSnippetFromSource(Buffer.alloc(0))).resolves.toBe("");
    await expect(makeSnippetFromSource(undefined)).resolves.toBe("");
  });
});
