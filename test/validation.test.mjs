import test from "node:test";
import assert from "node:assert/strict";
import { getTools } from "../dist/mcp/tools.js";
import { validateToolInput } from "../dist/mcp/validation.js";

test("ibmi.connect requires saved connection name", () => {
  const tool = getTools().find(t => t.name === "ibmi.connect");
  assert.ok(tool, "ibmi.connect tool is missing");

  const missing = validateToolInput(tool.inputSchema, {});
  assert.ok(missing.some(msg => msg.includes("$.name is required")));

  const withName = validateToolInput(tool.inputSchema, { name: "DEV400" });
  assert.equal(withName.length, 0);

  const withLegacyFields = validateToolInput(tool.inputSchema, { name: "DEV400", host: "legacy.example.com" });
  assert.ok(withLegacyFields.some(msg => msg.includes("$.host is not allowed")));
});

test("ibmi.sql.execute validates sql argument type", () => {
  const tool = getTools().find(t => t.name === "ibmi.sql.execute");
  assert.ok(tool, "ibmi.sql.execute tool is missing");

  const wrongType = validateToolInput(tool.inputSchema, { sql: 123 });
  assert.ok(wrongType.some(msg => msg.includes("$.sql must be string")));

  const valid = validateToolInput(tool.inputSchema, { sql: "delete from mylib.mytable" });
  assert.equal(valid.length, 0);
});

test("ibmi.connections.add rejects secret-bearing arguments", () => {
  const tool = getTools().find(t => t.name === "ibmi.connections.add");
  assert.ok(tool, "ibmi.connections.add tool is missing");

  const withPassword = validateToolInput(tool.inputSchema, {
    name: "DEV400",
    host: "dev400.company.com",
    username: "DEVUSER",
    password: "secret"
  });
  assert.ok(withPassword.some(msg => msg.includes("$.password is not allowed")));
});
