import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";

export const AUTOSTART_TASK_NAME = "mcp-for-i-controlplane";

export function getControlPlaneUrl() {
  const host = process.env.MCP_FOR_I_CONTROL_HOST || "127.0.0.1";
  const portRaw = Number(process.env.MCP_FOR_I_CONTROL_PORT || 3980);
  const port = Number.isFinite(portRaw) && portRaw > 0 && portRaw <= 65535 ? Math.floor(portRaw) : 3980;
  return `http://${host}:${port}`;
}

export async function isControlPlaneRunning(baseUrl = getControlPlaneUrl()) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

export async function configureWindowsAutostart(scriptPath: string, nodePath = process.execPath) {
  assertWindowsPlatform();

  const startupScriptPath = getWindowsStartupScriptPath();
  await fs.mkdir(path.dirname(startupScriptPath), { recursive: true });

  const command = `${quoteForWindowsCommand(nodePath)} ${quoteForWindowsCommand(scriptPath)} serve`;
  const startupScript = [
    "@echo off",
    "setlocal",
    `start \"\" /MIN ${command}`,
    "exit /b 0"
  ].join("\r\n");

  await fs.writeFile(startupScriptPath, startupScript, "utf8");

  spawn(nodePath, [scriptPath, "serve"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  }).unref();
}

export async function removeWindowsAutostart() {
  assertWindowsPlatform();
  const startupScriptPath = getWindowsStartupScriptPath();
  await fs.rm(startupScriptPath, { force: true });
}

export async function getWindowsAutostartStatus() {
  assertWindowsPlatform();
  const startupScriptPath = getWindowsStartupScriptPath();
  try {
    const stat = await fs.stat(startupScriptPath);
    return {
      installed: true,
      state: "startup-script",
      raw: startupScriptPath,
      updatedAt: stat.mtime.toISOString()
    };
  } catch {
    return {
      installed: false,
      state: undefined,
      raw: startupScriptPath,
      updatedAt: undefined
    };
  }
}

function getWindowsStartupScriptPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${AUTOSTART_TASK_NAME}.cmd`);
}

function assertWindowsPlatform() {
  if (process.platform !== "win32") {
    throw new Error("This autostart operation is currently supported on Windows only.");
  }
}

function quoteForWindowsCommand(value: string) {
  const escaped = value.replaceAll(`"`, `""`);
  return `"${escaped}"`;
}
