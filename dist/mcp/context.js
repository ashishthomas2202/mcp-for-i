import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { ConfigStore, getConfigDir } from "../config/store.js";
import { IBMiClient } from "../ibmi/client.js";
import { getPassword } from "../security/credentialStore.js";
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_PING_MS = 15 * 1000;
const DEFAULT_CURSOR_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RECONNECT_ATTEMPTS = 2;
export class McpContext {
    store = new ConfigStore();
    activeName;
    sessions = new Map();
    cursors = new Map();
    connectLocks = new Map();
    reconnectLocks = new Map();
    cursorTtlMs = toPositiveInt(process.env.MCP_FOR_I_SQL_CURSOR_TTL_MS, DEFAULT_CURSOR_TTL_MS);
    defaultSessionIdleMs = toPositiveInt(process.env.MCP_FOR_I_SESSION_IDLE_MS, DEFAULT_SESSION_IDLE_MS);
    defaultSessionPingMs = toPositiveInt(process.env.MCP_FOR_I_SESSION_PING_MS, DEFAULT_SESSION_PING_MS);
    defaultReconnectAttempts = toPositiveInt(process.env.MCP_FOR_I_SESSION_RECONNECT_ATTEMPTS, DEFAULT_RECONNECT_ATTEMPTS);
    sessionSnapshotPath = path.join(getConfigDir(), "session-state.json");
    lastSessionSnapshotAt = 0;
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
        await this.registerSession(connection.name, client, policy || defaultPolicy(), connection);
        return client;
    }
    async connectByName(name) {
        const inFlight = this.connectLocks.get(name);
        if (inFlight)
            return inFlight;
        const connectPromise = (async () => {
            const existing = this.sessions.get(name);
            if (existing) {
                await this.ensureSessionHealthy(name);
                this.touchSession(name, true);
                this.activeName = name;
                return this.sessions.get(name).client;
            }
            const prepared = await this.prepareStoredConnection(name);
            return this.connect(prepared.connection, prepared.configOverride, prepared.policy);
        })();
        this.connectLocks.set(name, connectPromise);
        try {
            return await connectPromise;
        }
        finally {
            this.connectLocks.delete(name);
        }
    }
    async ensureActive(name) {
        const sessionName = name || this.activeName;
        if (!sessionName)
            throw new Error("Not connected");
        if (!this.sessions.has(sessionName)) {
            await this.connectByName(sessionName);
        }
        await this.ensureSessionHealthy(sessionName);
        this.touchSession(sessionName);
        return this.sessions.get(sessionName).client;
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
            state: session.state,
            policy: session.policy.profile,
            lastUsedAt: new Date(session.lastUsedAt).toISOString(),
            lastValidatedAt: session.lastValidatedAt ? new Date(session.lastValidatedAt).toISOString() : undefined,
            expiresAt: new Date(session.expiresAt).toISOString(),
            idleSecondsRemaining: Math.max(0, Math.floor((session.expiresAt - now) / 1000)),
            lastError: session.lastError
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
            state: session.state,
            policy: session.policy.profile,
            lastUsedAt: new Date(session.lastUsedAt).toISOString(),
            lastValidatedAt: session.lastValidatedAt ? new Date(session.lastValidatedAt).toISOString() : undefined,
            expiresAt: new Date(session.expiresAt).toISOString(),
            idleSecondsRemaining: Math.max(0, Math.floor((session.expiresAt - now) / 1000)),
            lastError: session.lastError
        };
    }
    async keepaliveSession(name) {
        const target = name || this.activeName;
        if (!target)
            throw new Error("connectionName is required (no active session)");
        await this.ensureSessionHealthy(target);
        this.touchSession(target, true);
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
            if (session.heartbeat)
                clearInterval(session.heartbeat);
            try {
                await session.client.disconnect();
            }
            catch {
                // ignore disconnect errors
            }
            this.sessions.delete(name);
            if (this.activeName === name) {
                this.activeName = this.sessions.keys().next().value;
            }
            await this.persistSessionState(true);
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
    async prepareStoredConnection(name) {
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
            privateKeyPath: stored.privateKeyPath,
            keepaliveInterval: stored.keepaliveInterval,
            readyTimeout: stored.readyTimeout,
            sshDebug: stored.sshDebug
        };
        const profile = resolveProfile(stored.currentProfile, stored.profiles);
        const profileSettings = profileToSettings(profile);
        const policy = normalizePolicy(stored.policy);
        return {
            connection,
            policy,
            configOverride: { ...stored.settings, ...profileSettings }
        };
    }
    async registerSession(name, client, policy, connection) {
        const existing = this.sessions.get(name);
        if (existing) {
            if (existing.timeout)
                clearTimeout(existing.timeout);
            if (existing.heartbeat)
                clearInterval(existing.heartbeat);
            try {
                await existing.client.disconnect();
            }
            catch {
                // ignore disconnect errors while replacing session
            }
        }
        const now = Date.now();
        this.sessions.set(name, {
            name,
            client,
            policy,
            connection,
            state: "connected",
            lastError: undefined,
            lastUsedAt: now,
            lastValidatedAt: 0,
            heartbeatMs: undefined,
            expiresAt: now + this.resolveSessionIdleMs(client.getConfig())
        });
        this.activeName = name;
        this.touchSession(name, true);
    }
    touchSession(name, forcePersist = false) {
        const session = this.sessions.get(name);
        if (!session)
            throw new Error(`Session ${name} not found`);
        const idleMs = this.resolveSessionIdleMs(session.client.getConfig());
        session.lastUsedAt = Date.now();
        session.expiresAt = session.lastUsedAt + idleMs;
        if (session.timeout)
            clearTimeout(session.timeout);
        session.timeout = setTimeout(() => {
            this.disconnect(name).catch(() => { });
        }, idleMs);
        this.sessions.set(name, session);
        this.scheduleSessionHeartbeat(name);
        void this.persistSessionState(forcePersist);
    }
    async ensureSessionHealthy(name) {
        const session = this.sessions.get(name);
        if (!session)
            throw new Error(`Session ${name} is not connected`);
        const reconnecting = this.reconnectLocks.get(name);
        if (reconnecting) {
            await reconnecting;
        }
        const latest = this.sessions.get(name);
        if (!latest)
            throw new Error(`Session ${name} is not connected`);
        const pingMs = this.resolveSessionPingMs(latest.client.getConfig());
        const now = Date.now();
        if (latest.lastValidatedAt > 0 && now - latest.lastValidatedAt < pingMs) {
            return;
        }
        try {
            await latest.client.sendCommand({ command: "echo MCP_FOR_I_SESSION_OK" });
            latest.lastValidatedAt = now;
            latest.state = "connected";
            latest.lastError = undefined;
            this.sessions.set(name, latest);
        }
        catch (err) {
            const message = err?.message || String(err);
            if (!isLikelyTransientConnectionError(message)) {
                latest.state = "error";
                latest.lastError = message;
                this.sessions.set(name, latest);
                throw err;
            }
            await this.reconnectSession(name, message);
        }
    }
    async reconnectSession(name, reason) {
        const existingLock = this.reconnectLocks.get(name);
        if (existingLock) {
            await existingLock;
            return;
        }
        const reconnectPromise = (async () => {
            const session = this.sessions.get(name);
            if (!session)
                return;
            session.state = "reconnecting";
            session.lastError = reason;
            this.sessions.set(name, session);
            await this.persistSessionState(true);
            const attempts = this.resolveReconnectAttempts(session.client.getConfig());
            let lastErrorMessage = reason || "Connection dropped";
            for (let attempt = 1; attempt <= attempts; attempt += 1) {
                try {
                    try {
                        await session.client.disconnect();
                    }
                    catch {
                        // ignore disconnect failures during reconnect
                    }
                    const nextClient = new IBMiClient(session.client.getConfig());
                    await nextClient.connect(session.connection);
                    session.client = nextClient;
                    session.state = "connected";
                    session.lastError = undefined;
                    session.lastValidatedAt = Date.now();
                    this.sessions.set(name, session);
                    this.touchSession(name, true);
                    return;
                }
                catch (err) {
                    lastErrorMessage = err?.message || String(err);
                    if (attempt < attempts) {
                        await wait(Math.min(1500, 250 * attempt));
                    }
                }
            }
            await this.disconnect(name);
            throw new Error(`Failed to reconnect session '${name}': ${lastErrorMessage}`);
        })();
        this.reconnectLocks.set(name, reconnectPromise);
        try {
            await reconnectPromise;
        }
        finally {
            this.reconnectLocks.delete(name);
        }
    }
    resolveSessionIdleMs(config) {
        const minutes = Number(config.sessionIdleMinutes);
        if (Number.isFinite(minutes) && minutes > 0) {
            return Math.floor(minutes * 60 * 1000);
        }
        return this.defaultSessionIdleMs;
    }
    resolveSessionPingMs(config) {
        const seconds = Number(config.sessionPingSeconds);
        if (Number.isFinite(seconds) && seconds > 0) {
            return Math.floor(seconds * 1000);
        }
        return this.defaultSessionPingMs;
    }
    resolveReconnectAttempts(config) {
        const attempts = Number(config.sessionReconnectAttempts);
        if (Number.isFinite(attempts) && attempts > 0) {
            return Math.max(1, Math.min(5, Math.floor(attempts)));
        }
        return this.defaultReconnectAttempts;
    }
    scheduleSessionHeartbeat(name) {
        const session = this.sessions.get(name);
        if (!session)
            return;
        const heartbeatMs = this.resolveSessionPingMs(session.client.getConfig());
        if (session.heartbeat && session.heartbeatMs === heartbeatMs) {
            return;
        }
        if (session.heartbeat) {
            clearInterval(session.heartbeat);
        }
        session.heartbeatMs = heartbeatMs;
        session.heartbeat = setInterval(() => {
            this.ensureSessionHealthy(name).catch(() => {
                // reconnect path and error state are handled inside ensureSessionHealthy
            });
        }, heartbeatMs);
        this.sessions.set(name, session);
    }
    async persistSessionState(force = false) {
        const now = Date.now();
        if (!force && now - this.lastSessionSnapshotAt < 2000)
            return;
        const payload = {
            updatedAt: new Date(now).toISOString(),
            activeName: this.activeName,
            sessions: this.listSessions()
        };
        try {
            await fs.mkdir(path.dirname(this.sessionSnapshotPath), { recursive: true });
            await fs.writeFile(this.sessionSnapshotPath, JSON.stringify(payload, null, 2), "utf8");
            this.lastSessionSnapshotAt = now;
        }
        catch {
            // best effort only
        }
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
function isLikelyTransientConnectionError(message) {
    const text = String(message || "").toLowerCase();
    if (!text)
        return false;
    return [
        "not connected",
        "transport closed",
        "connection",
        "socket",
        "channel",
        "econn",
        "timed out",
        "timeout",
        "broken pipe",
        "end of file"
    ].some(token => text.includes(token));
}
async function wait(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
}
