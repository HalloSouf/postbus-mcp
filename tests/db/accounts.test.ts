import { beforeEach, describe, expect, it } from "vitest";
import {
  accountExists,
  getAccount,
  listAccounts,
  removeAccount,
  saveGmailApiAccount,
  saveImapAccount,
} from "../../src/db/accounts.js";
import { closeDb, getDb } from "../../src/db/index.js";
import {
  createUser,
  deleteUser,
  findUserById,
  findUserByToken,
  listUsers,
  rotateToken,
  setUserDisabled,
} from "../../src/db/users.js";
import { PostbusError, type ImapAccount } from "../../src/types.js";

// Every test starts with a fresh in-memory database.
beforeEach(() => {
  closeDb();
  getDb();
});

const IMAP = {
  imapHost: "imap.example.com",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "smtp.example.com",
  smtpPort: 465,
  smtpSecure: true,
};

function addMailbox(userId: string, alias: string, email: string, password = "app-password") {
  return saveImapAccount({ userId, alias, email, username: email, password, ...IMAP });
}

describe("users and tokens", () => {
  it("finds the user behind a token and nobody behind a wrong one", () => {
    const { user, token } = createUser("Soufiane");

    expect(findUserByToken(token)?.id).toBe(user.id);
    expect(findUserByToken("pb_does-not-exist")).toBeUndefined();
    expect(findUserByToken("")).toBeUndefined();
  });

  it("never stores a readable token in the database", () => {
    const { token } = createUser("Soufiane");
    const rows = getDb().prepare("SELECT api_token_hash AS h FROM users").all() as { h: string }[];

    expect(rows[0]?.h).not.toBe(token);
    expect(rows[0]?.h).toHaveLength(64);
  });

  it("keeps a disabled user out", () => {
    const { user, token } = createUser("Soufiane");

    setUserDisabled(user.id, true);
    expect(findUserByToken(token)).toBeUndefined();

    setUserDisabled(user.id, false);
    expect(findUserByToken(token)?.id).toBe(user.id);
  });

  it("invalidates the old token on rotation", () => {
    const { user, token } = createUser("Soufiane");
    const nieuw = rotateToken(user.id);

    expect(findUserByToken(token)).toBeUndefined();
    expect(findUserByToken(nieuw)?.id).toBe(user.id);
  });

  it("counts mailboxes per user", () => {
    const { user } = createUser("Soufiane");
    addMailbox(user.id, "personal", "souf@example.com");
    addMailbox(user.id, "work", "souf@work.com");

    expect(listUsers().find((u) => u.id === user.id)?.accountCount).toBe(2);
  });

  it("deletes the mailboxes along with the user", () => {
    const { user } = createUser("Soufiane");
    addMailbox(user.id, "personal", "souf@example.com");

    expect(deleteUser(user.id)).toBe(true);
    expect(findUserById(user.id)).toBeUndefined();
    expect(listAccounts(user.id)).toEqual([]);
  });
});

describe("separation between users", () => {
  it("lets two users share an alias without touching each other", () => {
    const a = createUser("Soufiane").user;
    const b = createUser("Colleague").user;

    addMailbox(a.id, "personal", "souf@example.com", "password-a");
    addMailbox(b.id, "personal", "colleague@example.com", "password-b");

    expect((getAccount(a.id, "personal") as ImapAccount).password).toBe("password-a");
    expect((getAccount(b.id, "personal") as ImapAccount).password).toBe("password-b");
    expect(listAccounts(a.id)).toHaveLength(1);
  });

  it("makes someone else's alias simply not exist", () => {
    const a = createUser("Soufiane").user;
    const b = createUser("Colleague").user;
    addMailbox(b.id, "secret", "colleague@example.com");

    expect(accountExists(a.id, "secret")).toBe(false);
    expect(() => getAccount(a.id, "secret")).toThrow(PostbusError);
  });

  it("does not leak other people's aliases in the error", () => {
    const a = createUser("Soufiane").user;
    const b = createUser("Colleague").user;
    addMailbox(a.id, "personal", "souf@example.com");
    addMailbox(b.id, "payroll", "colleague@example.com");

    try {
      getAccount(a.id, "payroll");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as PostbusError).hint).toContain("personal");
      expect((error as PostbusError).hint).not.toContain("payroll");
    }
  });

  it("lets nobody delete another user's mailbox", () => {
    const a = createUser("Soufiane").user;
    const b = createUser("Colleague").user;
    addMailbox(b.id, "personal", "colleague@example.com");

    expect(removeAccount(a.id, "personal")).toBeUndefined();
    expect(accountExists(b.id, "personal")).toBe(true);
    expect(removeAccount(b.id, "personal")).toBeTypeOf("string");
  });
});

describe("mailbox storage", () => {
  it("stores the app password encrypted and hands it back decrypted", () => {
    const { user } = createUser("Soufiane");
    addMailbox(user.id, "personal", "souf@example.com", "abcd efgh ijkl mnop");

    const stored = getDb().prepare("SELECT encrypted_password AS p FROM mail_accounts").get() as {
      p: string;
    };

    expect(stored.p).not.toContain("abcd");
    expect(stored.p.startsWith("enc:v1:")).toBe(true);
    expect((getAccount(user.id, "personal") as ImapAccount).password).toBe("abcd efgh ijkl mnop");
  });

  it("keeps credentials out of what the tools show", () => {
    const { user } = createUser("Soufiane");
    addMailbox(user.id, "personal", "souf@example.com", "secret");

    const listed = listAccounts(user.id)[0];

    expect(JSON.stringify(listed)).not.toContain("secret");
    expect(listed).not.toHaveProperty("password");
    expect(listed?.server).toBe("imap.example.com:993");
  });

  it("looks up an alias case-insensitively", () => {
    const { user } = createUser("Soufiane");
    addMailbox(user.id, "Personal", "souf@example.com");

    expect(getAccount(user.id, "PERSONAL").alias).toBe("Personal");
    expect(accountExists(user.id, "personal")).toBe(true);
  });

  it("replaces an existing alias instead of adding a second", () => {
    const { user } = createUser("Soufiane");
    addMailbox(user.id, "work", "old@example.com", "old-password");
    addMailbox(user.id, "work", "new@example.com", "new-password");

    expect(listAccounts(user.id)).toHaveLength(1);
    expect(getAccount(user.id, "work").email).toBe("new@example.com");
    expect((getAccount(user.id, "work") as ImapAccount).password).toBe("new-password");
  });

  it("sorts the list by alias", () => {
    const { user } = createUser("Soufiane");
    addMailbox(user.id, "work", "b@example.com");
    addMailbox(user.id, "archive", "a@example.com");

    expect(listAccounts(user.id).map((a) => a.alias)).toEqual(["archive", "work"]);
  });

  it("stores a Gmail API mailbox with an encrypted refresh token", () => {
    const { user } = createUser("Soufiane");
    saveGmailApiAccount({
      userId: user.id,
      alias: "gmail",
      email: "souf@gmail.com",
      refreshToken: "1//refresh-token",
    });

    const account = getAccount(user.id, "gmail");
    expect(account.provider).toBe("gmail-api");
    expect(account.provider === "gmail-api" && account.refreshToken).toBe("1//refresh-token");
  });

  it("rejects an unknown alias with a usable hint", () => {
    const { user } = createUser("Soufiane");

    expect(() => getAccount(user.id, "doesnotexist")).toThrow(/Unknown mailbox/);
    try {
      getAccount(user.id, "doesnotexist");
    } catch (error) {
      expect((error as PostbusError).hint).toMatch(/add_mail_account/);
    }
  });
});
