import { EventEmitter } from "events";
import net from "net";
import tls from "tls";
import { AID, FLAG_ATN, FLAG_SRQ, OP_NO_OP, buildGdsRecord, parseGdsRecord } from "./datastream.js";
import { Screen } from "./screen.js";
import {
  DO,
  DONT,
  ENV_SEND,
  EnvValue,
  OPT_BINARY,
  OPT_EOR,
  OPT_NEW_ENVIRON,
  OPT_TERMINAL_TYPE,
  TT_SEND,
  TelnetEvent,
  TelnetParser,
  WILL,
  WONT,
  envIs,
  frameRecord,
  parseEnvSend,
  telnetCommand,
  terminalTypeIs
} from "./telnet.js";

export type TerminalType = "IBM-3179-2" | "IBM-3477-FC";

export type CertificateCheck = (info: { host: string; port: number; certificate: Buffer; authorized: boolean; authorizationError?: string }) => Promise<unknown>;

export type Tn5250ClientOptions = {
  host: string;
  port: number;
  tls?: boolean;
  terminalType?: TerminalType;
  /** Requested virtual device name (DEVNAME). */
  deviceName?: string;
  /** RFC 4777 auto sign-on credentials, offered in NEW-ENVIRON. */
  autoSignOn?: { user: string; password: string };
  ccsid?: number;
  connectTimeoutMs?: number;
  /** Called for TLS connections before any data is exchanged; throw to refuse. */
  checkCertificate?: CertificateCheck;
};

const AID_ALIASES: Record<string, number> = {
  ENTER: AID.ENTER,
  RETURN: AID.ENTER,
  HELP: AID.HELP,
  PAGEUP: AID.ROLLDOWN,
  ROLLDOWN: AID.ROLLDOWN,
  PGUP: AID.ROLLDOWN,
  PAGEDOWN: AID.ROLLUP,
  ROLLUP: AID.ROLLUP,
  PGDN: AID.ROLLUP,
  PRINT: AID.PRINT,
  CLEAR: AID.CLEAR,
  RECORDBACKSPACE: AID.RECORD_BACKSPACE
};

/** AID byte for a key name, or undefined when it is not an AID key. */
export function aidForKey(name: string): number | undefined {
  const key = name.toUpperCase().replace(/[\s_-]/g, "");
  if (key in AID_ALIASES) return AID_ALIASES[key];
  const f = /^F([1-9]|1[0-9]|2[0-4])$/.exec(key);
  if (f) return (AID as Record<string, number>)[`F${f[1]}`];
  return undefined;
}

const SUPPORTED_DO = new Set([OPT_BINARY, OPT_TERMINAL_TYPE, OPT_EOR, OPT_NEW_ENVIRON]);
const SUPPORTED_WILL = new Set([OPT_BINARY, OPT_EOR]);

export class Tn5250Client extends EventEmitter {
  readonly screen: Screen;
  closed = false;
  closeReason?: string;
  secure = false;
  certificateStatus?: unknown;
  autoSignOnOffered = false;
  readonly negotiated = { binary: false, eor: false, terminalType: false, newEnviron: false };
  private socket?: net.Socket;
  private parser = new TelnetParser();
  private willSent = new Set<number>();
  private doSent = new Set<number>();
  private lastUpdateAt = 0;

  constructor(readonly options: Tn5250ClientOptions) {
    super();
    this.setMaxListeners(50);
    const terminalType = options.terminalType || "IBM-3179-2";
    this.screen = new Screen({ ccsid: options.ccsid, deviceType: terminalType === "IBM-3477-FC" ? "3477" : "3179" });
  }

  get terminalType(): TerminalType {
    return this.options.terminalType || "IBM-3179-2";
  }

