import { spawn } from "child_process";

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
  const taskCmd = `"${nodePath}" "${scriptPath}" serve`;

  await runCommand("schtasks", [
    "/Create",
    "/F",
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/TN",
    AUTOSTART_TASK_NAME,
    "/TR",
    taskCmd
  ]);

  await runCommand("schtasks", ["/Run", "/TN", AUTOSTART_TASK_NAME]);
}

export async function removeWindowsAutostart() {
  assertWindowsPlatform();
  await runCommand("schtasks", ["/Delete", "/TN", AUTOSTART_TASK_NAME, "/F"]);
}

export async function getWindowsAutostartStatus() {
  assertWindowsPlatform();
  try {
    const output = await runCommandCapture("schtasks", ["/Query", "/TN", AUTOSTART_TASK_NAME, "/FO", "LIST"]);
    const lower = output.toLowerCase();
    const hasTask = lower.includes("taskname:");
    const stateLine = output
      .split(/\r?\n/)
      .find(line => line.trim().toLowerCase().startsWith("status:"));

    return {
      installed: hasTask,
      state: stateLine ? stateLine.split(":").slice(1).join(":").trim() : undefined,
      raw: output
    };
  } catch {
    return {
      installed: false,
      state: undefined,
      raw: ""
    };
  }
}

export async function runCommand(command: string, args: string[]) {
  await runCommandCapture(command, args);
}

export async function runCommandCapture(command: string, args: string[]) {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { shell: process.platform === "win32" });
    let output = "";

    child.stdout.on("data", chunk => {
      output += String(chunk);
    });
    child.stderr.on("data", chunk => {
      output += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(new Error(output.trim() || `Command failed (${code}): ${command} ${args.join(" ")}`));
      }
    });
  });
}

function assertWindowsPlatform() {
  if (process.platform !== "win32") {
    throw new Error("This autostart operation is currently supported on Windows only.");
  }
}
