import {
  AID,
  AID_WITHOUT_DATA,
  CMD_CLEAR_FORMAT_TABLE,
  CMD_CLEAR_UNIT,
  CMD_CLEAR_UNIT_ALTERNATE,
  CMD_READ_IMMEDIATE,
  CMD_READ_INPUT_FIELDS,
  CMD_READ_MDT_ALTERNATE,
  CMD_READ_MDT_FIELDS,
  CMD_READ_MDT_IMMEDIATE_ALTERNATE,
  CMD_READ_SCREEN_IMMEDIATE,
  CMD_RESTORE_PARTIAL_SCREEN,
  CMD_RESTORE_SCREEN,
  CMD_ROLL,
  CMD_SAVE_PARTIAL_SCREEN,
  CMD_SAVE_SCREEN,
  CMD_WRITE_ERROR_CODE,
  CMD_WRITE_ERROR_CODE_TO_WINDOW,
  CMD_WRITE_STRUCTURED_FIELD,
  CMD_WRITE_TO_DISPLAY,
  ESC,
  GdsRecord,
  OP_CANCEL_INVITE,
  OP_MESSAGE_LIGHT_OFF,
  OP_MESSAGE_LIGHT_ON,
  OP_NO_OP,
  OP_PUT_GET,
  OP_READ_IMMEDIATE,
  OP_READ_SCREEN,
  OP_SAVE_SCREEN,
  ORD_EA,
  ORD_IC,
  ORD_MC,
  ORD_RA,
  ORD_SBA,
  ORD_SF,
  ORD_SOH,
  ORD_TD,
  ORD_WDSF,
  ORD_WEA,
  buildGdsRecord
} from "./datastream.js";
import { ebcdicToChar, stringToEbcdic } from "./ebcdic.js";

/** An input field from the 5250 format table. Positions are 0-based buffer addresses. */
export class Tn5250Field {
  modified: boolean;

  constructor(
    /** Address of the first data position (the attribute byte sits just before it). */
    public start: number,
    public length: number,
    /** Field format word: first byte in the high 8 bits. */
    public ffw: number,
    public fcw: number[],
    public attr: number
  ) {
    this.modified = (ffw & 0x0800) !== 0;
  }

  /** Bypass (protected) input field: the operator cannot type into it. */
  get bypass() { return (this.ffw & 0x2000) !== 0; }
  /** Non-display attribute (password-style field). */
  get hidden() { return (this.attr & 0x07) === 0x07; }
  get shift() { return (this.ffw >> 8) & 0x07; }
  /** Numeric only, digits only or signed numeric. */
  get numeric() { return this.shift === 3 || this.shift === 5 || this.shift === 7; }
  get monocase() { return (this.ffw & 0x0020) !== 0; }
  get autoEnter() { return (this.ffw & 0x0080) !== 0; }
  get mandatoryEntry() { return (this.ffw & 0x0008) !== 0; }
  get rightAdjust(): "zero" | "blank" | undefined {
    const value = this.ffw & 0x07;
    return value === 5 ? "zero" : value === 6 ? "blank" : undefined;
  }
  get end() { return this.start + this.length - 1; }

  contains(address: number) {
    return address >= this.start && address <= this.end;
  }

  clone() {
    const copy = new Tn5250Field(this.start, this.length, this.ffw, [...this.fcw], this.attr);
    copy.modified = this.modified;
    return copy;
  }
}

export type FieldView = {
  id: string;
  index: number;
  row: number;
  col: number;
  length: number;
  label: string;
  protected: boolean;
  hidden: boolean;
  modified: boolean;
  numeric: boolean;
  commandLine: boolean;
  /** Field text with trailing blanks removed. Never present for hidden fields. */
  value?: string;
  /** For hidden fields only: whether anything has been entered. */
  hasValue?: boolean;
};

export type ScreenView = {
  rows: number;
  cols: number;
  cursor: { row: number; col: number };
  keyboardLocked: boolean;
  inputInhibited: boolean;
  messageWaiting: boolean;
  readPending: boolean;
  errorLine?: string;
  text: string[];
  fields: FieldView[];
  version: number;
};

