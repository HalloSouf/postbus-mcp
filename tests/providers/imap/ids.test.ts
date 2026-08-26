import { describe, expect, it } from "vitest";
import {
  decodeMessageId,
  decodeThreadId,
  encodeMessageId,
  encodeReferenceThreadId,
  encodeServerThreadId,
  normalizeMessageIdHeader,
  parseReferences,
} from "../../../src/providers/imap/ids.js";
import { PostbusError } from "../../../src/types.js";

describe("message ids", () => {
  it("encodes and decodes without loss", () => {
    const ref = { mailbox: "INBOX", uidValidity: "1787752052", uid: 42 };
    expect(decodeMessageId(encodeMessageId(ref))).toEqual(ref);
  });

  it("survives folder names with slashes, spaces and brackets", () => {
    const ref = { mailbox: "[Gmail]/All Mail", uidValidity: "1", uid: 7 };
    expect(decodeMessageId(encodeMessageId(ref))).toEqual(ref);
  });

  it("survives a colon in the folder name (that is our separator too)", () => {
    const ref = { mailbox: "Archief:2026", uidValidity: "99", uid: 3 };
    const encoded = encodeMessageId(ref);

    expect(encoded.split(":")).toHaveLength(3);
    expect(decodeMessageId(encoded)).toEqual(ref);
  });

  it("rejects nonsense instead of fetching the wrong message", () => {
    for (const broken of ["kapot", "INBOX:1", "INBOX:1:abc", "INBOX::5", ":1:5"]) {
      expect(() => decodeMessageId(broken), broken).toThrow(PostbusError);
    }
  });
});

describe("thread ids", () => {
  it("encodes and decodes a server thread (Gmail X-GM-THRID / RFC 8474)", () => {
    const encoded = encodeServerThreadId("1829384756");

    expect(encoded).toBe("srv:1829384756");
    expect(decodeThreadId(encoded)).toEqual({ kind: "server", id: "1829384756" });
  });

  it("encodes and decodes a reconstructed thread", () => {
    const encoded = encodeReferenceThreadId("<abc+def/ghi@mail.example>");

    expect(encoded.startsWith("ref:")).toBe(true);
    expect(encoded).not.toContain("@");
    expect(decodeThreadId(encoded)).toEqual({
      kind: "references",
      rootMessageId: "<abc+def/ghi@mail.example>",
    });
  });

  it("rejects a thread id without a known prefix", () => {
    expect(() => decodeThreadId("1829384756")).toThrow(PostbusError);
    expect(() => decodeThreadId("srv:")).toThrow(PostbusError);
  });
});

describe("header helpers", () => {
  it("normalises Message-ID to the angle-bracket form", () => {
    expect(normalizeMessageIdHeader("<abc@x.nl>")).toBe("<abc@x.nl>");
    expect(normalizeMessageIdHeader("  <abc@x.nl>  ")).toBe("<abc@x.nl>");
    expect(normalizeMessageIdHeader("abc@x.nl")).toBe("<abc@x.nl>");
    expect(normalizeMessageIdHeader(undefined)).toBeUndefined();
    expect(normalizeMessageIdHeader("   ")).toBeUndefined();
  });

  it("pulls every id out of a References chain, in order", () => {
    const header = "<een@x.nl> <twee@x.nl>\r\n <drie@x.nl>";
    expect(parseReferences(header)).toEqual(["<een@x.nl>", "<twee@x.nl>", "<drie@x.nl>"]);
  });

  it("returns an empty list when the header is missing", () => {
    expect(parseReferences(undefined)).toEqual([]);
    expect(parseReferences("")).toEqual([]);
  });
});
