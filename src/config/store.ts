import fs from "fs/promises";
import path from "path";
import os from "os";
import { Action, ConnectionConfig, ConnectionData } from "../ibmi/types.js";
import { setPassword } from "../security/credentialStore.js";

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

export class ConfigStore {
  private configDir: string;
  private configPath: string;
  private data: ConfigFile | null = null;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.configDir = getConfigDir();
    this.configPath = path.join(this.configDir, "config.json");
  }

  async load(): Promise<ConfigFile> {
    await ensureDir(this.configDir);
    let loadedFromDisk = true;
    try {
      const raw = await fs.readFile(this.configPath, "utf8");
      this.data = JSON.parse(raw) as ConfigFile;
    } catch {
      loadedFromDisk = false;
      this.data = { connections: [], settings: defaultSettings, actions: [] };
    }

    const migrated = await migrateConfigFile(this.data);
    this.data = migrated.config;

    if (!loadedFromDisk || migrated.changed) {
      await this.save();
    }

    return this.data;
  }

  async save() {
    if (!this.data) await this.load();
    const payload = JSON.stringify(this.data, null, 2);
    await this.enqueueSave(async () => {
      const tempPath = `${this.configPath}.${process.pid}.${Date.now()}.tmp`;
      await writeFileWithRetry(tempPath, payload);
      try {
        await fs.rename(tempPath, this.configPath);
      } catch {
        await writeFileWithRetry(this.configPath, payload);
        await fs.rm(tempPath, { force: true });
      }
    });
  }

  async listConnections() {
    const cfg = await this.load();
    return cfg.connections;
  }

  async getConnection(name: string) {
    const cfg = await this.load();
    return cfg.connections.find(c => c.name === name);
  }

  async upsertConnection(connection: StoredConnection) {
    const cfg = await this.load();
    const sanitized = await sanitizeConnection(connection);
    const idx = cfg.connections.findIndex(c => c.name === sanitized.name);
    if (idx >= 0) {
      cfg.connections[idx] = { ...cfg.connections[idx], ...sanitized };
    } else {
      cfg.connections.push(sanitized);
    }
    await this.save();
  }

  async deleteConnection(name: string) {
    const cfg = await this.load();
    cfg.connections = cfg.connections.filter(c => c.name !== name);
    await this.save();
  }

  async getSettings() {
    const cfg = await this.load();
    return cfg.settings;
  }

  async updateSettings(update: Partial<Settings>) {
    const cfg = await this.load();
    cfg.settings = { ...cfg.settings, ...update };
    await this.save();
  }

  async listActions() {
    const cfg = await this.load();
    return cfg.actions || [];
  }

  async upsertAction(action: Action) {
    const cfg = await this.load();
    const idx = cfg.actions.findIndex(a => a.name === action.name);
    if (idx >= 0) cfg.actions[idx] = action; else cfg.actions.push(action);
    await this.save();
  }

  async deleteAction(name: string) {
    const cfg = await this.load();
    cfg.actions = cfg.actions.filter(a => a.name !== name);
    await this.save();
  }

  async listProfiles(connectionName: string) {
    const conn = await this.getConnection(connectionName);
    return conn?.profiles || [];
  }

  async saveProfile(connectionName: string, profile: ConnectionProfile) {
    const conn = await this.getConnection(connectionName);
    if (!conn) throw new Error(`Connection ${connectionName} not found`);
    const profiles = conn.profiles || [];
    const idx = profiles.findIndex(p => p.name === profile.name);
    if (idx >= 0) profiles[idx] = profile; else profiles.push(profile);
    conn.profiles = profiles;
    await this.upsertConnection(conn);
  }

  async deleteProfile(connectionName: string, profileName: string) {
    const conn = await this.getConnection(connectionName);
    if (!conn) throw new Error(`Connection ${connectionName} not found`);
    conn.profiles = (conn.profiles || []).filter(p => p.name !== profileName);
    if (conn.currentProfile === profileName) {
      conn.currentProfile = undefined;
    }
    await this.upsertConnection(conn);
  }

  async setCurrentProfile(connectionName: string, profileName?: string) {
    const conn = await this.getConnection(connectionName);
    if (!conn) throw new Error(`Connection ${connectionName} not found`);
    conn.currentProfile = profileName;
    await this.upsertConnection(conn);
  }

  private enqueueSave(operation: () => Promise<void>) {
    this.saveQueue = this.saveQueue.then(operation, operation);
    return this.saveQueue;
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
    if (password) {
      await setPassword(uniqueName, password);
      changed = true;
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

    if (JSON.stringify(normalized) !== JSON.stringify(entry)) {
      changed = true;
    }
    connections.push(normalized);
  }

  return { connections, changed };
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

async function sanitizeConnection(connection: StoredConnection): Promise<StoredConnection> {
  const raw = connection as StoredConnection & { password?: unknown; storePassword?: unknown };
  const password = toNonEmptyString(raw.password);
  if (password) {
    await setPassword(connection.name, password);
  }

  const { password: _password, storePassword: _storePassword, ...rest } = raw;
  const normalizedPort = normalizePort(rest.port);
  return {
    ...rest,
    port: normalizedPort
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

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeFileWithRetry(filePath: string, content: string, retries = 5, delayMs = 40) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fs.writeFile(filePath, content, "utf8");
      return;
    } catch (err: any) {
      const transient = err?.code === "EBUSY" || err?.code === "EPERM";
      if (!transient || attempt === retries) throw err;
      await wait(delayMs * (attempt + 1));
    }
  }
}

async function wait(ms: number) {
  await new Promise(resolve => setTimeout(resolve, ms));
}
