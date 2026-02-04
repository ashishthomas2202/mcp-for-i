const SERVICE = "mcp-for-i";
const sessionStore = new Map();
let keytar;
async function getKeytar() {
    if (keytar !== undefined)
        return keytar;
    try {
        const mod = await import("keytar");
        keytar = mod.default || mod;
    }
    catch {
        keytar = null;
    }
    return keytar;
}
export async function setPassword(connectionName, password) {
    const kt = await getKeytar();
    if (kt) {
        await kt.setPassword(SERVICE, connectionName, password);
    }
    else {
        sessionStore.set(connectionName, password);
    }
}
export async function getPassword(connectionName) {
    const kt = await getKeytar();
    if (kt) {
        return kt.getPassword(SERVICE, connectionName);
    }
    return sessionStore.get(connectionName);
}
export async function deletePassword(connectionName) {
    const kt = await getKeytar();
    if (kt) {
        await kt.deletePassword(SERVICE, connectionName);
    }
    sessionStore.delete(connectionName);
}
export async function isKeychainAvailable() {
    const kt = await getKeytar();
    return Boolean(kt);
}
