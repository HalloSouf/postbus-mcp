import { describe, expect, it } from "vitest";
import { addresses, buildForward, buildReply } from "../../../src/providers/imap/reply.js";
import type { MessageDetail } from "../../../src/types.js";

const ORIGINAL: MessageDetail = {
  id: "INBOX:1:42",
  threadId: "ref:abc",
  from: "Client <client@example.com>",
  to: "Souf <souf@work.com>, Colleague <colleague@work.com>",
  cc: "billing@example.com",
  subject: "March invoice",
  date: "2026-08-20T09:00:00.000Z",
  snippet: "",
  unread: true,
  hasAttachments: false,
  mailbox: "INBOX",
  messageId: "<original@example.com>",
  references: "<root@example.com>",
  body: "Could you confirm the amount?\n\n-- \nClient Ltd",
  bodyFormat: "text",
  attachments: [],
};

describe("buildReply", () => {
  it("answers the sender and quotes the original", () => {
    const reply = buildReply(ORIGINAL, "Yes, that is correct.", "souf@work.com");

    expect(reply.to).toBe("Client <client@example.com>");
    expect(reply.subject).toBe("Re: March invoice");
    expect(reply.body).toContain("Yes, that is correct.");
    expect(reply.body).toContain("> Could you confirm the amount?");
  });

  it("prefers Reply-To over From, which is the whole point of that header", () => {
    const reply = buildReply(
      { ...ORIGINAL, replyTo: "billing@example.com" },
      "Thanks",
      "souf@work.com",
    );

    expect(reply.to).toBe("billing@example.com");
  });

  it("does not stack Re: on a subject that already has one", () => {
    expect(
      buildReply({ ...ORIGINAL, subject: "Re: March invoice" }, "ok", "souf@work.com").subject,
    ).toBe("Re: March invoice");
    expect(
      buildReply({ ...ORIGINAL, subject: "RE: March invoice" }, "ok", "souf@work.com").subject,
    ).toBe("RE: March invoice");
  });

  it("extends the References chain so clients keep the thread together", () => {
    const reply = buildReply(ORIGINAL, "ok", "souf@work.com");

    expect(reply.inReplyTo).toBe("<original@example.com>");
    expect(reply.references).toBe("<root@example.com> <original@example.com>");
  });

  it("starts a chain when the original had none", () => {
    const reply = buildReply({ ...ORIGINAL, references: undefined }, "ok", "souf@work.com");
    expect(reply.references).toBe("<original@example.com>");
  });

  it("leaves cc empty on a plain reply", () => {
    expect(buildReply(ORIGINAL, "ok", "souf@work.com").cc).toBeUndefined();
  });

  it("copies everyone on reply-all, minus yourself and the sender", () => {
    const reply = buildReply(ORIGINAL, "ok", "souf@work.com", { all: true });

    expect(reply.cc).toContain("colleague@work.com");
    expect(reply.cc).toContain("billing@example.com");
    expect(reply.cc).not.toContain("souf@work.com");
    expect(reply.cc).not.toContain("client@example.com");
  });

  it("does not list the same address twice on reply-all", () => {
    const reply = buildReply(
      { ...ORIGINAL, to: "colleague@work.com", cc: "Colleague <colleague@work.com>" },
      "ok",
      "souf@work.com",
      { all: true },
    );

    expect(reply.cc?.match(/colleague@work\.com/g)).toHaveLength(1);
  });

  it("lets an explicit cc win over reply-all", () => {
    const reply = buildReply(ORIGINAL, "ok", "souf@work.com", {
      all: true,
      cc: "boss@work.com",
    });

    expect(reply.cc).toBe("boss@work.com");
  });
});

describe("buildForward", () => {
  it("prefixes the subject and keeps the original headers readable", () => {
    const forwarded = buildForward(ORIGINAL, "someone@example.com");

    expect(forwarded.to).toBe("someone@example.com");
    expect(forwarded.subject).toBe("Fwd: March invoice");
    expect(forwarded.body).toContain("---------- Forwarded message ----------");
    expect(forwarded.body).toContain("From: Client <client@example.com>");
    expect(forwarded.body).toContain("Could you confirm the amount?");
  });

  it("puts a note above the forwarded message", () => {
    const forwarded = buildForward(ORIGINAL, "someone@example.com", { note: "See below." });

    expect(forwarded.body.indexOf("See below.")).toBeLessThan(
      forwarded.body.indexOf("---------- Forwarded message"),
    );
  });

  it("does not stack Fwd: either", () => {
    expect(buildForward({ ...ORIGINAL, subject: "Fwd: March invoice" }, "a@b.com").subject).toBe(
      "Fwd: March invoice",
    );
  });

  it("does not thread a forward into the original conversation", () => {
    const forwarded = buildForward(ORIGINAL, "someone@example.com");

    expect(forwarded.inReplyTo).toBeUndefined();
    expect(forwarded.references).toBeUndefined();
  });

  it("truncates a huge body, since the original is attached anyway", () => {
    const forwarded = buildForward({ ...ORIGINAL, body: "x".repeat(20_000) }, "a@b.com");
    expect(forwarded.body).toContain("[… truncated]");
    expect(forwarded.body.length).toBeLessThan(6_000);
  });
});

describe("addresses", () => {
  it("pulls bare addresses out of a header", () => {
    expect(addresses("Souf <souf@work.com>, plain@example.com")).toEqual([
      "souf@work.com",
      "plain@example.com",
    ]);
  });

  it("ignores entries that are not addresses", () => {
    expect(addresses("undisclosed recipients")).toEqual([]);
    expect(addresses(undefined)).toEqual([]);
  });
});