type SavedState = {
  rows: number;
  cols: number;
  buffer: Uint8Array;
  attrMap: Uint8Array;
  fields: Tn5250Field[];
  cursor: number;
  errorRow: number;
  savedErrorLine?: { buffer: Uint8Array; attrMap: Uint8Array };
  inputInhibited: boolean;
};

export type ScreenOptions = {
  ccsid?: number;
  /** "3477" announces a 27x132-capable display in the query reply. */
  deviceType?: "3179" | "3477";
};

export class DataStreamError extends Error {}

const MAX_SAVED_SCREENS = 32;
const SAVE_TAG = "MCPS";

/**
 * In-memory 5250 display: the character buffer, attribute positions, the
 * format table (input fields), cursor and keyboard state. process() applies a
 * host record and returns any records the terminal must send back.
 */
export class Screen {
  rows = 24;
  cols = 80;
  buffer = new Uint8Array(24 * 80);
  attrMap = new Uint8Array(24 * 80);
  fields: Tn5250Field[] = [];
  cursor = 0;
  keyboardLocked = true;
  inputInhibited = false;
  messageWaiting = false;
  pendingRead: number | null = null;
  errorRow = 23;
  version = 0;
  warnings: string[] = [];
  readonly ccsid: number;
  readonly deviceType: "3179" | "3477";
  private addr = 0;
  private savedErrorLine?: { buffer: Uint8Array; attrMap: Uint8Array };
  private savedScreens = new Map<string, SavedState>();
  private nextSaveId = 1;

  constructor(options: ScreenOptions = {}) {
    this.ccsid = options.ccsid ?? 37;
    this.deviceType = options.deviceType ?? "3179";
  }

  get size() { return this.rows * this.cols; }

  // ---------------------------------------------------------------- host input

  /** Apply one host record. Returns outbound GDS records (already headed). */
  process(record: GdsRecord): Buffer[] {
    const responses: Buffer[] = [];
    switch (record.opcode) {
      case OP_CANCEL_INVITE:
        responses.push(buildGdsRecord(OP_CANCEL_INVITE));
        break;
      case OP_MESSAGE_LIGHT_ON:
        this.messageWaiting = true;
        break;
      case OP_MESSAGE_LIGHT_OFF:
        this.messageWaiting = false;
        break;
      case OP_SAVE_SCREEN:
        if (record.data.length === 0) responses.push(this.saveScreen());
        break;
      case OP_READ_SCREEN:
        if (record.data.length === 0) responses.push(this.readScreenResponse());
        break;
      case OP_READ_IMMEDIATE:
        if (record.data.length === 0) responses.push(this.readImmediateResponse());
        break;
    }
    try {
      this.processCommands(record.data, responses);
    } catch (err: any) {
      this.warn(`5250 data stream error: ${err?.message || err}`);
    }
    this.version += 1;
    return responses;
  }

