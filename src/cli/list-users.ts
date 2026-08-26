#!/usr/bin/env node
import { databasePath } from "../db/index.js";
import { listUsers } from "../db/users.js";

// npm run list-users  ->  who has access and how many mailboxes they linked.
const users = listUsers();

if (users.length === 0) {
  console.log("No users yet.");
  console.log('Create one with: npm run add-user -- "Name"');
} else {
  const width = Math.max(...users.map((user) => user.label.length), 4);

  console.log(`Users in ${databasePath()}:\n`);
  console.log(`${"NAME".padEnd(width)}  ID           MAILBOXES  STATUS   CREATED`);

  for (const user of users) {
    console.log(
      `${user.label.padEnd(width)}  ${user.id.padEnd(12)} ${String(user.accountCount).padStart(9)}  ` +
        `${(user.disabled ? "off" : "active").padEnd(7)}  ${user.createdAt.slice(0, 10)}`,
    );
  }

  console.log("\nOnly token hashes are stored, so tokens cannot be read back.");
  console.log("Need a new one? npm run rotate-token -- <id>");
}
