import { ConfigStore, ConnectionPolicy, StoredConnection } from "../config/store.js";
import { deletePassword, getPassword, setPassword } from "../security/credentialStore.js";
import { ControlPlaneError } from "./errors.js";

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

export class ConnectionService {
  constructor(private readonly store: ConfigStore) {}

  async list() {
    return this.store.listConnections();
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
    return this.get(newName);
  }

  async delete(name: string) {
    await this.store.deleteConnection(name);
    await deletePassword(name);
  }

  async setConnectionPassword(name: string, password: string) {
    const existing = await this.store.getConnection(name);
    if (!existing) throw new Error(`Connection ${name} not found`);
    await setPassword(name, password);
  }
}
