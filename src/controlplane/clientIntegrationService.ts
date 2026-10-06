import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";

const SERVER_NAME = "mcp-for-i";

export type ClientTarget = {
  id: string;
  label: string;
  description: string;
  available: boolean;
  autoInstall: boolean;
  configured: boolean;
  details?: string;
};

export type ClientInstallResult = {
  ok: boolean;
  id: string;
  label: string;
  message: string;
  output?: string[];
};

export class ClientIntegrationService {
  constructor(private readonly rootDir: string) {}

  async listTargets(): Promise<ClientTarget[]> {
    const launchSpec = this.getLaunchSpec();
    const [hasCodex, hasClaude, hasCode] = await Promise.all([
      commandExists("codex"),
      commandExists("claude"),
      commandExists("code")
    ]);

    const [codexConfigured, claudeConfigured, codeConfigured] = await Promise.all([
      hasCodex ? this.isCodexConfigured() : false,
      hasClaude ? this.isClaudeConfigured() : false,
      hasCode ? this.isCodeConfigured() : false
    ]);

    return [
      {
        id: "codex",
        label: "Codex Desktop / CLI",
        description: "Adds mcp-for-i to Codex using the local Codex MCP command.",
        available: hasCodex,
        autoInstall: hasCodex,
        configured: codexConfigured,
        details: hasCodex ? undefined : "codex command not found on PATH."
      },
      {
        id: "claude-code",
        label: "Claude Code",
        description: "Adds mcp-for-i to Claude Code at user scope.",
        available: hasClaude,
        autoInstall: hasClaude,
        configured: claudeConfigured,
        details: hasClaude ? undefined : "claude command not found on PATH."
      },
      {
        id: "vscode-copilot",
        label: "VS Code / GitHub Copilot",
        description: "Adds mcp-for-i to the current VS Code user profile via the code CLI.",
        available: hasCode,
        autoInstall: hasCode,
        configured: codeConfigured,
        details: hasCode ? undefined : "code command not found on PATH."
      },
      {
        id: "project-bob",
        label: "Project Bob",
        description: "Manual instructions only. No stable local Project Bob automation path is configured here.",
        available: true,
        autoInstall: false,
        configured: false,
        details: "Use manual instructions until a documented local config or CLI flow is available."
      },
      {
        id: "manual",
        label: "Other MCP Clients",
        description: "Show ready-to-copy config snippets for clients not listed above.",
        available: true,
        autoInstall: false,
        configured: false,
        details: `Launch command: ${launchSpec.command} ${launchSpec.args.join(" ")}`
      }
    ];
  }

  async installTarget(id: string): Promise<ClientInstallResult> {
    switch (id) {
      case "codex":
        return this.installCodex();
      case "claude-code":
        return this.installClaudeCode();
      case "vscode-copilot":
        return this.installVsCode();
      case "project-bob":
        return this.manualOnly("project-bob", "Project Bob");
      case "manual":
        return this.manualOnly("manual", "Other MCP Clients");
      default:
        throw new Error(`Unknown client target: ${id}`);
    }
  }

  private async installCodex(): Promise<ClientInstallResult> {
    if (!await commandExists("codex")) {
      return {
        ok: false,
        id: "codex",
        label: "Codex Desktop / CLI",
        message: "codex command was not found. Use the manual instructions below."
      };
    }

    if (await this.isCodexConfigured()) {
      return {
        ok: true,
        id: "codex",
        label: "Codex Desktop / CLI",
        message: "mcp-for-i is already configured in Codex."
      };
    }

    const spec = this.getLaunchSpec();
    const result = await runCommand("codex", ["mcp", "add", SERVER_NAME, "--", spec.command, ...spec.args]);
    if (!result.ok) throw new Error(result.stderr || result.stdout || "Failed to add mcp-for-i to Codex.");
    return {
      ok: true,
      id: "codex",
      label: "Codex Desktop / CLI",
      message: "Added mcp-for-i to Codex.",
      output: compactOutput(result)
    };
  }

