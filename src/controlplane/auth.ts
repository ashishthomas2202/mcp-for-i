import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getConfigDir } from "../config/store.js";

/** Header the Web UI and the CLI send with every control-plane API call. */
export const CONTROL_TOKEN_HEADER = "X-MCP-For-I-Token";

const TOKEN_FILE = "controlplane.token";
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function getControlTokenPath(configDir = getConfigDir()) {
  return path.join(configDir, TOKEN_FILE);
}

/** Reads the per-install token, or returns undefined when none exists yet. */
export function readControlToken(configDir = getConfigDir()): string | undefined {
  try {
    const raw = fs.readFileSync(getControlTokenPath(configDir), "utf8").trim();
    return TOKEN_PATTERN.test(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the per-install token, creating it on first use. The file is written
 * with mode 0600 (owner only) where the platform supports it.
 */
export function ensureControlToken(configDir = getConfigDir()): string {
  const existing = readControlToken(configDir);
  if (existing) return existing;

  fs.mkdirSync(configDir, { recursive: true });
  const tokenPath = getControlTokenPath(configDir);
  const token = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return token;
  } catch (err: any) {
    if (err?.code !== "EEXIST") throw err;
  }

  // Another process created it first, or the existing file is unreadable/invalid.
  const raced = readControlToken(configDir);
  if (raced) return raced;
  fs.writeFileSync(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    // best effort on platforms without POSIX modes
  }
  return token;
}

/** Constant-time token comparison. */
export function tokensMatch(expected: string, provided: unknown) {
  if (typeof provided !== "string" || !provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided.trim(), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Hostnames the control plane answers to (blocks DNS rebinding). */
export function isAllowedHostHeader(hostHeader: string | undefined, port: number, extraHosts: string[] = []) {
  if (!hostHeader) return false;
  const parsed = parseHostPort(hostHeader.trim().toLowerCase());
  if (!parsed) return false;
  const allowed = new Set(["localhost", "127.0.0.1", "[::1]", ...extraHosts.map(normalizeHostName)]);
  if (!allowed.has(parsed.host)) return false;
  const effectivePort = parsed.port ?? 80;
  return effectivePort === port;
}

/** An Origin header, when present, must point at this same local server. */
export function isAllowedOrigin(origin: string | undefined, port: number, extraHosts: string[] = []) {
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  return isAllowedHostHeader(host, port, extraHosts);
}

function parseHostPort(value: string): { host: string; port?: number } | undefined {
  let host: string;
  let portText: string | undefined;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return undefined;
    host = value.slice(0, end + 1);
    const rest = value.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(":")) return undefined;
      portText = rest.slice(1);
    }
  } else {
    const parts = value.split(":");
    if (parts.length > 2) return undefined;
    host = parts[0];
    portText = parts[1];
  }
  if (!host) return undefined;
  if (portText === undefined) return { host };
  if (!/^\d{1,5}$/.test(portText)) return undefined;
  return { host, port: Number(portText) };
}

function normalizeHostName(host: string) {
  const lower = host.trim().toLowerCase();
  if (lower.includes(":") && !lower.startsWith("[")) return `[${lower}]`;
  return lower;
}
