import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "path";
import os from "os";
import { Action, ConnectionConfig, ConnectionData } from "../ibmi/types.js";
import { setPassword } from "../security/credentialStore.js";
import { readFileWithRetry, sleep, writeFileAtomic } from "../util/atomicWrite.js";
import { withFileLock } from "../util/fileLock.js";

export type PolicyProfile = "read-only" | "guarded" | "power-user";

export type ConnectionPolicy = {
  profile: PolicyProfile;
  requireApprovalFor?: string[];
  allowCommands?: string[];
  denyCommands?: string[];
  allowLibraries?: string[];
  denyLibraries?: string[];
  allowPaths?: string[];
  denyPaths?: string[];
};

export type Settings = {
  readOnlyMode: boolean;
  tempLibrary: string;
  tempDir: string;
  autoClearTempData: boolean;
  sourceFileCCSID: string;
  sqlJobCcsid: number;
  enableSourceDates: boolean;
  homeDirectory: string;
  libraryList: string[];
  currentLibrary: string;
  customVariables: { name: string; value: string }[];
  objectFilters: any[];
  ifsShortcuts: string[];
  debugPort: number;
  debugSepPort: number;
  sessionIdleMinutes: number;
  sessionPingSeconds: number;
  sessionReconnectAttempts: number;
};

export type ConnectionProfile = {
  name: string;
  currentLibrary?: string;
  libraryList?: string[];
  customVariables?: { name: string; value: string }[];
};

export type StoredConnection = Omit<ConnectionData, "password"> & {
  settings?: Partial<Settings>;
  profiles?: ConnectionProfile[];
  currentProfile?: string;
  policy?: ConnectionPolicy;
};

export type ConfigFile = {
  connections: StoredConnection[];
  settings: Settings;
  actions: Action[];
};

const defaultSettings: Settings = {
  readOnlyMode: false,
  tempLibrary: "ILEDITOR",
  tempDir: "/tmp",
  autoClearTempData: true,
  sourceFileCCSID: "*FILE",
  sqlJobCcsid: 1208,
  enableSourceDates: true,
  homeDirectory: ".",
  libraryList: [],
  currentLibrary: "",
  customVariables: [],
  objectFilters: [],
  ifsShortcuts: [],
  debugPort: 8005,
  debugSepPort: 8008,
  sessionIdleMinutes: 30,
  sessionPingSeconds: 15,
  sessionReconnectAttempts: 2
};

export class ConfigCorruptError extends Error {
  constructor(
    readonly configPath: string,
    readonly backupPath: string | undefined,
    readonly detail: string
  ) {
    super(
      `Config file ${configPath} could not be parsed (${detail}). ` +
        (backupPath ? `A copy was saved to ${backupPath}. ` : "") +
        "The file was left unchanged; fix or remove it and try again."
    );
    this.name = "ConfigCorruptError";
  }
}

type DiskRead = { exists: true; raw: string; parsed: unknown } | { exists: false };

// configPath -> { raw content already backed up, backup path }
const backedUpCorruptContent = new Map<string, { raw: string; backupPath: string }>();
const plaintextWarnings = new Set<string>();

export type ConfigStoreOptions = {
  /** Overrides the config directory (defaults to getConfigDir()). */
  configDir?: string;
};

export class ConfigStore {
  private configDir: string;
  private configPath: string;
  private lockPath: string;
  private data: ConfigFile | null = null;

  constructor(options: ConfigStoreOptions = {}) {
    this.configDir = options.configDir || getConfigDir();
    this.configPath = path.join(this.configDir, "config.json");
    this.lockPath = `${this.configPath}.lock`;
  }

  getConfigPath() {
    return this.configPath;
  }

  /**
   * Reads the config from disk. Defaults are created only when the file does not
   * exist. A file that exists but cannot be read or parsed is never overwritten:
   * a backup copy is made and ConfigCorruptError is thrown.
   */
  async load(): Promise<ConfigFile> {
    const disk = await this.readFromDisk();
    if (disk.exists) {
      const migrated = await migrateConfigFile(disk.parsed);
      if (!migrated.changed) {
        this.data = migrated.config;
        return this.data;
      }
    }
    // Missing file or a migration is needed: redo the read under the lock so a
    // concurrent writer's changes are not overwritten.
    await this.mutate(() => undefined);
    return this.data!;
  }

