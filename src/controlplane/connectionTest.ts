import crypto from "crypto";
import dns from "dns/promises";
import fs from "fs/promises";
import net from "net";
import { createRequire } from "module";
import { Tools } from "../ibmi/Tools.js";
import {
  ACCEPT_NEW_HOSTKEY_ENV,
  getKnownHostsPath,
  hostKeyFingerprint,
  isNewHostKeyAccepted,
  knownHostId,
  readKnownHosts
} from "../ibmi/knownHosts.js";

/**
 * One-off "does this connection work" check for the control plane: finds the
 * host, opens the SSH port, checks the host key, signs on once and signs off.
 * Nothing is written on the IBM i, and the host key is not recorded here (the
 * first real connection does that).
 *
 * Every failed sign-on counts toward the system's QMAXSIGN limit, so a test
 * makes exactly one password attempt (no keyboard-interactive retry), and a
 * password the system already rejected is not sent again.
 */

export type ConnectionTestTarget = {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
};

export type ConnectionTestCode =
  | "ok"
  | "invalid-input"
  | "host-not-found"
  | "host-unreachable"
  | "port-closed"
  | "port-timeout"
  | "not-ssh"
  | "host-key-changed"
  | "no-credentials"
  | "key-unreadable"
  | "auth-failed"
  | "password-expired"
  | "password-already-rejected"
  | "timeout"
  | "error";

export type ConnectionTestStep = { name: string; ok: boolean; detail: string };

export type ConnectionTestResult = {
  ok: boolean;
  code: ConnectionTestCode;
  /** Plain-language summary, safe to show as is. */
  message: string;
  steps: ConnectionTestStep[];
  warnings: string[];
  hostKey?: { fingerprint: string; status: "trusted" | "new" | "changed"; stored?: string };
  profile?: { daysUntilPasswordExpires: number };
  testedAt: string;
  durationMs: number;
};

export type HostKeyCheck = { status: "trusted" | "new" | "changed"; fingerprint: string; stored?: string };

export type SshAttemptOutcome =
  | { kind: "ready"; profile?: { daysUntilPasswordExpires?: number } }
  | { kind: "host-key-changed"; hostKey: HostKeyCheck }
  | { kind: "password-expired"; prompt?: string }
  | { kind: "error"; error: any };

export type ConnectionTestDeps = {
  lookup: (host: string) => Promise<string>;
  /** Resolves with the first bytes the server sent (the SSH banner). */
  probePort: (address: string, port: number, timeoutMs: number) => Promise<string>;
  readKey: (path: string) => Promise<string>;
  checkHostKey: (host: string, port: number, key: Buffer) => Promise<HostKeyCheck>;
  ssh: (options: SshAttemptOptions) => Promise<SshAttemptOutcome>;
  now: () => number;
};

export type SshAttemptOptions = {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  timeoutMs: number;
  checkHostKey: (key: Buffer) => Promise<HostKeyCheck>;
};

const DNS_TIMEOUT_MS = 5000;
const PORT_TIMEOUT_MS = 5000;
const SSH_TIMEOUT_MS = 20000;
const PROFILE_TIMEOUT_MS = 20000;
const REJECTED_TTL_MS = 15 * 60 * 1000;
const PASSWORD_WARNING_DAYS = 14;

/** Passwords the IBM i rejected recently, by hash of host, port, user and password. */
const rejected = new Map<string, number>();

function rejectionKey(target: ConnectionTestTarget, port: number) {
  return crypto.createHash("sha256")
    .update([target.host.trim().toLowerCase(), port, target.username.trim().toUpperCase(), target.password || ""].join("\0"))
    .digest("hex");
}

function wasRejected(key: string, now: number) {
  const at = rejected.get(key);
  if (at === undefined) return false;
  if (now - at > REJECTED_TTL_MS) {
    rejected.delete(key);
    return false;
  }
  return true;
}

/** Forgets every remembered rejection (for tests). */
export function clearRejectedPasswords() {
  rejected.clear();
}

