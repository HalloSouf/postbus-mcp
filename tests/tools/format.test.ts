import { describe, expect, it } from "vitest";
import {
  formatAccounts,
  formatMessage,
  formatSearchResults,
  formatThread,
} from "../../src/tools/format.js";
import type { AccountInfo, MessageDetail, MessageSummary } from "../../src/types.js";

const SUMMARY: MessageSummary = {
  id: "INBOX:1787752052:42",
  threadId: "ref:PHRocmVhZC1yb290QGV4YW1wbGUuY29tPg",
  from: "Client <client@example.com>",
  to: "souf@postbus.test",
  subject: "March invoice",
  date: "2026-08-20T09:00:00.000Z",
  snippet: "Here is the invoice",
  unread: true,
  hasAttachments: true,
  mailbox: "INBOX",
};

const DETAIL: MessageDetail = {
  ...SUMMARY,
  body: "Here is the invoice for March.",
  bodyFormat: "text",
  attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", size: 2048 }],
};

describe("formatSearchResults", () => {
  it("carries the ids the next tool needs", () => {
    const output = formatSearchResults("work", "is:unread", [SUMMARY]);

    expect(output).toContain(SUMMARY.id);
    expect(output).toContain(SUMMARY.threadId);
    expect(output).toContain("get_message");
    expect(output).toContain("get_thread");
  });

  it("marks unread mail and attachments", () => {
    const output = formatSearchResults("work", "", [SUMMARY]);

    expect(output).toContain("[UNREAD]");
    expect(output).toContain("attachment");
  });

  it("says plainly that nothing was found", () => {
    const output = formatSearchResults("work", "from:niemand", []);

    expect(output).toContain("No messages found");
    expect(output).toContain("from:niemand");
  });
});

describe("formatMessage", () => {
  it("puts the headers above the body", () => {
    const output = formatMessage("work", DETAIL, DETAIL.body);
    const [header, body] = output.split("---");

    expect(header).toContain("March invoice");
    expect(header).toContain("invoice.pdf (2.0 KB)");
    expect(body).toContain("Here is the invoice for March.");
  });

  it("shows that a message is empty instead of showing nothing", () => {
    expect(formatMessage("work", DETAIL, "   ")).toContain("(empty body)");
  });
});

describe("formatThread", () => {
  it("numbers the messages and keeps the order", () => {
    const tweede = { ...DETAIL, id: "INBOX:1787752052:43", subject: "Re: March invoice" };
    const output = formatThread("work", [DETAIL, tweede], ["eerste", "tweede"]);

    expect(output).toContain("2 message(s), oldest first");
    expect(output).toContain("[1/2]");
    expect(output).toContain("[2/2]");
    expect(output.indexOf("eerste")).toBeLessThan(output.indexOf("tweede"));
  });
});

describe("formatAccounts", () => {
  it("explains how to start when nothing is linked yet", () => {
    expect(formatAccounts([])).toContain("add_mail_account");
  });

  it("shows alias, address and server", () => {
    const account: AccountInfo = {
      alias: "work",
      email: "souf@postbus.test",
      provider: "imap",
      createdAt: "2026-08-26T00:00:00.000Z",
      server: "imap.example.com:993",
    };

    expect(formatAccounts([account])).toContain("work — souf@postbus.test (imap.example.com:993)");
  });
});
