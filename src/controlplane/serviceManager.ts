import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { getConfigDir } from "../config/store.js";
import { getPlatformDescriptor } from "./platform.js";
import { getControlPlanePort, isControlPlaneRunning } from "./serverShared.js";

const SERVICE_ID = "mcp-for-i-controlplane";
const MAC_LABEL = "com.mcpfori.controlplane";
const RC_BEGIN = "# >>> mcp-for-i control >>>";
const RC_END = "# <<< mcp-for-i control <<<";

export type ControlServiceStatus = ReturnType<typeof getPlatformDescriptor> & {
  enabled: boolean;
  running: boolean;
  managedBy: string;
  target?: string;
  detail?: string;
};

export async function getServiceStatus(scriptPath: string, nodePath = process.execPath): Promise<ControlServiceStatus> {
  const descriptor = getPlatformDescriptor();
  const running = await isControlPlaneRunning();

  if (descriptor.platform === "win32") {
    const target = getWindowsStartupScriptPath();
    return {
      ...descriptor,
      enabled: await pathExists(target),
      running,
      managedBy: "Windows Startup",
      target
    };
  }

  if (descriptor.platform === "darwin") {
    const target = getMacLaunchAgentPath();
    return {
      ...descriptor,
      enabled: await pathExists(target),
      running,
      managedBy: "launchd LaunchAgent",
      target
    };
  }

  if (!descriptor.isWsl && await canUseSystemdUser()) {
    const target = getLinuxSystemdUnitPath();
    const enabled = await isSystemdEnabled();
    const active = await isSystemdActive();
    return {
      ...descriptor,
      enabled,
      running: running || active,
      managedBy: "systemd user service",
      target
    };
  }

  const rcPath = getBashRcPath();
  const enabled = await hasManagedRcBlock(rcPath);
  return {
    ...descriptor,
    enabled,
    running,
    managedBy: descriptor.isWsl ? "WSL .bashrc hook" : ".bashrc hook",
    target: rcPath,
    detail: descriptor.isWsl ? "Starts on interactive Bash shell launch inside WSL." : "Starts on interactive Bash shell launch."
  };
}

export async function enableBackgroundService(scriptPath: string, nodePath = process.execPath) {
  const descriptor = getPlatformDescriptor();

  if (descriptor.platform === "win32") {
    await enableWindowsStartup(scriptPath, nodePath);
  } else if (descriptor.platform === "darwin") {
    await enableMacLaunchAgent(scriptPath, nodePath);
  } else if (!descriptor.isWsl && await canUseSystemdUser()) {
    await enableLinuxSystemdService(scriptPath, nodePath);
  } else {
    await enableBashRcHook(scriptPath, nodePath, descriptor.isWsl);
  }

  return getServiceStatus(scriptPath, nodePath);
}

export async function disableBackgroundService(scriptPath: string, nodePath = process.execPath) {
  const descriptor = getPlatformDescriptor();

  if (descriptor.platform === "win32") {
    await fs.rm(getWindowsStartupScriptPath(), { force: true });
  } else if (descriptor.platform === "darwin") {
    await disableMacLaunchAgent();
  } else if (!descriptor.isWsl && await canUseSystemdUser()) {
    await disableLinuxSystemdService();
  } else {
    await disableBashRcHook();
  }

  return getServiceStatus(scriptPath, nodePath);
}

export async function ensureControlPlaneRunning(scriptPath: string, nodePath = process.execPath, timeoutMs = 15000) {
  if (await isControlPlaneRunning()) {
    return { started: false };
  }

  const child = spawn(nodePath, [scriptPath, "serve"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await wait(500);
    if (await isControlPlaneRunning()) {
      return { started: true };
    }
  }

  throw new Error("Control plane did not become healthy after launch.");
}

export function upsertManagedBlock(input: string, block: string, begin = RC_BEGIN, end = RC_END) {
  const stripped = removeManagedBlock(input, begin, end).trimEnd();
  return `${stripped}${stripped ? "\n\n" : ""}${block.trim()}\n`;
}

export function removeManagedBlock(input: string, begin = RC_BEGIN, end = RC_END) {
  const pattern = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "g");
  return input.replace(pattern, "").replace(/\n{3,}/g, "\n\n");
}

