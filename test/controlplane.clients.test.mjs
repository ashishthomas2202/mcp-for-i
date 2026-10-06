import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSpawnSpec,
  escapeCmdArgument,
  resolveWindowsCommand,
  runCommand
} from "../dist/controlplane/clientIntegrationService.js";

test("non-Windows platforms spawn the command directly", () => {
  const spec = buildSpawnSpec("codex", ["mcp", "get", "mcp-for-i"], "linux", {});
  assert.deepEqual(spec, { file: "codex", args: ["mcp", "get", "mcp-for-i"], windowsVerbatimArguments: false });
});

test("escapeCmdArgument quotes and caret-escapes cmd metacharacters", () => {
  assert.equal(escapeCmdArgument("a b", false), '^"a^ b^"');
  assert.equal(escapeCmdArgument('say "hi"', false), '^"say^ \\^"hi\\^"^"');
  assert.equal(escapeCmdArgument("dir\\", false), '^"dir\\\\^"');
  assert.equal(escapeCmdArgument("a&b", true), '^^^"a^^^&b^^^"');
});

test("Windows .cmd shims are resolved through PATHEXT and receive arguments intact", { skip: process.platform !== "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-for-i-shim-"));
  try {
    fs.writeFileSync(path.join(dir, "echo-args.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    // Same shape as the npm-generated shims for codex/claude/code.
    fs.writeFileSync(path.join(dir, "fakecli.cmd"), `@"${process.execPath}" "%~dp0echo-args.js" %*\r\n`);
    const env = { ...process.env, PATH: `${dir};${process.env.PATH || ""}` };

    const resolved = resolveWindowsCommand("fakecli", env);
    assert.equal(resolved?.toLowerCase(), path.join(dir, "fakecli.cmd").toLowerCase());
    assert.equal(resolveWindowsCommand("definitely-not-a-command-xyz", env), undefined);

    const args = [
      "mcp",
      "add",
      "mcp-for-i",
      "--",
      "C:\\Program Files (x86)\\nodejs\\node.exe",
      JSON.stringify({ name: "mcp-for-i", command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\x y\\dist\\index.js"] }),
      "a&b|c<d>e^f",
      "100% done!",
      "trailing\\"
    ];
    const result = await runCommand("fakecli", args, env);
    assert.equal(result.ok, true, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
