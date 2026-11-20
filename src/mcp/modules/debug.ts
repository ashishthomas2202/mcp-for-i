import crypto from "crypto";
import tls from "tls";
import type { McpContext } from "../context.js";
import type { ToolModule } from "./index.js";
import { clampNumber, getConnectionName, json, requireQsysName } from "../tools.js";
import { Tools } from "../../ibmi/Tools.js";
import { getPassword } from "../../security/credentialStore.js";

/**
 * Is this system ready to be debugged from this computer?
 *
 * Debugging goes through the IBM i Debug Service (a job on the system that
 * speaks the Debug Adapter Protocol over TLS). Getting it ready is where people
 * lose most time: the service not running, an old level, a certificate that
 * does not match the host name, a port closed between the PC and the system, a
 * program without debug data. ibmi.debug.ready checks each of these and says,
 * for every one that fails, what to do and who does it.
 *
 * It only looks: one TLS handshake to the debug port (nothing is sent after
 * it), and reads on the system.
 */

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SERVICE_ROOT = "/QIBM/ProdData/IBMiDebugService";
const CERTIFICATE_PATHS = ["/QIBM/UserData/IBMiDebugService/certs/debug_service.crt", "/QIBM/UserData/IBMIDEBUGSERVICE/certs/debug_service.crt"];
/** The lowest Debug Service this is written for (the one Code for IBM i requires too). */
export const MINIMUM_SERVICE_MAJOR = 3;
const ROUTER_PORT = 3825;

export type Check = {
  id: string;
  title: string;
  /** true: fine. false: stops debugging. null: could not be told. */
  ok: boolean | null;
  detail: string;
  /** What to do about it, when it is not fine. */
  fix?: string;
  /** Who can do that. */
  who?: "you" | "administrator";
};

export type TlsProbe = { connected: boolean; authorized?: boolean; error?: string; protocol?: string; validTo?: string; subject?: string };

/** One TLS handshake to host:port, trusting only `ca`. Nothing is written to the socket. */
export function probeTls(host: string, port: number, ca: string | undefined, timeoutMs = 6000): Promise<TlsProbe> {
  return new Promise(resolve => {
    let done = false;
    const finish = (probe: TlsProbe) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(probe);
    };
    // rejectUnauthorized stays off so the handshake completes and says *why* a certificate is not trusted.
    const socket = tls.connect({ host, port, servername: host, ca: ca ? [ca] : undefined, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const peer = socket.getPeerCertificate();
      finish({
        connected: true,
        authorized: socket.authorized,
        error: socket.authorized ? undefined : String(socket.authorizationError || "not trusted"),
        protocol: socket.getProtocol() || undefined,
        validTo: peer?.valid_to,
        subject: peer?.subject?.CN
      });
    });
    socket.on("timeout", () => finish({ connected: false, error: `no answer within ${Math.round(timeoutMs / 1000)} seconds` }));
    socket.on("error", (err: any) => finish({ connected: false, error: err?.code || err?.message || String(err) }));
  });
}

/** What a certificate says about itself, and whether it is for this host. */
export function describeCertificate(pem: string, host: string, now = new Date()) {
  const cert = new crypto.X509Certificate(pem);
  const validTo = new Date(cert.validTo);
  const validFrom = new Date(cert.validFrom);
  return {
    subject: cert.subject.replace(/\n/g, ", "),
    names: cert.subjectAltName || "",
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    expired: validTo.getTime() < now.getTime(),
    notYetValid: validFrom.getTime() > now.getTime(),
    daysLeft: Math.floor((validTo.getTime() - now.getTime()) / 86_400_000),
    matchesHost: Boolean(/^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? cert.checkIP(host) : cert.checkHost(host))
  };
}

type Deps = { probe?: typeof probeTls; hasPassword?: (name: string) => Promise<boolean> };

