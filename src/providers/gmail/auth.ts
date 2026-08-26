import { auth } from "@googleapis/gmail";

// The OAuth2 client that ships with @googleapis/gmail, not a separately
// installed google-auth-library: two copies would be structurally different
// types to the compiler even though they behave identically.
export type GmailOAuthClient = InstanceType<typeof auth.OAuth2>;
import { getGoogleOAuthConfig } from "../../config.js";
import { PostbusError } from "../../types.js";

// The Gmail API provider only exists when Google credentials are configured.
export function gmailApiEnabled(): boolean {
  return getGoogleOAuthConfig() !== null;
}

function requireConfig() {
  const config = getGoogleOAuthConfig();
  if (!config) {
    throw new PostbusError(
      "The Gmail API provider is disabled.",
      "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment, or just use IMAP/SMTP " +
        "with an app password (add_mail_account) — that is the normal route.",
      "config",
    );
  }
  return config;
}

export function createOAuthClient(redirectUriOverride?: string): GmailOAuthClient {
  const { clientId, clientSecret, redirectUri } = requireConfig();
  return new auth.OAuth2({
    clientId,
    clientSecret,
    redirectUri: redirectUriOverride ?? redirectUri,
  });
}

export function createClientForRefreshToken(refreshToken: string): GmailOAuthClient {
  const client = createOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}