  private async installClaudeCode(): Promise<ClientInstallResult> {
    if (!await commandExists("claude")) {
      return {
        ok: false,
        id: "claude-code",
        label: "Claude Code",
        message: "claude command was not found. Use the manual instructions below."
      };
    }

    if (await this.isClaudeConfigured()) {
      return {
        ok: true,
        id: "claude-code",
        label: "Claude Code",
        message: "mcp-for-i is already configured in Claude Code."
      };
    }

    const spec = this.getLaunchSpec();
    const result = await runCommand("claude", ["mcp", "add", "--scope", "user", "--transport", "stdio", SERVER_NAME, "--", spec.command, ...spec.args]);
    if (!result.ok) throw new Error(result.stderr || result.stdout || "Failed to add mcp-for-i to Claude Code.");
    return {
      ok: true,
      id: "claude-code",
      label: "Claude Code",
      message: "Added mcp-for-i to Claude Code.",
      output: compactOutput(result)
    };
  }

  private async installVsCode(): Promise<ClientInstallResult> {
    if (!await commandExists("code")) {
      return {
        ok: false,
        id: "vscode-copilot",
        label: "VS Code / GitHub Copilot",
        message: "code command was not found. Use the manual instructions below."
      };
    }

    const spec = this.getLaunchSpec();
    const payload = JSON.stringify({
      name: SERVER_NAME,
      command: spec.command,
      args: spec.args
    });

    const result = await runCommand("code", ["--add-mcp", payload]);
    if (!result.ok) throw new Error(result.stderr || result.stdout || "Failed to add mcp-for-i to VS Code.");
    return {
      ok: true,
      id: "vscode-copilot",
      label: "VS Code / GitHub Copilot",
      message: "Added mcp-for-i to VS Code / GitHub Copilot.",
      output: compactOutput(result)
    };
  }

  private async manualOnly(id: string, label: string): Promise<ClientInstallResult> {
    const spec = this.getLaunchSpec();
    const genericJson = JSON.stringify({
      mcpServers: {
        [SERVER_NAME]: {
          command: spec.command,
          args: spec.args
        }
      }
    }, null, 2);

    const vscodeJson = JSON.stringify({
      name: SERVER_NAME,
      command: spec.command,
      args: spec.args
    }, null, 2);

    const codexToml = [
      `[mcp_servers.${quoteTomlKey(SERVER_NAME)}]`,
      `command = ${quoteToml(spec.command)}`,
      `args = [${spec.args.map(quoteToml).join(", ")}]`
    ].join("\n");

    const claudeCommand = `claude mcp add --scope user --transport stdio ${SERVER_NAME} -- ${spec.command} ${spec.args.join(" ")}`;
    const codexCommand = `codex mcp add ${SERVER_NAME} -- ${spec.command} ${spec.args.join(" ")}`;
    const vscodeCommand = `code --add-mcp ${JSON.stringify(vscodeJson)}`;

    return {
      ok: true,
      id,
      label,
      message: "Manual setup instructions",
      output: [
        "Codex:",
        codexCommand,
        "",
        codexToml,
        "",
        "Claude Code:",
        claudeCommand,
        "",
        "VS Code / GitHub Copilot:",
        vscodeCommand,
        "",
        vscodeJson,
        "",
        "Generic JSON clients:",
        genericJson,
        "",
        "Project Bob:",
        "Use the generic JSON command/args above unless Project Bob publishes a stable local MCP config or CLI flow."
      ]
    };
  }

  private async isCodexConfigured() {
    const result = await runCommand("codex", ["mcp", "get", SERVER_NAME]);
    return result.ok;
  }

  private async isClaudeConfigured() {
    const result = await runCommand("claude", ["mcp", "get", SERVER_NAME]);
    return result.ok;
  }

