import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// tools.js first: it loads the tool modules.
import { getTools } from "../dist/mcp/tools.js";
import { debugReadiness, describeCertificate, probeTls } from "../dist/mcp/modules/debug.js";
import { PAGE_TOOLS, startWorkbenchServer } from "../dist/mcp/modules/workbench.js";
import { renderWorkbenchPage } from "../dist/mcp/modules/workbenchPage.js";

/** A context whose one connection answers commands and SQL from the rules given. */
function fakeCtx({ commands = {}, sql = [], host = "ibmi.example.com", config = {} } = {}) {
  const conn = {
    currentHost: host,
    getConfig: () => config,
    validQsysName: name => /^[A-Z#@$][A-Z0-9#@$_.]{0,9}$/.test(name),
    sendCommand: async ({ command }) => {
      for (const [needle, answer] of Object.entries(commands)) if (command.includes(needle)) return answer;
      return { code: 1, stdout: "", stderr: "not found" };
    },
    runSQL: async statement => {
      for (const [needle, rows] of sql) if (statement.includes(needle)) return rows;
      return [];
    }
  };
  return { activeName: "TEST", ensureActive: async () => conn };
}

const LISTENERS = [
  { LOCAL_PORT: 8005, JOB_NAME: "770954/QDBGSRV/QP0ZSPWT" },
  { LOCAL_PORT: 8008, JOB_NAME: "770954/QDBGSRV/QP0ZSPWT" },
  { LOCAL_PORT: 3825, JOB_NAME: "931251/QSECOFR/QB5ROUTER" }
];
const trusted = async () => ({ connected: true, authorized: true, protocol: "TLSv1.3" });
const byId = (result, id) => result.checks.find(check => check.id === id);

test("a system with nothing set up says what is missing and who puts it right", async () => {
  const result = await debugReadiness(fakeCtx(), {}, { probe: async () => ({ connected: false, error: "ECONNREFUSED" }), hasPassword: async () => false });
  assert.equal(result.ready, false);
  assert.equal(byId(result, "installed").ok, false);
  assert.equal(byId(result, "installed").who, "administrator");
  assert.equal(byId(result, "running").ok, false);
  assert.equal(byId(result, "debugServer").ok, false);
  assert.equal(byId(result, "certificate").ok, false);
  assert.match(byId(result, "reachable").detail, /ECONNREFUSED/);
  assert.equal(byId(result, "password").who, "you");
  assert.match(result.summary, /to put right first/);
});

test("an old service level is refused, a current one with everything in place is ready", async () => {
  const old = await debugReadiness(fakeCtx({ commands: { "package.json": { code: 0, stdout: '{"version":"2.0.1"}' } }, sql: [["netstat_job_info", LISTENERS]] }), { checkNetwork: false }, { hasPassword: async () => true });
  assert.equal(byId(old, "installed").ok, false);
  assert.match(byId(old, "installed").detail, /2\.0\.1/);
  assert.equal(byId(old, "reachable"), undefined, "the network is not tried when asked not to");

  // No certificate file in this fake: the certificate check fails, everything else passes.
  const now = await debugReadiness(fakeCtx({ commands: { "package.json": { code: 0, stdout: '{"version":"3.0.6","java":"11"}' } }, sql: [["netstat_job_info", LISTENERS]], config: { debugPort: 8005 } }), {}, { probe: trusted, hasPassword: async () => true });
  assert.equal(now.serviceVersion, "3.0.6");
  assert.equal(byId(now, "installed").ok, true);
  assert.equal(byId(now, "running").ok, true);
  assert.match(byId(now, "running").detail, /QDBGSRV/);
  assert.equal(byId(now, "debugServer").ok, true);
  assert.equal(byId(now, "sepDaemon").ok, true);
  assert.equal(byId(now, "password").ok, true);
  assert.deepEqual(result_blocking(now), ["certificate"]);
});

function result_blocking(result) {
  return result.checks.filter(check => check.ok === false).map(check => check.id);
}

test("a program is checked for debug data and for source changed since the compile", async () => {
  const modules = [
    { BOUND_MODULE: "ORDPOST", MODULE_ATTRIBUTE: "RPGLE", DEBUG_DATA: "*YES", SOURCE_CHANGE_TIMESTAMP: "2026-11-18-09.00.00.000000", SOURCE_NOW: "2026-11-19-10.00.00.000000" },
    { BOUND_MODULE: "ORDUTIL", MODULE_ATTRIBUTE: "RPGLE", DEBUG_DATA: "*NO", SOURCE_CHANGE_TIMESTAMP: "2026-11-18-09.00.00.000000", SOURCE_NOW: "2026-11-18-09.00.00.000000" }
  ];
  const ctx = fakeCtx({ sql: [["BOUND_MODULE_INFO", modules]] });
  const result = await debugReadiness(ctx, { library: "devlib", program: "ordpost", checkNetwork: false }, { hasPassword: async () => true });
  assert.equal(byId(result, "program").ok, true);
  assert.match(byId(result, "program").detail, /1 of 2 modules \(not in: ORDUTIL\)/);
  assert.match(byId(result, "sourceCurrent").detail, /ORDPOST/);
  assert.deepEqual(result.program.modules[0], { module: "ORDPOST", attribute: "RPGLE", debugData: true, sourceChangedSinceCompile: true });

  const none = await debugReadiness(fakeCtx({ sql: [["BOUND_MODULE_INFO", [{ ...modules[1] }]]] }), { library: "DEVLIB", program: "ORDUTIL", checkNetwork: false }, { hasPassword: async () => true });
  assert.equal(byId(none, "program").ok, false);
  assert.match(byId(none, "program").fix, /DBGVIEW/);
  await assert.rejects(debugReadiness(ctx, { library: "DEV'LIB", program: "X", checkNetwork: false }, { hasPassword: async () => true }), /Invalid library/);
});

/** A self-signed certificate for a host name, made with openssl when it is there. */
function selfSigned(hostName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpfori-cert-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-subj", `/CN=${hostName}`, "-addext", `subjectAltName=DNS:${hostName}`, "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem")], { stdio: "ignore" });
    return { cert: fs.readFileSync(path.join(dir, "c.pem"), "utf8"), key: fs.readFileSync(path.join(dir, "k.pem"), "utf8") };
  } catch {
    return undefined;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a certificate is read for its dates and the host it is for; a handshake says whether it is trusted", async t => {
  const made = selfSigned("localhost");
  if (!made) return t.skip("openssl is not available to make a test certificate");
  const about = describeCertificate(made.cert, "localhost");
  assert.equal(about.matchesHost, true);
  assert.equal(about.expired, false);
  assert.ok(about.daysLeft >= 28);
  assert.equal(describeCertificate(made.cert, "other.example.com").matchesHost, false);
  assert.equal(describeCertificate(made.cert, "localhost", new Date(Date.now() + 90 * 86_400_000)).expired, true);

  const tls = await import("node:tls");
  const server = tls.createServer({ cert: made.cert, key: made.key }, socket => socket.end());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const good = await probeTls("localhost", port, made.cert, 4000);
    assert.equal(good.connected, true);
    assert.equal(good.authorized, true);
    const stranger = await probeTls("localhost", port, undefined, 4000);
    assert.equal(stranger.connected, true);
    assert.equal(stranger.authorized, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  const closed = await probeTls("127.0.0.1", 1, undefined, 3000);
  assert.equal(closed.connected, false);
});

test("the workbench page is served only with its key, and calls only tools that read", async () => {
  const calls = [];
  const server = await startWorkbenchServer(
    async (tool, args) => {
      calls.push([tool, args]);
      if (args.fail) return { isError: true, content: [{ type: "text", text: "No such job." }] };
      return { structuredContent: { ok: true, data: { echoed: tool } } };
    },
    async () => ({ connections: [{ name: "TEST", host: "ibmi.example.com" }], active: "TEST" }),
    0
  );
  const base = `http://127.0.0.1:${server.port}`;
  const post = (tool, args, key = server.token, headers = {}) =>
    fetch(`${base}/api/call?t=${key}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ tool, args }) });
  try {
    assert.equal((await fetch(`${base}/`)).status, 401);
    assert.equal((await fetch(`${base}/?t=wrong`)).status, 401);
    const page = await fetch(server.urlFor({ connectionName: "TEST", jobName: "123456/A/B", view: "debug" }));
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(await page.text(), /IBM i workbench/);
    assert.match(server.urlFor({ jobName: "123456/A/B" }), /job=123456%2FA%2FB/);

    assert.deepEqual(await (await fetch(`${base}/api/connections?t=${server.token}`)).json(), { ok: true, connections: [{ name: "TEST", host: "ibmi.example.com" }], active: "TEST" });
    assert.deepEqual(await (await post("ibmi.jobs.find", { connectionName: "TEST" })).json(), { ok: true, data: { echoed: "ibmi.jobs.find" } });
    assert.deepEqual(await (await post("ibmi.jobs.log", { fail: true })).json(), { ok: false, error: "No such job." });

    for (const tool of ["ibmi.jobs.end", "ibmi.cl.run", "ibmi.sql.execute", "ibmi.sql.query", "ibmi.msgq.reply", ""]) {
      const refused = await post(tool, {});
      assert.equal(refused.status, 403, `${tool} is refused`);
    }
    assert.equal(calls.some(([tool]) => !PAGE_TOOLS.has(tool)), false);
    assert.equal((await post("ibmi.jobs.find", {}, "wrong")).status, 401);
    assert.equal((await post("ibmi.jobs.find", {}, server.token, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await fetch(`${base}/api/call?t=${server.token}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 415);
    assert.equal((await fetch(`${base}/nope?t=${server.token}`)).status, 404);
  } finally {
    await server.close();
  }
});

test("everything the page may call is a tool that only reads, and the page script is safe to embed", () => {
  const tools = getTools();
  for (const name of PAGE_TOOLS) {
    const tool = tools.find(t => t.name === name);
    assert.ok(tool, `${name} exists`);
    assert.equal(tool.annotations.readOnlyHint, true, `${name} only reads`);
  }
  for (const name of ["ibmi.debug.ready", "ibmi.workbench.open"]) assert.ok(tools.find(t => t.name === name), `${name} is listed`);
  const page = renderWorkbenchPage("9.9.9");
  assert.match(page, /mcp-for-i 9\.9\.9/);
  const script = page.slice(page.indexOf("<script>"), page.indexOf("</script>"));
  assert.equal(script.includes("innerHTML"), false, "text from the system is never put on the page as markup");
  // The script must be valid on its own.
  assert.doesNotThrow(() => new Function(script.replace("<script>", "")));
});
