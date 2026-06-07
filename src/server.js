#!/usr/bin/env node
// agent-synapse MCP server (stdio).
//
// IMPORTANT: an MCP stdio server must keep stdout clean for the JSON-RPC
// protocol. Never console.log here — use console.error (stderr) for any logging.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const server = new McpServer({
  name: "agent-synapse",
  version: "0.1.0",
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("[agent-synapse] MCP server running on stdio");
