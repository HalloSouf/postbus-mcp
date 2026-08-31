import { beforeEach, describe, expect, it, vi } from "vitest";
import { simpleParser } from "mailparser";
import { PostbusError, type ImapAccount } from "../../../src/types.js";

const { append, resolveMailbox } = vi.hoisted(() => ({
  append: vi.fn(),
  resolveMailbox: vi.fn(),
}));

// The draft path is the only thing under test here, so the connection pool is
// replaced by a client that records what would have been appended.
vi.mock("../../../src/providers/imap/connection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/providers/imap/connection.js")>();

  return {
    ...actual,
    resolveMailbox,
    withImap: (_account: ImapAccount, fn: (context: unknown) => unknown) =>
      fn({ client: { append }, gmail: false, objectId: false, serverThreads: false }),
  };
});

const { ImapSmtpProvider } = await import("../../../src/providers/imap/provider.js");

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

const provider = new ImapSmtpProvider();

function appended() {
  return append.mock.calls[0] as [string, Buffer, string[]];
}

beforeEach(() => {
  append.mockReset();
  resolveMailbox.mockReset();
  resolveMailbox.mockResolvedValue("INBOX.Drafts");
  append.mockResolvedValue({ destination: "INBOX.Drafts", uid: 12, uidValidity: 99n });
});

describe("createDraft", () => {
  it("appends to Drafts with the flags a draft needs", async () => {
    await provider.createDraft(ACCOUNT, "client@example.com", "Offer", "Here it is.");

    const [path, , flags] = appended();
    expect(path).toBe("INBOX.Drafts");
    expect(flags).toEqual(["\\Draft", "\\Seen"]);
  });

  it("hands back an id that get_message accepts", async () => {
    const draft = await provider.createDraft(ACCOUNT, "client@example.com", "Offer", "Here it is.");

    expect(draft.id).toBe("INBOX.Drafts:99:12");
    expect(draft.folder).toBe("INBOX.Drafts");
    expect(draft.notes).toEqual([]);
  });

  // Without UIDPLUS the append still lands, so the draft exists; only the id
  // is missing, and saying so beats handing back a broken one.
  it("says so when the server reports no uid", async () => {
    append.mockResolvedValue({ destination: "INBOX.Drafts" });

    const draft = await provider.createDraft(ACCOUNT, "client@example.com", "Offer", "Body");

    expect(draft.id).toBeUndefined();
    expect(draft.notes).toHaveLength(1);
  });

  it("refuses when the mailbox has no Drafts folder", async () => {
    resolveMailbox.mockResolvedValue(undefined);

    await expect(
      provider.createDraft(ACCOUNT, "client@example.com", "Offer", "Body"),
    ).rejects.toThrow(PostbusError);
    expect(append).not.toHaveBeenCalled();
  });

  // A draft never reaches an SMTP envelope, so a Bcc dropped from the headers
  // is a Bcc the user silently loses when they send it from their client.
  it("keeps Bcc in the headers", async () => {
    await provider.createDraft(ACCOUNT, "client@example.com", "Offer", "Body", {
      cc: "colleague@example.com",
      bcc: "hidden@example.com",
    });

    const headers = appended()[1].toString("utf8").split("\r\n\r\n")[0] as string;
    expect(headers).toContain("Bcc: hidden@example.com");
    expect(headers).toContain("Cc: colleague@example.com");
  });
});

describe("createReplyDraft", () => {
  const ORIGINAL = [
    "From: Client <client@example.com>",
    "To: Souf <souf@postbus.test>, Colleague <colleague@example.com>",
    "Subject: March invoice",
    "Message-ID: <original@example.com>",
    "Date: Thu, 20 Aug 2026 09:00:00 +0000",
    "",
    "Could you confirm the amount?",
  ].join("\r\n");

  beforeEach(() => {
    vi.spyOn(provider, "getMessage").mockImplementation(async () => {
      const parsed = await simpleParser(Buffer.from(ORIGINAL, "utf8"));
      return {
        id: "INBOX:1:42",
        threadId: "ref:abc",
        from: "Client <client@example.com>",
        to: "Souf <souf@postbus.test>, Colleague <colleague@example.com>",
        subject: "March invoice",
        date: "2026-08-20T09:00:00.000Z",
        snippet: "",
        unread: true,
        hasAttachments: false,
        mailbox: "INBOX",
        messageId: "<original@example.com>",
        body: parsed.text ?? "",
        bodyFormat: "text" as const,
        attachments: [],
      };
    });
  });

  it("fills in recipient, Re: subject and the threading headers", async () => {
    await provider.createReplyDraft(ACCOUNT, "INBOX:1:42", "Confirmed.");

    const headers = appended()[1].toString("utf8").split("\r\n\r\n")[0] as string;
    expect(headers).toContain("To: Client <client@example.com>");
    expect(headers).toContain("Subject: Re: March invoice");
    expect(headers).toContain("In-Reply-To: <original@example.com>");
  });

  it("keeps the other recipients on a reply-all draft", async () => {
    await provider.createReplyDraft(ACCOUNT, "INBOX:1:42", "Confirmed.", { all: true });

    const headers = appended()[1].toString("utf8").split("\r\n\r\n")[0] as string;
    expect(headers).toContain("colleague@example.com");
    // Replying to yourself is what reply-all does when self is not dropped.
    expect(headers).not.toContain("Cc: Souf");
  });

  it("quotes the original, so the draft reads like a reply", async () => {
    await provider.createReplyDraft(ACCOUNT, "INBOX:1:42", "Confirmed.");

    const body = appended()[1].toString("utf8");
    expect(body).toContain("Confirmed.");
    expect(body).toContain("> Could you confirm the amount?");
  });
});
