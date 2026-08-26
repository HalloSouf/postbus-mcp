import { describe, expect, it } from "vitest";
import { resolveSettings } from "../../src/tools/accounts.js";
import { findPreset } from "../../src/providers/imap/presets.js";
import { PostbusError } from "../../src/types.js";

describe("findPreset", () => {
  it("recognises well-known domains", () => {
    expect(findPreset("souf@gmail.com")?.imapHost).toBe("imap.gmail.com");
    expect(findPreset("souf@hotmail.nl")?.imapHost).toBe("outlook.office365.com");
    expect(findPreset("souf@me.com")?.imapHost).toBe("imap.mail.me.com");
  });

  it("matches by name and ignores case", () => {
    expect(findPreset("Fastmail")?.smtpHost).toBe("smtp.fastmail.com");
    expect(findPreset("GMAIL")?.imapHost).toBe("imap.gmail.com");
  });

  it("returns nothing for an unknown domain", () => {
    expect(findPreset("souf@ownserver.com")).toBeUndefined();
    expect(findPreset(undefined)).toBeUndefined();
  });
});

describe("resolveSettings", () => {
  it("fills in host and port for a known provider", () => {
    expect(resolveSettings({ email: "souf@gmail.com" })).toEqual({
      imapHost: "imap.gmail.com",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
      smtpSecure: true,
    });
  });

  it("picks STARTTLS where the provider wants it (Outlook on 587)", () => {
    const settings = resolveSettings({ email: "souf@outlook.com" });

    expect(settings.smtpPort).toBe(587);
    expect(settings.smtpSecure).toBe(false);
  });

  it("does not force implicit TLS on a non-standard port", () => {
    // Regression: port 3143 used to get implicit TLS and the connection blew up.
    const settings = resolveSettings({
      email: "souf@ownserver.com",
      imap_host: "127.0.0.1",
      imap_port: 3143,
      smtp_host: "127.0.0.1",
      smtp_port: 3025,
    });

    expect(settings.imapSecure).toBe(false);
    expect(settings.smtpSecure).toBe(false);
  });

  it("keeps implicit TLS on the standard ports", () => {
    const settings = resolveSettings({
      email: "souf@ownserver.com",
      imap_host: "imap.ownserver.com",
      imap_port: 993,
      smtp_host: "smtp.ownserver.com",
      smtp_port: 465,
    });

    expect(settings.imapSecure).toBe(true);
    expect(settings.smtpSecure).toBe(true);
  });

  it("lets the user override TLS explicitly", () => {
    const settings = resolveSettings({
      email: "souf@ownserver.com",
      imap_host: "imap.ownserver.com",
      imap_port: 1993,
      imap_secure: true,
      smtp_host: "smtp.ownserver.com",
      smtp_port: 465,
      smtp_secure: false,
    });

    expect(settings.imapSecure).toBe(true);
    expect(settings.smtpSecure).toBe(false);
  });

  it("lets an explicit host win over the preset", () => {
    const settings = resolveSettings({
      email: "souf@gmail.com",
      imap_host: "imap.own-proxy.com",
    });

    expect(settings.imapHost).toBe("imap.own-proxy.com");
    expect(settings.smtpHost).toBe("smtp.gmail.com");
  });

  it("asks for server details when the domain is unknown", () => {
    try {
      resolveSettings({ email: "souf@ownserver.com" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PostbusError);
      expect((error as PostbusError).message).toContain("souf@ownserver.com");
      expect((error as PostbusError).hint).toMatch(/imap_host/);
    }
  });
});
