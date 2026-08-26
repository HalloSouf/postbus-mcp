import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";
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

const port = z.coerce.number().int().min(1).max(65535);
const bytes = z.coerce.number().int().positive();

// Zod validates tool input already; the environment deserves the same rather
// than a NaN that only shows up as a listen() failure much later.
const schema = z.object({
  PORT: port.default(3000),
  HOST: z.string().trim().min(1).default("0.0.0.0"),

  // Off unless asked for. Trusting X-Forwarded-* by default makes req.ip
  // spoofable by any client when there is no reverse proxy in front, and the
  // safe direction is the one you have to opt out of.
  TRUST_PROXY: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((value) => value === "true" || value === "1"),

  DATABASE_PATH: z
    .string()
    .trim()
    .min(1)
    .default(resolve(PROJECT_ROOT, "data", "postbus.db")),
  MAX_BODY_SIZE: z.string().trim().min(1).default("4mb"),
  MAIL_TIMEOUT_MS: bytes.default(30_000),

  // How much of a single message we are willing to pull over and hand to the
  // MIME parser. get_message and get_thread used to fetch the whole RFC822
  // source, attachments included, for up to fifty messages at once.
  MAX_MESSAGE_BYTES: bytes.default(2 * 1024 * 1024),

  // Per token, per minute. A mailbox call is slow and hits someone else's
  // server, so this is about keeping one client from monopolising the pool.
  RATE_LIMIT_PER_MINUTE: bytes.default(60),
  MAX_ACCOUNTS_PER_USER: bytes.default(20),

  OAUTH_CALLBACK_PORT: port.default(53682),
  GOOGLE_CLIENT_ID: z.string().trim().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().trim().min(1).optional(),
});

function load(): z.infer<typeof schema> {
  // Empty strings are how a .env says "not set", not how it says "".
  const present = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value?.trim()),
  );

  const parsed = schema.safeParse(present);
  if (parsed.success) return parsed.data;

  const problems = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");

  throw new PostbusError(`The environment is not valid: ${problems}.`, undefined, "config");
}

const config = load();

export const PORT = config.PORT;
export const HOST = config.HOST;
export const TRUST_PROXY = config.TRUST_PROXY;
export const DATABASE_PATH = config.DATABASE_PATH;
export const MAX_BODY_SIZE = config.MAX_BODY_SIZE;
export const MAIL_TIMEOUT_MS = config.MAIL_TIMEOUT_MS;
export const MAX_MESSAGE_BYTES = config.MAX_MESSAGE_BYTES;
export const RATE_LIMIT_PER_MINUTE = config.RATE_LIMIT_PER_MINUTE;
export const MAX_ACCOUNTS_PER_USER = config.MAX_ACCOUNTS_PER_USER;
export const OAUTH_CALLBACK_PORT = config.OAUTH_CALLBACK_PORT;

export function getGoogleOAuthConfig(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} | null {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) return null;

  return {
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    redirectUri: `http://localhost:${config.OAUTH_CALLBACK_PORT}/oauth2callback`,
  };
}

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.labels",
];