export async function testConnection(target: ConnectionTestTarget, deps: Partial<ConnectionTestDeps> = {}): Promise<ConnectionTestResult> {
  const d: ConnectionTestDeps = { ...defaultDeps, ...deps };
  const started = d.now();
  const steps: ConnectionTestStep[] = [];
  const warnings: string[] = [];
  let hostKey: ConnectionTestResult["hostKey"];
  let profile: ConnectionTestResult["profile"];

  const finish = (code: ConnectionTestCode, message: string): ConnectionTestResult => ({
    ok: code === "ok",
    code,
    message,
    steps,
    warnings,
    ...(hostKey ? { hostKey } : {}),
    ...(profile ? { profile } : {}),
    testedAt: new Date(d.now()).toISOString(),
    durationMs: Math.max(0, d.now() - started)
  });

  const host = String(target?.host ?? "").trim();
  const username = String(target?.username ?? "").trim();
  const port = Number(target?.port || 22);
  if (!host || !username) return finish("invalid-input", "Enter a host and a username to test.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) return finish("invalid-input", "The SSH port must be between 1 and 65535.");

  // 1. Name lookup
  let address: string;
  try {
    address = await withTimeout(d.lookup(host), DNS_TIMEOUT_MS, "lookup");
    steps.push({ name: "Host lookup", ok: true, detail: address === host ? host : `${host} is ${address}` });
  } catch (err: any) {
    steps.push({ name: "Host lookup", ok: false, detail: err?.code || err?.message || String(err) });
    return finish("host-not-found", `Host ${host} was not found. Check the spelling, or that this computer can resolve it (VPN or DNS).`);
  }

  // 2. SSH port
  try {
    const banner = await d.probePort(address, port, PORT_TIMEOUT_MS);
    if (banner && !banner.startsWith("SSH-")) {
      steps.push({ name: "SSH port", ok: false, detail: `Port ${port} answered, but not with SSH` });
      return finish("not-ssh", `Port ${port} on ${host} is open but is not an SSH server. Check the port number.`);
    }
    steps.push({ name: "SSH port", ok: true, detail: banner ? banner.trim() : `Port ${port} accepted the connection` });
  } catch (err: any) {
    const code = err?.code;
    steps.push({ name: "SSH port", ok: false, detail: code || err?.message || String(err) });
    if (code === "ECONNREFUSED") {
      return finish("port-closed", `${host} refused a connection on port ${port}. SSH may not be running there (STRTCPSVR SERVER(*SSHD)), or the port is wrong.`);
    }
    if (code === "ETIMEDOUT" || code === "TIMEOUT") {
      return finish("port-timeout", `No answer from ${host} on port ${port}. The system may be down, or a firewall or VPN is blocking the port.`);
    }
    if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
      return finish("host-unreachable", `${host} cannot be reached from this computer. Check the network or VPN.`);
    }
    return finish("error", `Could not open port ${port} on ${host}: ${err?.message || err}`);
  }

  // 3. Credentials available?
  let privateKey: string | undefined;
  if (target.privateKeyPath) {
    try {
      privateKey = await d.readKey(target.privateKeyPath);
    } catch (err: any) {
      steps.push({ name: "Private key", ok: false, detail: err?.code || err?.message || String(err) });
      return finish("key-unreadable", `The private key ${target.privateKeyPath} could not be read on this computer.`);
    }
  }
  if (!target.password && !privateKey) {
    return finish("no-credentials", "The host and SSH port work. Enter a password or a private key path to test the sign-on.");
  }

  const key = rejectionKey(target, port);
  if (target.password && !privateKey && wasRejected(key, d.now())) {
    return finish(
      "password-already-rejected",
      `${host} already rejected this password for ${username.toUpperCase()}. It was not sent again, because every failed sign-on counts toward disabling the profile. Enter a different password.`
    );
  }

  // 4. Host key and sign-on
  const outcome = await d.ssh({
    host,
    port,
    username,
    password: target.password,
    privateKey,
    timeoutMs: SSH_TIMEOUT_MS,
    checkHostKey: async (raw: Buffer) => {
      const check = await d.checkHostKey(host, port, raw);
      hostKey = check;
      return check;
    }
  });

  if (hostKey && hostKey.status !== "changed") {
    steps.push({
      name: "Host key",
      ok: true,
      detail: hostKey.status === "trusted" ? "Matches the saved key" : `New key ${hostKey.fingerprint}, saved on the first connection`
    });
  }

  if (outcome.kind === "host-key-changed") {
    hostKey = outcome.hostKey;
    steps.push({ name: "Host key", ok: false, detail: `Saved ${outcome.hostKey.stored}, server sent ${outcome.hostKey.fingerprint}` });
    return finish(
      "host-key-changed",
      `The SSH host key of ${host} has changed, so the password was not sent. If the system was rebuilt or its keys were regenerated, remove its entry from ${getKnownHostsPath()} or set ${ACCEPT_NEW_HOSTKEY_ENV}=${knownHostId(host, port)}.`
    );
  }

  if (outcome.kind === "password-expired") {
    steps.push({ name: "Sign-on", ok: false, detail: outcome.prompt || "Password change required" });
    return finish("password-expired", `The password for ${username.toUpperCase()} has expired. Change it on the IBM i (for example with a 5250 sign-on), then save the new one here.`);
  }

  if (outcome.kind === "error") {
    const err = outcome.error;
    const level = err?.level;
    const text = String(err?.message || err);
    steps.push({ name: "Sign-on", ok: false, detail: text });
    if (level === "client-authentication" || /authentication methods failed/i.test(text)) {
      if (target.password && !privateKey) rejected.set(key, d.now());
      return finish(
        "auth-failed",
        privateKey && !target.password
          ? `${host} did not accept the private key for ${username.toUpperCase()}. Check that its public key is in the user's ~/.ssh/authorized_keys on the IBM i.`
          : `${host} rejected the username or password for ${username.toUpperCase()}. A disabled profile or an expired password gets the same answer over SSH, so check those too if the password is right.`
      );
    }
    if (level === "client-timeout" || /timed out/i.test(text)) {
      return finish("timeout", `${host} did not finish the SSH sign-on in time. The system may be busy; try again.`);
    }
    if (/privateKey|private key|Unsupported key format|Cannot parse/i.test(text)) {
      return finish("key-unreadable", `The private key ${target.privateKeyPath} could not be used: ${text}`);
    }
    return finish("error", `The SSH sign-on failed: ${text}`);
  }

  rejected.delete(key);
  steps.push({ name: "Sign-on", ok: true, detail: `Signed on as ${username.toUpperCase()} and signed off` });
  const days = outcome.profile?.daysUntilPasswordExpires;
  if (typeof days === "number") {
    profile = { daysUntilPasswordExpires: days };
    if (days >= 0 && days <= PASSWORD_WARNING_DAYS) {
      warnings.push(days === 0 ? "The password expires today." : `The password expires in ${days} day${days === 1 ? "" : "s"}.`);
    }
  }
  return finish("ok", `Connected to ${host} as ${username.toUpperCase()}.`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`${what} timed out`), { code: "TIMEOUT" })), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

