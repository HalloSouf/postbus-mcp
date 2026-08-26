import type { Server } from "node:http";
import { HOST, PORT } from "./config.js";
import { assertMasterKey } from "./crypto.js";
import { closeDb, databasePath, getDb } from "./db/index.js";
import { createApp } from "./http/server.js";
import { logEvent } from "./log.js";
import { closeAllConnections } from "./providers/imap/connection.js";
import { gmailApiEnabled } from "./providers/gmail/auth.js";

// Docker sends SIGKILL ten seconds after SIGTERM. Give up before that so the
// database still gets closed rather than being killed mid-checkpoint.
const SHUTDOWN_GRACE_MS = 8_000;

export function main(): void {
  // Without a usable key nothing can be read or stored: fail at startup, not
  // halfway through someone's first tool call.
  assertMasterKey();
  getDb();

  const server = createApp().listen(PORT, HOST, () => {
    logEvent({
      event: "started",
      url: `http://${HOST}:${PORT}/mcp`,
      database: databasePath(),
      gmailApi: gmailApiEnabled(),
    });
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(server, signal));
  }

  // An unhandled rejection kills the process by default, taking the reason
  // with it. Log it, then let the same orderly shutdown run.
  process.on("unhandledRejection", (reason) => {
    logEvent({ event: "unhandled_rejection", error: String(reason) });
    void shutdown(server, "unhandledRejection", 1);
  });
}

async function shutdown(server: Server, reason: string, code = 0): Promise<void> {
  logEvent({ event: "shutting_down", reason });

  const giveUp = setTimeout(() => {
    logEvent({ event: "shutdown_timeout" });
    process.exit(code || 1);
  }, SHUTDOWN_GRACE_MS);
  giveUp.unref();

  server.close();
  server.closeIdleConnections();

  // These were fire-and-forget before, with process.exit() on the next line,
  // so the LOGOUT never left the socket and the mail server held the session
  // open until its own timeout.
  await closeAllConnections();
  closeDb();

  clearTimeout(giveUp);
  process.exit(code);
}
