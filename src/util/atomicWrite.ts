import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

/**
 * Error codes that Windows (antivirus, search indexer, backup agents, another
 * reader holding the file open) raises transiently on rename/open/unlink.
 */
const TRANSIENT_CODES = new Set(["EPERM", "EBUSY", "EACCES", "EAGAIN", "EMFILE", "ENFILE"]);

export function isTransientFsError(err: unknown) {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}

export type AtomicWriteOptions = {
  /** File mode for the new file (e.g. 0o600). Ignored by Windows except for the read-only bit. */
  mode?: number;
  /** Number of retries for transient rename failures. Default 10. */
  retries?: number;
  /** Base delay in ms between retries (grows linearly). Default 25. */
  retryDelayMs?: number;
  /** fsync the temp file before rename. Default true. */
  fsync?: boolean;
  encoding?: BufferEncoding;
};

/**
 * Writes `data` to `filePath` atomically: the content goes to a uniquely named
 * temp file in the same directory, is fsynced, and then renamed over the target.
 * Rename is retried on transient Windows errors. There is deliberately no
 * non-atomic fallback: if the rename keeps failing the temp file is removed and
 * the error is thrown, leaving the original file untouched.
 */
export async function writeFileAtomic(filePath: string, data: string | Uint8Array, options: AtomicWriteOptions = {}) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  const mode = options.mode ?? 0o666;
  const handle = await fs.open(tempPath, "wx", mode);
  try {
    if (typeof data === "string") {
      await handle.writeFile(data, options.encoding || "utf8");
    } else {
      await handle.writeFile(data);
    }
    if (options.fsync !== false) {
      await handle.sync();
    }
  } catch (err) {
    await handle.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
  await handle.close();

  try {
    await renameWithRetry(tempPath, filePath, options.retries ?? 10, options.retryDelayMs ?? 25);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }

  if (options.mode !== undefined && process.platform !== "win32") {
    await fs.chmod(filePath, options.mode).catch(() => {});
  }
  if (options.fsync !== false) {
    await fsyncDirectory(dir);
  }
}

export async function renameWithRetry(from: string, to: string, retries = 10, delayMs = 25) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      if (!isTransientFsError(err) || attempt >= retries) throw err;
      await sleep(delayMs * (attempt + 1));
    }
  }
}

/** Reads a file, retrying on transient Windows sharing errors. ENOENT and other errors are thrown unchanged. */
export async function readFileWithRetry(filePath: string, retries = 5, delayMs = 25): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (err) {
      if (!isTransientFsError(err) || attempt >= retries) throw err;
      await sleep(delayMs * (attempt + 1));
    }
  }
}

async function fsyncDirectory(dir: string) {
  // Directory fsync makes the rename durable on POSIX; Windows cannot open directories this way.
  if (process.platform === "win32") return;
  try {
    const handle = await fs.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort only.
  }
}

export function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}
