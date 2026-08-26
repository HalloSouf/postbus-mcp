import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { DATABASE_PATH } from "../config.js";
import { PostbusError } from "../types.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  mkdirSync(dirname(DATABASE_PATH), { recursive: true });

  db = new Database(DATABASE_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);

  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export function databasePath(): string {
  return DATABASE_PATH;
}

// Migrations are additive and idempotent; user_version tracks how far we got.
function migrate(database: Database.Database): void {
  const migrations: Array<(d: Database.Database) => void> = [
    (d) => {
      d.exec(`
        CREATE TABLE users (
          id             TEXT PRIMARY KEY,
          label          TEXT NOT NULL,
          api_token_hash TEXT NOT NULL UNIQUE,
          created_at     TEXT NOT NULL,
          disabled       INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE mail_accounts (
          id                 TEXT PRIMARY KEY,
          user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          alias              TEXT NOT NULL,
          email              TEXT NOT NULL,
          provider           TEXT NOT NULL DEFAULT 'imap',
          display_name       TEXT,
          imap_host          TEXT,
          imap_port          INTEGER,
          imap_secure        INTEGER NOT NULL DEFAULT 1,
          smtp_host          TEXT,
          smtp_port          INTEGER,
          smtp_secure        INTEGER NOT NULL DEFAULT 1,
          username           TEXT,
          encrypted_password TEXT NOT NULL,
          created_at         TEXT NOT NULL,
          UNIQUE (user_id, alias)
        );

        CREATE INDEX idx_mail_accounts_user ON mail_accounts (user_id);
      `);
    },

    // The alias column was compared binary by UNIQUE but NOCASE by every
    // lookup, so "work" and "Work" were two rows that every query treated as
    // one. Give the column the collation the code already assumes, after
    // folding any duplicates that slipped in.
    (d) => {
      d.exec(`
        DELETE FROM mail_accounts WHERE id NOT IN (
          SELECT id FROM mail_accounts m
          WHERE m.id = (
            SELECT x.id FROM mail_accounts x
            WHERE x.user_id = m.user_id AND lower(x.alias) = lower(m.alias)
            ORDER BY x.created_at, x.id
            LIMIT 1
          )
        );

        CREATE TABLE mail_accounts_v2 (
          id                 TEXT PRIMARY KEY,
          user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          alias              TEXT NOT NULL COLLATE NOCASE,
          email              TEXT NOT NULL,
          provider           TEXT NOT NULL DEFAULT 'imap',
          display_name       TEXT,
          imap_host          TEXT,
          imap_port          INTEGER,
          imap_secure        INTEGER NOT NULL DEFAULT 1,
          smtp_host          TEXT,
          smtp_port          INTEGER,
          smtp_secure        INTEGER NOT NULL DEFAULT 1,
          username           TEXT,
          encrypted_password TEXT NOT NULL,
          created_at         TEXT NOT NULL,
          UNIQUE (user_id, alias)
        );

        INSERT INTO mail_accounts_v2
          SELECT id, user_id, alias, email, provider, display_name,
                 imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
                 username, encrypted_password, created_at
          FROM mail_accounts;

        DROP TABLE mail_accounts;
        ALTER TABLE mail_accounts_v2 RENAME TO mail_accounts;

        CREATE INDEX idx_mail_accounts_user ON mail_accounts (user_id);
      `);
    },
  ];

  const current = database.pragma("user_version", { simple: true }) as number;

  // A rollback to an older image would otherwise run old code against a newer
  // schema and corrupt quietly instead of refusing loudly.
  if (current > migrations.length) {
    throw new PostbusError(
      `The database is newer than this version of postbus-mcp (schema ${current}, expected at most ${migrations.length}).`,
      "Deploy the version it was migrated with, or restore a backup from before the upgrade.",
      "config",
    );
  }

  for (let version = current; version < migrations.length; version++) {
    const migration = migrations[version];
    if (!migration) continue;

    database.transaction(() => {
      migration(database);
      database.pragma(`user_version = ${version + 1}`);
    })();
  }
}