  private processCommands(data: Buffer, responses: Buffer[]) {
    let i = 0;
    while (i < data.length) {
      if (data[i] !== ESC) {
        i += 1;
        continue;
      }
      const command = data[i + 1];
      i += 2;
      switch (command) {
        case CMD_CLEAR_UNIT:
          this.clearUnit(24, 80);
          break;
        case CMD_CLEAR_UNIT_ALTERNATE: {
          const param = data[i++];
          if (param === 0x00) this.clearUnit(27, 132);
          else this.clearUnit(this.rows, this.cols);
          break;
        }
        case CMD_CLEAR_FORMAT_TABLE:
          this.fields = [];
          this.keyboardLocked = true;
          break;
        case CMD_WRITE_TO_DISPLAY:
          i = this.writeToDisplay(data, i);
          break;
        case CMD_WRITE_ERROR_CODE:
          i = this.writeErrorCode(data, i);
          break;
        case CMD_WRITE_ERROR_CODE_TO_WINDOW:
          i = this.writeErrorCode(data, i + 2);
          break;
        case CMD_READ_INPUT_FIELDS:
        case CMD_READ_MDT_FIELDS:
        case CMD_READ_MDT_ALTERNATE: {
          const cc1 = data[i] ?? 0;
          const cc2 = data[i + 1] ?? 0;
          i += 2;
          this.applyCC1(cc1);
          this.pendingRead = command;
          // A read waits for the operator, so the keyboard opens for input.
          this.keyboardLocked = false;
          this.applyCC2(cc2);
          break;
        }
        case CMD_READ_IMMEDIATE:
        case CMD_READ_MDT_IMMEDIATE_ALTERNATE:
          responses.push(this.readImmediateResponse());
          break;
        case CMD_READ_SCREEN_IMMEDIATE:
          responses.push(this.readScreenResponse());
          break;
        case CMD_SAVE_SCREEN:
          responses.push(this.saveScreen());
          break;
        case CMD_SAVE_PARTIAL_SCREEN:
          // Parameters are not needed: the whole screen is saved.
          while (i < data.length && data[i] !== ESC) i += 1;
          responses.push(this.saveScreen());
          break;
        case CMD_RESTORE_SCREEN:
        case CMD_RESTORE_PARTIAL_SCREEN: {
          const startPayload = i;
          while (i < data.length && data[i] !== ESC) i += 1;
          this.restoreScreen(data.subarray(startPayload, i));
          break;
        }
        case CMD_ROLL:
          this.roll(data[i] ?? 0, data[i + 1] ?? 1, data[i + 2] ?? this.rows);
          i += 3;
          break;
        case CMD_WRITE_STRUCTURED_FIELD: {
          const length = data.length >= i + 2 ? data.readUInt16BE(i) : 0;
          if (length < 2) throw new DataStreamError("invalid structured field length");
          const body = data.subarray(i + 2, i + length);
          i += length;
          if (body[0] === 0xd9 && body[1] === 0x70) {
            responses.push(this.queryReply());
          } else {
            this.warn(`Unsupported 5250 structured field 0x${hex(body[0])}${hex(body[1])}`);
          }
          break;
        }
        default:
          throw new DataStreamError(`unsupported 5250 command 0x${hex(command)}`);
      }
    }
  }

  private clearUnit(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
    this.buffer = new Uint8Array(rows * cols);
    this.attrMap = new Uint8Array(rows * cols);
    this.fields = [];
    this.cursor = 0;
    this.addr = 0;
    this.errorRow = rows - 1;
    this.savedErrorLine = undefined;
    this.inputInhibited = false;
    this.keyboardLocked = true;
    this.pendingRead = null;
  }

  private applyCC1(cc1: number) {
    const action = cc1 & 0xe0;
    if (action === 0) return;
    this.keyboardLocked = true;
    const nonBypass = this.fields.filter(f => !f.bypass);
    switch (action) {
      case 0x40:
        nonBypass.forEach(f => { f.modified = false; });
        break;
      case 0x60:
        this.fields.forEach(f => { f.modified = false; });
        break;
      case 0x80:
        nonBypass.filter(f => f.modified).forEach(f => this.nullField(f));
        break;
      case 0xa0:
        nonBypass.filter(f => f.modified).forEach(f => this.nullField(f));
        nonBypass.forEach(f => { f.modified = false; });
        break;
      case 0xc0:
        nonBypass.forEach(f => { this.nullField(f); f.modified = false; });
        break;
      case 0xe0:
        nonBypass.forEach(f => this.nullField(f));
        this.fields.forEach(f => { f.modified = false; });
        break;
    }
  }

  private applyCC2(cc2: number) {
    if (cc2 & 0x08) this.keyboardLocked = false;
    if (cc2 & 0x02) this.messageWaiting = false;
    if (cc2 & 0x01) this.messageWaiting = true;
  }

  private writeToDisplay(data: Buffer, i: number) {
    const cc1 = data[i] ?? 0;
    const cc2 = data[i + 1] ?? 0;
    i += 2;
    this.applyCC1(cc1);
    const outcome = this.writeOrders(data, i, this.addr);
    this.addr = outcome.addr;
    if (!outcome.cursorSet && outcome.fieldsDefined) {
      const first = this.fields.find(f => !f.bypass);
      this.cursor = first ? first.start : 0;
    }
    this.applyCC2(cc2);
    return outcome.next;
  }

