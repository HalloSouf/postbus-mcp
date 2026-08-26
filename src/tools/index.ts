import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountTools } from "./accounts.js";
import type { ToolContext } from "./context.js";
import { registerMailTools } from "./mail.js";

export function registerTools(server: McpServer, context: ToolContext): void {
  registerAccountTools(server, context);
  registerMailTools(server, context);
}
