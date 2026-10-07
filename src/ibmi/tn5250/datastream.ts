/**
 * 5250 data stream constants and GDS record framing (RFC 1205, RFC 2877).
 *
 * Every 5250 record starts with a 10-byte header:
 *   length(2) | record type 0x12A0 (2) | reserved(2) | var header length 0x04 (1)
 *   | flags(2) | opcode(1)
 * followed by commands, each introduced by ESC (0x04).
 */

export const GDS_RECORD_TYPE = 0x12a0;
export const ESC = 0x04;

// Header opcodes
export const OP_NO_OP = 0x00;
export const OP_INVITE = 0x01;
export const OP_OUTPUT_ONLY = 0x02;
export const OP_PUT_GET = 0x03;
export const OP_SAVE_SCREEN = 0x04;
export const OP_RESTORE_SCREEN = 0x05;
export const OP_READ_IMMEDIATE = 0x06;
export const OP_READ_SCREEN = 0x08;
export const OP_CANCEL_INVITE = 0x0a;
export const OP_MESSAGE_LIGHT_ON = 0x0b;
export const OP_MESSAGE_LIGHT_OFF = 0x0c;

// Header flag bits (first flag byte)
export const FLAG_ERR = 0x80;
export const FLAG_ATN = 0x40;
export const FLAG_SRQ = 0x04;
export const FLAG_TRQ = 0x02;
// Second flag byte
export const FLAG_HLP = 0x80;

// Commands (after ESC)
export const CMD_SAVE_SCREEN = 0x02;
export const CMD_SAVE_PARTIAL_SCREEN = 0x03;
export const CMD_WRITE_TO_DISPLAY = 0x11;
export const CMD_RESTORE_SCREEN = 0x12;
export const CMD_RESTORE_PARTIAL_SCREEN = 0x13;
export const CMD_CLEAR_UNIT_ALTERNATE = 0x20;
export const CMD_WRITE_ERROR_CODE = 0x21;
export const CMD_WRITE_ERROR_CODE_TO_WINDOW = 0x22;
export const CMD_ROLL = 0x23;
export const CMD_CLEAR_UNIT = 0x40;
export const CMD_READ_INPUT_FIELDS = 0x42;
export const CMD_CLEAR_FORMAT_TABLE = 0x50;
export const CMD_READ_MDT_FIELDS = 0x52;
export const CMD_READ_SCREEN_IMMEDIATE = 0x62;
export const CMD_READ_IMMEDIATE = 0x72;
export const CMD_READ_MDT_ALTERNATE = 0x82;
export const CMD_READ_MDT_IMMEDIATE_ALTERNATE = 0x83;
export const CMD_WRITE_STRUCTURED_FIELD = 0xf3;

// Orders inside Write To Display
export const ORD_SOH = 0x01;
export const ORD_RA = 0x02;
export const ORD_EA = 0x03;
export const ORD_TD = 0x10;
export const ORD_SBA = 0x11;
export const ORD_WEA = 0x12;
export const ORD_IC = 0x13;
export const ORD_MC = 0x14;
export const ORD_WDSF = 0x15;
export const ORD_SF = 0x1d;

// AID codes
export const AID = {
  ENTER: 0xf1,
  HELP: 0xf3,
  ROLLDOWN: 0xf4,
  ROLLUP: 0xf5,
  PRINT: 0xf6,
  RECORD_BACKSPACE: 0xf8,
  CLEAR: 0xbd,
  INBOUND_WSF: 0x88,
  F1: 0x31, F2: 0x32, F3: 0x33, F4: 0x34, F5: 0x35, F6: 0x36,
  F7: 0x37, F8: 0x38, F9: 0x39, F10: 0x3a, F11: 0x3b, F12: 0x3c,
  F13: 0xb1, F14: 0xb2, F15: 0xb3, F16: 0xb4, F17: 0xb5, F18: 0xb6,
  F19: 0xb7, F20: 0xb8, F21: 0xb9, F22: 0xba, F23: 0xbb, F24: 0xbc
} as const;

/** AID keys whose response carries no field data. */
export const AID_WITHOUT_DATA = new Set<number>([AID.CLEAR, AID.HELP, AID.PRINT, AID.RECORD_BACKSPACE]);

export type GdsRecord = {
  flags: number;
  flags2: number;
  opcode: number;
  data: Buffer;
};

export function parseGdsRecord(record: Buffer): GdsRecord {
  if (record.length < 10) throw new Error(`5250 record too short (${record.length} bytes)`);
  const recordType = record.readUInt16BE(2);
  if (recordType !== GDS_RECORD_TYPE) {
    throw new Error(`Unexpected 5250 record type 0x${recordType.toString(16)}`);
  }
  const varLength = record[6];
  const headerEnd = 6 + varLength;
  if (varLength < 4 || headerEnd > record.length) throw new Error("Invalid 5250 record header");
  const declared = record.readUInt16BE(0);
  const end = declared >= headerEnd && declared <= record.length ? declared : record.length;
  return {
    flags: record[7],
    flags2: record[8],
    opcode: record[9],
    data: record.subarray(headerEnd, end)
  };
}

export function buildGdsRecord(opcode: number, data: Uint8Array = new Uint8Array(0), flags = 0, flags2 = 0) {
  const length = 10 + data.length;
  const out = Buffer.alloc(length);
  out.writeUInt16BE(length, 0);
  out.writeUInt16BE(GDS_RECORD_TYPE, 2);
  out.writeUInt16BE(0, 4);
  out[6] = 0x04;
  out[7] = flags;
  out[8] = flags2;
  out[9] = opcode;
  Buffer.from(data).copy(out, 10);
  return out;
}
