import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { PostbusError } from "./types.js";

// Walk up to package.json so this resolves from both src/ and dist/.
function findProjectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const PROJECT_ROOT = findProjectRoot();

// The MCP client starts us from an arbitrary cwd, so be explicit about .env.
dotenv.config({ path: resolve(PROJECT_ROOT, ".env") });

function int(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new PostbusError(`${name} is not a number: "${raw}".`);
  return parsed;
}

export const PORT = int("PORT", 3000);
export const HOST = process.env.HOST?.trim() || "0.0.0.0";

export const TRUST_PROXY = (process.env.TRUST_PROXY?.trim() || "1").toLowerCase() !== "false";

export const DATABASE_PATH =
  process.env.DATABASE_PATH?.trim() || resolve(PROJECT_ROOT, "data", "postbus.db");

export const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE?.trim() || "4mb";

export const MAIL_TIMEOUT_MS = int("MAIL_TIMEOUT_MS", 30_000);

// How much of a single message we are willing to pull over and hand to the
// MIME parser. get_message and get_thread used to fetch the whole RFC822
// source, attachments included, for up to fifty messages at once.
export const MAX_MESSAGE_BYTES = int("MAX_MESSAGE_BYTES", 2 * 1024 * 1024);

export function getGoogleOAuthConfig(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  const port = int("OAUTH_CALLBACK_PORT", 53682);
  return { clientId, clientSecret, redirectUri: `http://localhost:${port}/oauth2callback` };
}

export const OAUTH_CALLBACK_PORT = int("OAUTH_CALLBACK_PORT", 53682);

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.labels",
];
