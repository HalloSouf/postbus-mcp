import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { PostbusError } from "./types.js";

// These secrets unlock other people's mailboxes, so MASTER_KEY is mandatory.
const PREFIX = "enc:v1:";
const SALT = "postbus-mcp/v1";

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.MASTER_KEY?.trim();
  if (!raw) {
    throw new PostbusError(
      "MASTER_KEY is missing.",
      "Generate one with `openssl rand -hex 32` and put it in .env or your docker-compose environment. " +
        "Without it, stored app passwords can be neither written nor read.",
    );
  }

  if (raw.length < 16) {
    throw new PostbusError(
      "MASTER_KEY is too short (16 characters minimum; `openssl rand -hex 32` is better).",
    );
  }

  // 64 hex chars is a real 256-bit key; anything else is a passphrase.
  cachedKey = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : scryptSync(raw, SALT, 32);
  return cachedKey;
}

export function assertMasterKey(): void {
  getKey();
}

export function resetKeyCache(): void {
  cachedKey = null;
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptSecret(value: string): string {
  if (!value.startsWith(PREFIX)) {
    throw new PostbusError(
      "A secret in the database is not stored encrypted.",
      "Remove the mailbox and add it again with add_mail_account.",
    );
  }

  const [ivPart, tagPart, dataPart] = value.slice(PREFIX.length).split(":");
  if (!ivPart || !tagPart || !dataPart) {
    throw new PostbusError("An encrypted secret in the database is corrupt.");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivPart, "base64"));
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
    );
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

export function generateApiToken(): string {
  return `pb_${randomBytes(32).toString("base64url")}`;
}
