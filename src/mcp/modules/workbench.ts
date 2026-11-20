import crypto from "crypto";
import fs from "fs";
import http, { IncomingMessage, ServerResponse } from "http";
import { AddressInfo } from "net";
import { fileURLToPath } from "url";
import type { McpContext } from "../context.js";
import type { ToolModule } from "./index.js";
import { handleTool, json } from "../tools.js";
import { requireJob } from "./jobs.js";
import { renderWorkbenchPage } from "./workbenchPage.js";

/**
 * The workbench: a page on this computer that shows jobs, job logs with their
 * diagnosis, and debug readiness. It is for the person, whatever agent they
 * use: the agent calls ibmi.workbench.open and hands over the link.
 *
 * The page has no logic of its own about the system. It calls the same
 * read-only tools the agent calls, through this server, so the library policy
 * of the connection applies to it as it does to the agent. Only the tools
 * listed in PAGE_TOOLS can be called from it: nothing that writes.
 *
 * Like the live 5250 view, it listens on 127.0.0.1 only and every request
 * needs the per-process token that is part of the link.
 */

/** What the page may call. Every one of them only reads. */
export const PAGE_TOOLS = new Set([
  "ibmi.jobs.find",
  "ibmi.jobs.log",
  "ibmi.jobs.diagnose",
  "ibmi.jobs.stack",
  "ibmi.joblog.parse",
  "ibmi.source.locateStatement",
  "ibmi.debug.ready"
]);

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DEFAULT_PORT = 3982;
/** A pasted job log can be large; anything else the page sends is small. */
const MAX_BODY_BYTES = 24 * 1024 * 1024;

export type WorkbenchServer = { port: number; token: string; urlFor(options?: { connectionName?: string; jobName?: string; view?: string }): string; close(): Promise<void> };

type Caller = (tool: string, args: any) => Promise<any>;
type Lister = () => Promise<{ connections: Array<{ name: string; host?: string; username?: string }>; active?: string }>;

export async function startWorkbenchServer(callTool: Caller, listConnections: Lister, preferredPort = DEFAULT_PORT): Promise<WorkbenchServer> {
  const token = crypto.randomBytes(24).toString("hex");
  let port = 0;
  const page = renderWorkbenchPage(packageVersion());

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err?.message || String(err) });
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (!allowedHost(req.headers.host, port)) return sendJson(res, 421, { ok: false, error: "Host not allowed" });
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (origin && !allowedOrigin(origin, port)) return sendJson(res, 403, { ok: false, error: "Cross-origin requests are not allowed" });
    if (!tokensMatch(token, url.searchParams.get("t"))) return sendJson(res, 401, { ok: false, error: "Missing or invalid workbench token" });

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'"
      });
      res.end(page);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/connections") {
      return sendJson(res, 200, { ok: true, ...(await listConnections()) });
    }
    if (req.method === "POST" && url.pathname === "/api/call") {
      const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (contentType !== "application/json") return sendJson(res, 415, { ok: false, error: "Content-Type must be application/json" });
      let body: any;
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch (err: any) {
        return sendJson(res, 400, { ok: false, error: err?.message === "Request body too large" ? err.message : "Invalid JSON" });
      }
      const tool = String(body?.tool || "");
      if (!PAGE_TOOLS.has(tool)) return sendJson(res, 403, { ok: false, error: `The workbench page cannot call ${tool || "that"}.` });
      const args = body?.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {};
      try {
        const result = await callTool(tool, args);
        if (result?.isError) {
          const said = result?.structuredContent?.error?.message || (result?.content || []).map((c: any) => c?.text || "").join(" ").trim();
          return sendJson(res, 200, { ok: false, error: said || "The tool failed." });
        }
        return sendJson(res, 200, { ok: true, data: result?.structuredContent?.data ?? null });
      } catch (err: any) {
        return sendJson(res, 200, { ok: false, error: err?.message || String(err) });
      }
    }
    sendJson(res, 404, { ok: false, error: "Not found" });
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

  return {
    port,
    token,
    urlFor(options = {}) {
      const params = new URLSearchParams({ t: token });
      if (options.connectionName) params.set("c", options.connectionName);
      if (options.jobName) params.set("job", options.jobName);
      if (options.view) params.set("view", options.view);
      return `http://127.0.0.1:${port}/?${params.toString()}`;
    },
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    })
  };
}

function packageVersion() {
  try {
    const file = fileURLToPath(new URL("../../../package.json", import.meta.url));
    const version = JSON.parse(fs.readFileSync(file, "utf8")).version;
    return typeof version === "string" ? version : "";
  } catch {
    return "";
  }
}

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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
  const lower = String(host || "").toLowerCase();
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

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

let workbench: WorkbenchServer | undefined;
let starting: Promise<WorkbenchServer> | undefined;

async function ensureWorkbench(ctx: McpContext) {
  if (workbench) return workbench;
  starting ??= startWorkbenchServer(
    (tool, args) => handleTool(ctx, tool, args),
    async () => ({
      connections: (await ctx.store.listConnections()).map((c: any) => ({ name: c.name, host: c.host, username: c.username })),
      active: ctx.activeName
    })
  ).then(server => (workbench = server)).finally(() => { starting = undefined; });
  return starting;
}

/** For tests: stop the workbench server. */
export async function stopWorkbench() {
  const server = workbench;
  workbench = undefined;
  await server?.close();
}

export const workbenchModule: ToolModule = {
  tools: [
    {
      name: "ibmi.workbench.open",
      description:
        "Get the link to the workbench: a page on this computer where the person sees their jobs, any job's log with its diagnosis (the failing message, what led to it, the program and source line), and whether the system is ready for debugging. " +
        "Give the link to the person when they want to look for themselves, or to show a job you diagnosed (pass jobName). The page only reads, and shows what the ibmi.jobs.* tools return. The link works on this computer only.",
      inputSchema: {
        type: "object",
        properties: {
          jobName: { type: "string", description: "Open on this job (number/user/name)." },
          view: { type: "string", enum: ["jobs", "debug"], description: "jobs (default), or debug for the readiness check." },
          connectionName: { type: "string" }
        }
      },
      annotations: READ
    }
  ],
  handle: async (ctx, name, args) => {
    if (name !== "ibmi.workbench.open") throw new Error(`Unknown tool: ${name}`);
    const jobName = args?.jobName ? requireJob(args.jobName, false) : undefined;
    const view = args?.view === "debug" ? "debug" : undefined;
    const connectionName = String(args?.connectionName || ctx.activeName || "") || undefined;
    const server = await ensureWorkbench(ctx);
    return json({
      url: server.urlFor({ connectionName, jobName, view }),
      note: "Open this link in a browser on this computer. It carries a key for this session: do not post it anywhere."
    });
  }
};