  private writeErrorCode(data: Buffer, i: number) {
    const rowStart = this.errorRow * this.cols;
    if (!this.savedErrorLine) {
      this.savedErrorLine = {
        buffer: this.buffer.slice(rowStart, rowStart + this.cols),
        attrMap: this.attrMap.slice(rowStart, rowStart + this.cols)
      };
    }
    const keepCursor = this.cursor;
    const outcome = this.writeOrders(data, i, rowStart);
    if (!outcome.cursorSet) this.cursor = keepCursor;
    this.inputInhibited = true;
    this.keyboardLocked = true;
    return outcome.next;
  }

  /** Process orders and data until the next command (ESC) or the end. */
  private writeOrders(data: Buffer, i: number, addr: number) {
    let cursorSet = false;
    let fieldsDefined = false;
    const size = this.size;
    const need = (count: number) => {
      if (i + count > data.length) throw new DataStreamError("truncated 5250 order");
    };
    while (i < data.length && data[i] !== ESC) {
      const byte = data[i++];
      switch (byte) {
        case ORD_SOH: {
          need(1);
          const length = data[i++];
          need(length);
          const header = data.subarray(i, i + length);
          i += length;
          // The error row is the 4th header byte; SOH also resets the format table.
          if (header.length >= 4 && header[3] >= 1 && header[3] <= this.rows) this.errorRow = header[3] - 1;
          this.fields = [];
          break;
        }
        case ORD_RA: {
          need(3);
          const target = this.address(data[i], data[i + 1]);
          const ch = data[i + 2];
          i += 3;
          if (target >= addr) {
            for (let p = addr; p <= target; p += 1) this.put(p, ch);
            addr = (target + 1) % size;
          }
          break;
        }
        case ORD_EA: {
          need(3);
          const target = this.address(data[i], data[i + 1]);
          const length = data[i + 2];
          i += 2 + Math.max(1, length);
          if (target >= addr) {
            for (let p = addr; p <= target; p += 1) this.put(p, 0x00);
            addr = (target + 1) % size;
          }
          break;
        }
        case ORD_TD: {
          need(2);
          const length = data.readUInt16BE(i);
          i += 2;
          need(length);
          for (let n = 0; n < length; n += 1) {
            this.buffer[addr] = data[i + n];
            this.attrMap[addr] = 0;
            addr = (addr + 1) % size;
          }
          i += length;
          break;
        }
        case ORD_SBA:
          need(2);
          addr = this.address(data[i], data[i + 1]);
          i += 2;
          break;
        case ORD_WEA:
          need(2);
          i += 2;
          break;
        case ORD_IC:
        case ORD_MC:
          need(2);
          this.cursor = this.address(data[i], data[i + 1]);
          cursorSet = true;
          i += 2;
          break;
        case ORD_WDSF: {
          need(2);
          const length = data.readUInt16BE(i);
          if (length < 2) throw new DataStreamError("invalid WDSF length");
          i += length;
          this.warn("Write To Display Structured Field (window or GUI construct) ignored");
          break;
        }
        case ORD_SF: {
          const parsed = this.startField(data, i, addr);
          i = parsed.next;
          addr = parsed.addr;
          if (parsed.input) fieldsDefined = true;
          break;
        }
        default:
          this.put(addr, byte);
          addr = (addr + 1) % size;
      }
    }
    return { next: i, addr, cursorSet, fieldsDefined };
  }

