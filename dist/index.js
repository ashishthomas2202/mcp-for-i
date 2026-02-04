#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getTools, handleTool } from "./mcp/tools.js";
import { McpContext } from "./mcp/context.js";
import { log } from "./mcp/logger.js";
const server = new Server({ name: "mcp-for-i", version: "0.1.0" }, { capabilities: { tools: {} } });
const ctx = new McpContext();
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getTools()
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        log("info", "tool.call", { name, args });
        const result = await handleTool(ctx, name, args || {});
        log("debug", "tool.result", { name });
        return result;
    }
    catch (err) {
        log("error", "tool.error", { name, error: err?.message || String(err) });
        return {
            isError: true,
            content: [{ type: "text", text: err?.message || String(err) }]
        };
    }
});
const transport = new StdioServerTransport();
await server.connect(transport);
