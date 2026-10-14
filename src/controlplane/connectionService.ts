import { ConfigStore, ConnectionPolicy, StoredConnection } from "../config/store.js";
import { deletePassword, getPassword, setPassword } from "../security/credentialStore.js";
import { ControlPlaneError } from "./errors.js";
import { ConnectionTestResult, ConnectionTestTarget, testConnection } from "./connectionTest.js";

/** True when host, port or username differ (host compared case-insensitively). */
export function connectionEndpointChanged(
  before: Pick<StoredConnection, "host" | "port" | "username">,
  after: Pick<StoredConnection, "host" | "port" | "username">
) {
  const host = (value: unknown) => String(value ?? "").trim().toLowerCase();
  const port = (value: unknown) => Number(value || 22);
  const user = (value: unknown) => String(value ?? "").trim().toUpperCase();
  return host(before.host) !== host(after.host)
    || port(before.port) !== port(after.port)
    || user(before.username) !== user(after.username);
}

export type ConnectionUpsertInput = {
  name: string;
  host: string;
  port?: number;
  username: string;
  privateKeyPath?: string;
  settings?: Record<string, any>;
  policy?: ConnectionPolicy;
  password?: string;
  storePassword?: boolean;
};

export type ConnectionTestInput = {
  /** Saved connection whose stored password may be used when none is given. */
  name?: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
};

export class ConnectionService {
  /** Last test result per saved connection, kept in memory only. */
  private readonly lastTests = new Map<string, ConnectionTestResult>();
  /** Endpoints with a test in progress, so a double click signs on once. */
  private readonly running = new Set<string>();

  constructor(
    private readonly store: ConfigStore,
    private readonly runTest: (target: ConnectionTestTarget) => Promise<ConnectionTestResult> = testConnection
  ) {}

  async list() {
    const list = await this.store.listConnections();
    return list.map(conn => {
      const lastTest = this.lastTests.get(conn.name);
      return lastTest ? { ...conn, lastTest } : conn;
    });
  }

  /** Tests a saved connection with its stored details and password. */
  async testSaved(name: string) {
    const stored = await this.store.getConnection(name);
    if (!stored) throw new ControlPlaneError(404, `Connection ${name} not found`);
    const password = await getPassword(name).catch(() => undefined);
    const result = await this.guardedTest({
      host: stored.host,
      port: stored.port,
      username: stored.username,
      password: password || undefined,
      privateKeyPath: stored.privateKeyPath
    });
    this.lastTests.set(name, result);
    return result;
  }

  /**
   * Tests details that may not be saved yet (the add and edit form). A saved
   * password is only used for the same host, port and user it was saved for.
   */
  async testDetails(input: ConnectionTestInput) {
    const host = typeof input?.host === "string" ? input.host.trim() : "";
    const username = typeof input?.username === "string" ? input.username.trim() : "";
    if (!host || !username) throw new ControlPlaneError(400, "host and username are required");
    const port = Number(input.port || 22);
    let password = typeof input.password === "string" && input.password ? input.password : undefined;
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const stored = name ? await this.store.getConnection(name) : undefined;
    if (!password && stored && !connectionEndpointChanged(stored, { host, port, username })) {
      password = (await getPassword(name).catch(() => undefined)) || undefined;
    }
    const privateKeyPath = typeof input.privateKeyPath === "string" && input.privateKeyPath.trim()
      ? input.privateKeyPath.trim()
      : undefined;
    return this.guardedTest({ host, port, username, password, privateKeyPath });
  }

  private async guardedTest(target: ConnectionTestTarget) {
    const key = [target.host.trim().toLowerCase(), Number(target.port || 22), target.username.trim().toUpperCase()].join("|");
    if (this.running.has(key)) {
      throw new ControlPlaneError(409, "A test of this connection is already running");
    }
    this.running.add(key);
    try {
      return await this.runTest(target);
    } finally {
      this.running.delete(key);
    }
  }

  async get(name: string) {
    return this.store.getConnection(name);
  }

  async add(input: ConnectionUpsertInput) {
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    if (!name || !input.host || !input.username) {
      throw new ControlPlaneError(400, "name, host and username are required");
    }
    // Adding must never overwrite an existing entry: that would let a caller
    // repoint a connection without the checks in update().
    if (await this.store.getConnection(input.name)) {
      throw new ControlPlaneError(409, `Connection ${input.name} already exists`);
    }
    await this.store.upsertConnection({
      name: input.name,
      host: input.host,
      port: input.port || 22,
      username: input.username,
      privateKeyPath: input.privateKeyPath,
      settings: input.settings,
      policy: input.policy
    });
    if (input.storePassword && input.password) {
      await setPassword(input.name, input.password);
    }
    return this.get(input.name);
  }

  async update(name: string, input: Partial<ConnectionUpsertInput>) {
    const existing = await this.store.getConnection(name);
    if (!existing) throw new ControlPlaneError(404, `Connection ${name} not found`);

    const next: StoredConnection = {
      ...existing,
      host: input.host ?? existing.host,
      port: input.port ?? existing.port,
      username: input.username ?? existing.username,
      privateKeyPath: input.privateKeyPath ?? existing.privateKeyPath,
      settings: input.settings ? { ...(existing.settings || {}), ...input.settings } : existing.settings,
      policy: input.policy ?? existing.policy
    };

    // A saved password must never follow the connection to a different
    // endpoint or user. Changing host, port or username therefore needs the
    // password in the same request.
    const endpointChanged = connectionEndpointChanged(existing, next);
    const newPassword = typeof input.password === "string" && input.password ? input.password : undefined;
    if (endpointChanged && !newPassword && await getPassword(name)) {
      throw new ControlPlaneError(
        400,
        "Changing host, port or username requires entering the password again in the same request"
      );
    }

    await this.store.upsertConnection(next);
    // An earlier result says nothing about new details or a new password.
    if (endpointChanged || newPassword || next.privateKeyPath !== existing.privateKeyPath) {
      this.lastTests.delete(name);
    }
    if (newPassword && (input.storePassword || endpointChanged)) {
      if (input.storePassword === false) {
        // The caller does not want it stored; drop the old one so it is not
        // sent to the new endpoint.
        await deletePassword(name);
      } else {
        await setPassword(name, newPassword);
      }
    }
    return this.get(name);
  }

  async rename(oldName: string, newName: string) {
    if (oldName === newName) {
      return this.get(oldName);
    }

    const existing = await this.store.getConnection(oldName);
    if (!existing) throw new Error(`Connection ${oldName} not found`);
    if (await this.store.getConnection(newName)) {
      throw new Error(`Connection ${newName} already exists`);
    }

    await this.store.upsertConnection({
      ...existing,
      name: newName
    });
    await this.store.deleteConnection(oldName);

    const password = await getPassword(oldName);
    if (password) {
      await setPassword(newName, password);
    }
    await deletePassword(oldName);
    const lastTest = this.lastTests.get(oldName);
    this.lastTests.delete(oldName);
    if (lastTest) this.lastTests.set(newName, lastTest);
    return this.get(newName);
  }

  async delete(name: string) {
    await this.store.deleteConnection(name);
    await deletePassword(name);
    this.lastTests.delete(name);
  }

  async setConnectionPassword(name: string, password: string) {
    const existing = await this.store.getConnection(name);
    if (!existing) throw new Error(`Connection ${name} not found`);
    await setPassword(name, password);
    this.lastTests.delete(name);
  }
}