  private startField(data: Buffer, i: number, addr: number) {
    let ffw: number | undefined;
    const fcw: number[] = [];
    if (i < data.length && (data[i] & 0xc0) === 0x40) {
      if (i + 2 > data.length) throw new DataStreamError("truncated field format word");
      ffw = (data[i] << 8) | data[i + 1];
      i += 2;
      while (i < data.length && (data[i] & 0xc0) === 0x80) {
        if (i + 2 > data.length) throw new DataStreamError("truncated field control word");
        fcw.push((data[i] << 8) | data[i + 1]);
        i += 2;
      }
    }
    if (i + 3 > data.length) throw new DataStreamError("truncated start of field");
    const attr = data[i];
    const length = (data[i + 1] << 8) | data[i + 2];
    i += 3;
    this.buffer[addr] = attr;
    this.attrMap[addr] = 1;
    const start = (addr + 1) % this.size;
    if (ffw !== undefined && length > 0) {
      this.fields = this.fields.filter(f => f.start !== start);
      this.fields.push(new Tn5250Field(start, Math.min(length, this.size), ffw, fcw, attr));
      this.fields.sort((a, b) => a.start - b.start);
    }
    return { next: i, addr: start, input: ffw !== undefined };
  }

  private roll(control: number, top: number, bottom: number) {
    const lines = control & 0x1f;
    const down = (control & 0x80) !== 0;
    const first = Math.max(1, top) - 1;
    const last = Math.min(this.rows, bottom) - 1;
    if (lines === 0 || last < first) return;
    const rowBytes = (row: number) => [row * this.cols, (row + 1) * this.cols] as const;
    const copyRow = (from: number, to: number) => {
      const [fs, fe] = rowBytes(from);
      this.buffer.copyWithin(to * this.cols, fs, fe);
      this.attrMap.copyWithin(to * this.cols, fs, fe);
    };
    const clearRow = (row: number) => {
      const [s, e] = rowBytes(row);
      this.buffer.fill(0, s, e);
      this.attrMap.fill(0, s, e);
    };
    if (down) {
      for (let row = last; row >= first; row -= 1) {
        if (row - lines >= first) copyRow(row - lines, row);
        else clearRow(row);
      }
    } else {
      for (let row = first; row <= last; row += 1) {
        if (row + lines <= last) copyRow(row + lines, row);
        else clearRow(row);
      }
    }
  }

  private put(address: number, byte: number) {
    this.buffer[address] = byte;
    this.attrMap[address] = byte >= 0x20 && byte <= 0x3f ? 1 : 0;
  }

  private nullField(field: Tn5250Field) {
    for (let n = 0; n < field.length; n += 1) {
      const p = (field.start + n) % this.size;
      this.buffer[p] = 0;
      this.attrMap[p] = 0;
    }
  }

  /** 1-based row/column to a buffer address. */
  address(row: number, col: number) {
    if (row < 1 || row > this.rows || col < 1 || col > this.cols) {
      throw new DataStreamError(`buffer address row ${row} column ${col} is outside the ${this.rows}x${this.cols} screen`);
    }
    return (row - 1) * this.cols + (col - 1);
  }

  rowCol(address: number) {
    return { row: Math.floor(address / this.cols) + 1, col: (address % this.cols) + 1 };
  }

  // ------------------------------------------------------------ save / restore

  private saveScreen() {
    const id = (this.nextSaveId++ & 0xffff).toString(16).toUpperCase().padStart(4, "0");
    this.savedScreens.set(id, {
      rows: this.rows,
      cols: this.cols,
      buffer: this.buffer.slice(),
      attrMap: this.attrMap.slice(),
      fields: this.fields.map(f => f.clone()),
      cursor: this.cursor,
      errorRow: this.errorRow,
      savedErrorLine: this.savedErrorLine,
      inputInhibited: this.inputInhibited
    });
    while (this.savedScreens.size > MAX_SAVED_SCREENS) {
      const oldest = this.savedScreens.keys().next().value as string;
      this.savedScreens.delete(oldest);
    }
    // The host hands these bytes back in a Restore Screen command.
    const payload = Buffer.concat([Buffer.from([ESC, CMD_RESTORE_SCREEN]), Buffer.from(`${SAVE_TAG}${id}`, "ascii")]);
    return buildGdsRecord(OP_PUT_GET, payload);
  }