  /**
   * Writes the in-memory config as-is (last writer wins). Prefer the specific
   * update methods or mutate(), which re-read the file under the lock first.
   */
  async save() {
    if (!this.data) await this.load();
    const payload = serializeConfig(this.data!);
    await withFileLock(this.lockPath, () => this.writePayload(payload));
  }

  async listConnections() {
    const cfg = await this.load();
    return cfg.connections.map(publicConnection);
  }

  async getConnection(name: string) {
    const cfg = await this.load();
    const found = cfg.connections.find(c => c.name === name);
    return found ? publicConnection(found) : undefined;
  }

  async upsertConnection(connection: StoredConnection) {
    const { sanitized, password, persisted } = await sanitizeConnection(connection);
    await this.mutate(cfg => {
      const idx = cfg.connections.findIndex(c => c.name === sanitized.name);
      if (idx >= 0) {
        const merged = { ...cfg.connections[idx], ...sanitized } as StoredConnection & { password?: string };
        // A legacy plaintext password stays only while it is still the password in
        // use and the keychain could not take it.
        if (password !== undefined && (persisted || merged.password !== password)) {
          delete merged.password;
        }
        cfg.connections[idx] = merged;
      } else {
        cfg.connections.push(sanitized);
      }
    });
  }

  async deleteConnection(name: string) {
    await this.mutate(cfg => {
      cfg.connections = cfg.connections.filter(c => c.name !== name);
    });
  }

  async getSettings() {
    const cfg = await this.load();
    return cfg.settings;
  }

  async updateSettings(update: Partial<Settings>) {
    await this.mutate(cfg => {
      cfg.settings = { ...cfg.settings, ...update };
    });
  }

  async listActions() {
    const cfg = await this.load();
    return cfg.actions || [];
  }

  async upsertAction(action: Action) {
    await this.mutate(cfg => {
      const idx = cfg.actions.findIndex(a => a.name === action.name);
      if (idx >= 0) cfg.actions[idx] = action; else cfg.actions.push(action);
    });
  }

  async deleteAction(name: string) {
    await this.mutate(cfg => {
      cfg.actions = cfg.actions.filter(a => a.name !== name);
    });
  }

  async listProfiles(connectionName: string) {
    const conn = await this.getConnection(connectionName);
    return conn?.profiles || [];
  }

  async saveProfile(connectionName: string, profile: ConnectionProfile) {
    await this.mutateConnection(connectionName, conn => {
      const profiles = conn.profiles || [];
      const idx = profiles.findIndex(p => p.name === profile.name);
      if (idx >= 0) profiles[idx] = profile; else profiles.push(profile);
      conn.profiles = profiles;
    });
  }

  async deleteProfile(connectionName: string, profileName: string) {
    await this.mutateConnection(connectionName, conn => {
      conn.profiles = (conn.profiles || []).filter(p => p.name !== profileName);
      if (conn.currentProfile === profileName) {
        conn.currentProfile = undefined;
      }
    });
  }

  async setCurrentProfile(connectionName: string, profileName?: string) {
    await this.mutateConnection(connectionName, conn => {
      conn.currentProfile = profileName;
    });
  }

  /**
   * Read-modify-write under the cross-process lock: the file is re-read (and
   * migrated) while the lock is held, `fn` changes it, and the result is written
   * atomically. Concurrent callers in this and other processes are serialized,
   * so no update is lost. `fn` must not call other ConfigStore update methods.
   */
  async mutate<T>(fn: (cfg: ConfigFile) => T | Promise<T>): Promise<T> {
    return withFileLock(this.lockPath, async () => {
      const disk = await this.readFromDisk();
      const migrated = await migrateConfigFile(disk.exists ? disk.parsed : undefined);
      const cfg = migrated.config;
      const result = await fn(cfg);
      const payload = serializeConfig(cfg);
      if (!disk.exists || payload !== disk.raw) {
        await this.writePayload(payload);
      }
      this.data = cfg;
      return result;
    });
  }

  private async mutateConnection(connectionName: string, fn: (conn: StoredConnection) => void) {
    await this.mutate(cfg => {
      const conn = cfg.connections.find(c => c.name === connectionName);
      if (!conn) throw new Error(`Connection ${connectionName} not found`);
      fn(conn);
    });
  }