export async function debugReadiness(ctx: McpContext, args: any, deps: Deps = {}) {
  const conn: any = await ctx.ensureActive(args?.connectionName);
  const connectionName = getConnectionName(ctx, args);
  const host = String(conn.currentHost || "");
  const config = conn.getConfig?.() || {};
  const port = clampNumber(config.debugPort, 8005, 1, 65535);
  const sepPort = clampNumber(config.debugSepPort, 8008, 1, 65535);
  const checks: Check[] = [];
  const add = (check: Check) => { checks.push(check); return check; };

  // 1. Installed, and at what level.
  let version: string | undefined;
  try {
    const res = await conn.sendCommand({ command: `cat ${SERVICE_ROOT}/package.json` });
    if (res?.code === 0) version = String(JSON.parse(String(res.stdout || "{}")).version || "") || undefined;
  } catch {
    // told below
  }
  const major = Number(String(version || "").split(".")[0]);
  if (!version) {
    add({ id: "installed", title: "Debug Service installed", ok: false, detail: `${SERVICE_ROOT} was not found, or its version could not be read.`, fix: "Install the IBM i Debug Service PTF for this release (and 5770WDS option 60).", who: "administrator" });
  } else if (!(major >= MINIMUM_SERVICE_MAJOR)) {
    add({ id: "installed", title: "Debug Service installed", ok: false, detail: `Version ${version} is installed; version ${MINIMUM_SERVICE_MAJOR} or later is needed.`, fix: "Apply the current IBM i Debug Service PTF.", who: "administrator" });
  } else {
    add({ id: "installed", title: "Debug Service installed", ok: true, detail: `Version ${version}.` });
  }

  // 2. Running: the service on its ports, and the debug server it works through.
  let listeners: Record<string, unknown>[] | undefined;
  try {
    listeners = await conn.runSQL(
      `select LOCAL_PORT, JOB_NAME from qsys2.netstat_job_info where LOCAL_PORT in (${port}, ${sepPort}, ${ROUTER_PORT}) and REMOTE_ADDRESS in ('0.0.0.0', '::')`
    );
  } catch (err: any) {
    add({ id: "running", title: "Debug Service running", ok: null, detail: `The system's listeners could not be read: ${String(err?.message || err).slice(0, 160)}` });
  }
  if (listeners) {
    const jobOn = (p: number) => listeners!.find(row => Number(row.LOCAL_PORT) === p)?.JOB_NAME as string | undefined;
    const service = jobOn(port);
    add(service
      ? { id: "running", title: "Debug Service running", ok: true, detail: `Listening on port ${port} (job ${String(service).trim()}).` }
      : { id: "running", title: "Debug Service running", ok: false, detail: `Nothing is listening on port ${port}.`, fix: "Start the Debug Service (Navigator for i, or ibmi.debug.startService).", who: "administrator" });
    add(jobOn(ROUTER_PORT)
      ? { id: "debugServer", title: "Debug server (STRDBGSVR) running", ok: true, detail: `Listening on port ${ROUTER_PORT} (job ${String(jobOn(ROUTER_PORT)).trim()}).` }
      : { id: "debugServer", title: "Debug server (STRDBGSVR) running", ok: false, detail: `Nothing is listening on port ${ROUTER_PORT}.`, fix: "Run STRDBGSVR.", who: "administrator" });
    add(jobOn(sepPort)
      ? { id: "sepDaemon", title: "Service entry point port", ok: true, detail: `Listening on port ${sepPort}.` }
      : { id: "sepDaemon", title: "Service entry point port", ok: null, detail: `Nothing is listening on port ${sepPort}: service entry points will not work; debugging a submitted job does not need it.` });
  }

  // 3. The certificate the service presents: readable, in date, and for the host name this connection uses.
  let pem: string | undefined;
  for (const path of CERTIFICATE_PATHS) {
    try {
      const res = await conn.sendCommand({ command: `cat ${path}` });
      if (res?.code === 0 && /BEGIN CERTIFICATE/.test(String(res.stdout || ""))) { pem = String(res.stdout); break; }
    } catch {
      // next path
    }
  }
  if (!pem) {
    add({ id: "certificate", title: "Debug Service certificate", ok: false, detail: "debug_service.crt could not be read from the Debug Service's certs directory.", fix: "In Navigator for i: Network > Servers > TCP/IP Servers > System Debugger > Regenerate Debug Service Trust Store, and make the certificate readable.", who: "administrator" });
  } else {
    try {
      const cert = describeCertificate(pem, host);
      const problem = cert.expired ? `it expired on ${cert.validTo}` : cert.notYetValid ? `it is not valid before ${cert.validFrom}` : !cert.matchesHost ? `it is not for the host name "${host}" (it names: ${cert.names || cert.subject})` : undefined;
      add(problem
        ? { id: "certificate", title: "Debug Service certificate", ok: false, detail: `The certificate was read, but ${problem}.`, fix: cert.matchesHost ? "Renew the system certificate and regenerate the Debug Service trust store." : "Connect by a host name the certificate names (not an IP address), or have the certificate issued for this name.", who: cert.matchesHost ? "administrator" : "you" }
        : { id: "certificate", title: "Debug Service certificate", ok: true, detail: `For ${host}, valid until ${cert.validTo}${cert.daysLeft < 30 ? ` (${cert.daysLeft} days left)` : ""}.` });
    } catch (err: any) {
      add({ id: "certificate", title: "Debug Service certificate", ok: null, detail: `The certificate could not be read as one: ${String(err?.message || err).slice(0, 160)}` });
    }
  }

  // 4. From this computer: can the port be reached, and is the certificate it presents the one above.
  if (host && args?.checkNetwork !== false) {
    const probe = await (deps.probe || probeTls)(host, port, pem);
    if (!probe.connected) {
      add({ id: "reachable", title: `Port ${port} reachable from this computer`, ok: false, detail: `${host}:${port} did not answer (${probe.error}).`, fix: `Have port ${port} (and ${sepPort} for service entry points) opened from your computer to the system; on a VPN, check that it routes them.`, who: "administrator" });
    } else if (!probe.authorized) {
      add({ id: "reachable", title: `Port ${port} reachable from this computer`, ok: pem ? false : null, detail: `Connected (${probe.protocol || "TLS"}), but the certificate presented is not trusted: ${probe.error}.`, fix: pem ? "The service is using a different certificate from the one in its certs directory: regenerate the Debug Service trust store and restart the service." : undefined, who: "administrator" });
    } else {
      add({ id: "reachable", title: `Port ${port} reachable from this computer`, ok: true, detail: `Connected with ${probe.protocol || "TLS"}; the certificate is trusted.` });
    }
  }

  // 5. Signing on: the service is given the user and password with each session.
  const hasPassword = await (deps.hasPassword || (async (name: string) => Boolean(await getPassword(name))))(connectionName).catch(() => false);
  add(hasPassword
    ? { id: "password", title: "Password for the debug session", ok: true, detail: "This connection has a stored password." }
    : { id: "password", title: "Password for the debug session", ok: false, detail: "This connection signs on with a key and has no stored password; the Debug Service needs the user's password.", fix: "Save the password with the connection.", who: "you" });

  // 6. The program, when one is named: does it carry debug data, and is its source the one it was compiled from.
  let program: Record<string, unknown> | undefined;
  if (args?.library && args?.program) {
    const library = requireQsysName(conn, args.library, "library");
    const name = requireQsysName(conn, args.program, "program");
    try {
      const modules: Record<string, unknown>[] = await conn.runSQL(
        "select M.BOUND_MODULE, M.MODULE_ATTRIBUTE, M.DEBUG_DATA, M.SOURCE_FILE_LIBRARY, M.SOURCE_FILE, M.SOURCE_FILE_MEMBER, M.SOURCE_STREAM_FILE_PATH, M.SOURCE_CHANGE_TIMESTAMP, " +
        "(select P.LAST_SOURCE_UPDATE_TIMESTAMP from QSYS2.SYSPARTITIONSTAT P where P.SYSTEM_TABLE_SCHEMA = M.SOURCE_FILE_LIBRARY and P.SYSTEM_TABLE_NAME = M.SOURCE_FILE and P.SYSTEM_TABLE_MEMBER = M.SOURCE_FILE_MEMBER fetch first 1 row only) as SOURCE_NOW " +
        `from QSYS2.BOUND_MODULE_INFO M where M.PROGRAM_LIBRARY = ${Tools.sqlString(library)} and M.PROGRAM_NAME = ${Tools.sqlString(name)} fetch first 200 rows only`
      );
      if (modules.length === 0) {
        add({ id: "program", title: `${library}/${name} can be debugged`, ok: null, detail: "No ILE modules were found for it (an OPM program, not found, or not authorised): its debug data could not be checked." });
      } else {
        const without = modules.filter(row => String(row.DEBUG_DATA ?? "").trim() !== "*YES").map(row => String(row.BOUND_MODULE).trim());
        const stale = modules.filter(row => row.SOURCE_NOW && row.SOURCE_CHANGE_TIMESTAMP && String(row.SOURCE_NOW).slice(0, 19) !== String(row.SOURCE_CHANGE_TIMESTAMP).slice(0, 19)).map(row => String(row.BOUND_MODULE).trim());
        program = {
          library, name,
          modules: modules.map(row => ({ module: String(row.BOUND_MODULE).trim(), attribute: String(row.MODULE_ATTRIBUTE ?? "").trim(), debugData: String(row.DEBUG_DATA ?? "").trim() === "*YES", sourceChangedSinceCompile: stale.includes(String(row.BOUND_MODULE).trim()) }))
        };
        if (without.length === modules.length) {
          add({ id: "program", title: `${library}/${name} can be debugged`, ok: false, detail: "None of its modules has debug data.", fix: "Compile it with DBGVIEW(*SOURCE) (or *LIST / *ALL).", who: "you" });
        } else {
          add({ id: "program", title: `${library}/${name} can be debugged`, ok: true, detail: without.length ? `Debug data in ${modules.length - without.length} of ${modules.length} modules (not in: ${without.slice(0, 8).join(", ")}).` : `All ${modules.length} module(s) have debug data.` });
        }
        if (stale.length) add({ id: "sourceCurrent", title: "Source matches the program", ok: null, detail: `The source of ${stale.slice(0, 8).join(", ")} has changed since the program was compiled: lines shown while debugging may not match.`, fix: "Compile again before debugging.", who: "you" });
      }
    } catch (err: any) {
      add({ id: "program", title: `${library}/${name} can be debugged`, ok: null, detail: `Its modules could not be read: ${String(err?.message || err).slice(0, 160)}` });
    }
  }

  const blocking = checks.filter(check => check.ok === false && check.id !== "sepDaemon");
  return {
    connectionName,
    host,
    port,
    sepPort,
    serviceVersion: version || null,
    ready: blocking.length === 0,
    summary: blocking.length === 0
      ? "Nothing found that would stop a debug session."
      : `${blocking.length} thing(s) to put right first: ${blocking.map(check => check.title).join("; ")}.`,
    checks,
    ...(program ? { program } : {}),
    notes: [
      "Not checked: your authority to STRDBG/STRSRVJOB and to the program (*CHANGE, or *USE with *SERVICE). A session that is refused for authority says so when it starts.",
      "This version checks readiness only; it does not run debug sessions yet."
    ]
  };
}

export const debugModule: ToolModule = {
  tools: [
    {
      name: "ibmi.debug.ready",
      description:
        "Check whether programs on this system can be debugged from this computer, and what is in the way: the IBM i Debug Service (installed, level, running), the debug server, " +
        "the service's certificate (readable, in date, issued for the host name this connection uses), whether the debug port can be reached from here (one TLS handshake), whether the connection has a password to sign on with, " +
        "and, when a program is named, whether it has debug data and its source is unchanged since the compile. Each failed check says what to do and who does it. Only looks; starts nothing.",
      inputSchema: {
        type: "object",
        properties: {
          library: { type: "string", description: "Library of a program to check too." },
          program: { type: "string", description: "A program or service program to check for debug data." },
          checkNetwork: { type: "boolean", description: "Try the debug port from this computer (default true)." },
          connectionName: { type: "string" }
        }
      },
      annotations: READ
    }
  ],
  handle: async (ctx, name, args) => {
    if (name === "ibmi.debug.ready") return json(await debugReadiness(ctx, args));
    throw new Error(`Unknown tool: ${name}`);
  }
};
