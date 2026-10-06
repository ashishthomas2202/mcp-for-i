import os from "os";

const SERVICE = "mcp-for-i";
const sessionStore = new Map<string, string>();
let lastKeychainError: string | undefined;

type CredentialStoreMode = "auto" | "keychain" | "session";

let keytar: any | undefined;
async function getKeytar() {
  if (keytar !== undefined) return keytar;
  try {
    const mod = await import("keytar");
    keytar = mod.default || mod;
  } catch {
    keytar = null;
  }
  return keytar;
}

export function detectCredentialEnvironment(env: NodeJS.ProcessEnv = process.env, platform = process.platform, release = os.release()) {
  const isWsl = isWslRuntime(env, platform, release);
  const shell = String(env.SHELL || env.ComSpec || env.PSModulePath || "").toLowerCase();
  const terminal = platform === "win32"
    ? shell.includes("bash") || shell.includes("git") || env.MSYSTEM
      ? "git-bash"
      : env.PSModulePath
        ? "powershell"
        : "cmd"
    : isWsl
      ? "wsl"
      : shell.includes("zsh")
        ? "zsh"
        : shell.includes("bash")
          ? "bash"
          : "unknown";
  const nativeStore = platform === "win32"
    ? "Windows Credential Manager"
    : platform === "darwin"
      ? "macOS Keychain"
      : "Linux Secret Service";

  return {
    platform,
    arch: process.arch,
    isWsl,
    terminal,
    nativeStore,
    label: isWsl
      ? "Linux (WSL)"
      : platform === "win32"
        ? "Windows"
        : platform === "darwin"
          ? "macOS"
          : platform === "linux"
            ? "Linux"
            : platform
  };
}

function getCredentialStoreMode(): CredentialStoreMode {
  const value = String(process.env.MCP_FOR_I_CREDENTIAL_STORE || "auto").trim().toLowerCase();
  if (value === "keychain" || value === "session") return value;
  return "auto";
}

function describeError(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export type SetPasswordResult = {
  /** True when the password reached the OS keychain and survives this process. */
  persistent: boolean;
  store: "keychain" | "session";
};

export type SetPasswordOptions = {
  /**
   * When the password can only be kept in memory and this process already holds
   * one for the connection, keep the existing value instead of overwriting it.
   */
  keepExistingSessionValue?: boolean;
};

export class KeychainUnavailableError extends Error {
  constructor(operation: string, detail?: string) {
    super(
      `MCP_FOR_I_CREDENTIAL_STORE=keychain is set, but the OS keychain could not ${operation}` +
        `${detail ? `: ${detail}` : ""}. ` +
        "Passwords are not kept in memory in keychain mode. Fix the keychain (or unset MCP_FOR_I_CREDENTIAL_STORE) and try again."
    );
    this.name = "KeychainUnavailableError";
  }
}

export async function setPassword(connectionName: string, password: string, options: SetPasswordOptions = {}): Promise<SetPasswordResult> {
  const mode = getCredentialStoreMode();
  if (mode === "session") {
    setSessionValue(connectionName, password, options);
    return { persistent: false, store: "session" };
  }
  const kt = await getKeytar();
  if (kt) {
    try {
      await kt.setPassword(SERVICE, connectionName, password);
      lastKeychainError = undefined;
      sessionStore.delete(connectionName);
      return { persistent: true, store: "keychain" };
    } catch (err) {
      lastKeychainError = describeError(err);
    }
  } else if (!lastKeychainError) {
    lastKeychainError = "keytar module is not available";
  }
  if (mode === "keychain") {
    throw new KeychainUnavailableError("store the password", lastKeychainError);
  }
  setSessionValue(connectionName, password, options);
  return { persistent: false, store: "session" };
}

export async function getPassword(connectionName: string) {
  const mode = getCredentialStoreMode();
  if (mode === "session") {
    return sessionStore.get(connectionName);
  }
  const kt = await getKeytar();
  if (kt) {
    try {
      const password = await kt.getPassword(SERVICE, connectionName);
      lastKeychainError = undefined;
      if (password) return password;
      if (mode === "keychain") return undefined;
    } catch (err) {
      lastKeychainError = describeError(err);
      if (mode === "keychain") throw new KeychainUnavailableError("read the password", lastKeychainError);
    }
  } else if (mode === "keychain") {
    throw new KeychainUnavailableError("read the password", "keytar module is not available");
  }
  return sessionStore.get(connectionName);
}

export async function deletePassword(connectionName: string) {
  const mode = getCredentialStoreMode();
  if (mode === "session") {
    sessionStore.delete(connectionName);
    return;
  }
  const kt = await getKeytar();
  if (kt) {
    try {
      await kt.deletePassword(SERVICE, connectionName);
      lastKeychainError = undefined;
    } catch (err) {
      lastKeychainError = describeError(err);
      if (mode === "keychain") {
        sessionStore.delete(connectionName);
        throw new KeychainUnavailableError("delete the password", lastKeychainError);
      }
    }
  } else if (mode === "keychain") {
    sessionStore.delete(connectionName);
    throw new KeychainUnavailableError("delete the password", "keytar module is not available");
  }
  sessionStore.delete(connectionName);
}

function setSessionValue(connectionName: string, password: string, options: SetPasswordOptions) {
  if (options.keepExistingSessionValue && sessionStore.has(connectionName)) return;
  sessionStore.set(connectionName, password);
}

/**
 * Replaces the keytar module used by this store. Intended for tests only:
 * pass an object with keytar's methods, `null` for "keytar not installed",
 * or `undefined` to restore normal lazy loading.
 */
export function setKeytarModuleForTesting(mod: any | null | undefined) {
  keytar = mod;
  lastKeychainError = undefined;
}

export async function isKeychainAvailable() {
  if (getCredentialStoreMode() === "session") return false;
  const kt = await getKeytar();
  if (!kt) return false;
  try {
    if (typeof kt.findCredentials === "function") {
      await kt.findCredentials(SERVICE);
    }
    lastKeychainError = undefined;
    return true;
  } catch (err) {
    lastKeychainError = describeError(err);
    return false;
  }
}

export async function getCredentialStoreStatus() {
  const requestedMode = getCredentialStoreMode();
  const environment = detectCredentialEnvironment();
  const keychainAvailable = await isKeychainAvailable();
  const isWsl = environment.isWsl;
  const mode = keychainAvailable ? "keychain" : "session";
  return {
    mode,
    requestedMode,
    persistent: keychainAvailable,
    keychainAvailable,
    platform: environment.platform,
    terminal: environment.terminal,
    nativeStore: environment.nativeStore,
    runtimeLabel: environment.label,
    isWsl,
    error: lastKeychainError,
    message: keychainAvailable
      ? `Passwords are stored in ${environment.nativeStore}.`
      : requestedMode === "keychain"
        ? `MCP_FOR_I_CREDENTIAL_STORE=keychain is set but ${environment.nativeStore} is not usable; saving or reading passwords will fail until it is fixed.`
      : requestedMode === "session"
        ? "Password storage is configured for session-only mode by MCP_FOR_I_CREDENTIAL_STORE=session."
      : isWsl
        ? "WSL could not access a persistent Linux Secret Service keychain; passwords are kept in this process only. Use SSH keys, install/configure libsecret in WSL, or run MCP-for-i from Windows to use Windows Credential Manager."
        : "No persistent OS keychain is available; passwords are kept in this process only."
  };
}

function isWslRuntime(env: NodeJS.ProcessEnv = process.env, platform = process.platform, release = os.release()) {
  if (platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  return /microsoft/i.test(release);
}