  private restoreScreen(payload: Buffer) {
    const text = payload.toString("ascii");
    const id = text.startsWith(SAVE_TAG) ? text.substring(SAVE_TAG.length, SAVE_TAG.length + 4) : "";
    const saved = this.savedScreens.get(id);
    if (!saved) {
      this.warn("Restore Screen referenced a screen that was not saved by this session");
      return;
    }
    this.rows = saved.rows;
    this.cols = saved.cols;
    this.buffer = saved.buffer.slice();
    this.attrMap = saved.attrMap.slice();
    this.fields = saved.fields.map(f => f.clone());
    this.cursor = saved.cursor;
    this.errorRow = saved.errorRow;
    this.savedErrorLine = saved.savedErrorLine;
    this.inputInhibited = saved.inputInhibited;
  }

  // --------------------------------------------------------- outbound records

  private readScreenResponse() {
    return buildGdsRecord(OP_NO_OP, this.buffer);
  }

  private readImmediateResponse() {
    const { row, col } = this.rowCol(this.cursor);
    return buildGdsRecord(OP_PUT_GET, Buffer.from([row, col, 0x00, ...this.fieldData(CMD_READ_INPUT_FIELDS)]));
  }

  /** 5250 Query reply: identifies the terminal as a 5250 display emulator. */
  private queryReply() {
    const { row, col } = this.rowCol(this.cursor);
    const wide = this.deviceType === "3477";
    const deviceType = stringToEbcdic(wide ? "3477" : "3179");
    const model = stringToEbcdic(wide ? "FC " : "002");
    const body = [
      0xd9, 0x70, // query class and type
      0x80, // flag: query reply
      0x06, 0x00, // controller hardware class: another 5250 emulator
      0x01, 0x01, 0x00, // controller code level
      ...new Array(16).fill(0), // reserved
      0x01, // device class: display
      ...deviceType,
      ...model,
      0x02, // keyboard id: standard
      0x00, // extended keyboard id
      0x00, // reserved
      0x00, 0x00, 0x00, 0x00, // display serial number
      0x01, 0x00, // maximum input fields (256)
      0x00, // control unit customization
      0x00, 0x00, // reserved
      ...new Array(12).fill(0) // controller/display capabilities: basic 5250 only
    ];
    const length = body.length + 2;
    return buildGdsRecord(OP_NO_OP, Buffer.from([row, col, AID.INBOUND_WSF, length >> 8, length & 0xff, ...body]));
  }

  /** Field data for an inbound response, in the format the pending read asked for. */
  private fieldData(readCommand: number) {
    const out: number[] = [];
    if (readCommand === CMD_READ_INPUT_FIELDS) {
      if (!this.fields.some(f => f.modified)) return out;
      for (const field of this.fields) {
        for (let n = 0; n < field.length; n += 1) {
          const byte = this.buffer[(field.start + n) % this.size];
          out.push(byte === 0 ? 0x40 : byte);
        }
      }
      return out;
    }
    for (const field of this.fields) {
      if (!field.modified) continue;
      const { row, col } = this.rowCol(field.start);
      out.push(ORD_SBA, row, col);
      const bytes: number[] = [];
      for (let n = 0; n < field.length; n += 1) bytes.push(this.buffer[(field.start + n) % this.size]);
      while (bytes.length > 0 && bytes[bytes.length - 1] === 0) bytes.pop();
      out.push(...bytes.map(b => (b === 0 ? 0x40 : b)));
    }
    return out;
  }

  /** Build the Put/Get record for an AID key and lock the keyboard. */
  buildAidResponse(aid: number) {
    const { row, col } = this.rowCol(this.cursor);
    const data = [row, col, aid];
    if (!AID_WITHOUT_DATA.has(aid)) {
      const readCommand = this.pendingRead === CMD_READ_INPUT_FIELDS ? CMD_READ_INPUT_FIELDS : CMD_READ_MDT_FIELDS;
      data.push(...this.fieldData(readCommand));
    }
    this.keyboardLocked = true;
    this.inputInhibited = false;
    this.pendingRead = null;
    return buildGdsRecord(OP_PUT_GET, Buffer.from(data));
  }

  // ------------------------------------------------------------ operator input

