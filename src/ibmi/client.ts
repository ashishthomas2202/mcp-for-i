import { NodeSSH } from "node-ssh";
import fs from "fs/promises";
import path from "path";
import { Tools } from "./Tools.js";
import { IBMiContent } from "./IBMiContent.js";
import { CommandData, CommandResult, ConnectionConfig, ConnectionData } from "./types.js";

const LOCALE = "LC_ALL=EN_US.UTF-8";

export class IBMiClient {
  client?: NodeSSH;
  content: IBMiContent;
  remoteFeatures: Record<string, string | undefined> = {};

  currentHost = "";
  currentPort = 22;
  currentUser = "";
  currentConnectionName = "";

  private config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    this.config = config;
    this.content = new IBMiContent(this);
  }

  getConfig() {
    return this.config;
  }

  setConfig(config: ConnectionConfig) {
    this.config = config;
  }

  getTempRemote(prefix = "mcpfori") {
    const tempDir = this.config.tempDir || "/tmp";
    const name = `${prefix}_${Tools.makeid(8)}`;
    return path.posix.join(tempDir, name);
  }

  upperCaseName(value: string) {
    return Tools.upperCaseName(value);
  }

  async connect(connection: ConnectionData): Promise<void> {
    this.currentHost = connection.host;
    this.currentPort = connection.port;
    this.currentUser = connection.username;
    this.currentConnectionName = connection.name;

    this.client = new NodeSSH();
    await this.client.connect({
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
      privateKey: connection.privateKeyPath ? await fs.readFile(connection.privateKeyPath, "utf8") : undefined,
      keepaliveInterval: connection.keepaliveInterval,
      readyTimeout: connection.readyTimeout,
      debug: connection.sshDebug ? (msg: string) => process.stderr.write(`[ssh] ${msg}\n`) : undefined
    });

    await this.detectRemoteFeatures();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.dispose();
      this.client = undefined;
    }
  }

  static escapeForShell(command: string) {
    return command.replace(/\$/g, `\\$`);
  }

  async sendQsh(options: CommandData): Promise<CommandResult> {
    const stdin = options.command;
    return this.sendCommand({
      ...options,
      command: `${LOCALE} /QOpenSys/usr/bin/qsh`,
      stdin
    });
  }

  async sendCommand(options: CommandData): Promise<CommandResult> {
    if (!this.client) throw new Error("Not connected");
    let commands: string[] = [];

    if (options.env) {
      commands.push(...Object.entries(options.env).map(([key, value]) => `export ${key}="${value ? IBMiClient.escapeForShell(value) : ``}"`));
    }

    commands.push(options.command);
    const command = commands.join(" && ");
    const directory = options.directory || this.config.homeDirectory || ".";

    const result = await this.client.execCommand(command, {
      cwd: directory,
      stdin: options.stdin,
      onStdout: options.onStdout,
      onStderr: options.onStderr
    });

    if (result.code === null) result.code = 0;
    if (result.signal === "SIGABRT") result.code = 127;

    return {
      code: result.code ?? 0,
      signal: result.signal,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      command
    };
  }

  async runSQL(statements: string): Promise<Tools.DB2Row[]> {
    const input = Tools.fixSQL(statements, true);
    const command = `${LOCALE} system "call QSYS/QZDFMDB2 PARM('-d' '-i' '-t')"`;

    const output = await this.sendCommand({ command, stdin: input });
    if (output.stderr && output.stderr.trim()) {
      // QZDFMDB2 tends to emit errors in stdout, but keep stderr for debugging
    }

    if (output.stdout) {
      return Tools.db2Parse(output.stdout, input);
    }
    return [];
  }

  private async detectRemoteFeatures() {
    const featurePaths: Record<string, string[]> = {
      grep: ["/QOpenSys/pkgs/bin/grep", "/usr/bin/grep"],
      pfgrep: ["/QOpenSys/pkgs/bin/pfgrep"],
      find: ["/QOpenSys/pkgs/bin/find", "/usr/bin/find"],
      tar: ["/QOpenSys/pkgs/bin/tar", "/usr/bin/tar"],
      attr: ["/QOpenSys/pkgs/bin/attr"],
      iconv: ["/usr/bin/iconv", "/QOpenSys/pkgs/bin/iconv"],
      setccsid: ["/QOpenSys/pkgs/bin/setccsid"],
      stat: ["/QOpenSys/pkgs/bin/stat", "/usr/bin/stat"],
      ls: ["/QOpenSys/pkgs/bin/ls", "/usr/bin/ls"]
    };

    for (const [name, paths] of Object.entries(featurePaths)) {
      for (const p of paths) {
        const res = await this.sendCommand({ command: `test -x ${p} && echo ${p}` });
        if (res.stdout.trim()) {
          this.remoteFeatures[name] = p;
          break;
        }
      }
    }

    // QZDFMDB2.PGM is in QSYS/QZDFMDB2 by default; treat as present
    this.remoteFeatures["QZDFMDB2.PGM"] = "/QSYS.LIB/QZDFMDB2.PGM";
  }
}
