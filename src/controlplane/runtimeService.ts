import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";

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
};

export class RuntimeService {
  private readonly state: RuntimeState = {
    install: makeJob("install"),
    updateMcp: makeJob("updateMcp"),
    updateSkills: makeJob("updateSkills")
  };

  constructor(private readonly rootDir: string) {}

  getStatus() {
    return this.state;
  }

  async installOrRepair() {
    return this.runJob("install", async push => {
      await this.runNpm(["install"], this.rootDir, push);
      await this.runNpm(["run", "build"], this.rootDir, push);
    });
  }

  async updateMcp() {
    return this.runJob("updateMcp", async push => {
      await this.runCommand("git", ["pull", "--ff-only"], this.rootDir, push);
      await this.runNpm(["install"], this.rootDir, push);
      await this.runNpm(["run", "build"], this.rootDir, push);
    });
  }

  async updateSkills() {
    return this.runJob("updateSkills", async push => {
      const skillsDir = path.join(this.rootDir, "skills");
      const hasSkills = await pathExists(skillsDir);
      if (!hasSkills) {
        push("No skills directory found.");
        return;
      }

      const skillsGit = path.join(skillsDir, ".git");
      if (await pathExists(skillsGit)) {
        await this.runCommand("git", ["pull", "--ff-only"], skillsDir, push);
        return;
      }

      const rootGit = path.join(this.rootDir, ".git");
      if (await pathExists(rootGit)) {
        await this.runCommand("git", ["pull", "--ff-only"], this.rootDir, push);
        return;
      }

      throw new Error("Skills update requires a git repository.");
    });
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

async function pathExists(target: string) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
