import crypto from "crypto";
import { ConfigStore } from "../config/store.js";
import { IBMiClient } from "../ibmi/client.js";
import { getPassword } from "../security/credentialStore.js";
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_CURSOR_TTL_MS = 5 * 60 * 1000;
export class McpContext {
    store = new ConfigStore();
    activeName;
    sessions = new Map();
    cursors = new Map();
    sessionIdleMs = toPositiveInt(process.env.MCP_FOR_I_SESSION_IDLE_MS, DEFAULT_SESSION_IDLE_MS);
    cursorTtlMs = toPositiveInt(process.env.MCP_FOR_I_SQL_CURSOR_TTL_MS, DEFAULT_CURSOR_TTL_MS);
    async connect(connection, configOverride, policy) {
        const baseSettings = await this.store.getSettings();
        const config = {
            name: connection.name,
            host: connection.host,
            port: connection.port,
            username: connection.username,
            ...baseSettings,
            ...configOverride
        };
        const client = new IBMiClient(config);
        await client.connect(connection);
        await this.registerSession(connection.name, client, policy || defaultPolicy());
        return client;
    }
    async connectByName(name) {
        const existing = this.sessions.get(name);
        if (existing) {
            this.touchSession(name);
            this.activeName = name;
            return existing.client;
        }
        const stored = await this.store.getConnection(name);
        if (!stored)
            throw new Error(`Unknown connection: ${name}`);
        const password = await getPassword(name);
        const connection = {
            name: stored.name,
            host: stored.host,
            port: stored.port,
            username: stored.username,
            password,
            privateKeyPath: stored.privateKeyPath
        };
        const profile = resolveProfile(stored.currentProfile, stored.profiles);
        const profileSettings = profileToSettings(profile);
        const policy = normalizePolicy(stored.policy);
        return this.connect(connection, { ...stored.settings, ...profileSettings }, policy);
    }
    ensureActive(name) {
        const sessionName = name || this.activeName;
        if (!sessionName)
            throw new Error("Not connected");
        const session = this.sessions.get(sessionName);
        if (!session)
            throw new Error(`Session ${sessionName} is not connected`);
        this.touchSession(sessionName);
        return session.client;
    }
    getPolicy(name) {
        const sessionName = name || this.activeName;
        if (!sessionName)
            return defaultPolicy();
        return this.sessions.get(sessionName)?.policy || defaultPolicy();
    }
    listSessions() {
        const now = Date.now();
        return Array.from(this.sessions.values()).map(session => ({
            name: session.name,
            active: session.name === this.activeName,
            policy: session.policy.profile,
            lastUsedAt: new Date(session.lastUsedAt).toISOString(),
            expiresAt: new Date(session.expiresAt).toISOString(),
            idleSecondsRemaining: Math.max(0, Math.floor((session.expiresAt - now) / 1000))
        }));
    }
    statusSession(name) {
        const target = name || this.activeName;
        if (!target)
            return { connected: false };
        const session = this.sessions.get(target);
        if (!session)
            return { connected: false, name: target };
        const now = Date.now();
        return {
            connected: true,
            name: target,
            active: target === this.activeName,
            policy: session.policy.profile,
            lastUsedAt: new Date(session.lastUsedAt).toISOString(),
            expiresAt: new Date(session.expiresAt).toISOString(),
            idleSecondsRemaining: Math.max(0, Math.floor((session.expiresAt - now) / 1000))
        };
    }
    keepaliveSession(name) {
        const target = name || this.activeName;
        if (!target)
            throw new Error("connectionName is required (no active session)");
        this.touchSession(target);
        return this.statusSession(target);
    }
    async terminateSession(name) {
        const target = name || this.activeName;
        if (!target)
            throw new Error("connectionName is required (no active session)");
        await this.disconnect(target);
    }
    async disconnect(name) {
        if (name) {
            const session = this.sessions.get(name);
            if (!session)
                return;
            if (session.timeout)
                clearTimeout(session.timeout);
            await session.client.disconnect();
            this.sessions.delete(name);
            if (this.activeName === name) {
                this.activeName = this.sessions.keys().next().value;
            }
            return;
        }
        const current = this.activeName;
        if (current) {
            await this.disconnect(current);
        }
    }
    createSqlCursor(rows, pageSize) {
        const cursor = crypto.randomUUID();
        const initial = rows.slice(pageSize);
        if (initial.length === 0)
            return { cursor: undefined };
        this.cursors.set(cursor, {
            rows: initial,
            nextIndex: 0,
            expiresAt: Date.now() + this.cursorTtlMs
        });
        return { cursor };
    }
    consumeSqlCursor(cursor, pageSize) {
        const state = this.cursors.get(cursor);
        if (!state)
            throw new Error(`Unknown cursor: ${cursor}`);
        if (state.expiresAt < Date.now()) {
            this.cursors.delete(cursor);
            throw new Error(`Cursor expired: ${cursor}`);
        }
        const start = state.nextIndex;
        const end = start + pageSize;
        const page = state.rows.slice(start, end);
        state.nextIndex = end;
        state.expiresAt = Date.now() + this.cursorTtlMs;
        if (state.nextIndex >= state.rows.length) {
            this.cursors.delete(cursor);
            return { rows: page, cursor: undefined };
        }
        this.cursors.set(cursor, state);
        return { rows: page, cursor };
    }
    async registerSession(name, client, policy) {
        const existing = this.sessions.get(name);
        if (existing) {
            if (existing.timeout)
                clearTimeout(existing.timeout);
            await existing.client.disconnect();
        }
        const now = Date.now();
        this.sessions.set(name, {
            name,
            client,
            policy,
            lastUsedAt: now,
            expiresAt: now + this.sessionIdleMs
        });
        this.activeName = name;
        this.touchSession(name);
    }
    touchSession(name) {
        const session = this.sessions.get(name);
        if (!session)
            throw new Error(`Session ${name} not found`);
        session.lastUsedAt = Date.now();
        session.expiresAt = session.lastUsedAt + this.sessionIdleMs;
        if (session.timeout)
            clearTimeout(session.timeout);
        session.timeout = setTimeout(() => {
            this.disconnect(name).catch(() => { });
        }, this.sessionIdleMs);
        this.sessions.set(name, session);
    }
}
function resolveProfile(name, profiles) {
    if (!name || !profiles)
        return undefined;
    return profiles.find(p => p.name === name);
}
function profileToSettings(profile) {
    if (!profile)
        return {};
    return {
        currentLibrary: profile.currentLibrary,
        libraryList: profile.libraryList,
        customVariables: profile.customVariables
    };
}
function toPositiveInt(input, fallback) {
    const parsed = Number(input || "");
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return Math.floor(parsed);
}
function defaultPolicy() {
    return {
        profile: "guarded",
        requireApprovalFor: ["sql.write", "cl.run", "deploy.sync", "ifs.delete", "qsys.write"]
    };
}
function normalizePolicy(policy) {
    if (!policy)
        return defaultPolicy();
    const profile = normalizeProfile(policy.profile);
    return {
        ...defaultPolicy(),
        ...policy,
        profile
    };
}
function normalizeProfile(profile) {
    if (profile === "read-only" || profile === "power-user" || profile === "guarded") {
        return profile;
    }
    return "guarded";
}
