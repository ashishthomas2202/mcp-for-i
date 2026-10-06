import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Runs every test/*.test.mjs except the live IBM i integration suites.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "test");
const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs") && !name.includes(".integration."))
  .sort()
  .map((name) => path.join("test", name));

const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
