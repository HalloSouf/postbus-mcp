import { describe, expect, it } from "vitest";
import { parseQuery } from "../../../src/providers/imap/query.js";

function daysAgo(value: unknown): number {
  const date = value as Date;
  return Math.round((Date.now() - date.getTime()) / 86_400_000);
}

describe("parseQuery", () => {
  it("translates the most common combination", () => {
    const parsed = parseQuery("from:boss@company.com is:unread newer_than:7d");

    expect(parsed.criteria.from).toBe("boss@company.com");
    expect(parsed.criteria.seen).toBe(false);
    expect(daysAgo(parsed.criteria.since)).toBe(7);
    expect(parsed.ignored).toEqual([]);
  });

  it("keeps the raw query for the X-GM-RAW route", () => {
    const query = "from:boss@company.com label:work";
    expect(parseQuery(query).raw).toBe(query);
  });

  it("keeps a quoted value together", () => {
    expect(parseQuery('subject:"march invoice"').criteria.subject).toBe("march invoice");
  });

  it("reads in: as a folder, not as a search term", () => {
    const parsed = parseQuery("in:sent to:client@example.com");

    expect(parsed.mailbox).toBe("sent");
    expect(parsed.criteria.to).toBe("client@example.com");
    expect(parsed.criteria.text).toBeUndefined();
  });

  it("knows the common folder names", () => {
    expect(parseQuery("in:inbox").mailbox).toBe("inbox");
    expect(parseQuery("in:anywhere").mailbox).toBe("all");
    expect(parseQuery("in:spam").mailbox).toBe("junk");
    expect(parseQuery("in:bin").mailbox).toBe("trash");
  });

  it("sets has:attachment aside, since IMAP cannot search on it", () => {
    const parsed = parseQuery("has:attachment subject:invoice");

    expect(parsed.requireAttachments).toBe(true);
    expect(parsed.criteria).not.toHaveProperty("has");
    expect(parsed.ignored).toEqual([]);
  });

  it("translates flags in both directions", () => {
    expect(parseQuery("is:unread").criteria.seen).toBe(false);
    expect(parseQuery("is:read").criteria.seen).toBe(true);
    expect(parseQuery("is:starred").criteria.flagged).toBe(true);
    expect(parseQuery("is:unflagged").criteria.flagged).toBe(false);
    expect(parseQuery("is:answered").criteria.answered).toBe(true);
  });

  it("inverts a flag with a leading minus", () => {
    expect(parseQuery("-is:unread").criteria.seen).toBe(true);
  });

  it("puts -from: in a NOT branch instead of the criteria themselves", () => {
    const parsed = parseQuery("-from:spam@x.com quote");

    expect(parsed.criteria.not?.from).toBe("spam@x.com");
    expect(parsed.criteria.from).toBeUndefined();
    expect(parsed.criteria.text).toBe("quote");
  });

  it("converts relative periods into days", () => {
    expect(daysAgo(parseQuery("newer_than:2w").criteria.since)).toBe(14);
    expect(daysAgo(parseQuery("newer_than:3m").criteria.since)).toBe(90);
    expect(daysAgo(parseQuery("older_than:1y").criteria.before)).toBe(365);
  });

  it("reads absolute dates with dashes and with slashes", () => {
    const dashes = parseQuery("after:2026-01-01").criteria.since as Date;
    const slashes = parseQuery("before:2026/03/01").criteria.before as Date;

    expect(dashes.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(slashes.toISOString().slice(0, 10)).toBe("2026-03-01");
  });

  it("converts sizes into bytes", () => {
    expect(parseQuery("larger:5M").criteria.larger).toBe(5 * 1024 * 1024);
    expect(parseQuery("smaller:100k").criteria.smaller).toBe(100 * 1024);
    expect(parseQuery("larger:2048").criteria.larger).toBe(2048);
  });

  it("joins loose words into one text term (IMAP has only one)", () => {
    expect(parseQuery("quote kitchen 2026").criteria.text).toBe("quote kitchen 2026");
  });

  it("returns everything for an empty query", () => {
    expect(parseQuery("").criteria).toEqual({ all: true });
    expect(parseQuery("   ").criteria).toEqual({ all: true });
  });

  it("reports what it could not translate instead of dropping it silently", () => {
    const parsed = parseQuery("filename:pdf category:promotions from:a@b.nl");

    expect(parsed.ignored).toContain("filename:pdf");
    expect(parsed.ignored).toContain("category:promotions");
    expect(parsed.criteria.from).toBe("a@b.nl");
  });

  it("keeps nonsensical dates and sizes out of the criteria", () => {
    const parsed = parseQuery("newer_than:yesterday larger:lots");

    expect(parsed.criteria.since).toBeUndefined();
    expect(parsed.criteria.larger).toBeUndefined();
    expect(parsed.ignored).toHaveLength(2);
  });
});

// Compiling the criteria is the only way to see what the server is really
// asked; the shape of the object hides the grouping.
async function compile(query: string): Promise<string> {
  const { searchCompiler } = await import("imapflow/lib/search-compiler.js");
  type Token = ReturnType<typeof searchCompiler>[number];

  const flatten = (node: Token): string =>
    Array.isArray(node) ? `(${node.map(flatten).join(" ")})` : node.value;

  return searchCompiler(
    { mailbox: { uidNext: 1 }, capabilities: new Map() },
    parseQuery(query).criteria,
  )
    .map(flatten)
    .join(" ");
}

describe("negation", () => {
  it("negates a single term", async () => {
    expect(await compile("-from:spam@example.com")).toBe("NOT FROM spam@example.com");
  });

  // NOT over a group of keys is NOT (A AND B), which is true whenever either
  // half fails — so spam from that sender under any other subject came back.
  it("negates each term separately instead of the group", async () => {
    const compiled = await compile("-from:spam@example.com -subject:sale");

    expect(compiled).toBe("NOT OR FROM spam@example.com SUBJECT sale");
    expect(compiled).not.toBe("NOT (FROM spam@example.com SUBJECT sale)");
  });

  it("keeps positive terms alongside negated ones", async () => {
    const parsed = parseQuery("to:me@example.com -from:spam@example.com");

    expect(parsed.criteria.to).toBe("me@example.com");
    expect(parsed.criteria.not).toEqual({ from: "spam@example.com" });
  });
});

describe("absolute dates", () => {
  // new Date("2026-3-1") is local time while new Date("2026-03-01") is UTC, and
  // imapflow formats with toISOString(), so east of Greenwich the unpadded form
  // searched from the previous day.
  it("reads padded and unpadded dates as the same UTC day", () => {
    const padded = parseQuery("after:2026-03-01").criteria.since as Date;
    const unpadded = parseQuery("after:2026/3/1").criteria.since as Date;

    expect(unpadded.toISOString()).toBe(padded.toISOString());
    expect(padded.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("reports a date it cannot read instead of guessing", () => {
    expect(parseQuery("after:yesterday").ignored).toContain("since:yesterday");
    expect(parseQuery("before:2026-13-40").ignored).toContain("before:2026-13-40");
  });
});

describe("folder selection", () => {
  it("maps the folder aliases it knows", () => {
    expect(parseQuery("in:sent").mailbox).toBe("sent");
    expect(parseQuery("in:bin").mailbox).toBe("trash");
    expect(parseQuery("in:spam").mailbox).toBe("junk");
  });

  // An unknown folder used to vanish without even being recorded, so
  // "label:invoices" came back as the whole inbox announced as a search for
  // invoices. The name is passed on; the provider resolves or reports it.
  it("passes an unknown folder name through instead of dropping it", () => {
    expect(parseQuery("label:invoices").mailbox).toBe("invoices");
    expect(parseQuery("in:projects").mailbox).toBe("projects");
  });
});
