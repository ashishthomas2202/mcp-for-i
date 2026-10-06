import { CONTROL_TOKEN_HEADER, readControlToken } from "./auth.js";

/** Marker returned by /api/health so callers know they reached this service. */
export const HEALTH_SERVICE_ID = "mcp-for-i-control";

export function getControlPlanePort() {
  const portRaw = Number(process.env.MCP_FOR_I_CONTROL_PORT || 3980);
  return Number.isFinite(portRaw) && portRaw > 0 && portRaw <= 65535 ? Math.floor(portRaw) : 3980;
}

export function getControlPlaneUrl() {
  const configured = (process.env.MCP_FOR_I_CONTROL_HOST || "").trim();
  // A wildcard bind address is not a valid Host for the server's checks.
  const host = !configured || ["0.0.0.0", "::", "[::]"].includes(configured) ? "127.0.0.1" : configured;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${getControlPlanePort()}`;
}

/** Headers the CLI sends to the control plane (includes the per-install token). */
export function getControlPlaneAuthHeaders(): Record<string, string> {
  const token = readControlToken();
  return token ? { [CONTROL_TOKEN_HEADER]: token } : {};
}

export async function isControlPlaneRunning(baseUrl = getControlPlaneUrl()) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: controller.signal,
      headers: getControlPlaneAuthHeaders()
    });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const body: any = await res.json().catch(() => null);
    return Boolean(body?.ok);
  } catch {
    return false;
  }
}
