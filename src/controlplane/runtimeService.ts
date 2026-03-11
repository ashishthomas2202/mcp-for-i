import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  AUTOSTART_TASK_NAME,
  configureWindowsAutostart,
  getControlPlaneUrl,
  getWindowsAutostartStatus,
  isControlPlaneRunning,
  removeWindowsAutostart
} from "./autostart.js";

type JobStatus = "idle" | "running" | "success" | "failed";

export type RuntimeJob = {
  id: string;
  status: JobStatus;
  startedAt?: string;
  finishedAt?: string;
  output: string[];
  error?: string;
};

type RuntimeState = {
  install: RuntimeJob;
  updateMcp: RuntimeJob;
  updateSkills: RuntimeJob;
  setupAutostart: RuntimeJob;
  removeAutostart: RuntimeJob;
};

type UpdateSkillsOptions = {
  repoUrl?: string;
  branch?: string;
};

export class RuntimeService {
  private readonly state: RuntimeState = {
    install: makeJob("install"),
    updateMcp: makeJob("updateMcp"),
    updateSkills: makeJob("updateSkills"),
    setupAutostart: makeJob("setupAutostart"),
    removeAutostart: makeJob("removeAutostart")
  };

  constructor(private readonly rootDir: string) {}

  getStatus() {
    return this.state;
  }

  async installOrRepair() {
    return this.runJob("install", async push => {
      const mode = await this.detectExecutionMode(push);
      if (mode === "git-checkout") {
        await this.runNpm(["install"], this.rootDir, push);
        await this.buildIfPresent(push);
        return;
      }
      await this.runGlobalPackageUpdate(push, "install");
    });
  }

  async updateMcp() {
    return this.runJob("updateMcp", async push => {
      const mode = await this.detectExecutionMode(push);
      if (mode === "git-checkout") {
        const branch = await this.getGitCurrentBranch(this.rootDir, push);
        if (branch) {
          await this.runCommand("git", ["fetch", "origin", branch], this.rootDir, push);
          await this.runCommand("git", ["pull", "--ff-only", "origin", branch], this.rootDir, push);
        } else {
          push("Could not determine current branch. Using plain fast-forward pull.");
          await this.runCommand("git", ["pull", "--ff-only"], this.rootDir, push);
        }
        await this.runNpm(["install"], this.rootDir, push);
        await this.buildIfPresent(push);
        return;
      }
      await this.runGlobalPackageUpdate(push, "update");
    });
  }

  async updateSkills(options?: UpdateSkillsOptions) {
    return this.runJob("updateSkills", async push => {
      const repoUrl = sanitizeRepoUrl(options?.repoUrl) || process.env.MCP_FOR_I_SKILLS_REPO || DEFAULT_SKILLS_REPO;
      const branch = sanitizeBranch(options?.branch) || process.env.MCP_FOR_I_SKILLS_BRANCH || "main";
      const skillsDir = path.join(this.rootDir, "skills");
      const hasSkills = await pathExists(skillsDir);

      push(`Using skills repository: ${repoUrl} (${branch})`);

      if (!hasSkills) {
        await this.runCommand("git", ["clone", "--depth", "1", "--branch", branch, repoUrl, skillsDir], this.rootDir, push);
        return;
      }

      const skillsGit = path.join(skillsDir, ".git");
      if (await pathExists(skillsGit)) {
        const currentRemote = await this.getGitRemoteUrl(skillsDir, push);
        if (currentRemote && currentRemote !== repoUrl) {
          push(`Switching skills remote from ${currentRemote} to ${repoUrl}`);
          await this.runCommand("git", ["remote", "set-url", "origin", repoUrl], skillsDir, push);
        }
        await this.runCommand("git", ["fetch", "origin", branch], skillsDir, push);
        await this.runCommand("git", ["checkout", branch], skillsDir, push);
        await this.runCommand("git", ["pull", "--ff-only", "origin", branch], skillsDir, push);
        return;
      }

      const backupDir = `${skillsDir}.backup-${Date.now()}`;
      push(`Existing skills directory is not a git repository. Backing it up to ${backupDir}`);
      await fs.rename(skillsDir, backupDir);
      try {
        await this.runCommand("git", ["clone", "--depth", "1", "--branch", branch, repoUrl, skillsDir], this.rootDir, push);
      } catch (error) {
        push("Clone failed. Restoring previous skills directory.");
        await safeRename(backupDir, skillsDir);
        throw error;
      }
    });
  }