  /** Open the connection. Resolves once TCP (and TLS, if used) is established and trusted. */
  connect(): Promise<void> {
    const { host, port } = this.options;
    const timeoutMs = this.options.connectTimeoutMs ?? 15000;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.markClosed(err.message);
        socket.destroy();
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error(`TN5250 connection to ${host}:${port} timed out after ${timeoutMs} ms`)), timeoutMs);
      const ready = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      let socket: net.Socket;
      if (this.options.tls) {
        const tlsSocket = tls.connect({
          host,
          port,
          servername: net.isIP(host) ? undefined : host,
          // Verification is done below so self-signed IBM i certificates can be pinned.
          rejectUnauthorized: false
        });
        socket = tlsSocket;
        tlsSocket.once("secureConnect", async () => {
          try {
            const cert = tlsSocket.getPeerCertificate(false);
            if (!cert || !cert.raw) throw new Error("TLS server did not present a certificate");
            this.certificateStatus = await (this.options.checkCertificate
              ? this.options.checkCertificate({
                host,
                port,
                certificate: cert.raw,
                authorized: tlsSocket.authorized,
                authorizationError: tlsSocket.authorizationError ? String(tlsSocket.authorizationError) : undefined
              })
              : Promise.reject(new Error("No TLS certificate check configured")));
            this.secure = true;
            this.attach(socket);
            ready();
          } catch (err: any) {
            fail(err instanceof Error ? err : new Error(String(err)));
          }
        });
      } else {
        socket = net.connect({ host, port });
        socket.once("connect", () => {
          this.attach(socket);
          ready();
        });
      }
      socket.on("error", err => {
        if (!settled) fail(err);
        else this.markClosed(err.message);
      });
      socket.on("close", () => this.markClosed(this.closeReason || "connection closed by host"));
      this.socket = socket;
    });
  }

  private attach(socket: net.Socket) {
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer | string) => this.onData(typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk));
  }

  private markClosed(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.emit("update");
    this.emit("close", reason);
  }

  close() {
    this.markClosed("disconnected");
    this.socket?.destroy();
  }

  private write(bytes: Buffer) {
    if (this.closed || !this.socket) throw new Error(`TN5250 session is closed (${this.closeReason || "not connected"})`);
    this.socket.write(bytes);
  }

  /** Feed raw bytes (used by the socket handler and by tests). */
  onData(chunk: Uint8Array) {
    let events: TelnetEvent[];
    try {
      events = this.parser.push(chunk);
    } catch (err: any) {
      this.screen.warnings.push(`telnet parse error: ${err?.message || err}`);
      return;
    }
    for (const event of events) {
      if (event.type === "command") this.onCommand(event.command, event.option);
      else if (event.type === "subnegotiation") this.onSubnegotiation(event.option, event.data);
      else this.onRecord(event.data);
    }
  }

  private onCommand(command: number, option: number) {
    if (command === DO) {
      if (SUPPORTED_DO.has(option)) {
        if (!this.willSent.has(option)) {
          this.willSent.add(option);
          this.write(telnetCommand(WILL, option));
        }
        if (option === OPT_BINARY) this.negotiated.binary = true;
        if (option === OPT_EOR) this.negotiated.eor = true;
      } else {
        this.write(telnetCommand(WONT, option));
      }
    } else if (command === WILL) {
      if (SUPPORTED_WILL.has(option)) {
        if (!this.doSent.has(option)) {
          this.doSent.add(option);
          this.write(telnetCommand(DO, option));
        }
      } else {
        this.write(telnetCommand(DONT, option));
      }
    } else if (command === DONT) {
      if (this.willSent.delete(option)) this.write(telnetCommand(WONT, option));
    }
  }

  private onSubnegotiation(option: number, data: Buffer) {
    if (option === OPT_TERMINAL_TYPE && data[0] === TT_SEND) {
      this.negotiated.terminalType = true;
      this.write(terminalTypeIs(this.terminalType));
    } else if (option === OPT_NEW_ENVIRON && data[0] === ENV_SEND) {
      this.negotiated.newEnviron = true;
      parseEnvSend(data.subarray(1));
      this.write(envIs(this.environment()));
    }
  }

  /** NEW-ENVIRON values sent to the server. */
  environment(): EnvValue[] {
    const ascii = (text: string) => Buffer.from(text, "ascii");
    const values: EnvValue[] = [];
    if (this.options.deviceName) values.push({ kind: "uservar", name: "DEVNAME", value: ascii(this.options.deviceName) });
    values.push({ kind: "uservar", name: "KBDTYPE", value: ascii("USB") });
    values.push({ kind: "uservar", name: "CODEPAGE", value: ascii("37") });
    values.push({ kind: "uservar", name: "CHARSET", value: ascii("697") });
    const signOn = this.options.autoSignOn;
    if (signOn) {
      // RFC 4777: an empty IBMRSEED means IBMSUBSPW carries the password unencrypted.
      values.push({ kind: "var", name: "USER", value: ascii(signOn.user) });
      values.push({ kind: "uservar", name: "IBMRSEED", value: Buffer.alloc(0) });
      values.push({ kind: "uservar", name: "IBMSUBSPW", value: ascii(signOn.password) });
      this.autoSignOnOffered = true;
    }
    return values;
  }

  private onRecord(record: Buffer) {
    try {
      const responses = this.screen.process(parseGdsRecord(record));
      for (const response of responses) this.write(frameRecord(response));
    } catch (err: any) {
      this.screen.warnings.push(err?.message || String(err));
    }
    this.lastUpdateAt = Date.now();
    this.emit("update");
  }

  /** Send an AID key (Enter, F1-F24, PageUp, ...) or Attn / SysReq. */
  sendKey(name: string) {
    const key = name.toUpperCase().replace(/[\s_-]/g, "");
    if (key === "ATTN") {
      this.write(frameRecord(buildGdsRecord(OP_NO_OP, new Uint8Array(0), FLAG_ATN)));
      this.screen.keyboardLocked = true;
      return;
    }
    if (key === "SYSREQ") {
      this.write(frameRecord(buildGdsRecord(OP_NO_OP, new Uint8Array(0), FLAG_SRQ)));
      this.screen.keyboardLocked = true;
      return;
    }
    const aid = aidForKey(key);
    if (aid === undefined) throw new Error(`Unknown AID key: ${name}`);
    this.lastUpdateAt = Date.now();
    this.write(frameRecord(this.screen.buildAidResponse(aid)));
  }

  /** True once the host has handed control back to the operator. */
  isReady() {
    return !this.screen.keyboardLocked || this.screen.inputInhibited;
  }

  /**
   * Wait until the predicate holds. Re-checks on every screen update.
   * Resolves false on timeout or when the connection closes first.
   */
  waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    if (predicate()) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    return new Promise(resolve => {
      const done = (value: boolean) => {
        clearTimeout(timer);
        this.off("update", check);
        resolve(value);
      };
      const check = () => {
        if (predicate()) done(true);
        else if (this.closed) done(false);
      };
      const timer = setTimeout(() => done(predicate()), timeoutMs);
      this.on("update", check);
    });
  }

  /** Wait for the keyboard to unlock, then for a short quiet period with no more records. */
  async waitForSettled(timeoutMs: number, quietMs = 150): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return this.isReady();
      const ready = await this.waitFor(() => this.isReady(), remaining);
      if (!ready) return false;
      const sinceUpdate = Date.now() - this.lastUpdateAt;
      if (sinceUpdate >= quietMs) return true;
      await new Promise(resolve => setTimeout(resolve, Math.min(quietMs - sinceUpdate, Math.max(0, deadline - Date.now()))));
      if (Date.now() - this.lastUpdateAt >= quietMs && this.isReady()) return true;
    }
  }
}
