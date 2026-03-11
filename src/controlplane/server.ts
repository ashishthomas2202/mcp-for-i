import http, { IncomingMessage, ServerResponse } from "http";
import { URL } from "url";
import { ConfigStore } from "../config/store.js";
import { isKeychainAvailable } from "../security/credentialStore.js";
import { ConnectionService } from "./connectionService.js";
import { RuntimeService } from "./runtimeService.js";
import { renderControlPlaneHtml } from "./ui.js";

export type ControlPlaneServer = {
  close: () => Promise<void>;
  port: number;
  host: string;
};

export async function startControlPlaneServer(opts?: { host?: string; port?: number; rootDir?: string }) {
  const host = opts?.host || process.env.MCP_FOR_I_CONTROL_HOST || "127.0.0.1";
  const port = normalizePort(opts?.port || Number(process.env.MCP_FOR_I_CONTROL_PORT || 3980));
  const rootDir = opts?.rootDir || process.cwd();

  const store = new ConfigStore();
  const connections = new ConnectionService(store);
  const runtime = new RuntimeService(rootDir);

  const server = http.createServer(async (req, res) => {
    try {
      await routeRequest(req, res, { connections, runtime });
    } catch (err: any) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  return {
    host,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      })
  } satisfies ControlPlaneServer;
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  services: { connections: ConnectionService; runtime: RuntimeService }
) {
  const method = req.method || "GET";
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderControlPlaneHtml());
    return;
  }

  if (method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true, keychainAvailable: await isKeychainAvailable() });
    return;
  }

  if (method === "GET" && pathname === "/api/runtime/status") {
    sendJson(res, 200, { jobs: services.runtime.getStatus() });
    return;
  }

  if (method === "POST" && pathname === "/api/runtime/install") {
    const job = await services.runtime.installOrRepair();
    sendJson(res, 202, { job });
    return;
  }

  if (method === "POST" && pathname === "/api/runtime/update/mcp") {
    const job = await services.runtime.updateMcp();
    sendJson(res, 202, { job });
    return;
  }

  if (method === "POST" && pathname === "/api/runtime/update/skills") {
    const body = await readJson(req);
    const job = await services.runtime.updateSkills({
      repoUrl: typeof body.repoUrl === "string" ? body.repoUrl : undefined,
      branch: typeof body.branch === "string" ? body.branch : undefined
    });
    sendJson(res, 202, { job });
    return;
  }

  if (method === "GET" && pathname === "/api/runtime/autostart/status") {
    const status = await services.runtime.getAutostartStatus();
    sendJson(res, 200, { status });
    return;
  }

  if (method === "POST" && pathname === "/api/runtime/autostart/setup") {
    const job = await services.runtime.setupAutostart();
    sendJson(res, 202, { job });
    return;
  }

  if (method === "POST" && pathname === "/api/runtime/autostart/remove") {
    const job = await services.runtime.removeAutostart();
    sendJson(res, 202, { job });
    return;
  }

  if (method === "GET" && pathname === "/api/connections") {
    const list = await services.connections.list();
    sendJson(res, 200, { connections: list });
    return;
  }

  if (method === "POST" && pathname === "/api/connections") {
    const body = await readJson(req);
    const created = await services.connections.add(body);
    sendJson(res, 201, { connection: created });
    return;
  }

  const matchConn = pathname.match(/^\/api\/connections\/([^/]+)$/);
  if (matchConn) {
    const name = decodeURIComponent(matchConn[1]);
    if (method === "GET") {
      const connection = await services.connections.get(name);
      if (!connection) {
        sendJson(res, 404, { error: `Connection ${name} not found` });
      } else {
        sendJson(res, 200, { connection });
      }
      return;
    }
    if (method === "PUT") {
      const body = await readJson(req);
      const updated = await services.connections.update(name, body);
      sendJson(res, 200, { connection: updated });
      return;
    }
    if (method === "DELETE") {
      await services.connections.delete(name);
      sendNoContent(res);
      return;
    }
  }

  const matchRename = pathname.match(/^\/api\/connections\/([^/]+)\/rename$/);
  if (matchRename && method === "POST") {
    const oldName = decodeURIComponent(matchRename[1]);
    const body = await readJson(req);
    const newName = String(body.newName || "").trim();
    if (!newName) {
      sendJson(res, 400, { error: "newName is required" });
      return;
    }
    const renamed = await services.connections.rename(oldName, newName);
    sendJson(res, 200, { connection: renamed });
    return;
  }

  const matchPwd = pathname.match(/^\/api\/connections\/([^/]+)\/password$/);
  if (matchPwd && method === "POST") {
    const name = decodeURIComponent(matchPwd[1]);
    const body = await readJson(req);
    const password = String(body.password || "");
    if (!password) {
      sendJson(res, 400, { error: "password is required" });
      return;
    }
    await services.connections.setConnectionPassword(name, password);
    sendNoContent(res);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function sendNoContent(res: ServerResponse) {
  res.writeHead(204);
  res.end();
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function normalizePort(port: number) {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return 3980;
  return Math.floor(port);
}
