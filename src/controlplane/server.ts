import http, { IncomingMessage, ServerResponse } from "http";
import { AddressInfo } from "net";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { URL } from "url";
import { fileURLToPath } from "url";
import { ConfigStore, Settings, getConfigDir } from "../config/store.js";
import { getCredentialStoreStatus } from "../security/credentialStore.js";
import { ConnectionService, ConnectionTestInput, ConnectionUpsertInput } from "./connectionService.js";
import { RuntimeService } from "./runtimeService.js";
import { ClientIntegrationService } from "./clientIntegrationService.js";
import { renderControlPlaneHtml } from "./ui.js";
import { ControlPlaneError } from "./errors.js";
import { HEALTH_SERVICE_ID } from "./serverShared.js";
import {
  CONTROL_TOKEN_HEADER,
  ensureControlToken,
  isAllowedHostHeader,
  isAllowedOrigin,
  tokensMatch
} from "./auth.js";

export type ControlPlaneServer = {
  close: () => Promise<void>;
  /** Resolves once the server has stopped listening. */
  closed: Promise<void>;
  port: number;
  host: string;
  token: string;
};

/** Largest accepted request body. Bigger bodies get 413. */
export const MAX_BODY_BYTES = 1024 * 1024;

type RequestGuard = {
  token: string;
  port: number;
  extraHosts: string[];
};

type Services = {
  store: ConfigStore;
  connections: ConnectionService;
  runtime: RuntimeService;
  clients: ClientIntegrationService;
  token: string;
};

