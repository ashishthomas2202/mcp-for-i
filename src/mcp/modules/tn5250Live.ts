import crypto from "crypto";
import fs from "fs";
import http, { IncomingMessage, ServerResponse } from "http";
import path from "path";
import { AddressInfo } from "net";
import type { EventEmitter } from "events";
import { getConfigDir } from "../../config/store.js";
import { renderLivePage } from "./tn5250LivePage.js";

/**
 * Live 5250 view: a small web server inside the MCP process that shows the
 * TN5250 sessions the agent drives and lets the person type and click in them
 * at the same time. It listens on 127.0.0.1 only, and every request needs the
 * per-process token that is part of the link the agent hands out.
 */

export type LiveInput = {
  text?: string;
  keys?: string;
  cursorRow?: number;
  cursorCol?: number;
  click?: { row: number; col: number; doubleClick?: boolean };
};

export type LiveProvider = {
  events: EventEmitter;
  list(): Array<{ connectionName: string; host: string; connected: boolean; signedOn: boolean; lastActor?: string }>;
  screen(connectionName: string): Record<string, any> | undefined;
  input(connectionName: string, input: LiveInput): Promise<Record<string, any>>;
};

export type LiveServer = {
  port: number;
  token: string;
  urlFor(connectionName?: string): string;
  close(): Promise<void>;
};

export const LIVE_TOKEN_HEADER = "x-mcp-for-i-live-token";
const MAX_INPUT_BYTES = 16 * 1024;

/** Folder where each MCP process lists its live view, for the control plane. */
export function liveRegistryDir(configDir = getConfigDir()) {
  return path.join(configDir, "tn5250-live");
}

export async function startLiveServer(provider: LiveProvider, preferredPort = 3981): Promise<LiveServer> {
  const token = crypto.randomBytes(24).toString("hex");
  const streams = new Set<ServerResponse>();
  let port = 0;

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (!res.headersSent) sendJson(res, 500, { error: err?.message || String(err) });
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (!allowedHost(req.headers.host, port)) return sendJson(res, 421, { error: "Host not allowed" });
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (origin && !allowedOrigin(origin, port)) return sendJson(res, 403, { error: "Cross-origin requests are not allowed" });
    const provided = url.searchParams.get("t") || req.headers[LIVE_TOKEN_HEADER];
    if (!tokensMatch(token, provided)) return sendJson(res, 401, { error: "Missing or invalid live view token" });
    const name = url.searchParams.get("s") || "";

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'"
      });
      res.end(renderLivePage());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      return sendJson(res, 200, { sessions: provider.list() });
    }
    if (req.method === "GET" && url.pathname === "/api/screen") {
      const screen = provider.screen(name);
      return screen ? sendJson(res, 200, screen) : sendJson(res, 404, { error: `No 5250 session for ${name}` });
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive"
      });
      streams.add(res);
      let timer: NodeJS.Timeout | undefined;
      const push = () => {
        timer = undefined;
        const screen = provider.screen(name);
        res.write(`event: screen\ndata: ${JSON.stringify(screen || { missing: true, connectionName: name })}\n\n`);
      };
      const onChanged = (changed: string) => {
        if (changed === name && !timer) timer = setTimeout(push, 40);
        res.write(`event: sessions\ndata: ${JSON.stringify(provider.list())}\n\n`);
      };
      const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15000);
      provider.events.on("changed", onChanged);
      push();
      req.on("close", () => {
        clearInterval(keepAlive);
        if (timer) clearTimeout(timer);
        provider.events.off("changed", onChanged);
        streams.delete(res);
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/input") {
      const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (contentType !== "application/json") return sendJson(res, 415, { error: "Content-Type must be application/json" });
      const body = await readBody(req);
      let input: LiveInput;
      try {
        input = JSON.parse(body || "{}");
      } catch {
        return sendJson(res, 400, { error: "Invalid JSON" });
      }
      try {
        const result = await provider.input(name, sanitizeInput(input));
        return sendJson(res, 200, { ok: true, sent: result.sent, note: result.note, settled: result.settled });
      } catch (err: any) {
        return sendJson(res, 200, { ok: false, error: err?.message || String(err) });
      }
    }
    sendJson(res, 404, { error: "Not found" });
  }

  await new Promise<void>((resolve, reject) => {
    const tryListen = (candidate: number, fallback: boolean) => {
      server.once("error", (err: any) => {
        if (fallback && err?.code === "EADDRINUSE") tryListen(0, false);
        else reject(err);
      });
      server.listen(candidate, "127.0.0.1", () => resolve());
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
  server.unref();
  port = (server.address() as AddressInfo).port;

  const registryFile = path.join(liveRegistryDir(), `${process.pid}.json`);
  const writeRegistry = () => {
    try {
      fs.mkdirSync(path.dirname(registryFile), { recursive: true });
      const entry = { pid: process.pid, port, url: urlFor(), sessions: provider.list(), updatedAt: new Date().toISOString() };
      fs.writeFileSync(registryFile, JSON.stringify(entry, null, 2), { encoding: "utf8", mode: 0o600 });
    } catch {
      // the control plane listing is a convenience
    }
  };
  const removeRegistry = () => {
    try { fs.rmSync(registryFile, { force: true }); } catch { /* ignore */ }
  };
  let registryTimer: NodeJS.Timeout | undefined;
  const onAnyChange = () => {
    if (registryTimer) return;
    registryTimer = setTimeout(() => { registryTimer = undefined; writeRegistry(); }, 250);
    registryTimer.unref();
  };
  provider.events.on("changed", onAnyChange);
  process.once("exit", removeRegistry);
  writeRegistry();

  function urlFor(connectionName?: string) {
    const params = new URLSearchParams({ t: token });
    if (connectionName) params.set("s", connectionName);
    return `http://127.0.0.1:${port}/?${params.toString()}`;
  }

  return {
    port,
    token,
    urlFor,
    close: () => new Promise<void>(resolve => {
      provider.events.off("changed", onAnyChange);
      if (registryTimer) clearTimeout(registryTimer);
      removeRegistry();
      for (const stream of streams) stream.end();
      server.close(() => resolve());
      server.closeAllConnections();
    })
  };
}

function sanitizeInput(input: any): LiveInput {
  const out: LiveInput = {};
  if (typeof input?.text === "string") out.text = input.text.slice(0, 2000);
  if (typeof input?.keys === "string") out.keys = input.keys.slice(0, 500);
  if (Number.isFinite(input?.cursorRow)) out.cursorRow = Number(input.cursorRow);
  if (Number.isFinite(input?.cursorCol)) out.cursorCol = Number(input.cursorCol);
  if (input?.click && Number.isFinite(input.click.row) && Number.isFinite(input.click.col)) {
    out.click = { row: Number(input.click.row), col: Number(input.click.col), doubleClick: input.click.doubleClick === true };
  }
  return out;
}

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function allowedHost(host: string | undefined, port: number) {
  if (!host) return false;
  const lower = host.toLowerCase();
  return lower === `127.0.0.1:${port}` || lower === `localhost:${port}`;
}

function allowedOrigin(origin: string, port: number) {
  const lower = origin.toLowerCase();
  return lower === `http://127.0.0.1:${port}` || lower === `http://localhost:${port}`;
}

function tokensMatch(expected: string, provided: unknown) {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
