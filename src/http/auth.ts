import type { NextFunction, Request, Response } from "express";
import { findUserByToken } from "../db/users.js";
import type { User } from "../types.js";

declare module "express-serve-static-core" {
  interface Request {
    postbusUser?: User;
  }
}

// One token per user, handed out by the operator. No signup, by design.
const BEARER = /^Bearer\s+(.+)$/i;

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  const match = BEARER.exec(req.header("authorization") ?? "");
  const token = match?.[1]?.trim();

  if (!token) {
    unauthorized(res, "invalid_request", "Send your token as: Authorization: Bearer <token>");
    return;
  }

  const user = findUserByToken(token);
  if (!user) {
    unauthorized(res, "invalid_token", "This token is unknown or disabled.");
    return;
  }

  req.postbusUser = user;
  next();
}

function unauthorized(res: Response, code: string, description: string): void {
  res
    .status(401)
    .set("WWW-Authenticate", `Bearer error="${code}", error_description="${description}"`)
    .json({
      jsonrpc: "2.0",
      error: { code: -32001, message: `Unauthorized: ${description}` },
      id: null,
    });
}
