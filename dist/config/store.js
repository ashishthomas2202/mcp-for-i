import fs from "fs/promises";
import path from "path";
import os from "os";
const defaultSettings = {
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
    debugSepPort: 8008
};
export class ConfigStore {
    configDir;
    configPath;
    data = null;
    constructor() {
        this.configDir = getConfigDir();
        this.configPath = path.join(this.configDir, "config.json");
    }
    async load() {
        await ensureDir(this.configDir);
        try {
            const raw = await fs.readFile(this.configPath, "utf8");
            this.data = JSON.parse(raw);
        }
        catch {
            this.data = { connections: [], settings: defaultSettings, actions: [] };
            await this.save();
        }
        this.data.settings = { ...defaultSettings, ...(this.data.settings || {}) };
        this.data.actions = this.data.actions || [];
        return this.data;
    }
    async save() {
        if (!this.data)
            await this.load();
        await fs.writeFile(this.configPath, JSON.stringify(this.data, null, 2), "utf8");
    }
    async listConnections() {
        const cfg = await this.load();
        return cfg.connections;
    }
    async getConnection(name) {
        const cfg = await this.load();
        return cfg.connections.find(c => c.name === name);
    }
    async upsertConnection(connection) {
        const cfg = await this.load();
        const idx = cfg.connections.findIndex(c => c.name === connection.name);
        if (idx >= 0) {
            cfg.connections[idx] = { ...cfg.connections[idx], ...connection };
        }
        else {
            cfg.connections.push(connection);
        }
        await this.save();
    }
    async deleteConnection(name) {
        const cfg = await this.load();
        cfg.connections = cfg.connections.filter(c => c.name !== name);
        await this.save();
    }
    async getSettings() {
        const cfg = await this.load();
        return cfg.settings;
    }
    async updateSettings(update) {
        const cfg = await this.load();
        cfg.settings = { ...cfg.settings, ...update };
        await this.save();
    }
    async listActions() {
        const cfg = await this.load();
        return cfg.actions || [];
    }
    async upsertAction(action) {
        const cfg = await this.load();
        const idx = cfg.actions.findIndex(a => a.name === action.name);
        if (idx >= 0)
            cfg.actions[idx] = action;
        else
            cfg.actions.push(action);
        await this.save();
    }
    async deleteAction(name) {
        const cfg = await this.load();
        cfg.actions = cfg.actions.filter(a => a.name !== name);
        await this.save();
    }
    async listProfiles(connectionName) {
        const conn = await this.getConnection(connectionName);
        return conn?.profiles || [];
    }
    async saveProfile(connectionName, profile) {
        const conn = await this.getConnection(connectionName);
        if (!conn)
            throw new Error(`Connection ${connectionName} not found`);
        const profiles = conn.profiles || [];
        const idx = profiles.findIndex(p => p.name === profile.name);
        if (idx >= 0)
            profiles[idx] = profile;
        else
            profiles.push(profile);
        conn.profiles = profiles;
        await this.upsertConnection(conn);
    }
    async deleteProfile(connectionName, profileName) {
        const conn = await this.getConnection(connectionName);
        if (!conn)
            throw new Error(`Connection ${connectionName} not found`);
        conn.profiles = (conn.profiles || []).filter(p => p.name !== profileName);
        if (conn.currentProfile === profileName) {
            conn.currentProfile = undefined;
        }
        await this.upsertConnection(conn);
    }
    async setCurrentProfile(connectionName, profileName) {
        const conn = await this.getConnection(connectionName);
        if (!conn)
            throw new Error(`Connection ${connectionName} not found`);
        conn.currentProfile = profileName;
        await this.upsertConnection(conn);
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
async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
}
