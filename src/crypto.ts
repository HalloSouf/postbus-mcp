import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { PostbusError } from "./types.js";

// These secrets unlock other people's mailboxes, so MASTER_KEY is mandatory.
const PREFIX_V1 = "enc:v1:";
const PREFIX_V2 = "enc:v2:";

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.MASTER_KEY?.trim();
  if (!raw) {
    throw new PostbusError(
      "MASTER_KEY is missing.",
      "Generate one with `openssl rand -hex 32` and put it in .env or your docker-compose environment. " +
        "Without it, stored app passwords can be neither written nor read.",
      "config",
    );
  }

  // A passphrase used to be accepted and stretched with scrypt against a salt
  // that is hardcoded and therefore identical in every install of this project
  // — which is precisely the work a salt exists to prevent. One table cracks
  // every deployment at once, so only a real 256-bit key is allowed.
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    throw new PostbusError(
      "MASTER_KEY must be 64 hex characters (a 256-bit key).",
      "Generate one with `openssl rand -hex 32`. A passphrase is no longer accepted: it was " +
        "stretched against a salt shared by every postbus-mcp install. If your current key is a " +
        "passphrase, set a hex key and link the mailboxes again — the old secrets cannot be read " +
        "with the new key.",
      "config",
    );
  }

  cachedKey = Buffer.from(raw, "hex");
  return cachedKey;
}

export function assertMasterKey(): void {
  getKey();
}

export function resetKeyCache(): void {
  cachedKey = null;
}

/**
 * `context` is bound into the GCM tag, so a ciphertext only decrypts in the
 * row it was written for. Lifting a blob from one tenant's row into another's
 * then fails the tag check instead of silently handing over their mailbox.
 */
export function encryptSecret(value: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));

  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX_V2}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptSecret(value: string, context: string): string {
  // v1 predates the context binding. Still readable, so an existing database
  // keeps working; anything rewritten comes back as v2.
  const version = value.startsWith(PREFIX_V2) ? 2 : value.startsWith(PREFIX_V1) ? 1 : 0;

  if (version === 0) {
    throw new PostbusError(
      "A secret in the database is not stored encrypted.",
      "Remove the mailbox and add it again with add_mail_account.",
      "config",
    );
  }

  const [ivPart, tagPart, dataPart] = value.slice(PREFIX_V1.length).split(":");
  if (!ivPart || !tagPart || !dataPart) {
    throw new PostbusError("An encrypted secret in the database is corrupt.", undefined, "config");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivPart, "base64"));
    if (version === 2) decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new PostbusError(
      "Decryption failed.",
      "MASTER_KEY differs from the key this mailbox was stored with. " +
        "Restore the old key, or remove the mailbox and add it again.",
      "config",
    );
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

export function generateApiToken(): string {
  return `pb_${randomBytes(32).toString("base64url")}`;
}
