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

// The derived key is cached, so restore the env after every key experiment.
afterEach(() => {
  process.env.MASTER_KEY = KEY;
  resetKeyCache();
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips the original secret", () => {
    const secret = "abcd efgh ijkl mnop";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("handles non-ASCII and long values", () => {
    const secret = `password-wíth-emoji-🔐-${"x".repeat(500)}`;
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("produces different ciphertext each time (own IV per secret)", () => {
    const first = encryptSecret("same-password");
    const second = encryptSecret("same-password");

    expect(first).not.toBe(second);
    expect(decryptSecret(first)).toBe(decryptSecret(second));
  });

  it("is recognisable as stored form and leaks nothing", () => {
    const stored = encryptSecret("topsecret");

    expect(stored.startsWith("enc:v1:")).toBe(true);
    expect(stored).not.toContain("topsecret");
  });

  it("rejects tampered ciphertext (GCM tag mismatch)", () => {
    const stored = encryptSecret("topsecret");
    const [prefix, iv, tag, data] = [stored.slice(0, 7), ...stored.slice(7).split(":")] as [
      string,
      string,
      string,
      string,
    ];

    const flipped = `${data.startsWith("A") ? "B" : "A"}${data.slice(1)}`;
    expect(() => decryptSecret(`${prefix}${iv}:${tag}:${flipped}`)).toThrow(PostbusError);
  });

  it("rejects plain text that is not an encrypted secret", () => {
    expect(() => decryptSecret("just-a-password")).toThrow(/not stored encrypted/i);
  });

  it("fails with a usable message on a different MASTER_KEY", () => {
    const stored = encryptSecret("topsecret");

    process.env.MASTER_KEY = "f".repeat(64);
    resetKeyCache();

    expect(() => decryptSecret(stored)).toThrow(/Decryption failed/i);
  });

  it("accepts a passphrase as key too (via scrypt)", () => {
    process.env.MASTER_KEY = "a-long-passphrase-as-key";
    resetKeyCache();

    expect(decryptSecret(encryptSecret("secret"))).toBe("secret");
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

  it("complains when the key is too short to be worth anything", () => {
    process.env.MASTER_KEY = "kort";
    resetKeyCache();

    expect(() => assertMasterKey()).toThrow(/too short/i);
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
