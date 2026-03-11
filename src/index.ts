#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getTools, handleTool } from "./mcp/tools.js";
import { McpContext } from "./mcp/context.js";
import { log } from "./mcp/logger.js";
import { validateToolInput } from "./mcp/validation.js";

const server = new Server(
  { name: "mcp-for-i", version: "0.1.3" },
  { capabilities: { tools: {} } }
);

const ctx = new McpContext();
const tools = getTools();
const toolMap = new Map(tools.map(tool => [tool.name, tool]));

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const toolDef = toolMap.get(name);
    if (!toolDef) throw new Error(`Unknown tool: ${name}`);
    const errors = validateToolInput(toolDef.inputSchema as any, args || {});
    if (errors.length > 0) {
      throw new Error(`Invalid arguments: ${errors.join("; ")}`);
    }
    log("info", "tool.call", { name, args: redactSensitive(args || {}) });
    const result = await handleTool(ctx, name, args || {});
    log("debug", "tool.result", { name });
    return result;
  } catch (err: any) {
    log("error", "tool.error", { name, error: err?.message || String(err) });
    return {
      isError: true,
      content: [{ type: "text", text: err?.message || String(err) }]
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

function redactSensitive(input: unknown): unknown {
  const secrets = new Set(["password", "passphrase", "secret", "token", "apikey", "apiKey", "authorization"]);
  if (Array.isArray(input)) {
    return input.map(redactSensitive);
  }
  if (typeof input === "object" && input !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (secrets.has(key)) {
        out[key] = "***REDACTED***";
      } else {
        out[key] = redactSensitive(value);
      }
    }
    return out;
  }
  return input;
}
