#!/usr/bin/env node
import { findUserById, rotateToken } from "../db/users.js";
import { PostbusError } from "../types.js";

// npm run rotate-token -- <user-id>  ->  new token, the old one stops working.
const id = process.argv[2]?.trim();

if (!id) {
  console.error("Usage: npm run rotate-token -- <user-id>");
  console.error("Find the id with: npm run list-users");
  process.exit(1);
}

try {
  const user = findUserById(id);
  if (!user) throw new PostbusError(`Unknown user "${id}".`);

  const token = rotateToken(user.id);
  console.log(`\nNew token for ${user.label} (${user.id}):\n`);
  console.log(`  ${token}\n`);
  console.log("The previous token no longer works.");
} catch (error) {
  const problem = error as PostbusError;
  console.error(`Failed: ${problem?.message ?? String(error)}`);
  if (problem?.hint) console.error(`Tip: ${problem.hint}`);
  process.exit(1);
}
