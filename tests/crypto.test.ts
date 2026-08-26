import { afterEach, describe, expect, it } from "vitest";
import {
  assertMasterKey,
  decryptSecret,
  encryptSecret,
  generateApiToken,
  hashToken,
  resetKeyCache,
} from "../src/crypto.js";
import { PostbusError } from "../src/types.js";

const KEY = process.env.MASTER_KEY as string;

// Secrets are bound to the row they belong to.
const CONTEXT = "user1:account1";

// The derived key is cached, so restore the env after every key experiment.
afterEach(() => {
  process.env.MASTER_KEY = KEY;
  resetKeyCache();
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips the original secret", () => {
    const secret = "abcd efgh ijkl mnop";
    expect(decryptSecret(encryptSecret(secret, CONTEXT), CONTEXT)).toBe(secret);
  });

  it("handles non-ASCII and long values", () => {
    const secret = `password-wíth-emoji-🔐-${"x".repeat(500)}`;
    expect(decryptSecret(encryptSecret(secret, CONTEXT), CONTEXT)).toBe(secret);
  });

  it("produces different ciphertext each time (own IV per secret)", () => {
    const first = encryptSecret("same-password", CONTEXT);
    const second = encryptSecret("same-password", CONTEXT);

    expect(first).not.toBe(second);
    expect(decryptSecret(first, CONTEXT)).toBe(decryptSecret(second, CONTEXT));
  });

  it("is recognisable as stored form and leaks nothing", () => {
    const stored = encryptSecret("topsecret", CONTEXT);

    expect(stored.startsWith("enc:v2:")).toBe(true);
    expect(stored).not.toContain("topsecret");
  });

  it("rejects tampered ciphertext (GCM tag mismatch)", () => {
    const stored = encryptSecret("topsecret", CONTEXT);
    const [prefix, iv, tag, data] = [stored.slice(0, 7), ...stored.slice(7).split(":")] as [
      string,
      string,
      string,
      string,
    ];

    const flipped = `${data.startsWith("A") ? "B" : "A"}${data.slice(1)}`;
    expect(() => decryptSecret(`${prefix}${iv}:${tag}:${flipped}`, CONTEXT)).toThrow(PostbusError);
  });

  it("rejects plain text that is not an encrypted secret", () => {
    expect(() => decryptSecret("just-a-password", CONTEXT)).toThrow(/not stored encrypted/i);
  });

  it("fails with a usable message on a different MASTER_KEY", () => {
    const stored = encryptSecret("topsecret", CONTEXT);

    process.env.MASTER_KEY = "f".repeat(64);
    resetKeyCache();

    expect(() => decryptSecret(stored, CONTEXT)).toThrow(/Decryption failed/i);
  });

  // A passphrase was stretched against a salt hardcoded into the project, so
  // one precomputed table covered every install that ever used one.
  it("refuses a passphrase and says how to migrate", () => {
    process.env.MASTER_KEY = "a-long-passphrase-as-key";
    resetKeyCache();

    expect(() => encryptSecret("secret", CONTEXT)).toThrow(/64 hex characters/);
  });

  it("refuses to decrypt a secret lifted into another row", () => {
    const stored = encryptSecret("topsecret", "user1:account1");

    expect(() => decryptSecret(stored, "user2:account9")).toThrow(/Decryption failed/i);
    expect(decryptSecret(stored, "user1:account1")).toBe("topsecret");
  });
});

describe("assertMasterKey", () => {
  it("complains with a hint when the key is missing", () => {
    delete process.env.MASTER_KEY;
    resetKeyCache();

    try {
      assertMasterKey();
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PostbusError);
      expect((error as PostbusError).hint).toMatch(/openssl rand -hex 32/);
    }
  });

  it("complains when the key is not a 256-bit hex key", () => {
    for (const key of ["kort", "a-long-passphrase-as-key", "f".repeat(63), "z".repeat(64)]) {
      process.env.MASTER_KEY = key;
      resetKeyCache();

      expect(() => assertMasterKey()).toThrow(/64 hex characters/);
    }
  });
});

describe("API tokens", () => {
  it("hashes deterministically and irreversibly", () => {
    const token = "pb_example";

    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toHaveLength(64);
  });

  it("ignores whitespace around a pasted token", () => {
    expect(hashToken("  pb_example\n")).toBe(hashToken("pb_example"));
  });

  it("gives different tokens different hashes", () => {
    expect(hashToken("pb_a")).not.toBe(hashToken("pb_b"));
  });

  it("generates recognisable, unique tokens", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateApiToken()));

    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token.startsWith("pb_")).toBe(true);
      expect(token.length).toBeGreaterThan(40);
    }
  });
});
