import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigStore, ConfigCorruptError } from "../dist/config/store.js";
import { writeFileAtomic } from "../dist/util/atomicWrite.js";
import { acquireFileLock, withFileLock } from "../dist/util/fileLock.js";

const distStore = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/config/store.js")).href;

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("load creates defaults only when config.json does not exist", async () => {
  const dir = await tempDir("mcp-for-i-store-");
  try {
    const store = new ConfigStore({ configDir: dir });
    const cfg = await store.load();
    assert.deepEqual(cfg.connections, []);
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8"));
    assert.equal(onDisk.settings.tempLibrary, "ILEDITOR");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt config.json is backed up and never overwritten", async () => {
  const dir = await tempDir("mcp-for-i-store-");
  try {
    const configPath = path.join(dir, "config.json");
    const corrupt = '{"connections":[{"name":"PROD","host":"prod.example.com"';
    await fs.writeFile(configPath, corrupt, "utf8");

    const store = new ConfigStore({ configDir: dir });
    await assert.rejects(() => store.load(), err => err instanceof ConfigCorruptError && Boolean(err.backupPath));
    await assert.rejects(() => store.upsertAction({ name: "x", command: "y" }), ConfigCorruptError);
    await assert.rejects(() => store.listConnections(), ConfigCorruptError);

    assert.equal(await fs.readFile(configPath, "utf8"), corrupt, "the original file must be untouched");
    const backups = (await fs.readdir(dir)).filter(name => name.startsWith("config.json.corrupt-"));
    assert.equal(backups.length, 1, "the same corrupt content is backed up once");
    assert.equal(await fs.readFile(path.join(dir, backups[0]), "utf8"), corrupt);

    // After the user repairs the file, the store works again.
    await fs.writeFile(configPath, JSON.stringify({ connections: [], settings: {}, actions: [] }), "utf8");
    const repaired = await store.load();
    assert.deepEqual(repaired.actions, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an empty config.json is treated as missing", async () => {
  const dir = await tempDir("mcp-for-i-store-");
  try {
    await fs.writeFile(path.join(dir, "config.json"), "", "utf8");
    const cfg = await new ConfigStore({ configDir: dir }).load();
    assert.deepEqual(cfg.connections, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("concurrent updates from separate store instances are not lost", async () => {
  const dir = await tempDir("mcp-for-i-store-");
  try {
    const a = new ConfigStore({ configDir: dir });
    const b = new ConfigStore({ configDir: dir });
    await a.load();
    const writes = [];
    for (let i = 0; i < 15; i++) {
      writes.push((i % 2 ? a : b).upsertAction({ name: `action-${i}`, command: `CMD ${i}` }));
    }
    writes.push(a.updateSettings({ tempDir: "/tmp/one" }));
    writes.push(b.updateSettings({ homeDirectory: "/home/two" }));
    await Promise.all(writes);

    const cfg = await new ConfigStore({ configDir: dir }).load();
    assert.equal(cfg.actions.length, 15);
    assert.equal(cfg.settings.tempDir, "/tmp/one");
    assert.equal(cfg.settings.homeDirectory, "/home/two");
    const leftovers = (await fs.readdir(dir)).filter(name => name.endsWith(".tmp") || name.endsWith(".lock"));
    assert.deepEqual(leftovers, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("concurrent updates from several processes are not lost", async () => {
  const dir = await tempDir("mcp-for-i-store-");
  try {
    await new ConfigStore({ configDir: dir }).load();
    const script = `
      const { ConfigStore } = await import(${JSON.stringify(distStore)});
      const store = new ConfigStore({ configDir: process.argv[1] });
      const worker = process.argv[2];
      for (let i = 0; i < 8; i++) {
        await store.upsertAction({ name: "w" + worker + "-" + i, command: "CMD" });
      }
    `;
    const workers = [0, 1, 2, 3].map(
      worker =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, String(worker)], {
            stdio: ["ignore", "ignore", "pipe"]
          });
          let stderr = "";
          child.stderr.on("data", chunk => (stderr += chunk));
          child.on("error", reject);
          child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`worker ${worker} exited ${code}: ${stderr}`))));
        })
    );
    await Promise.all(workers);
    const cfg = await new ConfigStore({ configDir: dir }).load();
    assert.equal(cfg.actions.length, 32);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("writeFileAtomic replaces the file and leaves no temp files", async () => {
  const dir = await tempDir("mcp-for-i-atomic-");
  try {
    const target = path.join(dir, "data.json");
    await fs.writeFile(target, "old", "utf8");
    await Promise.all(Array.from({ length: 10 }, (_, i) => writeFileAtomic(target, `value-${i}`)));
    assert.match(await fs.readFile(target, "utf8"), /^value-\d$/);
    assert.deepEqual(await fs.readdir(dir), ["data.json"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("file lock waits for a live holder, times out, and breaks stale locks", async () => {
  const dir = await tempDir("mcp-for-i-lock-");
  try {
    const lockPath = path.join(dir, "thing.lock");
    const holder = await acquireFileLock(lockPath);
    await assert.rejects(() => acquireFileLock(lockPath, { timeoutMs: 150 }), /Timed out/);
    await holder.release();

    // A lock left behind by a crashed process (old mtime) is broken.
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, hostname: "other-host", token: "x" }), "utf8");
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lockPath, old, old);
    const taken = await acquireFileLock(lockPath, { staleMs: 5_000, timeoutMs: 2_000 });
    await taken.release();
    await assert.rejects(() => fs.access(lockPath));

    // In-process callers are serialized in order.
    const order = [];
    await Promise.all(
      [1, 2, 3].map(n =>
        withFileLock(lockPath, async () => {
          order.push(`start-${n}`);
          await new Promise(resolve => setTimeout(resolve, 5));
          order.push(`end-${n}`);
        })
      )
    );
    assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);

    // A failing holder does not block the next one.
    await assert.rejects(() => withFileLock(lockPath, async () => { throw new Error("boom"); }), /boom/);
    assert.equal(await withFileLock(lockPath, () => "ok"), "ok");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
