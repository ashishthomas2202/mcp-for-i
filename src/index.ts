#!/usr/bin/env node
import crypto from "crypto";
import fs from "fs";
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { getTools, handleTool } from "./mcp/tools.js";
import { McpContext } from "./mcp/context.js";
import { createElicitationConfirm } from "./mcp/confirm.js";
import { log } from "./mcp/logger.js";
import { redactSecrets, redactSecretsInText } from "./security/redact.js";
import { validateToolInput } from "./mcp/validation.js";
import { appendAuditRecord } from "./mcp/audit.js";
import { redactModuleArgs } from "./mcp/modules/index.js";
import { runControlCommand } from "./controlplane/commands.js";
import { ibmDocs } from "./ibmi/IbmDocs.js";

const argv = process.argv.slice(2);
const firstArg = (argv[0] || "").toLowerCase();
const packageVersion = readPackageVersion();

if (firstArg === "control") {
  await runControlCommand(argv.slice(1), {
    defaultCommand: "open",
    scriptPath: fileURLToPath(new URL("./controlplane/index.js", import.meta.url))
  });
  process.exit(0);
}

if (firstArg === "--version" || firstArg === "-v" || firstArg === "version") {
  process.stdout.write(`${packageVersion}\n`);
  process.exit(0);
}

if (firstArg === "--help" || firstArg === "-h" || firstArg === "help") {
  printHelp();
  process.exit(0);
}

const server = new Server(
  { name: "mcp-for-i", version: packageVersion },
  { capabilities: { tools: {}, resources: {} } }
);

const ctx = new McpContext();
ctx.confirm = createElicitationConfirm(server);
const tools = getTools();
const toolMap = new Map(tools.map(tool => [tool.name, tool]));

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "ibmi-docs://catalog",
      name: "IBM i documentation catalog",
      description: "Release-aware allowlist of official IBM i documentation available through mcp-for-i.",
      mimeType: "application/json"
    },
    ...ibmDocs.listResources()
  ]
}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [{
    uriTemplate: "ibmi-docs://topic/{ref}",
    name: "Official IBM i documentation topic",
    description: "Open a versioned official IBM i documentation topic using a ref from ibmi.docs.search.",
    mimeType: "text/markdown"
  }]
}));

server.setRequestHandler(ReadResourceRequestSchema, async request => {
  const uri = request.params.uri;
  const text = await ibmDocs.readResource(uri);
  return {
    contents: [{
      uri,
      mimeType: uri === "ibmi-docs://catalog" ? "application/json" : "text/markdown",
      text
    }]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const correlationId = crypto.randomUUID();
  const startedAt = Date.now();
  // Computed before the call: module redaction depends on the state the call starts from.
  let redactedArgs: unknown;
  try {
    const toolDef = toolMap.get(name);
    if (!toolDef) throw new Error(`Unknown tool: ${name}`);
    const errors = validateToolInput(toolDef.inputSchema as any, args || {});
    if (errors.length > 0) {
      throw new Error(`Invalid arguments: ${errors.join("; ")}`);
    }
    redactedArgs = redactSensitive(redactModuleArgs(ctx, name, args || {}));
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
      args: redactedArgs ?? redactSensitive(redactModuleArgs(ctx, name, args || {})),
      connectionName: resolveConnectionName(name, args || {}, ctx.activeName),
      approve: Boolean(args && typeof args === "object" && (args as any).approve),
      durationMs,
      correlationId,
      error: redactSecretsInText(errorMessage)
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
  return redactSecrets(input);
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

function printHelp() {
  process.stderr.write(`mcp-for-i usage:\n`);
  process.stderr.write(`  mcp-for-i                 Start MCP stdio server\n`);
  process.stderr.write(`  mcp-for-i control         Start/open control plane UI\n`);
  process.stderr.write(`  mcp-for-i control status  Show control plane and background-service status\n`);
  process.stderr.write(`  mcp-for-i control enable  Enable background service for this platform\n`);
  process.stderr.write(`  mcp-for-i control disable Disable background service for this platform\n`);
  process.stderr.write(`  mcp-for-i --version       Print package version\n`);
}

function readPackageVersion() {
  try {
    const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
