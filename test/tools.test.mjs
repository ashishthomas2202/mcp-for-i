import test from "node:test";
import assert from "node:assert/strict";
import { getTools } from "../dist/mcp/tools.js";

test("getTools exposes expected tool names", () => {
  const tools = getTools();
  const names = tools.map(t => t.name);

  const expected = [
    "ibmi.actions.list",
    "ibmi.actions.run",
    "ibmi.deploy.compare",
    "ibmi.deploy.sync",
    "ibmi.ifs.shortcuts.list",
    "ibmi.ifs.shortcuts.add",
    "ibmi.ifs.shortcuts.delete",
    "ibmi.filters.list",
    "ibmi.filters.save",
    "ibmi.filters.delete",
    "ibmi.debug.status",
    "ibmi.debug.startService",
    "ibmi.debug.stopService",
    "ibmi.session.bootstrap",
    "ibmi.source.resolve",
    "ibmi.source.inspect",
    "ibmi.docs.search",
    "ibmi.docs.open"
  ];

  for (const name of expected) {
    assert.ok(names.includes(name), `missing tool: ${name}`);
  }

  const uniqueCount = new Set(names).size;
  assert.equal(uniqueCount, names.length, "tool names should be unique");
});

test("source tool additions are optional and preserve legacy required arguments", () => {
  const byName = new Map(getTools().map(tool => [tool.name, tool]));
  const list = byName.get("ibmi.qsys.members.list");
  const read = byName.get("ibmi.qsys.members.read");
  const write = byName.get("ibmi.qsys.members.write");

  assert.deepEqual(list.inputSchema.required, ["library", "sourceFile"]);
  assert.deepEqual(read.inputSchema.required, ["library", "sourceFile", "member"]);
  assert.deepEqual(write.inputSchema.required, ["library", "sourceFile", "member", "content"]);
  assert.equal(list.inputSchema.properties.connectionName.type, "string");
  assert.equal(read.inputSchema.properties.responseFormat.enum.includes("structured"), true);
  assert.equal(write.inputSchema.properties.expectedVersion.type, "string");
});

test("all tools enforce strict top-level input schemas", () => {
  const tools = getTools();
  for (const tool of tools) {
    assert.ok(tool.inputSchema, `missing inputSchema for ${tool.name}`);
    assert.equal(
      tool.inputSchema.additionalProperties,
      false,
      `expected additionalProperties=false for ${tool.name}`
    );
  }
});
