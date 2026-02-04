import { ConfigStore } from "../config/store.js";
import { IBMiClient } from "../ibmi/client.js";
import { getPassword } from "../security/credentialStore.js";
export class McpContext {
    store = new ConfigStore();
    active;
    activeName;
    async connect(connection, configOverride) {
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
        this.active = client;
        this.activeName = connection.name;
        return client;
    }
    async connectByName(name) {
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
        return this.connect(connection, stored.settings);
    }
    ensureActive() {
        if (!this.active)
            throw new Error("Not connected");
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
