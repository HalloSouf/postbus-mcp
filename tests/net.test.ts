import { describe, expect, it } from "vitest";
import { assertMailHostAllowed, isLoopbackHost } from "../src/net.js";

describe("isLoopbackHost", () => {
  it("recognises the addresses a local bridge listens on", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "LocalHost"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it("does not mistake a public host for a bridge", () => {
    for (const host of ["imap.gmail.com", "8.8.8.8", "10.0.0.1", "2606:4700::1111"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("assertMailHostAllowed", () => {
  it("allows a local bridge", async () => {
    await expect(assertMailHostAllowed("127.0.0.1")).resolves.toBeUndefined();
  });

  it("refuses literal addresses inside the private network", async () => {
    for (const host of ["10.0.0.5", "192.168.1.10", "172.16.0.1", "169.254.169.254", "fd00::1"]) {
      await expect(assertMailHostAllowed(host)).rejects.toThrow(/private network/);
    }
  });

  it("allows a public literal address", async () => {
    await expect(assertMailHostAllowed("8.8.8.8")).resolves.toBeUndefined();
  });

  it("refuses an empty hostname", async () => {
    await expect(assertMailHostAllowed("  ")).rejects.toThrow(/required/);
  });
});
