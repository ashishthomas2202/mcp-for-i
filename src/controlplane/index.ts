#!/usr/bin/env node
import { startControlPlaneServer } from "./server.js";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import {
  AUTOSTART_TASK_NAME,
  configureWindowsAutostart,
  getControlPlaneUrl,
  getWindowsAutostartStatus,
  isControlPlaneRunning,
  removeWindowsAutostart
} from "./autostart.js";

const command = normalizeCommand(process.argv.slice(2));

switch (command) {
  case "serve":
    await serve();
    break;
  case "setup":
    await setupAutostart();
    break;
  case "status":
    await printStatus();
    break;
  case "remove":
  case "uninstall":
    await removeAutostart();
    break;
  case "open":
    await openUi();
    break;
  case "help":
  default:
    printHelp();
    break;
}

async function serve() {
  try {
    const server = await startControlPlaneServer();
    process.stderr.write(`mcp-for-i control plane running at http://${server.host}:${server.port}\n`);

    const shutdown = async () => {
      await server.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      const url = getControlPlaneUrl();
      process.stderr.write(`mcp-for-i control plane already running at ${url}\n`);
      process.exit(0);
    }
    throw err;
  }
}

async function setupAutostart() {
  if (process.platform !== "win32") {
    process.stderr.write("Autostart setup is currently implemented for Windows only.\n");
    process.stderr.write(`Run manually with: mcp-for-i-control serve\n`);
    return;
  }

  const scriptPath = fileURLToPath(import.meta.url);
  await configureWindowsAutostart(scriptPath, process.execPath);
  process.stderr.write(`Autostart configured (${AUTOSTART_TASK_NAME}).\n`);
  process.stderr.write(`Control plane URL: ${getControlPlaneUrl()}\n`);
}

async function removeAutostart() {
  if (process.platform !== "win32") {
    process.stderr.write("Autostart removal is currently implemented for Windows only.\n");
    return;
  }

  try {
    await removeWindowsAutostart();
    process.stderr.write(`Autostart removed (${AUTOSTART_TASK_NAME}).\n`);
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes("cannot find the file specified") || msg.includes("ERROR: The system cannot find")) {
      process.stderr.write(`Autostart task not found (${AUTOSTART_TASK_NAME}).\n`);
      return;
    }
    throw err;
  }
}

async function printStatus() {
  const url = getControlPlaneUrl();
  const running = await isControlPlaneRunning(url);

  process.stderr.write(`Control plane URL: ${url}\n`);
  process.stderr.write(`Running: ${running ? "yes" : "no"}\n`);

  if (process.platform === "win32") {
    const auto = await getWindowsAutostartStatus();
    process.stderr.write(`Autostart task: ${auto.installed ? "installed" : "not installed"}\n`);
    if (auto.state) {
      process.stderr.write(`Autostart state: ${auto.state}\n`);
    }
  } else {
    process.stderr.write("Autostart task: platform not managed by this command\n");
  }
}

async function openUi() {
  const url = getControlPlaneUrl();
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
  process.stderr.write(`Opening ${url}\n`);
}

function printHelp() {
  process.stderr.write(`mcp-for-i-control commands:\n`);
  process.stderr.write(`  serve      Start control plane server (foreground)\n`);
  process.stderr.write(`  setup      Configure autostart at login and launch now\n`);
  process.stderr.write(`  status     Show running/autostart status\n`);
  process.stderr.write(`  remove     Remove autostart configuration\n`);
  process.stderr.write(`  open       Open UI URL in default browser\n`);
}

function normalizeCommand(args: string[]) {
  const first = (args[0] || "serve").toLowerCase();
  if (!first || first === "start") return "serve";
  return first;
}