  inputFields() {
    return this.fields.filter(f => !f.bypass);
  }

  fieldAt(address: number) {
    return this.fields.find(f => f.contains(address));
  }

  setCursor(row: number, col: number) {
    this.cursor = this.address(row, col);
  }

  /** Local RESET key: leave the input-inhibited (error) state. */
  reset() {
    if (this.savedErrorLine) {
      const rowStart = this.errorRow * this.cols;
      this.buffer.set(this.savedErrorLine.buffer, rowStart);
      this.attrMap.set(this.savedErrorLine.attrMap, rowStart);
      this.savedErrorLine = undefined;
    }
    if (this.inputInhibited) {
      this.inputInhibited = false;
      this.keyboardLocked = false;
    }
  }

  private requireInputAllowed() {
    if (this.inputInhibited) throw new Error("Input is inhibited by an error message; send the RESET key first");
    if (this.keyboardLocked) throw new Error("The keyboard is locked: the host has not finished updating the screen");
  }

  private encodeFor(field: Tn5250Field, text: string) {
    const value = field.monocase ? text.toUpperCase() : text;
    if (field.numeric && !/^[0-9 +\-.,]*$/.test(value)) {
      throw new Error(`Field at row ${this.rowCol(field.start).row} column ${this.rowCol(field.start).col} accepts only numeric input`);
    }
    return stringToEbcdic(value, this.ccsid);
  }

  /** Type text at the cursor, as an operator would. */
  typeText(text: string) {
    this.requireInputAllowed();
    const field = this.fieldAt(this.cursor);
    if (!field || field.bypass) {
      const { row, col } = this.rowCol(this.cursor);
      throw new Error(`The cursor (row ${row}, column ${col}) is not in an input field`);
    }
    const bytes = this.encodeFor(field, text);
    const offset = this.cursor - field.start;
    if (offset + bytes.length > field.length) {
      throw new Error(`Text is ${bytes.length} characters but only ${field.length - offset} fit in the field from the cursor`);
    }
    bytes.forEach((byte, n) => {
      const p = (field.start + offset + n) % this.size;
      this.buffer[p] = byte;
      this.attrMap[p] = 0;
    });
    field.modified = true;
    const next = field.start + offset + bytes.length;
    if (next > field.end) this.tab();
    else this.cursor = next;
    this.version += 1;
  }

  /** Replace a field's whole content. */
  setFieldValue(field: Tn5250Field, value: string) {
    this.requireInputAllowed();
    if (field.bypass) throw new Error("Field is protected");
    let bytes = this.encodeFor(field, value);
    if (bytes.length > field.length) {
      throw new Error(`Value is ${bytes.length} characters but the field holds ${field.length}`);
    }
    const adjust = field.rightAdjust;
    if (adjust && bytes.length > 0) {
      const fill = adjust === "zero" ? 0xf0 : 0x40;
      const padded = new Uint8Array(field.length).fill(fill);
      padded.set(bytes, field.length - bytes.length);
      bytes = padded;
    }
    for (let n = 0; n < field.length; n += 1) {
      this.buffer[(field.start + n) % this.size] = n < bytes.length ? bytes[n] : 0x00;
      this.attrMap[(field.start + n) % this.size] = 0;
    }
    field.modified = true;
    this.version += 1;
  }

  tab() {
    const inputs = this.inputFields();
    if (inputs.length === 0) return;
    const next = inputs.find(f => f.start > this.cursor) || inputs[0];
    this.cursor = next.start;
  }

  backTab() {
    const inputs = this.inputFields();
    if (inputs.length === 0) return;
    const current = inputs.find(f => f.contains(this.cursor));
    if (current && this.cursor > current.start) {
      this.cursor = current.start;
      return;
    }
    const before = inputs.filter(f => f.start < this.cursor);
    this.cursor = (before[before.length - 1] || inputs[inputs.length - 1]).start;
  }

  home() {
    const first = this.inputFields()[0];
    this.cursor = first ? first.start : 0;
  }

