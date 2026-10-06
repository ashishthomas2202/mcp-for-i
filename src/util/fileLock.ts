import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { isTransientFsError, sleep } from "./atomicWrite.js";

export type FileLockOptions = {
  /** A lock whose file has not been touched for this long is considered abandoned. Default 30s. */
  staleMs?: number;
  /** Give up waiting for the lock after this long. Default 15s. */
  timeoutMs?: number;
  /** Base delay between acquisition attempts. Default 20ms (with jitter). */
  retryDelayMs?: number;
};

export type FileLockHandle = {
  lockPath: string;
  token: string;
  release(): Promise<void>;
};

type LockOwner = {
  pid: number;
  hostname: string;
  token: string;
  acquiredAt: string;
};

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_MS = 20;

// Serializes lock users inside this process so they queue instead of spinning on the lock file.
const inProcessQueues = new Map<string, Promise<void>>();

/**
 * Runs `fn` while holding an exclusive lock that works across processes.
 *
 * - Within one process, callers using the same lock path are queued in order.
 * - Across processes the lock is a file created with O_EXCL ("wx"). The owner
 *   refreshes its mtime while it holds the lock; a lock file that is older than
 *   `staleMs`, or whose owner process on this host no longer exists, is broken.
 *
 * The lock is not re-entrant: calling withFileLock for the same path from inside
 * `fn` deadlocks until the timeout.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T> | T, options: FileLockOptions = {}): Promise<T> {
  const key = lockKey(lockPath);
  const previous = inProcessQueues.get(key) || Promise.resolve();
  let releaseQueue!: () => void;
  const gate = new Promise<void>(resolve => {
    releaseQueue = resolve;
  });
  const tail = previous.then(() => gate);
  inProcessQueues.set(key, tail);

  await previous;
  try {
    const handle = await acquireFileLock(lockPath, options);
    try {
      return await fn();
    } finally {
      await handle.release();
    }
  } finally {
    releaseQueue();
    if (inProcessQueues.get(key) === tail) inProcessQueues.delete(key);
  }
}

/**
 * Acquires the cross-process lock file only (no in-process queueing). Prefer
 * withFileLock unless the lock must be held across separate calls.
 */
export async function acquireFileLock(lockPath: string, options: FileLockOptions = {}): Promise<FileLockHandle> {
  const staleMs = Math.max(1000, options.staleMs ?? DEFAULT_STALE_MS);
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const retryDelayMs = Math.max(1, options.retryDelayMs ?? DEFAULT_RETRY_MS);
  const deadline = Date.now() + timeoutMs;
  const token = crypto.randomBytes(16).toString("hex");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  let lastOwner: Partial<LockOwner> | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      await createLockFile(lockPath, token);
      return startHeldLock(lockPath, token, staleMs);
    } catch (err: any) {
      const code = err?.code;
      if (code !== "EEXIST" && !isTransientFsError(err)) throw err;
    }

    const state = await inspectLock(lockPath);
    if (state) {
      lastOwner = state.owner;
      if (isStale(state, staleMs)) {
        await breakStaleLock(lockPath, state.raw);
        continue;
      }
    }

    if (Date.now() >= deadline) {
      const holder = lastOwner?.pid ? ` (held by pid ${lastOwner.pid} on ${lastOwner.hostname || "unknown host"})` : "";
      throw new Error(`Timed out after ${timeoutMs} ms waiting for lock ${lockPath}${holder}`);
    }
    const backoff = Math.min(retryDelayMs * (1 + Math.floor(attempt / 5)), 250);
    await sleep(backoff + Math.floor(Math.random() * retryDelayMs));
  }
}

async function createLockFile(lockPath: string, token: string) {
  const owner: LockOwner = {
    pid: process.pid,
    hostname: os.hostname(),
    token,
    acquiredAt: new Date().toISOString()
  };
  const handle = await fs.open(lockPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(owner), "utf8");
  } finally {
    await handle.close();
  }
}

function startHeldLock(lockPath: string, token: string, staleMs: number): FileLockHandle {
  const heartbeat = setInterval(() => {
    const now = new Date();
    fs.utimes(lockPath, now, now).catch(() => {});
  }, Math.max(250, Math.floor(staleMs / 3)));
  heartbeat.unref?.();

  let released = false;
  return {
    lockPath,
    token,
    async release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      try {
        const raw = await fs.readFile(lockPath, "utf8");
        if (parseOwner(raw)?.token !== token) return; // our lock was broken and someone else owns it now
      } catch {
        return;
      }
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          await fs.unlink(lockPath);
          return;
        } catch (err: any) {
          if (err?.code === "ENOENT") return;
          if (!isTransientFsError(err)) throw err;
          await sleep(15 * (attempt + 1));
        }
      }
    }
  };
}

async function inspectLock(lockPath: string): Promise<{ raw: string; owner?: Partial<LockOwner>; mtimeMs: number } | undefined> {
  try {
    const stat = await fs.stat(lockPath);
    let raw = "";
    try {
      raw = await fs.readFile(lockPath, "utf8");
    } catch {
      // Holder may be mid-create or mid-release; age alone decides.
    }
    return { raw, owner: parseOwner(raw), mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

function isStale(state: { owner?: Partial<LockOwner>; mtimeMs: number }, staleMs: number) {
  if (Date.now() - state.mtimeMs > staleMs) return true;
  const owner = state.owner;
  if (owner?.pid && owner.hostname === os.hostname() && owner.pid !== process.pid) {
    return !isProcessAlive(owner.pid);
  }
  return false;
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

async function breakStaleLock(lockPath: string, observedRaw: string) {
  const aside = `${lockPath}.stale-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    await fs.rename(lockPath, aside);
  } catch {
    return; // someone else broke or released it first
  }
  let movedRaw = "";
  try {
    movedRaw = await fs.readFile(aside, "utf8");
  } catch {
    // ignore
  }
  if (observedRaw && movedRaw !== observedRaw) {
    // We moved a lock that was re-acquired after we inspected it. Put it back if nobody took the slot.
    await fs.link(aside, lockPath).catch(() => {});
  }
  await fs.rm(aside, { force: true }).catch(() => {});
}

function parseOwner(raw: string): Partial<LockOwner> | undefined {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function lockKey(lockPath: string) {
  const resolved = path.resolve(lockPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
