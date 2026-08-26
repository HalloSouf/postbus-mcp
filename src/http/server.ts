import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { MAX_BODY_SIZE, TRUST_PROXY } from "../config.js";
import { getDb } from "../db/index.js";
import { logEvent } from "../log.js";
import { pooledConnectionCount } from "../providers/imap/connection.js";
import { requireUser } from "./auth.js";
import { handleMcpRequest } from "./mcp.js";
import { rateLimit } from "./rate-limit.js";

export function createApp(): Express {
  const app = express();

  // Traefik terminates TLS and sets X-Forwarded-*.
  if (TRUST_PROXY) app.set("trust proxy", true);
  app.disable("x-powered-by");

  // A static ok told the healthcheck everything was fine while the volume was
  // read-only or the database was locked, so Traefik kept sending traffic.
  app.get("/health", (_req, res) => {
    try {
      getDb().prepare("SELECT 1").get();
      res.json({
        status: "ok",
        service: "postbus-mcp",
        pooledConnections: pooledConnectionCount(),
      });
    } catch (error) {
      logEvent({ event: "health", ok: false, error: String(error) });
      res.status(503).json({ status: "unavailable", service: "postbus-mcp" });
    }
  });

  // Body parsing sits behind the token: without that, an unauthenticated
  // caller could make the server parse a full MAX_BODY_SIZE payload per
  // request before anything checked who they were.
  app.post(
    "/mcp",
    requireUser,
    rateLimit,
    express.json({ limit: MAX_BODY_SIZE }),
    (req, res, next) => {
      handleMcpRequest(req, res, req.postbusUser!).catch(next);
    },
  );

  // Stateless: there is no server-initiated stream to attach to.
  app.get("/mcp", requireUser, (_req, res) => methodNotAllowed(res));
  app.delete("/mcp", requireUser, (_req, res) => methodNotAllowed(res));

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found", hint: "The MCP endpoint is POST /mcp." });
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    logEvent({ event: "request_failed", error: `${error.name}: ${error.message}` });
    if (res.headersSent) return;

    res.status(500).json({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: null,
    });
  });

  return app;
}

function methodNotAllowed(res: Response): void {
  res
    .status(405)
    .set("Allow", "POST")
    .json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "This server is stateless: use POST /mcp." },
      id: null,
    });
}