  private async isCodeConfigured() {
    const userConfigPath = getVsCodeUserMcpPath();
    try {
      const raw = await fsp.readFile(userConfigPath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.servers)) {
        return parsed.servers.some((entry: any) => entry?.name === SERVER_NAME);
      }
      if (parsed?.servers && typeof parsed.servers === "object") {
        return Object.prototype.hasOwnProperty.call(parsed.servers, SERVER_NAME);
      }
      return false;
    } catch {
      return false;
    }
  }

  private getLaunchSpec() {
    return {
      command: process.execPath,
      args: [path.join(this.rootDir, "dist", "index.js")]
    };
  }
}

function getVsCodeUserMcpPath() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Code", "User", "mcp.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Code", "User", "mcp.json");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Code", "User", "mcp.json");
}

async function commandExists(command: string) {
  const result = await runCommand(command, ["--help"]);
  return result.ok;
}

type SpawnSpec = {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
};

/**
 * Finds a command on PATH the way cmd.exe does (PATHEXT order). Returns the
 * full path, or undefined when nothing matches.
 */
export function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathExt = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map(ext => ext.trim().toLowerCase())
    .filter(Boolean);
  const hasExt = pathExt.includes(path.extname(command).toLowerCase());
  const candidates = hasExt ? [command] : pathExt.map(ext => command + ext);

  const isPath = command.includes("/") || command.includes("\\");
  const dirs = isPath
    ? [""]
    : String(env.PATH || env.Path || "").split(";").map(dir => dir.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = dir ? path.join(dir, candidate) : candidate;
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Quotes one argument for cmd.exe, following the MSVCRT argv rules. */
export function escapeCmdArgument(value: string, doubleEscapeMeta: boolean) {
  let arg = String(value);
  // Double the backslashes that precede a quote, then escape the quote.
  arg = arg.replace(/(\\*)"/g, '$1$1\\"');
  // Double trailing backslashes so they do not escape the closing quote.
  arg = arg.replace(/(\\*)$/, "$1$1");
  arg = `"${arg}"`;
  arg = arg.replace(CMD_META, "^$1");
  // .cmd shims re-parse their arguments (%*), so they need a second pass.
  if (doubleEscapeMeta) arg = arg.replace(CMD_META, "^$1");
  return arg;
}

/**
 * Builds how to start a command. On Windows, npm-installed CLIs (codex,
 * claude, code) are .cmd shims that only start through cmd.exe, so they are
 * resolved via PATHEXT and launched with every argument escaped. The
 * arguments are fixed by this module, never taken from a request.
 */
export function buildSpawnSpec(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): SpawnSpec | undefined {
  if (platform !== "win32") {
    return { file: command, args, windowsVerbatimArguments: false };
  }
  const resolved = resolveWindowsCommand(command, env);
  if (!resolved) return undefined;
  if (!/\.(cmd|bat)$/i.test(resolved)) {
    return { file: resolved, args, windowsVerbatimArguments: false };
  }
  const commandLine = [
    resolved.replace(CMD_META, "^$1"),
    ...args.map(arg => escapeCmdArgument(arg, true))
  ].join(" ");
  return {
    file: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true
  };
}

export async function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ ok: boolean; stdout: string; stderr: string }>(resolve => {
    const spec = buildSpawnSpec(command, args, process.platform, env);
    if (!spec) {
      resolve({ ok: false, stdout: "", stderr: `${command} was not found on PATH` });
      return;
    }
    const child = spawn(spec.file, spec.args, {
      env,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    child.stdout.on("data", chunk => stdout.push(String(chunk)));
    child.stderr.on("data", chunk => stderr.push(String(chunk)));
    child.on("error", () => resolve({ ok: false, stdout: "", stderr: "" }));
    child.on("exit", code => resolve({
      ok: code === 0,
      stdout: stdout.join("").trim(),
      stderr: stderr.join("").trim()
    }));
  });
}

function compactOutput(result: { stdout: string; stderr: string }) {
  return [result.stdout, result.stderr].filter(Boolean).flatMap(value => value.split(/\r?\n/)).filter(Boolean);
}

function quoteToml(value: string) {
  return JSON.stringify(value);
}

function quoteTomlKey(value: string) {
  return JSON.stringify(value);
}
