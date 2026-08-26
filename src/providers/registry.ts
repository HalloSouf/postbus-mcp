import { PostbusError, type MailAccount, type MailProvider, type ProviderId } from "../types.js";
import { GmailApiProvider } from "./gmail/provider.js";
import { ImapSmtpProvider } from "./imap/provider.js";

// The only place concrete providers are known. Adding one is a single line here.
const providers = new Map<ProviderId, MailProvider<never>>([
  ["imap", new ImapSmtpProvider() as MailProvider<never>],
  ["gmail-api", new GmailApiProvider() as MailProvider<never>],
]);

export function providerFor(account: MailAccount): MailProvider<MailAccount> {
  const provider = providers.get(account.provider);

  if (!provider) {
    throw new PostbusError(
      `Mailbox "${account.alias}" uses provider "${account.provider}", which this server does not know.`,
    );
  }

  return provider as MailProvider<MailAccount>;
}

export function registeredProviderIds(): ProviderId[] {
  return [...providers.keys()];
}
