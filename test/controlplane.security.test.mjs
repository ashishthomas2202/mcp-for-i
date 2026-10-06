import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Point every config path at a throwaway directory before loading modules.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-for-i-cp-"));
process.env.APPDATA = tempRoot;
process.env.XDG_CONFIG_HOME = tempRoot;
process.env.MCP_FOR_I_CREDENTIAL_STORE = "session";

const { startControlPlaneServer, MAX_BODY_BYTES } = await import("../dist/controlplane/server.js");
const { ensureControlToken, readControlToken, getControlTokenPath, isAllowedHostHeader, isAllowedOrigin } =
  await import("../dist/controlplane/auth.js");
const { RuntimeService, sanitizeRepoUrl, sanitizeBranch } = await import("../dist/controlplane/runtimeService.js");
const { buildBashLauncherScript } = await import("../dist/controlplane/serviceManager.js");
const { connectionEndpointChanged } = await import("../dist/controlplane/connectionService.js");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_HEADER = "x-mcp-for-i-token";

function request(port, { method = "GET", path: urlPath = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: urlPath,
      headers: { Host: `127.0.0.1:${port}`, ...headers }
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", err => {
      // The server may close the socket after rejecting a large body.
      if (err.code === "ECONNRESET" || err.code === "EPIPE") resolve({ status: 0, text: "", json: undefined });
      else reject(err);
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test("control token is created once, persisted and owner-only", { concurrency: false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-for-i-token-"));
  const first = ensureControlToken(dir);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(ensureControlToken(dir), first);
  assert.equal(readControlToken(dir), first);
  if (process.platform !== "win32") {
    const mode = fs.statSync(getControlTokenPath(dir)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test("Host and Origin checks only accept this local server", () => {
  assert.equal(isAllowedHostHeader("127.0.0.1:3980", 3980), true);
  assert.equal(isAllowedHostHeader("localhost:3980", 3980), true);
  assert.equal(isAllowedHostHeader("[::1]:3980", 3980), true);
  assert.equal(isAllowedHostHeader("127.0.0.1:3981", 3980), false);
  assert.equal(isAllowedHostHeader("evil.example:3980", 3980), false);
  assert.equal(isAllowedHostHeader(undefined, 3980), false);
  assert.equal(isAllowedOrigin(undefined, 3980), true);
  assert.equal(isAllowedOrigin("http://localhost:3980", 3980), true);
  assert.equal(isAllowedOrigin("http://evil.example:3980", 3980), false);
  assert.equal(isAllowedOrigin("null", 3980), false);
  assert.equal(isAllowedOrigin("https://127.0.0.1:3980", 3980), false);
});

test("control plane API requires token, local Host, same Origin, JSON and a size limit", async () => {
  const server = await startControlPlaneServer({ port: 0, rootDir: tempRoot });
  const { port, token } = server;
  try {
    const page = await request(port, { path: "/" });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(`<meta name="mcp-for-i-token" content="${token}" />`));
    assert.equal(page.headers["x-frame-options"], "DENY");

    assert.equal((await request(port, { path: "/api/settings" })).status, 401);
    assert.equal((await request(port, { path: "/api/settings", headers: { [TOKEN_HEADER]: "0".repeat(64) } })).status, 401);
    assert.equal((await request(port, { path: "/api/settings", headers: { [TOKEN_HEADER]: token } })).status, 200);

    const rebinding = await request(port, { path: "/api/settings", headers: { Host: `evil.example:${port}`, [TOKEN_HEADER]: token } });
    assert.equal(rebinding.status, 421);
    const rebindingPage = await request(port, { path: "/", headers: { Host: `evil.example:${port}` } });
    assert.equal(rebindingPage.status, 421);
    assert.ok(!rebindingPage.text.includes(token));

    const crossOrigin = await request(port, {
      method: "PUT",
      path: "/api/settings",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json", [TOKEN_HEADER]: token },
      body: JSON.stringify({ sessionIdleMinutes: 5 })
    });
    assert.equal(crossOrigin.status, 403);

    const textPlain = await request(port, {
      method: "PUT",
      path: "/api/settings",
      headers: { "Content-Type": "text/plain", [TOKEN_HEADER]: token },
      body: JSON.stringify({ sessionIdleMinutes: 5 })
    });
    assert.equal(textPlain.status, 415);

    const sameOrigin = await request(port, {
      method: "PUT",
      path: "/api/settings",
      headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json", [TOKEN_HEADER]: token },
      body: JSON.stringify({ sessionIdleMinutes: 5 })
    });
    assert.equal(sameOrigin.status, 200);

    const big = await request(port, {
      method: "PUT",
      path: "/api/settings",
      headers: { "Content-Type": "application/json", [TOKEN_HEADER]: token },
      body: JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES + 10) })
    });
    assert.ok(big.status === 413 || big.status === 0, `expected 413, got ${big.status}`);

    const badJson = await request(port, {
      method: "PUT",
      path: "/api/settings",
      headers: { "Content-Type": "application/json", [TOKEN_HEADER]: token },
      body: "{not json"
    });
    assert.equal(badJson.status, 400);

    const publicHealth = await request(port, { path: "/api/health" });
    assert.equal(publicHealth.status, 200);
    assert.deepEqual(Object.keys(publicHealth.json).sort(), ["ok", "service"]);
    const fullHealth = await request(port, { path: "/api/health", headers: { [TOKEN_HEADER]: token } });
    assert.ok("credentialStore" in fullHealth.json);

    const injected = await request(port, {
      path: "/api/runtime/versions?repoUrl=" + encodeURIComponent("--upload-pack=calc.exe"),
      headers: { [TOKEN_HEADER]: token }
    });
    assert.equal(injected.status, 400);

    const injectedUpdate = await request(port, {
      method: "POST",
      path: "/api/runtime/update/skills",
      headers: { "Content-Type": "application/json", [TOKEN_HEADER]: token },
      body: JSON.stringify({ branch: "--upload-pack=calc.exe" })
    });
    assert.equal(injectedUpdate.status, 400);
  } finally {
    await server.close();
  }
});

test("a connection's host, port or user cannot change without re-entering the password", async () => {
  const server = await startControlPlaneServer({ port: 0, rootDir: tempRoot });
  const { port, token } = server;
  const json = { "Content-Type": "application/json", [TOKEN_HEADER]: token };
  const name = `CP_TEST_${Date.now()}`;
  try {
    const created = await request(port, {
      method: "POST",
      path: "/api/connections",
      headers: json,
      body: JSON.stringify({ name, host: "good.example", port: 22, username: "DEV", password: "secret", storePassword: true })
    });
    assert.equal(created.status, 201);

    const duplicate = await request(port, {
      method: "POST",
      path: "/api/connections",
      headers: json,
      body: JSON.stringify({ name, host: "evil.example", username: "DEV" })
    });
    assert.equal(duplicate.status, 409);

    const redirect = await request(port, {
      method: "PUT",
      path: `/api/connections/${encodeURIComponent(name)}`,
      headers: json,
      body: JSON.stringify({ host: "evil.example" })
    });
    assert.equal(redirect.status, 400);
    const after = await request(port, { path: `/api/connections/${encodeURIComponent(name)}`, headers: { [TOKEN_HEADER]: token } });
    assert.equal(after.json.connection.host, "good.example");

    const otherField = await request(port, {
      method: "PUT",
      path: `/api/connections/${encodeURIComponent(name)}`,
      headers: json,
      body: JSON.stringify({ host: "GOOD.example", settings: { currentLibrary: "QGPL" } })
    });
    assert.equal(otherField.status, 200);

    const withPassword = await request(port, {
      method: "PUT",
      path: `/api/connections/${encodeURIComponent(name)}`,
      headers: json,
      body: JSON.stringify({ host: "new.example", password: "newsecret", storePassword: true })
    });
    assert.equal(withPassword.status, 200);
    assert.equal(withPassword.json.connection.host, "new.example");
  } finally {
    await request(port, { method: "DELETE", path: `/api/connections/${encodeURIComponent(name)}`, headers: { [TOKEN_HEADER]: token } });
    await server.close();
  }
});

test("connectionEndpointChanged compares host, port and user", () => {
  const base = { host: "a.example", port: 22, username: "DEV" };
  assert.equal(connectionEndpointChanged(base, { ...base }), false);
  assert.equal(connectionEndpointChanged(base, { ...base, host: "A.EXAMPLE" }), false);
  assert.equal(connectionEndpointChanged(base, { ...base, host: "b.example" }), true);
  assert.equal(connectionEndpointChanged(base, { ...base, port: 2222 }), true);
  assert.equal(connectionEndpointChanged(base, { ...base, username: "OTHER" }), true);
});

test("skills repo URL and branch reject option injection", () => {
  assert.equal(sanitizeRepoUrl("https://github.com/o/r.git"), "https://github.com/o/r.git");
  assert.equal(sanitizeRepoUrl("git@github.com:o/r.git"), "git@github.com:o/r.git");
  assert.equal(sanitizeRepoUrl("ssh://git@github.com/o/r.git"), "ssh://git@github.com/o/r.git");
  assert.equal(sanitizeRepoUrl(""), undefined);
  for (const bad of [
    "--upload-pack=calc.exe",
    "-u calc",
    "ext::sh -c touch% /tmp/x",
    "file:///etc",
    "http://github.com/o/r.git",
    "C:\\repos\\skills",
    "ssh://-oProxyCommand=calc/x",
    "https://github.com/o/r.git --upload-pack=x"
  ]) {
    assert.throws(() => sanitizeRepoUrl(bad), /repoUrl/, bad);
  }

  assert.equal(sanitizeBranch("main"), "main");
  assert.equal(sanitizeBranch("feature/new-ui_2"), "feature/new-ui_2");
  for (const bad of ["--upload-pack=x", "-b", "a..b", "a b", "a~1", "a^", "a:b", "x.lock", ".hidden", "a/", "a//b", "@", "a@{1}", "a\\b", "a*"]) {
    assert.throws(() => sanitizeBranch(bad), /branch/, bad);
  }
});

test("runtime jobs return immediately and report progress through status", async () => {
  const runtime = new RuntimeService(tempRoot);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const job = await runtime["runJob"]("updateMcp", async push => {
    push("working");
    await gate;
  });
  assert.equal(job.status, "running");
  assert.equal(runtime.getStatus().updateMcp.status, "running");

  const again = await runtime["runJob"]("updateMcp", async () => {});
  assert.equal(again.status, "running");

  release();
  const done = await runtime.waitForJob("updateMcp");
  assert.equal(done.status, "success");
  assert.ok(done.finishedAt);
});

test("Bash launcher health check uses the configured port", () => {
  const script = buildBashLauncherScript({ scriptPath: "/opt/x/index.js", nodePath: "/usr/bin/node", logFile: "/tmp/cp.log", port: 4123 });
  assert.ok(script.includes('PORT="${MCP_FOR_I_CONTROL_PORT:-4123}"'));
  assert.ok(script.includes('URL="http://127.0.0.1:${PORT}/api/health"'));
  assert.ok(!script.includes("3980"));
  assert.ok(script.includes('MCP_FOR_I_CONTROL_PORT="$PORT" nohup'));
});

test("mcp-for-i control serve keeps running until stopped", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(repoRoot, "dist", "index.js"), "control", "serve"], {
    env: { ...process.env, MCP_FOR_I_CONTROL_PORT: String(port), MCP_FOR_I_CONTROL_HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const exited = new Promise(resolve => child.once("exit", code => resolve(code)));
  try {
    const deadline = Date.now() + 15000;
    while (!stderr.includes("running at") && Date.now() < deadline && child.exitCode === null) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(stderr.includes("running at"), `server did not start: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(child.exitCode, null, "serve exited early");
    const health = await request(port, { path: "/api/health" });
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
  } finally {
    child.kill();
    await exited;
  }
});

test.after(async () => {
  await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
});
