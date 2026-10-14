/**
 * Telnet layer for TN5250 (RFC 854, RFC 1205, RFC 2877, RFC 4777).
 *
 * TelnetParser turns raw socket bytes into negotiation events and complete
 * 5250 records (data between IAC EOR markers, with IAC IAC unescaped).
 */

export const IAC = 255;
export const DONT = 254;
export const DO = 253;
export const WONT = 252;
export const WILL = 251;
export const SB = 250;
export const SE = 240;
export const EOR = 239;

export const OPT_BINARY = 0;
export const OPT_TERMINAL_TYPE = 24;
export const OPT_EOR = 25;
export const OPT_NEW_ENVIRON = 39;

// Subnegotiation codes
export const TT_IS = 0;
export const TT_SEND = 1;
export const ENV_IS = 0;
export const ENV_SEND = 1;
export const ENV_INFO = 2;
export const ENV_VAR = 0;
export const ENV_VALUE = 1;
export const ENV_ESC = 2;
export const ENV_USERVAR = 3;

export type TelnetEvent =
  | { type: "command"; command: number; option: number }
  | { type: "subnegotiation"; option: number; data: Buffer }
  | { type: "record"; data: Buffer };

export class TelnetParser {
  private state: "data" | "iac" | "option" | "sb" | "sb-iac" = "data";
  private command = 0;
  private record: number[] = [];
  private sb: number[] = [];

  /** Feed socket bytes; returns the events completed by this chunk. */
  push(chunk: Uint8Array): TelnetEvent[] {
    const events: TelnetEvent[] = [];
    for (const byte of chunk) {
      switch (this.state) {
        case "data":
          if (byte === IAC) this.state = "iac";
          else this.record.push(byte);
          break;
        case "iac":
          if (byte === IAC) {
            this.record.push(IAC);
            this.state = "data";
          } else if (byte === EOR) {
            events.push({ type: "record", data: Buffer.from(this.record) });
            this.record = [];
            this.state = "data";
          } else if (byte === DO || byte === DONT || byte === WILL || byte === WONT) {
            this.command = byte;
            this.state = "option";
          } else if (byte === SB) {
            this.sb = [];
            this.state = "sb";
          } else {
            // NOP, GA and other two-byte commands carry nothing we need.
            this.state = "data";
          }
          break;
        case "option":
          events.push({ type: "command", command: this.command, option: byte });
          this.state = "data";
          break;
        case "sb":
          if (byte === IAC) this.state = "sb-iac";
          else this.sb.push(byte);
          break;
        case "sb-iac":
          if (byte === SE) {
            const [option, ...rest] = this.sb;
            events.push({ type: "subnegotiation", option: option ?? -1, data: Buffer.from(rest) });
            this.sb = [];
            this.state = "data";
          } else {
            // IAC IAC inside a subnegotiation is a literal 0xFF.
            this.sb.push(byte);
            this.state = "sb";
          }
          break;
      }
    }
    return events;
  }
}

export function telnetCommand(command: number, option: number) {
  return Buffer.from([IAC, command, option]);
}

/** Wrap a 5250 record for sending: double IAC bytes and append IAC EOR. */
export function frameRecord(record: Uint8Array) {
  const out: number[] = [];
  for (const byte of record) {
    out.push(byte);
    if (byte === IAC) out.push(IAC);
  }
  out.push(IAC, EOR);
  return Buffer.from(out);
}

export function subnegotiation(option: number, payload: Uint8Array) {
  const out: number[] = [IAC, SB, option];
  for (const byte of payload) {
    out.push(byte);
    if (byte === IAC) out.push(IAC);
  }
  out.push(IAC, SE);
  return Buffer.from(out);
}

export function terminalTypeIs(terminalType: string) {
  return subnegotiation(OPT_TERMINAL_TYPE, Buffer.concat([Buffer.from([TT_IS]), Buffer.from(terminalType, "ascii")]));
}

export type EnvRequest = { kind: "var" | "uservar"; name: string };

/** Parse the body of a NEW-ENVIRON SEND (after the SEND byte). */
export function parseEnvSend(data: Buffer): { requested: EnvRequest[]; serverSeed?: Buffer } {
  const requested: EnvRequest[] = [];
  let serverSeed: Buffer | undefined;
  let i = 0;
  while (i < data.length) {
    const kindByte = data[i];
    if (kindByte !== ENV_VAR && kindByte !== ENV_USERVAR) {
      i += 1;
      continue;
    }
    i += 1;
    // RFC 4777: the server's seed follows the IBMRSEED name directly
    // (optionally after VALUE) and is 8 raw bytes.
    if (data.subarray(i, i + 8).toString("ascii") === "IBMRSEED") {
      i += 8;
      if (data[i] === ENV_VALUE) i += 1;
      const seed = data.subarray(i, Math.min(i + 8, data.length));
      if (seed.length > 0) serverSeed = Buffer.from(seed);
      i += seed.length;
      requested.push({ kind: kindByte === ENV_VAR ? "var" : "uservar", name: "IBMRSEED" });
      continue;
    }
    const name: number[] = [];
    let inValue = false;
    while (i < data.length && data[i] !== ENV_VAR && data[i] !== ENV_USERVAR) {
      if (data[i] === ENV_VALUE) {
        inValue = true;
        i += 1;
        continue;
      }
      if (data[i] === ENV_ESC && i + 1 < data.length) i += 1;
      if (!inValue) name.push(data[i]);
      i += 1;
    }
    // An empty name means "send all variables of this kind".
    requested.push({ kind: kindByte === ENV_VAR ? "var" : "uservar", name: Buffer.from(name).toString("ascii") });
  }
  return { requested, serverSeed };
}

export type EnvValue = { kind: "var" | "uservar"; name: string; value: Uint8Array };

function escapeEnv(bytes: Uint8Array) {
  const out: number[] = [];
  for (const byte of bytes) {
    if (byte === ENV_VAR || byte === ENV_VALUE || byte === ENV_ESC || byte === ENV_USERVAR) out.push(ENV_ESC);
    out.push(byte);
  }
  return out;
}

/** Build IAC SB NEW-ENVIRON IS ... IAC SE. */
export function envIs(values: EnvValue[]) {
  const out: number[] = [ENV_IS];
  for (const entry of values) {
    out.push(entry.kind === "var" ? ENV_VAR : ENV_USERVAR);
    out.push(...escapeEnv(Buffer.from(entry.name, "ascii")));
    out.push(ENV_VALUE);
    out.push(...escapeEnv(entry.value));
  }
  return subnegotiation(OPT_NEW_ENVIRON, Buffer.from(out));
}
