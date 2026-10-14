import crypto from "crypto";
import { createReadStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { Tools } from "../ibmi/Tools.js";

/**
 * Helpers for the deploy.sync / deploy.compare `method` option:
 * - "all":        size-based comparison of the whole tree (original behavior)
 * - "changed":    content comparison by SHA-256 (local via node crypto,
 *                 remote via sha256sum or openssl in batched PASE calls)
 * - "gitChanged": staged, unstaged and untracked files reported by git
 * - "selection":  an explicit list of relative file paths
 */
export type DeployMethod = "all" | "changed" | "gitChanged" | "selection";

export const DEPLOY_METHODS: DeployMethod[] = ["all", "changed", "gitChanged", "selection"];

export function normalizeDeployMethod(value: unknown): DeployMethod {
  if (value === undefined || value === null || value === "") return "all";
  const method = String(value);
  if (!DEPLOY_METHODS.includes(method as DeployMethod)) {
    throw new Error(`Invalid method: ${method}. Expected one of ${DEPLOY_METHODS.join(", ")}`);
  }
  return method as DeployMethod;
}

export async function sha256LocalFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// Upper bound on the size of one remote hashing command (bytes of quoted
// paths) and on the number of files hashed per call.
const REMOTE_HASH_BATCH_BYTES = 24_000;
const REMOTE_HASH_BATCH_FILES = 200;
const NO_HASH_TOOL_MARKER = "MCPFORI_NO_SHA256_TOOL";

/**
 * Picks sha256sum (PATH or /QOpenSys/pkgs/bin) or openssl, then hashes the
 * given files. Kept as one shell snippet so detection costs no extra call.
 */
function remoteHashCommand(remoteRoot: string, relPaths: string[]) {
  const quoted = relPaths.map(rel => Tools.shellQuote(`./${rel}`)).join(" ");
  return [
    `cd ${Tools.shellQuote(remoteRoot)} || exit 2`,
    `if command -v sha256sum >/dev/null 2>&1; then H="sha256sum"`,
    `elif [ -x /QOpenSys/pkgs/bin/sha256sum ]; then H="/QOpenSys/pkgs/bin/sha256sum"`,
    `elif command -v openssl >/dev/null 2>&1; then H="openssl dgst -sha256 -r"`,
    `elif [ -x /QOpenSys/usr/bin/openssl ]; then H="/QOpenSys/usr/bin/openssl dgst -sha256 -r"`,
    `else echo ${NO_HASH_TOOL_MARKER} >&2; exit 127; fi`,
    `$H ${quoted}`
  ].join("; ");
}

/** Parses sha256sum / `openssl dgst -r` / `openssl dgst` output into rel path -> hex. */
export function parseRemoteHashOutput(output: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    let hex: string | undefined;
    let file: string | undefined;
    const coreutils = line.match(/^\\?([0-9a-fA-F]{64}) [ *](.+)$/);
    if (coreutils) {
      hex = coreutils[1];
      file = coreutils[2];
    } else {
      const bsd = line.match(/^SHA2?-?256\((.+)\)\s*=\s*([0-9a-fA-F]{64})$/);
      if (bsd) {
        file = bsd[1];
        hex = bsd[2];
      }
    }
    if (!hex || !file) continue;
    hashes.set(file.replace(/^\.\//, ""), hex.toLowerCase());
  }
  return hashes;
}

/**
 * Hashes remote files (paths relative to remoteRoot) in batches. Files that
 * could not be hashed are simply absent from the result. Throws when the
 * remote system has neither sha256sum nor openssl.
 */
export async function sha256RemoteFiles(conn: any, remoteRoot: string, relPaths: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const root = remoteRoot.replace(/\/+$/, "") || "/";
  const usable = relPaths.filter(rel => !/[\r\n]/.test(rel));
  let batch: string[] = [];
  let batchBytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const res = await conn.sendCommand({ command: remoteHashCommand(root, batch) });
    if (String(res?.stderr || "").includes(NO_HASH_TOOL_MARKER)) {
      throw new Error("No SHA-256 tool (sha256sum or openssl) found on the IBM i; use method \"all\" instead");
    }
    if (res?.code === 2 && !String(res?.stdout || "").trim()) {
      throw new Error(`Remote directory ${root} is not accessible: ${String(res?.stderr || "").trim()}`);
    }
    // A non-zero exit with partial output means some files could not be
    // read; those stay unhashed and are treated as changed by the caller.
    for (const [file, hex] of parseRemoteHashOutput(res?.stdout || "")) result.set(file, hex);
    batch = [];
    batchBytes = 0;
  };
  for (const rel of usable) {
    const size = rel.length + 6;
    if (batch.length > 0 && (batch.length >= REMOTE_HASH_BATCH_FILES || batchBytes + size > REMOTE_HASH_BATCH_BYTES)) {
      await flush();
    }
    batch.push(rel);
    batchBytes += size;
  }
  await flush();
  return result;
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true, shell: false }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || "").trim();
        reject(new Error(`git ${args[0]} failed: ${detail}`));
        return;
      }
      resolve(String(stdout));
    });
  });
}