async function lookupHost(host: string) {
  if (net.isIP(host)) return host;
  const result = await dns.lookup(host);
  return result.address;
}

function probePort(address: string, port: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    let connected = false;
    let banner = "";
    const done = (err?: any) => {
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err); else resolve(banner);
    };
    const timer = setTimeout(() => {
      // Connected but silent: still a working port, just no banner yet.
      if (connected) done();
      else done(Object.assign(new Error("Connection timed out"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    socket.once("connect", () => { connected = true; });
    socket.on("data", chunk => {
      banner += chunk.toString("latin1");
      if (banner.includes("\n") || banner.length >= 255) {
        banner = banner.split(/\r?\n/)[0];
        done();
      }
    });
    socket.once("error", err => done(err));
    socket.once("end", () => done());
  });
}

async function checkStoredHostKey(host: string, port: number, key: Buffer): Promise<HostKeyCheck> {
  const fingerprint = hostKeyFingerprint(key);
  const data = await readKnownHosts(getKnownHostsPath());
  const existing = data.hosts[knownHostId(host, port)];
  if (!existing) return { status: "new", fingerprint };
  if (existing.fingerprint === fingerprint) return { status: "trusted", fingerprint };
  if (isNewHostKeyAccepted(process.env[ACCEPT_NEW_HOSTKEY_ENV], host, port, fingerprint)) {
    return { status: "new", fingerprint, stored: existing.fingerprint };
  }
  return { status: "changed", fingerprint, stored: existing.fingerprint };
}

/** Days until the password expires (null when it never does). */
const PROFILE_SQL =
  "SELECT DAYS_UNTIL_PASSWORD_EXPIRES AS DAYS FROM QSYS2.USER_INFO WHERE AUTHORIZATION_NAME = USER";

const PROFILE_COMMAND =
  "LC_ALL=EN_US.UTF-8 /QOpenSys/usr/bin/qsh -c " +
  Tools.shellQuote(`system "call QSYS/QZDFMDB2 PARM('-d' '-i' '-t')"`);

function sshAttempt(options: SshAttemptOptions): Promise<SshAttemptOutcome> {
  const require = createRequire(import.meta.url);
  const { Client } = require("ssh2");
  return new Promise(resolve => {
    const client = new Client();
    let settled = false;
    let hostKeyChanged: HostKeyCheck | undefined;
    const settle = (outcome: SshAttemptOutcome) => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch { /* already closed */ }
      resolve(outcome);
    };

    client.on("change password", (prompt: string) => {
      // Never change the password from a test; just report it.
      settle({ kind: "password-expired", prompt });
    });
    client.on("error", (error: any) => {
      if (hostKeyChanged) settle({ kind: "host-key-changed", hostKey: hostKeyChanged });
      else settle({ kind: "error", error });
    });
    client.on("close", () => {
      if (hostKeyChanged) settle({ kind: "host-key-changed", hostKey: hostKeyChanged });
      else settle({ kind: "error", error: new Error("The server closed the connection") });
    });
    client.on("ready", async () => {
      const profile = await readProfile(client).catch(() => undefined);
      settle({ kind: "ready", profile });
    });

    client.connect({
      host: options.host,
      port: options.port,
      username: options.username,
      password: options.password,
      privateKey: options.privateKey,
      tryKeyboard: false,
      readyTimeout: options.timeoutMs,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        options.checkHostKey(key)
          .then(check => {
            if (check.status === "changed") hostKeyChanged = check;
            verify(check.status !== "changed");
          })
          .catch(() => verify(false));
      }
    });
  });
}

function readProfile(client: any): Promise<{ daysUntilPasswordExpires?: number } | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("profile query timed out")), PROFILE_TIMEOUT_MS);
    client.exec(PROFILE_COMMAND, (err: any, stream: any) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      let stdout = "";
      stream.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      stream.stderr.on("data", () => undefined);
      stream.on("close", () => {
        clearTimeout(timer);
        try {
          const rows = Tools.db2Parse(stdout, PROFILE_SQL);
          const row = rows[0];
          if (!row) return resolve(undefined);
          const days = row.DAYS === null || row.DAYS === undefined || row.DAYS === "" ? undefined : Number(row.DAYS);
          resolve({
            daysUntilPasswordExpires: Number.isFinite(days) ? days : undefined
          });
        } catch (parseErr) {
          reject(parseErr);
        }
      });
      stream.end(`${PROFILE_SQL}\n`);
    });
  });
}

const defaultDeps: ConnectionTestDeps = {
  lookup: lookupHost,
  probePort,
  readKey: path => fs.readFile(path, "utf8"),
  checkHostKey: checkStoredHostKey,
  ssh: sshAttempt,
  now: () => Date.now()
};
