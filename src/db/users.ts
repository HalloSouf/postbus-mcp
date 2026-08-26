import { randomBytes } from "node:crypto";
import { generateApiToken, hashToken } from "../crypto.js";
import { PostbusError, type User } from "../types.js";
import { getDb } from "./index.js";

interface UserRow {
  id: string;
  label: string;
  created_at: string;
  disabled: number;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    disabled: row.disabled === 1,
  };
}

export function newId(): string {
  return randomBytes(9).toString("base64url");
}

// The token is returned once and only its hash is stored: lost is lost.
export function createUser(label: string): { user: User; token: string } {
  const token = generateApiToken();
  const row: UserRow = {
    id: newId(),
    label: label.trim() || "unnamed",
    created_at: new Date().toISOString(),
    disabled: 0,
  };

  getDb()
    .prepare(
      `INSERT INTO users (id, label, api_token_hash, created_at, disabled)
       VALUES (@id, @label, @hash, @created_at, 0)`,
    )
    .run({ ...row, hash: hashToken(token) });

  return { user: toUser(row), token };
}

export function findUserByToken(token: string): User | undefined {
  const row = getDb()
    .prepare<[string], UserRow>(
      `SELECT id, label, created_at, disabled FROM users WHERE api_token_hash = ?`,
    )
    .get(hashToken(token));

  if (!row || row.disabled === 1) return undefined;
  return toUser(row);
}

export function listUsers(): Array<User & { accountCount: number }> {
  const rows = getDb()
    .prepare<[], UserRow & { account_count: number }>(
      `SELECT u.id, u.label, u.created_at, u.disabled,
              (SELECT COUNT(*) FROM mail_accounts m WHERE m.user_id = u.id) AS account_count
       FROM users u
       ORDER BY u.created_at`,
    )
    .all();

  return rows.map((row) => ({ ...toUser(row), accountCount: row.account_count }));
}

export function findUserById(id: string): User | undefined {
  const row = getDb()
    .prepare<[string], UserRow>(`SELECT id, label, created_at, disabled FROM users WHERE id = ?`)
    .get(id);

  return row ? toUser(row) : undefined;
}

export function rotateToken(userId: string): string {
  const token = generateApiToken();
  const result = getDb()
    .prepare(`UPDATE users SET api_token_hash = ? WHERE id = ?`)
    .run(hashToken(token), userId);

  if (result.changes === 0) throw new PostbusError(`Unknown user "${userId}".`);
  return token;
}

export function setUserDisabled(userId: string, disabled: boolean): void {
  const result = getDb()
    .prepare(`UPDATE users SET disabled = ? WHERE id = ?`)
    .run(disabled ? 1 : 0, userId);

  if (result.changes === 0) throw new PostbusError(`Unknown user "${userId}".`);
}

export function deleteUser(userId: string): boolean {
  return getDb().prepare(`DELETE FROM users WHERE id = ?`).run(userId).changes > 0;
}
