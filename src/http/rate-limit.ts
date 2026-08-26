import type { NextFunction, Request, Response } from "express";
import { RATE_LIMIT_PER_MINUTE } from "../config.js";
import { logEvent } from "../log.js";

/**
 * A fixed window per token. Deliberately in-process and dependency-free: this
 * server is one container per deployment, and the thing being protected is a
 * connection pool that talks to someone else's mail server, not a CPU budget.
 */
const WINDOW_MS = 60_000;

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const userId = req.postbusUser?.id;
  if (!userId) return next();

  const now = Date.now();
  const window = windows.get(userId);

  if (!window || window.resetAt <= now) {
    windows.set(userId, { count: 1, resetAt: now + WINDOW_MS });
    sweep(now);
    return next();
  }

  if (window.count >= RATE_LIMIT_PER_MINUTE) {
    const retryAfter = Math.ceil((window.resetAt - now) / 1000);
    logEvent({ event: "rate_limited", userId, retryAfter });

    res
      .status(429)
      .set("Retry-After", String(retryAfter))
      .json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `Too many requests. Try again in ${retryAfter}s.`,
        },
        id: null,
      });
    return;
  }

  window.count += 1;
  next();
}

// Windows are tiny, but a server that runs for months should not accumulate
// one per token that ever connected.
function sweep(now: number): void {
  if (windows.size < 1000) return;
  for (const [userId, window] of windows) {
    if (window.resetAt <= now) windows.delete(userId);
  }
}

export function resetRateLimits(): void {
  windows.clear();
}
