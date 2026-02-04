import fs from "fs/promises";
import path from "path";
import os from "os";
import { Action, ConnectionConfig, ConnectionData } from "../ibmi/types.js";

export type Settings = {
  readOnlyMode: boolean;
  tempLibrary: string;
  tempDir: string;
  autoClearTempData: boolean;
  sourceFileCCSID: string;
  enableSourceDates: boolean;
  homeDirectory: string;
  libraryList: string[];
  currentLibrary: string;
  customVariables: { name: string; value: string }[];
};

export type StoredConnection = Omit<ConnectionData, "password"> & {
  settings?: Partial<Settings>;
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
  enableSourceDates: true,
  homeDirectory: ".",
  libraryList: [],
  currentLibrary: "",
  customVariables: []
};

export class ConfigStore {
  private configDir: string;
  private configPath: string;
  private data: ConfigFile | null = null;

  constructor() {
    this.configDir = getConfigDir();
    this.configPath = path.join(this.configDir, "config.json");
  }

  async load(): Promise<ConfigFile> {
    await ensureDir(this.configDir);
    try {
      const raw = await fs.readFile(this.configPath, "utf8");
      this.data = JSON.parse(raw) as ConfigFile;
    } catch {
      this.data = { connections: [], settings: defaultSettings, actions: [] };
      await this.save();
    }
    this.data.settings = { ...defaultSettings, ...(this.data.settings || {}) };
    this.data.actions = this.data.actions || [];
    return this.data;
  }

  async save() {
    if (!this.data) await this.load();
    await fs.writeFile(this.configPath, JSON.stringify(this.data, null, 2), "utf8");
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
    const idx = cfg.connections.findIndex(c => c.name === connection.name);
    if (idx >= 0) {
      cfg.connections[idx] = { ...cfg.connections[idx], ...connection };
    } else {
      cfg.connections.push(connection);
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

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}
