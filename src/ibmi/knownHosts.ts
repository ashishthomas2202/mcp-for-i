import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { getConfigDir } from "../config/store.js";

/**
 * Trust-on-first-use SSH host key store.
 *
 * Fingerprints are kept as OpenSSH-style SHA256 strings ("SHA256:<base64>")
 * per "host:port" in known_hosts.json in the mcp-for-i config directory.
 */

export const ACCEPT_NEW_HOSTKEY_ENV = "MCP_FOR_I_ACCEPT_NEW_HOSTKEY";

export interface KnownHostEntry {
  fingerprint: string;
  keyType?: string;
  addedAt: string;
  updatedAt: string;
}

export interface KnownHostsFile {
  version: 1;
  hosts: Record<string, KnownHostEntry>;
}

export type HostKeyStatus = "trusted" | "added" | "replaced";

export interface HostKeyCheckOptions {
  host: string;
  port: number;
  /** Raw public key blob as presented by the server (SSH wire format). */
  key: Buffer;
  /** Defaults to known_hosts.json in the config directory. */
  filePath?: string;
  /** Defaults to the MCP_FOR_I_ACCEPT_NEW_HOSTKEY environment variable. */
  acceptNew?: string;
}

export class HostKeyMismatchError extends Error {
  constructor(
    public readonly hostKey: string,
    public readonly expected: string,
    public readonly presented: string,
    public readonly filePath: string
  ) {
    super(
      `SSH host key for ${hostKey} has changed. Stored ${expected}, server presented ${presented}. ` +
      `This can mean a man-in-the-middle attack, so the connection was refused. ` +
      `If the change is expected (for example the system was rebuilt or its SSH keys were regenerated), ` +
      `set ${ACCEPT_NEW_HOSTKEY_ENV}=${hostKey} (or =${presented}) and connect again, ` +
      `or remove the "${hostKey}" entry from ${filePath}.`
    );
    this.name = "HostKeyMismatchError";
  }
}

export function getKnownHostsPath() {
  return path.join(getConfigDir(), "known_hosts.json");
}

export function hostKeyFingerprint(key: Buffer) {
  return `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** Reads the key type ("ssh-ed25519", "rsa-sha2-...", ...) from an SSH public key blob. */
export function hostKeyType(key: Buffer): string | undefined {
  if (key.length < 4) return undefined;
  const len = key.readUInt32BE(0);
  if (len <= 0 || len > 64 || 4 + len > key.length) return undefined;
  const type = key.subarray(4, 4 + len).toString("ascii");
  return /^[\x21-\x7e]+$/.test(type) ? type : undefined;
}

export function knownHostId(host: string, port: number) {
  const h = String(host).trim().toLowerCase();
  return h.includes(":") && !h.startsWith("[") ? `[${h}]:${port}` : `${h}:${port}`;
}

/**
 * True when the accept setting allows replacing the stored key for this host.
 * Accepted forms (comma separated): "1"/"true"/"yes"/"all" for any host,
 * "host", "host:port" or the new "SHA256:..." fingerprint.
 */
export function isNewHostKeyAccepted(acceptNew: string | undefined, host: string, port: number, fingerprint: string) {
  if (!acceptNew) return false;
  const id = knownHostId(host, port);
  const bareHost = String(host).trim().toLowerCase();
  return acceptNew.split(",").map(v => v.trim()).filter(Boolean).some(value => {
    const lower = value.toLowerCase();
    if (["1", "true", "yes", "all"].includes(lower)) return true;
    if (value.startsWith("SHA256:")) return value === fingerprint;
    return lower === id || lower === bareHost;
  });
}

async function readKnownHosts(filePath: string): Promise<KnownHostsFile> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return { version: 1, hosts: {} };
    throw err;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never silently forget trusted keys: a damaged file must be fixed by hand.
    throw new Error(`Known hosts file ${filePath} is not valid JSON. Fix or remove it before connecting.`);
  }
  const hosts = parsed && typeof parsed.hosts === "object" && parsed.hosts ? parsed.hosts : {};
  return { version: 1, hosts };
}

async function writeKnownHosts(filePath: string, data: KnownHostsFile) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Checks a presented host key against the store. Adds it on first use,
 * replaces it only when explicitly accepted, and otherwise throws
 * HostKeyMismatchError.
 */
export function checkHostKey(options: HostKeyCheckOptions): Promise<{ status: HostKeyStatus; fingerprint: string }> {
  const run = async () => {
    const filePath = options.filePath || getKnownHostsPath();
    const acceptNew = options.acceptNew ?? process.env[ACCEPT_NEW_HOSTKEY_ENV];
    const id = knownHostId(options.host, options.port);
    const fingerprint = hostKeyFingerprint(options.key);
    const keyType = hostKeyType(options.key);
    const data = await readKnownHosts(filePath);
    const existing = data.hosts[id];
    const now = new Date().toISOString();

    if (existing && existing.fingerprint === fingerprint) {
      return { status: "trusted" as const, fingerprint };
    }
    if (existing && !isNewHostKeyAccepted(acceptNew, options.host, options.port, fingerprint)) {
      throw new HostKeyMismatchError(id, existing.fingerprint, fingerprint, filePath);
    }

    data.hosts[id] = {
      fingerprint,
      ...(keyType ? { keyType } : {}),
      addedAt: existing ? existing.addedAt : now,
      updatedAt: now
    };
    await writeKnownHosts(filePath, data);
    return { status: existing ? "replaced" as const : "added" as const, fingerprint };
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}
