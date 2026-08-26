import { randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { gmail } from "@googleapis/gmail";
import { GOOGLE_SCOPES, OAUTH_CALLBACK_PORT, getGoogleOAuthConfig } from "../../config.js";
import { accountExists, saveGmailApiAccount } from "../../db/accounts.js";
import { PostbusError } from "../../types.js";
import { createOAuthClient, type GmailOAuthClient } from "./auth.js";

const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}/oauth2callback`;

// Admin-only flow: Google sends the callback to localhost, which does not work
// from a shared server. One callback port means one flow at a time.
export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

const FLOW_TTL_MS = 10 * 60 * 1000;

const DEFAULT_WAIT_MS = 90 * 1000;

export interface PendingAuthInfo {
  userId: string;
  alias: string;
  authUrl: string;
  redirectUri: string;
  expiresAt: string;
}

export interface LinkedAccountResult {
  alias: string;
  email: string;
  replaced: boolean;
}

interface PendingFlow extends PendingAuthInfo {
  state: string;
  codeVerifier: string;
  client: GmailOAuthClient;
  server: Server;
  timer: NodeJS.Timeout;
  code?: string;
  waiters: Array<{ resolve: (code: string) => void; reject: (error: Error) => void }>;
}

let pending: PendingFlow | null = null;

export function pendingAlias(): string | undefined {
  return pending?.alias;
}

export async function beginGmailAuth(userId: string, alias: string): Promise<PendingAuthInfo> {
  const cleaned = alias.trim();

  if (!ALIAS_PATTERN.test(cleaned)) {
    throw new PostbusError(
      `Invalid alias "${alias}".`,
      'Use letters, digits, dot, dash or underscore (32 characters max), e.g. "personal" or "work".',
    );
  }

  if (!getGoogleOAuthConfig()) {
    throw new PostbusError(
      "The Gmail API provider is disabled.",
      "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or use IMAP/SMTP with an app password.",
    );
  }

  cancelGmailAuth();

  const client = createOAuthClient(OAUTH_REDIRECT_URI);
  const state = randomBytes(16).toString("hex");

  // The code comes back over plain http on loopback, where any other local
  // process that can observe the URL could redeem it. PKCE ties it to this
  // flow, as OAuth 2.1 and Google's native-app guidance both require.
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces a refresh token, also when relinking
    scope: GOOGLE_SCOPES,
    include_granted_scopes: true,
    state,
    // "S256" rather than the enum: the enum lives in google-auth-library and
    // importing it separately drags in a second copy of that package.
    code_challenge_method: "S256" as never,
    code_challenge: codeChallenge,
  });

  const server = await startCallbackServer(state);
  const expiresAt = new Date(Date.now() + FLOW_TTL_MS).toISOString();

  const timer = setTimeout(() => {
    failPending(new PostbusError("The authorization expired (10 minutes passed)."));
  }, FLOW_TTL_MS);
  timer.unref?.();

  pending = {
    userId,
    alias: cleaned,
    authUrl,
    redirectUri: OAUTH_REDIRECT_URI,
    expiresAt,
    state,
    codeVerifier,
    client,
    server,
    timer,
    waiters: [],
  };

  return { userId, alias: cleaned, authUrl, redirectUri: OAUTH_REDIRECT_URI, expiresAt };
}

export async function finishGmailAuth(
  alias: string,
  waitMs = DEFAULT_WAIT_MS,
): Promise<LinkedAccountResult> {
  const flow = pending;

  if (!flow) {
    throw new PostbusError(
      "No authorization is pending.",
      "Start one first with `npm run link-gmail -- <user-id> <alias>`.",
    );
  }

  if (flow.alias.toLowerCase() !== alias.trim().toLowerCase()) {
    throw new PostbusError(
      `The pending authorization is for "${flow.alias}", not for "${alias}".`,
      `Finish "${flow.alias}" first, or start over.`,
    );
  }

  const code = await waitForCode(flow, waitMs);
  const { tokens } = await flow.client.getToken({ code, codeVerifier: flow.codeVerifier });

  if (!tokens.refresh_token) {
    cancelGmailAuth();
    throw new PostbusError(
      "Google returned no refresh token.",
      "Revoke access at https://myaccount.google.com/permissions and link again.",
    );
  }

  flow.client.setCredentials(tokens);
  const email = await fetchEmailAddress(flow.client);

  const existing = accountExists(flow.userId, flow.alias);

  saveGmailApiAccount({
    userId: flow.userId,
    alias: flow.alias,
    email,
    refreshToken: tokens.refresh_token,
  });

  cancelGmailAuth();
  return { alias: flow.alias, email, replaced: existing };
}

export function cancelGmailAuth(): boolean {
  if (!pending) return false;

  const flow = pending;
  pending = null;
  clearTimeout(flow.timer);

  for (const waiter of flow.waiters) {
    waiter.reject(new PostbusError("The authorization was cancelled."));
  }
  flow.waiters.length = 0;

  flow.server.closeAllConnections?.();
  flow.server.close();
  return true;
}

function waitForCode(flow: PendingFlow, waitMs: number): Promise<string> {
  if (flow.code) return Promise.resolve(flow.code);

  return new Promise<string>((resolve, reject) => {
    const waiter = { resolve, reject };
    flow.waiters.push(waiter);

    const deadline = setTimeout(
      () => {
        const index = flow.waiters.indexOf(waiter);
        if (index >= 0) flow.waiters.splice(index, 1);

        reject(
          new PostbusError(
            `No consent received yet for "${flow.alias}".`,
            `Open the URL, approve it, and try again. This authorization stays valid until ${flow.expiresAt}.`,
          ),
        );
      },
      Math.max(1000, waitMs),
    );

    deadline.unref?.();
    waiter.resolve = (code) => {
      clearTimeout(deadline);
      resolve(code);
    };
    waiter.reject = (error) => {
      clearTimeout(deadline);
      reject(error);
    };
  });
}

function acceptCode(code: string): void {
  if (!pending) return;
  pending.code = code;

  const waiters = [...pending.waiters];
  pending.waiters.length = 0;
  for (const waiter of waiters) waiter.resolve(code);
}

function failPending(error: Error): void {
  if (!pending) return;

  const flow = pending;
  pending = null;
  clearTimeout(flow.timer);

  const waiters = [...flow.waiters];
  flow.waiters.length = 0;
  for (const waiter of waiters) waiter.reject(error);

  flow.server.closeAllConnections?.();
  flow.server.close();
}

function startCallbackServer(expectedState: string): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", OAUTH_REDIRECT_URI);
      res.setHeader("Connection", "close");

      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      // State first. Checking the error branch ahead of it let any page the
      // operator happened to visit cancel the pending flow with a bare
      // /oauth2callback?error=x, no state needed.
      if (state !== expectedState) {
        respond(res, 400, "Invalid state", "The state parameter does not match. Start over.");
        return;
      }

      if (error) {
        respond(res, 400, "Access denied", `Google returned: ${error}`);
        failPending(new PostbusError(`Google refused the authorization: ${error}`));
        return;
      }

      if (!code) {
        respond(res, 400, "No code", "Google returned no authorization code.");
        return;
      }

      respond(res, 200, "Done", "You can close this tab and go back to your terminal.");
      acceptCode(code);
    });

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new PostbusError(
            `Port ${OAUTH_CALLBACK_PORT} is already in use.`,
            "Point OAUTH_CALLBACK_PORT at a free port and add the matching redirect URI in Google Cloud.",
          ),
        );
        return;
      }
      reject(err);
    });

    server.listen(OAUTH_CALLBACK_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function fetchEmailAddress(auth: GmailOAuthClient): Promise<string> {
  const profile = await gmail({ version: "v1", auth }).users.getProfile({ userId: "me" });
  const email = profile.data.emailAddress;

  if (!email) throw new PostbusError("Could not read the mailbox email address.");
  return email;
}

// `detail` can carry a query parameter, so it is not ours to trust.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function respond(res: ServerResponse, status: number, title: string, detail: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>postbus-mcp</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:15vh auto;max-width:32rem;padding:0 1.5rem;color:#111}
h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#555;margin:0}</style>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`,
  );
}