  private async readFromDisk(): Promise<DiskRead> {
    let raw: string;
    try {
      raw = await readFileWithRetry(this.configPath);
    } catch (err: any) {
      if (err?.code === "ENOENT") return { exists: false };
      throw new Error(
        `Config file ${this.configPath} could not be read (${err?.code || err?.message || String(err)}); it was left unchanged.`
      );
    }
    if (raw.trim().length === 0) {
      // An empty file holds nothing that could be lost; treat it like a missing one.
      return { exists: false };
    }
    try {
      return { exists: true, raw, parsed: JSON.parse(stripBom(raw)) };
    } catch {
      // A writer that does not use atomic renames (an older version) may be mid-write.
      await sleep(50);
    }
    try {
      raw = await readFileWithRetry(this.configPath);
    } catch (err: any) {
      if (err?.code === "ENOENT") return { exists: false };
      throw err;
    }
    try {
      return { exists: true, raw, parsed: JSON.parse(stripBom(raw)) };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const backupPath = await this.backupCorruptFile(raw);
      throw new ConfigCorruptError(this.configPath, backupPath, detail);
    }
  }

  private async backupCorruptFile(raw: string) {
    const previous = backedUpCorruptContent.get(this.configPath);
    if (previous && previous.raw === raw) return previous.backupPath;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${this.configPath}.corrupt-${stamp}`;
    try {
      await fs.copyFile(this.configPath, backupPath, fsConstants.COPYFILE_EXCL);
      backedUpCorruptContent.set(this.configPath, { raw, backupPath });
      return backupPath;
    } catch {
      return undefined;
    }
  }

  private async writePayload(payload: string) {
    await fs.mkdir(this.configDir, { recursive: true });
    await writeFileAtomic(this.configPath, payload, { mode: 0o600 });
  }
}

export function getConfigDir() {
  const platform = process.platform;
  if (platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "mcp-for-i");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "mcp-for-i");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "mcp-for-i");
}

function serializeConfig(cfg: ConfigFile) {
  return JSON.stringify(cfg, null, 2);
}

function stripBom(raw: string) {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function publicConnection(connection: StoredConnection): StoredConnection {
  const { password: _password, ...rest } = connection as StoredConnection & { password?: unknown };
  return rest;
}

async function migrateConfigFile(input: unknown): Promise<{ config: ConfigFile; changed: boolean }> {
  let changed = false;
  const root = isPlainObject(input) ? input : {};
  if (!isPlainObject(input)) changed = true;

  const settings = normalizeSettings(root.settings);
  changed = changed || settings.changed;

  const actions = normalizeActions(root.actions);
  changed = changed || actions.changed;

  const normalizedConnections = await normalizeConnections(root.connections);
  changed = changed || normalizedConnections.changed;

  return {
    changed,
    config: {
      connections: normalizedConnections.connections,
      settings: settings.value,
      actions: actions.value
    }
  };
}

async function normalizeConnections(value: unknown): Promise<{ connections: StoredConnection[]; changed: boolean }> {
  if (!Array.isArray(value)) {
    return { connections: [], changed: true };
  }

  let changed = false;
  const seenNames = new Set<string>();
  const connections: StoredConnection[] = [];

  for (const [index, entry] of value.entries()) {
    if (!isPlainObject(entry)) {
      changed = true;
      continue;
    }

    let name = toNonEmptyString(entry.name) || toNonEmptyString(entry.id);
    if (!name) {
      const user = toNonEmptyString(entry.username);
      const host = toNonEmptyString(entry.host);
      if (user && host) {
        name = `${user}@${host}`;
      } else if (host) {
        name = host;
      } else {
        name = `connection-${index + 1}`;
      }
      changed = true;
    }

    const uniqueName = uniqueConnectionName(name, seenNames);
    if (uniqueName !== name) changed = true;
    seenNames.add(uniqueName);

    const password = toNonEmptyString(entry.password);
    let keepPlaintext = false;
    if (password) {
      // The plaintext is dropped only once the keychain confirms it holds the password.
      let persistent = false;
      let reason: string | undefined;
      try {
        persistent = (await setPassword(uniqueName, password, { keepExistingSessionValue: true })).persistent;
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
      if (persistent) {
        changed = true;
      } else {
        keepPlaintext = true;
        warnPlaintextKept(uniqueName, reason);
      }
    }

    const host = toNonEmptyString(entry.host) || "";
    const username = toNonEmptyString(entry.username) || "";
    const port = normalizePort(entry.port);
    const privateKeyPath = toNonEmptyString(entry.privateKeyPath);
    const settings = isPlainObject(entry.settings) ? (entry.settings as Partial<Settings>) : undefined;
    const profiles = Array.isArray(entry.profiles) ? (entry.profiles as ConnectionProfile[]) : undefined;
    const currentProfile = toNonEmptyString(entry.currentProfile);
    const policy = normalizePolicy(entry.policy);
    const keepaliveInterval = normalizeOptionalNumber(entry.keepaliveInterval);
    const readyTimeout = normalizeOptionalNumber(entry.readyTimeout);
    const sshDebug = typeof entry.sshDebug === "boolean" ? entry.sshDebug : undefined;

    const normalized: StoredConnection = {
      name: uniqueName,
      host,
      port,
      username
    };

    if (privateKeyPath) normalized.privateKeyPath = privateKeyPath;
    if (settings) normalized.settings = settings;
    if (profiles) normalized.profiles = profiles;
    if (currentProfile) normalized.currentProfile = currentProfile;
    if (policy) normalized.policy = policy;
    if (keepaliveInterval !== undefined) normalized.keepaliveInterval = keepaliveInterval;
    if (readyTimeout !== undefined) normalized.readyTimeout = readyTimeout;
    if (sshDebug !== undefined) normalized.sshDebug = sshDebug;
    if (keepPlaintext) (normalized as StoredConnection & { password?: string }).password = password;

    if (JSON.stringify(normalized) !== JSON.stringify(entry)) {
      changed = true;
    }
    connections.push(normalized);
  }

  return { connections, changed };
}

function warnPlaintextKept(connectionName: string, reason?: string) {
  if (plaintextWarnings.has(connectionName)) return;
  plaintextWarnings.add(connectionName);
  process.stderr.write(
    `[mcp-for-i] warning: no persistent keychain is available, so the plaintext password for connection ` +
      `"${connectionName}" was left in config.json${reason ? ` (${reason})` : ""}. ` +
      "It will be moved to the keychain once one is available.\n"
  );
}

function normalizeSettings(value: unknown): { value: Settings; changed: boolean } {
  if (!isPlainObject(value)) {
    return { value: { ...defaultSettings }, changed: true };
  }

  const merged = { ...defaultSettings, ...(value as Partial<Settings>) };
  const changed = JSON.stringify(merged) !== JSON.stringify(value);
  return { value: merged, changed };
}

function normalizeActions(value: unknown): { value: Action[]; changed: boolean } {
  if (!Array.isArray(value)) {
    return { value: [], changed: true };
  }
  const filtered = value.filter(isPlainObject) as Action[];
  const changed = filtered.length !== value.length;
  return { value: filtered, changed };
}

function normalizePolicy(value: unknown): ConnectionPolicy | undefined {
  if (!isPlainObject(value)) return undefined;
  const profile = value.profile;
  const normalizedProfile: PolicyProfile =
    profile === "read-only" || profile === "power-user" || profile === "guarded" ? profile : "guarded";

  const policy: ConnectionPolicy = { ...value, profile: normalizedProfile } as ConnectionPolicy;
  if (!Array.isArray(policy.requireApprovalFor)) delete policy.requireApprovalFor;
  if (!Array.isArray(policy.allowCommands)) delete policy.allowCommands;
  if (!Array.isArray(policy.denyCommands)) delete policy.denyCommands;
  if (!Array.isArray(policy.allowLibraries)) delete policy.allowLibraries;
  if (!Array.isArray(policy.denyLibraries)) delete policy.denyLibraries;
  if (!Array.isArray(policy.allowPaths)) delete policy.allowPaths;
  if (!Array.isArray(policy.denyPaths)) delete policy.denyPaths;
  return policy;
}

async function sanitizeConnection(connection: StoredConnection) {
  const raw = connection as StoredConnection & { password?: unknown; storePassword?: unknown };
  const password = toNonEmptyString(raw.password);
  let persisted = false;
  if (password) {
    persisted = (await setPassword(connection.name, password)).persistent;
  }

  const { password: _password, storePassword: _storePassword, ...rest } = raw;
  const normalizedPort = normalizePort(rest.port);
  return {
    sanitized: { ...rest, port: normalizedPort } as StoredConnection,
    password,
    persisted
  };
}

function uniqueConnectionName(baseName: string, seen: Set<string>) {
  if (!seen.has(baseName)) return baseName;
  let suffix = 2;
  let candidate = `${baseName}-${suffix}`;
  while (seen.has(candidate)) {
    suffix += 1;
    candidate = `${baseName}-${suffix}`;
  }
  return candidate;
}

function normalizePort(value: unknown) {
  const port = Number(value);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return 22;
  }
  return Math.floor(port);
}

function normalizeOptionalNumber(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.floor(n);
}

function toNonEmptyString(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
