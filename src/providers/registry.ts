import { PostbusError, type MailAccount, type MailProvider, type ProviderId } from "../types.js";
import { GmailApiProvider } from "./gmail/provider.js";
import { ImapSmtpProvider } from "./imap/provider.js";

/**
 * Ties each provider id to the account shape that provider actually accepts.
 * The previous Map<ProviderId, MailProvider<never>> plus a cast checked
 * nothing: pairing "gmail-api" with the IMAP provider compiled fine and only
 * failed at runtime, on a missing imapHost.
 */
type ProviderMap = {
  [K in ProviderId]: MailProvider<Extract<MailAccount, { provider: K }>>;
};

// Adding a provider is a line here, and the compiler insists on it.
const providers: ProviderMap = {
  imap: new ImapSmtpProvider(),
  "gmail-api": new GmailApiProvider(),
};

export function providerFor(account: MailAccount): MailProvider<MailAccount> {
  const provider = providers[account.provider];

  if (!provider) {
    throw new PostbusError(
      `Mailbox "${account.alias}" uses provider "${account.provider}", which this server does not know.`,
      undefined,
      "config",
    );
  }

  return provider as MailProvider<MailAccount>;
}

export function registeredProviderIds(): ProviderId[] {
  return Object.keys(providers) as ProviderId[];
}

/**
 * A provider column read back from the database is just text. Casting it left
 * an unknown value to be treated as IMAP, which then failed with a misleading
 * "missing IMAP/SMTP details".
 */
export function parseProviderId(raw: string): ProviderId {
  if (raw in providers) return raw as ProviderId;

  throw new PostbusError(
    `This database holds a mailbox for provider "${raw}", which this server does not know.`,
    `Known providers: ${registeredProviderIds().join(", ")}. Deploy the version that wrote it, or unlink the mailbox.`,
    "config",
  );
}
