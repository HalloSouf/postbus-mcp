#!/usr/bin/env node
import open from "open";
import { assertMasterKey } from "../crypto.js";
import { findUserById } from "../db/users.js";
import { gmailApiEnabled } from "../providers/gmail/auth.js";
import { beginGmailAuth, cancelGmailAuth, finishGmailAuth } from "../providers/gmail/oauth-flow.js";
import { PostbusError } from "../types.js";

// npm run link-gmail -- <user-id> <alias>  ->  optional Gmail API route.
// Runs on the admin's machine: Google's callback goes to localhost.
const WAIT_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  const [userId, alias] = process.argv.slice(2);

  if (!userId || !alias) {
    console.error("Usage: npm run link-gmail -- <user-id> <alias>");
    console.error("Find user ids with: npm run list-users");
    process.exit(1);
  }

  assertMasterKey();

  if (!gmailApiEnabled()) {
    throw new PostbusError(
      "The Gmail API provider is disabled.",
      "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, or just use add_mail_account " +
        "with an app password.",
    );
  }

  const user = findUserById(userId);
  if (!user) throw new PostbusError(`Unknown user "${userId}".`);

  const flow = await beginGmailAuth(user.id, alias);

  console.log(`\nLinking Gmail as "${flow.alias}" for ${user.label}.`);
  console.log(`Listening on ${flow.redirectUri}\n`);
  console.log("Open this in your browser (we will try automatically):\n");
  console.log(`  ${flow.authUrl}\n`);

  void open(flow.authUrl).catch(() => {
    console.log("(Could not open a browser — copy the URL above manually.)");
  });

  console.log("Waiting for consent…");
  const result = await finishGmailAuth(flow.alias, WAIT_MS);

  console.log(`\n"${result.alias}" linked to ${result.email} for ${user.label}.`);
  console.log("The refresh token is stored encrypted in the database.");
  console.log(
    '\nNote: while your OAuth consent screen is on "Testing", this token expires after 7 days.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    cancelGmailAuth();
    const problem = error as PostbusError;
    console.error(`\nLinking failed: ${problem?.message ?? String(error)}`);
    if (problem?.hint) console.error(`Tip: ${problem.hint}`);
    process.exit(1);
  });
