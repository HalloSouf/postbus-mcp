import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PostbusError } from "../types.js";

export async function guard(fn: () => Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (error) {
    const message =
      error instanceof PostbusError
        ? [error.message, error.hint].filter(Boolean).join("\n\nTip: ")
        : `Unexpected error: ${(error as Error)?.message ?? String(error)}`;

    return { isError: true, content: [{ type: "text", text: message }] };
  }
}
