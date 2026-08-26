import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { logEvent } from "../log.js";
import { PostbusError, type ErrorKind, type User } from "../types.js";

// What the model should do about this class of failure. Without it every
// problem arrived as the same flat "isError: true" and retrying a bad alias
// looked as reasonable as retrying a timeout.
const ADVICE: Record<ErrorKind, string> = {
  not_found: "Call list_accounts to see which mailboxes exist, then try again.",
  invalid_input: "Fix the arguments and call again; repeating this call unchanged will not help.",
  auth: "The mailbox rejected these credentials. The user has to relink it; do not retry.",
  transient: "This is temporary. Retrying once is reasonable.",
  upstream: "The mail server refused or failed. Retrying immediately is unlikely to help.",
  config:
    "This is a server configuration problem. Tell the user to check the server; do not retry.",
  internal: "Something unexpected went wrong. Report this to the user rather than retrying.",
};

export async function guard(
  tool: string,
  user: User,
  fn: () => Promise<string>,
): Promise<CallToolResult> {
  const started = Date.now();

  try {
    const text = await fn();
    logEvent({ event: "tool", tool, userId: user.id, ms: Date.now() - started, ok: true });

    return { content: [{ type: "text", text }] };
  } catch (error) {
    const kind: ErrorKind = error instanceof PostbusError ? error.kind : "internal";

    logEvent({
      event: "tool",
      tool,
      userId: user.id,
      ms: Date.now() - started,
      ok: false,
      kind,
      // The message of an unexpected error is the whole reason to look at a
      // log at all; a PostbusError is already phrased for the caller.
      ...(kind === "internal" ? { error: describe(error) } : {}),
    });

    const message =
      error instanceof PostbusError
        ? [error.message, error.hint].filter(Boolean).join("\n\nTip: ")
        : `Unexpected error: ${describe(error)}`;

    return { isError: true, content: [{ type: "text", text: `${message}\n\n${ADVICE[kind]}` }] };
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
