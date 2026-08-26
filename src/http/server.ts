import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { MAX_BODY_SIZE, TRUST_PROXY } from "../config.js";
import { requireUser } from "./auth.js";
import { handleMcpRequest } from "./mcp.js";

export function createApp(): Express {
  const app = express();

  // Traefik terminates TLS and sets X-Forwarded-*.
  if (TRUST_PROXY) app.set("trust proxy", true);
  app.disable("x-powered-by");

  app.use(express.json({ limit: MAX_BODY_SIZE }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "postbus-mcp" });
  });

  app.post("/mcp", requireUser, (req, res, next) => {
    handleMcpRequest(req, res, req.postbusUser!).catch(next);
  });

  // Stateless: there is no server-initiated stream to attach to.
  app.get("/mcp", requireUser, (_req, res) => methodNotAllowed(res));
  app.delete("/mcp", requireUser, (_req, res) => methodNotAllowed(res));

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found", hint: "The MCP endpoint is POST /mcp." });
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[postbus-mcp] unexpected error:", error);
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
