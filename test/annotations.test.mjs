import test from "node:test";
import assert from "node:assert/strict";
import { getTools } from "../dist/mcp/tools.js";

test("every tool advertises MCP annotations", () => {
  for (const tool of getTools()) {
    const a = tool.annotations;
    assert.ok(a, `${tool.name} has no annotations`);
    for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assert.equal(typeof a[key], "boolean", `${tool.name}.${key}`);
    }
    if (a.readOnlyHint) assert.equal(a.destructiveHint, false, `${tool.name} is read-only and destructive`);
  }
});

test("annotations mark safe and dangerous tools correctly", () => {
  const byName = new Map(getTools().map(tool => [tool.name, tool.annotations]));
  assert.equal(byName.get("ibmi.sql.query").readOnlyHint, true);
  assert.equal(byName.get("ibmi.qsys.members.read").readOnlyHint, true);
  assert.equal(byName.get("ibmi.docs.open").openWorldHint, true);
  assert.equal(byName.get("ibmi.sql.execute").destructiveHint, true);
  assert.equal(byName.get("ibmi.cl.run").destructiveHint, true);
  assert.equal(byName.get("ibmi.ifs.delete").destructiveHint, true);
  assert.equal(byName.get("ibmi.libl.add").destructiveHint, false);
  assert.equal(byName.get("ibmi.libl.add").readOnlyHint, false);
});
