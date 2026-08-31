import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GmailApiAccount } from "../../../src/types.js";

const { drafts, get } = vi.hoisted(() => ({ drafts: { create: vi.fn() }, get: vi.fn() }));

vi.mock("@googleapis/gmail", () => ({
  gmail: () => ({ users: { drafts, messages: { get } } }),
}));

vi.mock("../../../src/providers/gmail/auth.js", () => ({
  createClientForRefreshToken: () => ({}),
}));

const { GmailApiProvider } = await import("../../../src/providers/gmail/provider.js");

const ACCOUNT: GmailApiAccount = {
  id: "acc1",
  userId: "user1",
  alias: "work",
  email: "souf@postbus.test",
  displayName: "Souf",
  createdAt: "2026-08-26T00:00:00.000Z",
  provider: "gmail-api",
  refreshToken: "refresh",
};

const provider = new GmailApiProvider();

/** The raw MIME that was handed to drafts.create, decoded again. */
function draftedMime(): string {
  const body = drafts.create.mock.calls[0]?.[0].requestBody;
  return Buffer.from(body.message.raw as string, "base64url").toString("utf8");
}

function createdMessage(): { raw: string; threadId?: string } {
  return drafts.create.mock.calls[0]?.[0].requestBody.message;
}

beforeEach(() => {
  drafts.create.mockReset();
  get.mockReset();
  drafts.create.mockResolvedValue({ data: { id: "r-123", message: { id: "m-456" } } });
});

describe("createDraft", () => {
  it("stores the message as a draft instead of sending it", async () => {
    const draft = await provider.createDraft(ACCOUNT, "client@example.com", "Offer", "Here it is.");

    expect(drafts.create).toHaveBeenCalledTimes(1);
    expect(draftedMime()).toContain("To: client@example.com");
    expect(draft.folder).toBe("DRAFTS");
  });

  // The draft id (r-123) is not a message id: only the latter reads back.
  it("returns the id get_message accepts, not the draft id", async () => {
    const draft = await provider.createDraft(ACCOUNT, "client@example.com", "Offer", "Body");

    expect(draft.id).toBe("m-456");
  });

  it("does not pin a plain draft to a thread", async () => {
    await provider.createDraft(ACCOUNT, "client@example.com", "Offer", "Body");

    expect(createdMessage().threadId).toBeUndefined();
  });
});

describe("createReplyDraft", () => {
  beforeEach(() => {
    get.mockResolvedValue({
      data: {
        id: "m-1",
        threadId: "t-9",
        labelIds: ["INBOX"],
        internalDate: "1787222400000",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "Client <client@example.com>" },
            { name: "To", value: "Souf <souf@postbus.test>" },
            { name: "Subject", value: "March invoice" },
            { name: "Message-ID", value: "<original@example.com>" },
            { name: "Date", value: "Thu, 20 Aug 2026 09:00:00 +0000" },
          ],
          body: { data: Buffer.from("Could you confirm the amount?").toString("base64url") },
        },
      },
    });
  });

  it("files the draft in the thread it answers", async () => {
    await provider.createReplyDraft(ACCOUNT, "m-1", "Confirmed.");

    expect(createdMessage().threadId).toBe("t-9");
  });

  it("fills in recipient, Re: subject and the threading headers", async () => {
    await provider.createReplyDraft(ACCOUNT, "m-1", "Confirmed.");

    const mime = draftedMime();
    expect(mime).toContain("To: Client <client@example.com>");
    expect(mime).toContain("Subject: Re: March invoice");
    expect(mime).toContain("In-Reply-To: <original@example.com>");
    expect(mime).toContain("> Could you confirm the amount?");
  });
});
