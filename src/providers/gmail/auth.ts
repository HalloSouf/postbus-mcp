import { Auth } from "googleapis";
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
    );
  }
  return config;
}

export function createOAuthClient(redirectUriOverride?: string): Auth.OAuth2Client {
  const { clientId, clientSecret, redirectUri } = requireConfig();
  return new Auth.OAuth2Client({
    clientId,
    clientSecret,
    redirectUri: redirectUriOverride ?? redirectUri,
  });
}

export function createClientForRefreshToken(refreshToken: string): Auth.OAuth2Client {
  const client = createOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}
