#!/usr/bin/env node
import { HOST, PORT } from "./config.js";
import { assertMasterKey } from "./crypto.js";
import { closeDb, databasePath, getDb } from "./db/index.js";
import { createApp } from "./http/server.js";
import { closeAllConnections } from "./providers/imap/connection.js";
import { gmailApiEnabled } from "./providers/gmail/auth.js";
import { PostbusError } from "./types.js";

function main(): void {
  // Without a usable key nothing can be read or stored: fail at startup, not
  // halfway through someone's first tool call.
  assertMasterKey();
  getDb();

  const server = createApp().listen(PORT, HOST, () => {
    console.log(`postbus-mcp is listening on http://${HOST}:${PORT}/mcp`);
    console.log(`database: ${databasePath()}`);
    console.log(`providers: imap/smtp${gmailApiEnabled() ? " + gmail-api (optional)" : ""}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`\ngot ${signal}, shutting down…`);
      server.close(() => {
        closeAllConnections();
        closeDb();
        process.exit(0);
      });
    });
  }
}

try {
  main();
} catch (error) {
  if (error instanceof PostbusError) {
    console.error(`postbus-mcp could not start: ${error.message}`);
    if (error.hint) console.error(`Tip: ${error.hint}`);
  } else {
    console.error("postbus-mcp could not start:", error);
  }
  process.exit(1);
}
