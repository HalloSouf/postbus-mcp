import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { registerTools } from "../tools/index.js";
import type { User } from "../types.js";

// One server per request, built around the token's user. Tools are registered
// with that user baked in, so they cannot reach another tenant's mailboxes.
export function createMcpServer(user: User): McpServer {
  const server = new McpServer(
    { name: "postbus-mcp", version: "0.2.0" },
    {
      instructions:
        "postbus-mcp gives access to this user's mailboxes. " +
        "Start with list_accounts to see which aliases exist, then pass one as `account` to " +
        "search_emails, get_message, get_thread and send_email. " +
        "If no mailbox is linked yet, use add_mail_account (address + app password). " +
        "Every search_emails result carries an id and a threadId: get_message reads one message, " +
        "get_thread the whole conversation. " +
        "send_email sends immediately — confirm the content with the user before calling it.",
    },
  );

  registerTools(server, { user });
  return server;
}

export async function handleMcpRequest(req: Request, res: Response, user: User): Promise<void> {
  const server = createMcpServer(user);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