export type GitChangedFiles = {
  /** Files under localRoot that exist and are staged, unstaged or untracked. */
  files: string[];
  /** Files git reports as deleted (not uploaded, reported only). */
  deleted: string[];
};

/** Parses `git status --porcelain -z` output (paths relative to the repo root). */
export function parseGitPorcelainZ(output: string): Array<{ status: string; path: string }> {
  const entries: Array<{ status: string; path: string }> = [];
  const tokens = String(output || "").split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4) continue;
    const status = token.substring(0, 2);
    const file = token.substring(3);
    entries.push({ status, path: file });
    // Renames and copies are followed by the original path.
    if (status[0] === "R" || status[0] === "C") i++;
  }
  return entries;
}

/**
 * Files changed in the git working tree under localRoot (staged, unstaged
 * and untracked), as paths relative to localRoot with forward slashes.
 */
export async function gitChangedFiles(localRoot: string): Promise<GitChangedFiles> {
  const prefix = (await runGit(localRoot, ["rev-parse", "--show-prefix"])).trim().replace(/\\/g, "/");
  const output = await runGit(localRoot, ["status", "--porcelain", "-z", "--untracked-files=all", "--", "."]);
  const files = new Set<string>();
  const deleted = new Set<string>();
  for (const entry of parseGitPorcelainZ(output)) {
    const repoPath = entry.path.replace(/\\/g, "/");
    if (prefix && !repoPath.startsWith(prefix)) continue;
    const rel = repoPath.substring(prefix.length);
    if (!rel || rel.endsWith("/")) continue;
    const full = path.join(localRoot, rel);
    const stat = await fs.stat(full).catch(() => undefined);
    if (stat?.isFile()) files.add(rel);
    else if (!stat) deleted.add(rel);
  }
  return {
    files: Array.from(files).sort((a, b) => a.localeCompare(b)),
    deleted: Array.from(deleted).sort((a, b) => a.localeCompare(b))
  };
}

/**
 * Normalizes an explicit file selection: relative paths only, no `..`, with
 * forward slashes and duplicates removed.
 */
export function normalizeDeploySelection(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("files must be a non-empty array of paths relative to localPath for method \"selection\"");
  }
  const out = new Set<string>();
  for (const item of value) {
    const raw = String(item ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!raw) throw new Error("files contains an empty path");
    if (raw.includes("\0") || /[\r\n]/.test(raw)) throw new Error(`Invalid file path: ${item}`);
    if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new Error(`files must be relative to localPath: ${item}`);
    if (raw.split("/").some(segment => segment === "..")) throw new Error(`files must not contain '..': ${item}`);
    out.add(raw.replace(/\/+/g, "/"));
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}
