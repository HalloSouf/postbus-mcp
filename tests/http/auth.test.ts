import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "../../src/db/index.js";
import { createUser, setUserDisabled } from "../../src/db/users.js";
import { requireUser } from "../../src/http/auth.js";

beforeEach(() => {
  closeDb();
  getDb();
});

// Minimal Request/Response pair, enough for the middleware.
function call(authorization?: string) {
  const req = {
    header: (name: string) => (name.toLowerCase() === "authorization" ? authorization : undefined),
  } as unknown as Request;

  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    set(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };

  const next = vi.fn() as unknown as NextFunction;
  requireUser(req, res as unknown as Response, next);

  return { req, res, next: next as unknown as ReturnType<typeof vi.fn> };
}

describe("requireUser", () => {
  it("lets a valid token through and attaches the user", () => {
    const { user, token } = createUser("Soufiane");
    const { req, next } = call(`Bearer ${token}`);

    expect(next).toHaveBeenCalledOnce();
    expect(req.postbusUser?.id).toBe(user.id);
  });

  it("accepts the scheme in any casing", () => {
    const { token } = createUser("Soufiane");

    expect(call(`bearer ${token}`).next).toHaveBeenCalledOnce();
    expect(call(`BEARER  ${token}`).next).toHaveBeenCalledOnce();
  });

  it("rejects a request without an Authorization header", () => {
    const { res, next } = call(undefined);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toContain("invalid_request");
  });

  it("rejects a different auth scheme", () => {
    const { res, next } = call("Basic c291ZjpnZWhlaW0=");

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("rejects an unknown token", () => {
    const { res, next } = call("Bearer pb_does-not-exist");

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toContain("invalid_token");
  });

  it("rejects a disabled user's token", () => {
    const { user, token } = createUser("Soufiane");
    setUserDisabled(user.id, true);

    expect(call(`Bearer ${token}`).next).not.toHaveBeenCalled();
  });

  it("gives nothing about the token away in the response", () => {
    const { res } = call("Bearer pb_topsecret");
    expect(JSON.stringify(res.body)).not.toContain("topsecret");
  });
});