async function enableWindowsStartup(scriptPath: string, nodePath: string) {
  const startupScriptPath = getWindowsStartupScriptPath();
  await fs.mkdir(path.dirname(startupScriptPath), { recursive: true });

  const command = `${quoteWindows(nodePath)} ${quoteWindows(scriptPath)} serve`;
  const startupScript = [
    "@echo off",
    "setlocal",
    `set "MCP_FOR_I_CONTROL_PORT=${getControlPlanePort()}"`,
    `start \"\" /MIN ${command}`,
    "exit /b 0"
  ].join("\r\n");

  await fs.writeFile(startupScriptPath, startupScript, "utf8");
}

async function enableMacLaunchAgent(scriptPath: string, nodePath: string) {
  const agentPath = getMacLaunchAgentPath();
  const configDir = getConfigDir();
  const outPath = path.join(configDir, "controlplane.out.log");
  const errPath = path.join(configDir, "controlplane.err.log");
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  await fs.mkdir(configDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(scriptPath)}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(outPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(errPath)}</string>
</dict>
</plist>
`;

  await fs.writeFile(agentPath, plist, "utf8");
  await runQuiet("launchctl", ["unload", agentPath]);
  await runQuiet("launchctl", ["load", agentPath]);
}

async function disableMacLaunchAgent() {
  const agentPath = getMacLaunchAgentPath();
  await runQuiet("launchctl", ["unload", agentPath]);
  await fs.rm(agentPath, { force: true });
}

async function enableLinuxSystemdService(scriptPath: string, nodePath: string) {
  const unitPath = getLinuxSystemdUnitPath();
  const configDir = getConfigDir();
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.mkdir(configDir, { recursive: true });

  const unit = `[Unit]
Description=MCP-for-i control plane
After=network.target

[Service]
Type=simple
ExecStart=${systemdQuote(nodePath)} ${systemdQuote(scriptPath)} serve
Restart=on-failure
RestartSec=3
WorkingDirectory=${systemdQuote(path.dirname(scriptPath))}
Environment=MCP_FOR_I_CONTROL_HOST=127.0.0.1
Environment=MCP_FOR_I_CONTROL_PORT=${getControlPlanePort()}

[Install]
WantedBy=default.target
`;

  await fs.writeFile(unitPath, unit, "utf8");
  await runOrThrow("systemctl", ["--user", "daemon-reload"]);
  await runOrThrow("systemctl", ["--user", "enable", "--now", SERVICE_ID]);
}

async function disableLinuxSystemdService() {
  const unitPath = getLinuxSystemdUnitPath();
  await runQuiet("systemctl", ["--user", "disable", "--now", SERVICE_ID]);
  await fs.rm(unitPath, { force: true });
  await runQuiet("systemctl", ["--user", "daemon-reload"]);
}

async function enableBashRcHook(scriptPath: string, nodePath: string, wslOnly: boolean) {
  const rcPath = getBashRcPath();
  const launcherPath = path.join(getConfigDir(), "control-start.sh");
  await fs.mkdir(path.dirname(launcherPath), { recursive: true });
  await writeBashLauncher(launcherPath, scriptPath, nodePath);

  const existing = await readTextOrEmpty(rcPath);
  const block = createBashRcBlock(launcherPath, wslOnly);
  const updated = upsertManagedBlock(existing, block);
  await fs.writeFile(rcPath, updated, "utf8");
}

async function disableBashRcHook() {
  const rcPath = getBashRcPath();
  const existing = await readTextOrEmpty(rcPath);
  const updated = removeManagedBlock(existing);
  if (updated !== existing) {
    await fs.writeFile(rcPath, updated, "utf8");
  }
}

async function writeBashLauncher(launcherPath: string, scriptPath: string, nodePath: string) {
  const logFile = path.join(getConfigDir(), "controlplane.log");
  const script = buildBashLauncherScript({ scriptPath, nodePath, logFile, port: getControlPlanePort() });
  await fs.writeFile(launcherPath, script, { encoding: "utf8", mode: 0o755 });
}

/**
 * Builds the Bash launcher. The port defaults to the one configured when the
 * service was enabled and can be overridden with MCP_FOR_I_CONTROL_PORT.
 */
export function buildBashLauncherScript(opts: { scriptPath: string; nodePath: string; logFile: string; port: number }) {
  const { scriptPath, nodePath, logFile } = opts;
  const port = Number.isInteger(opts.port) && opts.port > 0 && opts.port <= 65535 ? opts.port : 3980;

  return `#!/usr/bin/env bash
set -euo pipefail

PORT="\${MCP_FOR_I_CONTROL_PORT:-${port}}"
case "$PORT" in
  ""|*[!0-9]*) PORT=${port} ;;