  async setupAutostart() {
    return this.runJob("setupAutostart", async push => {
      if (process.platform !== "win32") {
        throw new Error("Autostart setup is currently supported on Windows only.");
      }
      const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
      await configureWindowsAutostart(scriptPath, process.execPath);
      push(`Autostart configured (${AUTOSTART_TASK_NAME}).`);
      push(`Control plane URL: ${getControlPlaneUrl()}`);
    });
  }

  async removeAutostart() {
    return this.runJob("removeAutostart", async push => {
      if (process.platform !== "win32") {
        throw new Error("Autostart removal is currently supported on Windows only.");
      }
      try {
        await removeWindowsAutostart();
        push(`Autostart removed (${AUTOSTART_TASK_NAME}).`);
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes("cannot find the file specified") || msg.includes("ERROR: The system cannot find")) {
          push(`Autostart task not found (${AUTOSTART_TASK_NAME}).`);
          return;
        }
        throw err;
      }
    });
  }

  async getAutostartStatus() {
    const url = getControlPlaneUrl();
    const running = await isControlPlaneRunning(url);
    if (process.platform !== "win32") {
      return {
        platform: process.platform,
        running,
        controlPlaneUrl: url,
        supported: false,
        installed: false
      };
    }
    const task = await getWindowsAutostartStatus();
    return {
      platform: process.platform,
      running,
      controlPlaneUrl: url,
      supported: true,
      installed: task.installed,
      state: task.state
    };
  }

  private async runJob(kind: keyof RuntimeState, fn: (push: (line: string) => void) => Promise<void>) {
    const current = this.state[kind];
    if (current.status === "running") {
      return current;
    }

    const job = makeJob(kind);
    job.status = "running";
    job.startedAt = new Date().toISOString();
    this.state[kind] = job;

    const push = (line: string) => {
      job.output.push(line);
      if (job.output.length > 300) {
        job.output.splice(0, job.output.length - 300);
      }
    };

    try {
      await fn(push);
      job.status = "success";
    } catch (err: any) {
      job.status = "failed";
      job.error = err?.message || String(err);
      push(`ERROR: ${job.error}`);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
    return job;
  }

  private runCommand(command: string, args: string[], cwd: string, push: (line: string) => void) {
    return new Promise<void>((resolve, reject) => {
      push(`$ ${command} ${args.join(" ")}`);
      const child = spawn(command, args, {
        cwd,
        shell: process.platform === "win32"
      });

      child.stdout.on("data", chunk => push(String(chunk).trimEnd()));
      child.stderr.on("data", chunk => push(String(chunk).trimEnd()));
      child.on("error", reject);
      child.on("exit", code => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}`));
        }
      });
    });
  }

  private async runNpm(args: string[], cwd: string, push: (line: string) => void) {
    const npm = await resolveNpmLaunch();
    if (npm.mode === "node-cli") {
      await this.runCommand(process.execPath, [npm.path, ...args], cwd, push);
      return;
    }
    await this.runCommand(npm.path, args, cwd, push);
  }

  private async getGitRemoteUrl(cwd: string, push: (line: string) => void) {
    try {
      const value = await this.runCommandCapture("git", ["remote", "get-url", "origin"], cwd, push);
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  private runCommandCapture(command: string, args: string[], cwd: string, push: (line: string) => void) {
    return new Promise<string>((resolve, reject) => {
      push(`$ ${command} ${args.join(" ")}`);
      const child = spawn(command, args, {
        cwd,
        shell: process.platform === "win32"
      });
      const lines: string[] = [];

      child.stdout.on("data", chunk => {
        const line = String(chunk).trimEnd();
        if (!line) return;
        lines.push(line);
        push(line);
      });
      child.stderr.on("data", chunk => push(String(chunk).trimEnd()));
      child.on("error", reject);
      child.on("exit", code => {
        if (code === 0) {
          resolve(lines.join("\n").trim());
        } else {
          reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}`));
        }
      });
    });
  }

  private async detectExecutionMode(push: (line: string) => void) {
    const gitDir = path.join(this.rootDir, ".git");
    if (await pathExists(gitDir)) {
      return "git-checkout" as const;
    }
    push("No git checkout found. Falling back to npm-based package management.");
    return "package-install" as const;
  }

  private async buildIfPresent(push: (line: string) => void) {
    const tsconfigPath = path.join(this.rootDir, "tsconfig.json");
    if (!await pathExists(tsconfigPath)) {
      push("Skipping build: tsconfig.json not found.");
      return;
    }
    await this.runNpm(["run", "build"], this.rootDir, push);
  }

  private async getGitCurrentBranch(cwd: string, push: (line: string) => void) {
    try {
      const name = await this.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd, push);
      const branch = name.trim();
      if (!branch || branch === "HEAD") {
        return undefined;
      }
      return branch;
    } catch {
      return undefined;
    }
  }

  private async runGlobalPackageUpdate(push: (line: string) => void, action: "install" | "update") {
    if (process.platform === "win32" && this.isLikelyGlobalInstall()) {
      await this.scheduleWindowsSelfUpdate(push, action);
      return;
    }

    push(`Running global ${action} for ${PACKAGE_NAME}@latest`);
    await this.runNpm(["install", "-g", `${PACKAGE_NAME}@latest`], this.rootDir, push);
  }

  private isLikelyGlobalInstall() {
    const normalizedRoot = path.normalize(this.rootDir).toLowerCase();
    const marker = `${path.sep}node_modules${path.sep}${PACKAGE_NAME}`.toLowerCase();
    return normalizedRoot.includes(marker);
  }

  private async scheduleWindowsSelfUpdate(push: (line: string) => void, action: "install" | "update") {
    const controlPlaneScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
    const jobId = `${Date.now()}-${process.pid}`;
    const logPath = path.join(os.tmpdir(), `${PACKAGE_NAME}-${action}-${jobId}.log`);
    const scriptPath = path.join(os.tmpdir(), `${PACKAGE_NAME}-${action}-${jobId}.cmd`);
    const npmCmdPath = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npm.cmd" : "npm");
    const npmCommand = await pathExists(npmCmdPath) ? `"${npmCmdPath}"` : "npm.cmd";
    const installCommand = `${npmCommand} install -g ${PACKAGE_NAME}@latest`;

    const script = [
      "@echo off",
      "setlocal",
      `set \"LOG_PATH=${logPath}\"`,
      `echo [${new Date().toISOString()}] Scheduled ${action}>>\"%LOG_PATH%\"`,
      "timeout /t 2 /nobreak >nul",
      `taskkill /PID ${process.pid} /F >nul 2>nul`,
      `${installCommand} >>\"%LOG_PATH%\" 2>&1`,
      "if errorlevel 1 goto :end",
      `start \"\" \"${process.execPath}\" \"${controlPlaneScript}\" serve`,
      ":end",
      `echo [${new Date().toISOString()}] Finished ${action}>>\"%LOG_PATH%\"`,
      "del \"%~f0\" >nul 2>nul"
    ].join("\r\n");

    await fs.writeFile(scriptPath, script, "utf8");
    spawn("cmd.exe", ["/d", "/s", "/c", scriptPath], {
      detached: true,
      stdio: "ignore"
    }).unref();

    push(`Scheduled self-${action} in background to avoid Windows file-lock errors.`);
    push("Control plane will stop briefly, then restart automatically.");
    push(`Background update log: ${logPath}`);
  }
}

function makeJob(id: string): RuntimeJob {
  return {
    id,
    status: "idle",
    output: []
  };
}

async function resolveNpmLaunch(): Promise<{ mode: "node-cli" | "command"; path: string }> {
  if (process.env.npm_execpath && await pathExists(process.env.npm_execpath)) {
    return { mode: "node-cli", path: process.env.npm_execpath };
  }
  const guessed = path.resolve(process.execPath, "..", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (await pathExists(guessed)) return { mode: "node-cli", path: guessed };
  return { mode: "command", path: process.platform === "win32" ? "npm.cmd" : "npm" };
}

function sanitizeRepoUrl(value?: string) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function sanitizeBranch(value?: string) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

async function safeRename(from: string, to: string) {
  try {
    await fs.rename(from, to);
  } catch {
    // best-effort rollback
  }
}

const DEFAULT_SKILLS_REPO = "https://github.com/ashishthomas2202/mcp-for-i-skills.git";
const PACKAGE_NAME = "mcp-for-i";

async function pathExists(target: string) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
