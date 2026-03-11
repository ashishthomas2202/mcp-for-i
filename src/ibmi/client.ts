import { NodeSSH } from "node-ssh";
import fs from "fs/promises";
import path from "path";
import { Tools } from "./Tools.js";
import { IBMiContent } from "./IBMiContent.js";
import { CommandData, CommandResult, ConnectionConfig, ConnectionData } from "./types.js";

const LOCALE = "LC_ALL=EN_US.UTF-8";
const SQL_HEREDOC_TAG = "__MCP_FOR_I_SQL__";

export class IBMiClient {
  client?: NodeSSH;
  content: IBMiContent;
  remoteFeatures: Record<string, string | undefined> = {};
  defaultUserLibraries: string[] = [];

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

  validQsysName(name: string): boolean {
    if (!name) return false;
    if (name.length > 10) return false;
    const upper = this.upperCaseName(name);
    return /^[A-Z][A-Z0-9_.]{0,9}$/.test(upper);
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
    await this.loadDefaultLibraryList();
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
      commands.push(...Object.entries(options.env).map(([key, value]) => {
        if (!(/^[A-Za-z_]\w*$/).test(key)) {
          throw new Error(`Invalid environment variable name: ${key}`);
        }
        return `export ${key}=${Tools.shellQuote(value || "")}`;
      }));
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
    const input = Tools.fixSQL(statements, true).trim();
    if (!input) return [];
    const ccsid = this.config.sqlJobCcsid ?? 1208;
    const command = [
      `system "CHGJOB CCSID(${ccsid})"`,
      `cat <<'${SQL_HEREDOC_TAG}' | system "call QSYS/QZDFMDB2 PARM('-d' '-i' '-t')"`,
      input,
      SQL_HEREDOC_TAG
    ].join("\n");

    const output = await this.sendQsh({
      command,
      env: { QIBM_PASE_CCSID: String(ccsid) }
    });

    if (output.stdout && output.stdout.trim()) {
      return Tools.db2Parse(output.stdout, input);
    }

    if (hasSqlError(output.stderr || "")) {
      throw new Tools.SqlError(normalizeSqlError(output.stderr || ""));
    }

    return [];
  }

  private async loadDefaultLibraryList() {
    let currentLibrary = "QGPL";
    this.defaultUserLibraries = [];
    const userLibraries: string[] = [];

    try {
      const liblResult = await this.sendQsh({ command: `liblist` });
      if (liblResult.code === 0) {
        const lines = (liblResult.stdout || "").split(`\n`);
        for (const line of lines) {
          if (!line.trim()) continue;
          const lib = line.substring(0, 10).trim();
          const type = line.substring(12).trim();
          switch (type) {
            case `USR`:
              if (lib) {
                userLibraries.push(lib);
                // QSYS cannot be removed from the library list
                if (lib !== `QSYS`) this.defaultUserLibraries.push(lib);
              }
              break;
            case `CUR`:
              if (lib) currentLibrary = lib;
              break;
          }
        }
      }
    } catch {
      // ignore, leave defaults
    }

    this.defaultUserLibraries = this.defaultUserLibraries.filter(Tools.distinct);
    if (!this.config.currentLibrary) {
      this.config.currentLibrary = currentLibrary;
    }
    if (!this.config.libraryList || this.config.libraryList.length === 0) {
      this.config.libraryList = this.defaultUserLibraries.length > 0 ? [...this.defaultUserLibraries] : userLibraries.filter(Tools.distinct);
    }

    await this.validateConfiguredLibraryList();
  }

  private async validateConfiguredLibraryList() {
    const libs = (this.config.libraryList || []).map(l => this.upperCaseName(l));
    if (libs.length === 0) return;

    const defaultLibs = Tools.sanitizeObjNamesForPase(this.defaultUserLibraries);
    const sanitized = Tools.sanitizeObjNamesForPase(libs);
    const commands = [
      `liblist -d ${IBMiClient.escapeForShell(defaultLibs.join(` `))}`,
      ...sanitized.map(lib => `liblist -a ${IBMiClient.escapeForShell(lib)}`)
    ].join(`; `);

    const result = await this.sendQsh({ command: commands });
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n");
    if (output) {
      const bad = libs.filter(lib => {
        const re = new RegExp(`\\b${lib}\\b`, `i`);
        return re.test(output);
      });
      if (bad.length > 0) {
        this.config.libraryList = libs.filter(lib => !bad.includes(lib));
      }
    }
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

function hasSqlError(stderr: string) {
  return /(SQL\d{4}|SQLSTATE|CLI ERROR)/i.test(stderr);
}

function normalizeSqlError(stderr: string) {
  return stderr
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.includes("Object is EN_US.UTF-8"))
    .join(" ");
}
