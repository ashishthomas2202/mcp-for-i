import { ConfigStore, ConnectionPolicy, StoredConnection } from "../config/store.js";
import { deletePassword, getPassword, setPassword } from "../security/credentialStore.js";

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
    if (!existing) throw new Error(`Connection ${name} not found`);

    const next: StoredConnection = {
      ...existing,
      host: input.host ?? existing.host,
      port: input.port ?? existing.port,
      username: input.username ?? existing.username,
      privateKeyPath: input.privateKeyPath ?? existing.privateKeyPath,
      settings: input.settings ?? existing.settings,
      policy: input.policy ?? existing.policy
    };

    await this.store.upsertConnection(next);
    if (input.storePassword && input.password) {
      await setPassword(name, input.password);
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
