#!/usr/bin/env node
import { assertMasterKey } from "../crypto.js";
import { createUser } from "../db/users.js";
import { databasePath } from "../db/index.js";
import { PostbusError } from "../types.js";

// npm run add-user -- "Name"  ->  creates a user and prints its token once.
function main(): void {
  const label = process.argv.slice(2).join(" ").trim();

  if (!label) {
    console.error('Usage: npm run add-user -- "User name"');
    process.exit(1);
  }

  assertMasterKey();
  const { user, token } = createUser(label);

  console.log(`\nCreated user: ${user.label} (id ${user.id})`);
  console.log(`Database: ${databasePath()}\n`);
  console.log("API token (shown this once and never again):\n");
  console.log(`  ${token}\n`);
  console.log("Have them put this in their MCP client, for example:\n");
  console.log(`  Authorization: Bearer ${token}\n`);
}

try {
  main();
} catch (error) {
  reportAndExit(error);
}

function reportAndExit(error: unknown): never {
  if (error instanceof PostbusError) {
    console.error(`Failed: ${error.message}`);
    if (error.hint) console.error(`Tip: ${error.hint}`);
  } else {
    console.error("Failed:", error);
  }
  process.exit(1);
}
