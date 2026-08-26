import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guard } from "../../src/tools/guard.js";
import { PostbusError, type User } from "../../src/types.js";

const USER: User = {
  id: "user1",
  label: "Soufiane",
  createdAt: "2026-08-26T00:00:00.000Z",
  disabled: false,
};

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
});

afterEach(() => vi.restoreAllMocks());

function logged() {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("guard", () => {
  it("returns what the tool produced", async () => {
    const result = await guard("list_accounts", USER, async () => "two mailboxes");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({ type: "text", text: "two mailboxes" });
  });

  // Every failure used to be swallowed without a single line, so a report of
  // "search does not work" left nothing at all in the server logs.
  it("logs one line per call, success or failure", async () => {
    await guard("list_accounts", USER, async () => "ok");
    await guard("search_emails", USER, async () => {
      throw new PostbusError("Unknown mailbox.", undefined, "not_found");
    });

    expect(logged()).toHaveLength(2);
    expect(logged()[0]).toMatchObject({ event: "tool", tool: "list_accounts", ok: true });
    expect(logged()[1]).toMatchObject({
      event: "tool",
      tool: "search_emails",
      ok: false,
      kind: "not_found",
      userId: "user1",
    });
    expect(logged()[0]).toHaveProperty("ms");
  });

  it("keeps mail content out of the log", async () => {
    await guard("get_message", USER, async () => "Subject: salary review\n\nvery private");

    expect(lines.join(" ")).not.toContain("very private");
    expect(lines.join(" ")).not.toContain("salary");
  });

  it("turns the error kind into advice the model can act on", async () => {
    const notFound = await guard("search_emails", USER, async () => {
      throw new PostbusError("Unknown mailbox.", undefined, "not_found");
    });
    const transient = await guard("search_emails", USER, async () => {
      throw new PostbusError("Could not connect.", undefined, "transient");
    });

    expect(notFound.isError).toBe(true);
    expect(String((notFound.content[0] as { text: string }).text)).toContain("list_accounts");
    expect(String((transient.content[0] as { text: string }).text)).toContain("Retrying once");
  });

  it("keeps the hint and records an unexpected error as internal", async () => {
    const withHint = await guard("add_mail_account", USER, async () => {
      throw new PostbusError("Invalid alias.", "Use letters and digits.");
    });
    expect(String((withHint.content[0] as { text: string }).text)).toContain(
      "Tip: Use letters and digits.",
    );

    const unexpected = await guard("get_message", USER, async () => {
      throw new TypeError("cannot read property of undefined");
    });

    expect(unexpected.isError).toBe(true);
    expect(logged().at(-1)).toMatchObject({ kind: "internal" });
    expect(String(logged().at(-1)?.error)).toContain("TypeError");
  });
});