  /** Erase from the cursor to the end of the current field. */
  eraseToEndOfField() {
    this.requireInputAllowed();
    const field = this.fieldAt(this.cursor);
    if (!field || field.bypass) throw new Error("The cursor is not in an input field");
    for (let p = this.cursor; p <= field.end; p += 1) this.buffer[p % this.size] = 0;
    field.modified = true;
    this.version += 1;
  }

  fieldExit() {
    this.eraseToEndOfField();
    this.tab();
  }

  // ------------------------------------------------------------------- views

  /** Screen rows as text. Attributes, nulls and non-display areas are blanks. */
  renderRows(): string[] {
    const hiddenMask = new Uint8Array(this.size);
    for (const field of this.fields) {
      if (!field.hidden) continue;
      for (let n = 0; n < field.length; n += 1) hiddenMask[(field.start + n) % this.size] = 1;
    }
    const rows: string[] = [];
    let attr = 0x20;
    let line = "";
    for (let p = 0; p < this.size; p += 1) {
      if (this.attrMap[p]) {
        attr = this.buffer[p];
        line += " ";
      } else if ((attr & 0x07) === 0x07 || hiddenMask[p]) {
        line += " ";
      } else {
        line += ebcdicToChar(this.buffer[p], this.ccsid);
      }
      if ((p + 1) % this.cols === 0) {
        rows.push(line);
        line = "";
      }
    }
    return rows;
  }

  fieldId(field: Tn5250Field) {
    const { row, col } = this.rowCol(field.start);
    return `r${row}c${col}`;
  }

  fieldText(field: Tn5250Field) {
    let out = "";
    for (let n = 0; n < field.length; n += 1) out += ebcdicToChar(this.buffer[(field.start + n) % this.size], this.ccsid);
    return out;
  }

  fieldHasValue(field: Tn5250Field) {
    for (let n = 0; n < field.length; n += 1) {
      const byte = this.buffer[(field.start + n) % this.size];
      if (byte !== 0 && byte !== 0x40) return true;
    }
    return false;
  }

  /** Text on the field's row to the left of it, used as a label. */
  fieldLabel(field: Tn5250Field, rows = this.renderRows()) {
    const { row, col } = this.rowCol(field.start);
    const left = rows[row - 1].substring(0, Math.max(0, col - 2));
    const trimmed = left.replace(/[\s.:]+$/, "");
    if (trimmed.endsWith("===>")) return "===>";
    const parts = trimmed.split(/\s{3,}/);
    return (parts[parts.length - 1] || "").trim();
  }

  isCommandLine(field: Tn5250Field, rows = this.renderRows()) {
    return !field.bypass && !field.hidden && this.fieldLabel(field, rows) === "===>";
  }

  view(): ScreenView {
    const rows = this.renderRows();
    const fields: FieldView[] = this.fields.map((field, index) => {
      const { row, col } = this.rowCol(field.start);
      const base: FieldView = {
        id: this.fieldId(field),
        index: index + 1,
        row,
        col,
        length: field.length,
        label: this.fieldLabel(field, rows),
        protected: field.bypass,
        hidden: field.hidden,
        modified: field.modified,
        numeric: field.numeric,
        commandLine: this.isCommandLine(field, rows)
      };
      if (field.hidden) base.hasValue = this.fieldHasValue(field);
      else base.value = this.fieldText(field).replace(/\s+$/, "");
      return base;
    });
    const view: ScreenView = {
      rows: this.rows,
      cols: this.cols,
      cursor: this.rowCol(this.cursor),
      keyboardLocked: this.keyboardLocked,
      inputInhibited: this.inputInhibited,
      messageWaiting: this.messageWaiting,
      readPending: this.pendingRead !== null,
      text: rows,
      fields,
      version: this.version
    };
    if (this.inputInhibited) view.errorLine = rows[this.errorRow].trim();
    return view;
  }

  private warn(message: string) {
    this.warnings.push(message);
    if (this.warnings.length > 20) this.warnings.shift();
  }
}

function hex(value: number | undefined) {
  return (value ?? 0).toString(16).padStart(2, "0");
}
