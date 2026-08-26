import { getAccount } from "../db/accounts.js";
import { providerFor } from "../providers/registry.js";
import type { MailAccount, MailProvider, User } from "../types.js";

export interface ToolContext {
  user: User;
}

export interface ResolvedAccount {
  account: MailAccount;
  provider: MailProvider<MailAccount>;
}

// Alias lookup is scoped to the session's user, so tools cannot name their way
// into someone else's mailbox.
export function resolveAccount(context: ToolContext, alias: string): ResolvedAccount {
  const account = getAccount(context.user.id, alias);
  return { account, provider: providerFor(account) };
}
