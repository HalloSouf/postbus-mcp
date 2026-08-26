import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_LIMIT_PER_MINUTE } from "../../src/config.js";
import { rateLimit, resetRateLimits } from "../../src/http/rate-limit.js";
import type { User } from "../../src/types.js";

function user(id: string): User {
  return { id, label: id, createdAt: "2026-08-26T00:00:00.000Z", disabled: false };
}

// Minimal Request/Response pair, enough for the middleware.
function call(postbusUser?: User) {
  const req = { postbusUser } as unknown as Request;
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
  rateLimit(req, res as unknown as Response, next);

  return { res, passed: (next as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0 };
}

beforeEach(() => resetRateLimits());

describe("rateLimit", () => {
  it("lets a normal amount of traffic through", () => {
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      expect(call(user("u1")).passed).toBe(true);
    }
  });

  it("refuses the call after the budget is spent and says when to retry", () => {
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) call(user("u1"));

    const { res, passed } = call(user("u1"));

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["Retry-After"])).toBeGreaterThan(0);
  });

  // One noisy token must not spend anybody else's budget.
  it("counts each token separately", () => {
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) call(user("u1"));

    expect(call(user("u1")).passed).toBe(false);
    expect(call(user("u2")).passed).toBe(true);
  });

  it("opens a fresh window once the minute has passed", () => {
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) call(user("u1"));
    expect(call(user("u1")).passed).toBe(false);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    expect(call(user("u1")).passed).toBe(true);
    vi.restoreAllMocks();
  });

  // Unauthenticated requests never reach here; if one did, requireUser is the
  // thing that should reject it, not this.
  it("stays out of the way when there is no user", () => {
    expect(call(undefined).passed).toBe(true);
  });
});