export async function startControlPlaneServer(opts?: { host?: string; port?: number; rootDir?: string; token?: string }) {
  const host = opts?.host || process.env.MCP_FOR_I_CONTROL_HOST || "127.0.0.1";
  const port = typeof opts?.port === "number"
    ? normalizePort(opts.port, true)
    : normalizePort(Number(process.env.MCP_FOR_I_CONTROL_PORT || 3980));
  const rootDir = opts?.rootDir || process.env.MCP_FOR_I_ROOT_DIR || getDefaultRootDir();
  const token = opts?.token || ensureControlToken();

  const store = new ConfigStore();
  const connections = new ConnectionService(store);
  const runtime = new RuntimeService(rootDir);
  const clients = new ClientIntegrationService(rootDir);
  const guard: RequestGuard = { token, port, extraHosts: extraAllowedHosts(host) };

  const server = http.createServer(async (req, res) => {
    try {
      if (!checkRequest(req, res, guard)) return;
      await routeRequest(req, res, { store, connections, runtime, clients, token });
    } catch (err: any) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = err instanceof ControlPlaneError ? err.status : 500;
      if (status === 413) res.setHeader("Connection", "close");
      sendJson(res, status, { error: err?.message || String(err) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  guard.port = (server.address() as AddressInfo).port;

  const closed = new Promise<void>(resolve => server.once("close", () => resolve()));

  return {
    host,
    port: guard.port,
    token,
    closed,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
        server.closeIdleConnections();
      })
  } satisfies ControlPlaneServer;
}

/**
 * Rejects requests that did not come from the local Web UI or CLI: a wrong Host
 * header (DNS rebinding), a foreign Origin, a missing token on /api routes,
 * non-JSON bodies, and bodies over the size limit.
 */
function checkRequest(req: IncomingMessage, res: ServerResponse, guard: RequestGuard) {
  if (!isAllowedHostHeader(req.headers.host, guard.port, guard.extraHosts)) {
    rejectRequest(req, res, 421, "Host not allowed");
    return false;
  }
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!isAllowedOrigin(origin, guard.port, guard.extraHosts) || req.headers["sec-fetch-site"] === "cross-site") {
    rejectRequest(req, res, 403, "Cross-origin requests are not allowed");
    return false;
  }

  const pathname = (req.url || "/").split("?")[0];
  if (!pathname.startsWith("/api/")) return true;

  // /api/health answers without a token so launchers can probe liveness,
  // but it only returns details when the token is present.
  const isHealth = pathname === "/api/health" && (req.method === "GET" || req.method === "HEAD");
  if (!isHealth && !tokensMatch(guard.token, req.headers[CONTROL_TOKEN_HEADER.toLowerCase()])) {
    rejectRequest(req, res, 401, `Missing or invalid ${CONTROL_TOKEN_HEADER} header`);
    return false;
  }

  const method = req.method || "GET";
  if (method !== "GET" && method !== "HEAD" && method !== "DELETE") {
    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      rejectRequest(req, res, 415, "Content-Type must be application/json");
      return false;
    }
  }

  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    rejectRequest(req, res, 413, `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    return false;
  }
  return true;
}

function rejectRequest(req: IncomingMessage, res: ServerResponse, status: number, error: string) {
  // Do not read a rejected body; close the connection once the reply is sent.
  res.setHeader("Connection", "close");
  sendJson(res, status, { error });
  req.resume();
}

function extraAllowedHosts(bindHost: string) {
  const lower = bindHost.trim().toLowerCase();
  if (!lower || lower === "0.0.0.0" || lower === "::" || lower === "[::]") return [];
  return [lower];
}

async function routeRequest(req: IncomingMessage, res: ServerResponse, services: Services) {
  const method = req.method || "GET";
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(renderControlPlaneHtml(services.token));
    return;
  }

  if (method === "GET" && pathname === "/api/health") {
    if (!tokensMatch(services.token, req.headers[CONTROL_TOKEN_HEADER.toLowerCase()])) {
      sendJson(res, 200, { ok: true, service: HEALTH_SERVICE_ID });
      return;
    }
    const credentialStore = await getCredentialStoreStatus();
    sendJson(res, 200, { ok: true, service: HEALTH_SERVICE_ID, keychainAvailable: credentialStore.keychainAvailable, credentialStore });
    return;
  }

  if (method === "GET" && pathname === "/api/settings") {
    const settings = await services.store.getSettings();
    sendJson(res, 200, { settings });
    return;
  }

  if (method === "PUT" && pathname === "/api/settings") {
    const body = await readJson(req);
    const update: Partial<Settings> = {};
    try {
      if (typeof body.sessionIdleMinutes !== "undefined") {
        update.sessionIdleMinutes = parseNumberSetting(body.sessionIdleMinutes, 1, 24 * 60, "sessionIdleMinutes");
      }
      if (typeof body.sessionPingSeconds !== "undefined") {
        update.sessionPingSeconds = parseNumberSetting(body.sessionPingSeconds, 5, 300, "sessionPingSeconds");
      }
      if (typeof body.sessionReconnectAttempts !== "undefined") {
        update.sessionReconnectAttempts = parseNumberSetting(body.sessionReconnectAttempts, 1, 5, "sessionReconnectAttempts");
      }
    } catch (err: any) {
      sendJson(res, 400, { error: err?.message || String(err) });
      return;
    }
    if (Object.keys(update).length === 0) {
      sendJson(res, 400, { error: "No supported settings provided" });
      return;
    }
    await services.store.updateSettings(update);
    const settings = await services.store.getSettings();
    sendJson(res, 200, { settings });
    return;
  }

  if (method === "GET" && pathname === "/api/sessions") {
    sendJson(res, 200, { snapshot: await readSessionSnapshot() });
    return;
  }

  if (method === "GET" && pathname === "/api/runtime/status") {
    sendJson(res, 200, { jobs: services.runtime.getStatus() });
    return;
  }

  if (method === "GET" && pathname === "/api/runtime/versions") {
    const versions = await services.runtime.getVersions({
      repoUrl: url.searchParams.get("repoUrl") || undefined,
      branch: url.searchParams.get("branch") || undefined
    });
    sendJson(res, 200, versions);
    return;
  }

  if (method === "GET" && pathname === "/api/runtime/environment") {
    const environment = await services.runtime.getEnvironmentInfo();
    sendJson(res, 200, { environment });
    return;
  }

  if (method === "GET" && pathname === "/api/service/status") {
    const status = await services.runtime.getServiceStatus();
    sendJson(res, 200, { status });
    return;
  }

  if (method === "GET" && pathname === "/api/clients") {
    const targets = await services.clients.listTargets();
    sendJson(res, 200, { targets });
    return;
  }

  if (method === "POST" && pathname === "/api/clients/install") {
    const body = await readJson(req);
    const id = String(body.id || "").trim();
    if (!id) {
      sendJson(res, 400, { error: "id is required" });
      return;
    }
    const result = await services.clients.installTarget(id);
    sendJson(res, 200, { result });
    return;
  }

  if (method === "POST" && pathname === "/api/service/enable") {
    const job = await services.runtime.enableService();
    sendJson(res, 202, { job });
    return;
  }

  if (method === "POST" && pathname === "/api/service/disable") {
    const job = await services.runtime.disableService();
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

  if (method === "GET" && pathname === "/api/connections") {
    const list = await services.connections.list();
    sendJson(res, 200, { connections: list });
    return;
  }

  if (method === "POST" && pathname === "/api/connections") {
    const body = await readJson(req);
    const created = await services.connections.add(body as ConnectionUpsertInput);
    sendJson(res, 201, { connection: created });
    return;
  }

  if (method === "POST" && pathname === "/api/connections/test") {
    const body = await readJson(req);
    const result = await services.connections.testDetails(body as ConnectionTestInput);
    sendJson(res, 200, { result });
    return;
  }

  const matchTest = pathname.match(/^\/api\/connections\/([^/]+)\/test$/);
  if (matchTest && method === "POST") {
    const result = await services.connections.testSaved(decodeURIComponent(matchTest[1]));
    sendJson(res, 200, { result });
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

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new ControlPlaneError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ControlPlaneError(400, "Invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ControlPlaneError(400, "JSON body must be an object");
  }
  return parsed as Record<string, any>;
}

function normalizePort(port: number, allowEphemeral = false) {
  if (allowEphemeral && port === 0) return 0;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return 3980;
  return Math.floor(port);
}

function getDefaultRootDir() {
  const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const packageJsonPath = path.join(runtimeRoot, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    return runtimeRoot;
  }
  return process.cwd();
}

function parseNumberSetting(input: unknown, min: number, max: number, key: string) {
  const value = Number(input);
  if (!Number.isFinite(value)) {
    throw new Error(`${key} must be a number`);
  }
  const normalized = Math.floor(value);
  if (normalized < min || normalized > max) {
    throw new Error(`${key} must be between ${min} and ${max}`);
  }
  return normalized;
}

async function readSessionSnapshot() {
  const snapshotPath = path.join(getConfigDir(), "session-state.json");
  try {
    const raw = await fsp.readFile(snapshotPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}
