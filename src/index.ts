#!/usr/bin/env node
import crypto from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getTools, handleTool } from "./mcp/tools.js";
import { McpContext } from "./mcp/context.js";
import { log } from "./mcp/logger.js";
import { validateToolInput } from "./mcp/validation.js";
import { appendAuditRecord } from "./mcp/audit.js";

const server = new Server(
  { name: "mcp-for-i", version: "0.1.8" },
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
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  try {
    const toolDef = toolMap.get(name);
    if (!toolDef) throw new Error(`Unknown tool: ${name}`);
    const errors = validateToolInput(toolDef.inputSchema as any, args || {});
    if (errors.length > 0) {
      throw new Error(`Invalid arguments: ${errors.join("; ")}`);
    }
    const redactedArgs = redactSensitive(args || {});
    log("info", "tool.call", { name, correlationId, args: redactedArgs });
    const result = await handleTool(ctx, name, args || {});
    const durationMs = Date.now() - startedAt;
    log("debug", "tool.result", { name, correlationId, durationMs });
    await safeAppendAudit({
      tool: name,
      status: "ok",
      args: redactedArgs,
      connectionName: resolveConnectionName(name, args || {}, ctx.activeName),
      approve: Boolean(args && typeof args === "object" && (args as any).approve),
      durationMs,
      correlationId,
      resultSummary: summarizeResult(result)
    });
    return result;
  } catch (err: any) {
    const durationMs = Date.now() - startedAt;
    const errorMessage = err?.message || String(err);
    log("error", "tool.error", { name, correlationId, durationMs, error: errorMessage });
    await safeAppendAudit({
      tool: name,
      status: "error",
      args: redactSensitive(args || {}),
      connectionName: resolveConnectionName(name, args || {}, ctx.activeName),
      approve: Boolean(args && typeof args === "object" && (args as any).approve),
      durationMs,
      correlationId,
      error: errorMessage
    });
    return {
      isError: true,
      content: [{ type: "text", text: errorMessage }]
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

function summarizeResult(result: any) {
  const contentCount = Array.isArray(result?.content) ? result.content.length : 0;
  return {
    isError: Boolean(result?.isError),
    contentCount,
    hasStructuredContent: typeof result?.structuredContent !== "undefined"
  };
}

function resolveConnectionName(tool: string, args: any, activeName?: string) {
  if (args?.connectionName) return String(args.connectionName);
  if (tool === "ibmi.connect" && args?.name) return String(args.name);
  return activeName;
}

async function safeAppendAudit(input: Parameters<typeof appendAuditRecord>[0]) {
  if (process.env.MCP_FOR_I_AUDIT_ENABLED === "0") return;
  try {
    await appendAuditRecord(input);
  } catch (err: any) {
    log("warn", "audit.append.failed", { error: err?.message || String(err) });
  }
}
