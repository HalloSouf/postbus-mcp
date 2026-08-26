#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { deleteUser, findUserById, listUsers } from "../db/users.js";

// npm run remove-user -- <user-id>  ->  removes a user and all their mailboxes.
async function main(): Promise<void> {
  const id = process.argv[2]?.trim();

  if (!id) {
    console.error("Usage: npm run remove-user -- <user-id>");
    console.error("Find the id with: npm run list-users");
    process.exit(1);
  }

  const user = findUserById(id);
  if (!user) {
    console.error(`Unknown user "${id}".`);
    process.exit(1);
  }

  const accounts = listUsers().find((candidate) => candidate.id === user.id)?.accountCount ?? 0;
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await rl.question(
      `Delete user "${user.label}" and ${accounts} linked mailbox(es)? [y/N] `,
    );

    if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
      console.log("Cancelled.");
      return;
    }
  } finally {
    rl.close();
  }

  deleteUser(user.id);
  console.log(`User "${user.label}" deleted.`);
}

main().catch((error: unknown) => {
  console.error("Failed:", (error as Error)?.message ?? error);
  process.exit(1);
});
