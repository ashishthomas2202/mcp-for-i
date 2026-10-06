import fs from "fs/promises";
import os from "os";
import path from "path";
import { getConfigDir } from "../config/store.js";

/**
 * Guard for local (PC-side) file paths used by tools such as ifs.upload,
 * ifs.download, deploy.*, audit.export and compliance.report.generate.
 *
 * A path is allowed when, after resolving `..` and symlinks, it lies inside
 * one of the allowed roots and not inside a sensitive location.
 *
 * Allowed roots, first match wins:
 * 1. MCP_FOR_I_ALLOWED_LOCAL_ROOTS (list separated by the OS path delimiter)
 * 2. the `allowedLocalRoots` array in the global config settings
 * 3. default: the process working directory and the user's home directory
 *
 * Sensitive locations are always refused, even inside an allowed root.
 */

export type LocalPathMode = "read" | "write";

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

function sensitiveLocations(): string[] {
  const home = os.homedir();
  const list = [
    ".ssh",
    ".aws",
    ".gnupg",
    ".azure",
    ".kube",
    ".docker",
    ".netrc",
    ".git-credentials",
    ".pgpass",
    ".npmrc",
    ".pypirc",
    path.join(".config", "gcloud"),
    path.join(".config", "gh")
  ].map(rel => path.join(home, rel));
  if (process.platform === "win32") {
    list.push(process.env.APPDATA || path.join(home, "AppData", "Roaming"));
  }
  if (process.platform === "darwin") {
    list.push(path.join(home, "Library", "Keychains"));
  }
  list.push(getConfigDir());
  return list;
}

/**
 * On Windows, %LOCALAPPDATA% holds browser profiles and cached tokens, but
 * also the temp directory. Everything there except temp is refused.
 */
function isInsideLocalAppDataOutsideTemp(resolved: string) {
  if (process.platform !== "win32") return false;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  if (!isInside(resolved, localAppData)) return false;
  return !isInside(resolved, os.tmpdir()) && !isInside(resolved, path.join(localAppData, "Temp"));
}

function isCredentialsFileUnderConfig(resolved: string) {
  const configRoot = path.join(os.homedir(), ".config");
  if (!isInside(resolved, configRoot)) return false;
  return path.relative(configRoot, resolved)
    .split(path.sep)
    .some(segment => /^credentials(\.[\w-]+)?$/i.test(segment));
}

function comparable(value: string) {
  const normalized = path.resolve(value);
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function isInside(target: string, root: string) {
  const relative = path.relative(comparable(root), comparable(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolve symlinks for the longest existing prefix of the path. */
async function realpathAllowMissing(target: string): Promise<string> {
  const absolute = path.resolve(target);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return missing.length > 0 ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function parseRootList(value: string | undefined): string[] {
  return String(value || "")
    .split(path.delimiter)
    .map(item => item.trim())
    .filter(Boolean);
}

export function defaultLocalRoots(): string[] {
  // A working directory that is a filesystem root (common when a client
  // launches the server) would allow the whole disk, so it is skipped.
  return [process.cwd(), os.homedir()].filter(root => {
    const resolved = path.resolve(root);
    return path.parse(resolved).root !== resolved;
  });
}

export function configuredLocalRoots(settingsRoots?: unknown): string[] {
  const fromEnv = parseRootList(process.env.MCP_FOR_I_ALLOWED_LOCAL_ROOTS);
  if (fromEnv.length > 0) return fromEnv;
  if (Array.isArray(settingsRoots)) {
    const fromSettings = settingsRoots.map(v => String(v || "").trim()).filter(Boolean);
    if (fromSettings.length > 0) return fromSettings;
  }
  return defaultLocalRoots();
}

/**
 * Resolve a local path and refuse it unless it is inside an allowed root and
 * outside every sensitive location. Returns the resolved real path, which
 * callers should use for the actual file operation.
 */
export async function resolveAllowedLocalPath(
  value: unknown,
  mode: LocalPathMode,
  roots: string[] = configuredLocalRoots()
): Promise<string> {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("Local path is required");
  if (raw.includes("\0")) throw new Error("Local path contains a NUL character");

  const expanded = raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")
    ? path.join(os.homedir(), raw.substring(1))
    : raw;
  const resolved = await realpathAllowMissing(expanded);

  for (const sensitive of sensitiveLocations()) {
    const realSensitive = await realpathAllowMissing(sensitive);
    if (isInside(resolved, sensitive) || isInside(resolved, realSensitive)) {
      throw new Error(`Local path refused (${mode}): ${raw} is inside a protected location`);
    }
  }
  if (isInsideLocalAppDataOutsideTemp(resolved)) {
    throw new Error(`Local path refused (${mode}): ${raw} is inside a protected location`);
  }
  if (isCredentialsFileUnderConfig(resolved)) {
    throw new Error(`Local path refused (${mode}): ${raw} is a credentials file`);
  }

  for (const root of roots) {
    const realRoot = await realpathAllowMissing(root);
    if (isInside(resolved, realRoot)) return resolved;
  }
  throw new Error(
    `Local path refused (${mode}): ${raw} is outside the allowed local roots. ` +
    "Set MCP_FOR_I_ALLOWED_LOCAL_ROOTS or settings.allowedLocalRoots to allow it."
  );
}
