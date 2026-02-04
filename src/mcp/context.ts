import { ConfigStore } from "../config/store.js";
import { IBMiClient } from "../ibmi/client.js";
import { ConnectionConfig, ConnectionData } from "../ibmi/types.js";
import { getPassword } from "../security/credentialStore.js";

export class McpContext {
  store = new ConfigStore();
  active?: IBMiClient;
  activeName?: string;

  async connect(connection: ConnectionData, configOverride?: Partial<ConnectionConfig>) {
    const baseSettings = await this.store.getSettings();
    const config: ConnectionConfig = {
      name: connection.name,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      ...baseSettings,
      ...configOverride
    };

    const client = new IBMiClient(config);
    await client.connect(connection);
    this.active = client;
    this.activeName = connection.name;
    return client;
  }

  async connectByName(name: string) {
    const stored = await this.store.getConnection(name);
    if (!stored) throw new Error(`Unknown connection: ${name}`);

    const password = await getPassword(name);
    const connection: ConnectionData = {
      name: stored.name,
      host: stored.host,
      port: stored.port,
      username: stored.username,
      password,
      privateKeyPath: stored.privateKeyPath
    };
    return this.connect(connection, stored.settings);
  }

  ensureActive(): IBMiClient {
    if (!this.active) throw new Error("Not connected");
    return this.active;
  }

  async disconnect() {
    if (this.active) {
      await this.active.disconnect();
      this.active = undefined;
      this.activeName = undefined;
    }
  }
}