esac
URL="http://127.0.0.1:\${PORT}/api/health"
LOG_FILE=${shellQuote(logFile)}
LOCK_DIR="\${XDG_RUNTIME_DIR:-/tmp}/${SERVICE_ID}.lock"

mkdir -p "$(dirname "$LOG_FILE")"

health_check() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 1 "$URL" >/dev/null 2>&1
    return $?
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -q -T 1 -O - "$URL" >/dev/null 2>&1
    return $?
  fi

  if command -v python3 >/dev/null 2>&1; then
    HEALTH_URL="$URL" python3 - <<'PY' >/dev/null 2>&1
import os, sys, urllib.request
try:
    with urllib.request.urlopen(os.environ["HEALTH_URL"], timeout=1) as response:
        sys.exit(0 if response.status == 200 else 1)
except Exception:
    sys.exit(1)
PY
    return $?
  fi

  return 1
}

if health_check; then
  exit 0
fi

if mkdir "$LOCK_DIR" 2>/dev/null; then
  trap 'rmdir "$LOCK_DIR" >/dev/null 2>&1 || true' EXIT
else
  exit 0
fi

if health_check; then
  exit 0
fi

MCP_FOR_I_CONTROL_PORT="$PORT" nohup ${shellQuote(nodePath)} ${shellQuote(scriptPath)} serve >>"$LOG_FILE" 2>&1 </dev/null &
`;
}

function createBashRcBlock(launcherPath: string, wslOnly: boolean) {
  const guard = wslOnly ? 'if [ -n "${WSL_DISTRO_NAME:-}" ]' : "if true";
  return `${RC_BEGIN}
case $- in
  *i*) ;;
  *) return ;;
esac

${guard} && [ -x ${shellQuote(launcherPath)} ]; then
  ${shellQuote(launcherPath)} >/dev/null 2>&1 &
fi
${RC_END}`;
}

async function hasManagedRcBlock(rcPath: string) {
  const content = await readTextOrEmpty(rcPath);
  return content.includes(RC_BEGIN) && content.includes(RC_END);
}

function getWindowsStartupScriptPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${SERVICE_ID}.cmd`);
}

function getMacLaunchAgentPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
}

function getLinuxSystemdUnitPath() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "systemd", "user", `${SERVICE_ID}.service`);
}

function getBashRcPath() {
  return path.join(os.homedir(), ".bashrc");
}

async function canUseSystemdUser() {
  const result = await runQuiet("systemctl", ["--user", "--version"]);
  return result.ok;
}

async function isSystemdEnabled() {
  const result = await runQuiet("systemctl", ["--user", "is-enabled", SERVICE_ID]);
  return result.ok && result.stdout.trim() === "enabled";
}

async function isSystemdActive() {
  const result = await runQuiet("systemctl", ["--user", "is-active", SERVICE_ID]);
  return result.ok && result.stdout.trim() === "active";
}

async function runOrThrow(command: string, args: string[]) {
  const result = await runQuiet(command, args);
  if (!result.ok) {
    throw new Error(result.stderr || result.stdout || `Command failed: ${command} ${args.join(" ")}`);
  }
}

async function runQuiet(command: string, args: string[]) {
  return new Promise<{ ok: boolean; stdout: string; stderr: string }>(resolve => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    child.stdout.on("data", chunk => stdout.push(String(chunk)));
    child.stderr.on("data", chunk => stderr.push(String(chunk)));
    child.on("error", () => resolve({ ok: false, stdout: "", stderr: "" }));
    child.on("exit", code => {
      resolve({
        ok: code === 0,
        stdout: stdout.join("").trim(),
        stderr: stderr.join("").trim()
      });
    });
  });
}

async function readTextOrEmpty(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function pathExists(target: string) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function quoteWindows(value: string) {
  return `"${value.replaceAll(`"`, `""`)}"`;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function systemdQuote(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function wait(ms: number) {
  await new Promise(resolve => setTimeout(resolve, ms));
}
