import type { McpContext } from "../context.js";
import type { ToolModule } from "./index.js";
import { clampNumber, enforceWritable, getConnectionName, json } from "../tools.js";
import { getPassword } from "../../security/credentialStore.js";
import { REDACTED } from "../../security/redact.js";
import { Screen, Tn5250Client, Tn5250Field, TerminalType, aidForKey, checkTlsCertificate } from "../../ibmi/tn5250/index.js";
import { AID_WITHOUT_DATA } from "../../ibmi/tn5250/datastream.js";

/**
 * ibmi.tn5250.*: a real TN5250 (5250 telnet) session per saved connection.
 * The host comes from the saved connection; nothing on the screen is ever
 * sent to the IBM i until sendKeys presses an AID key (Enter, F-keys, ...).
 */

type Session = {
  connectionName: string;
  host: string;
  port: number;
  tls: boolean;
  client: Tn5250Client;
  createdAt: string;
  lastKey?: string;
};

const sessions = new Map<string, Session>();

/** Replaceable dependencies (tests swap these). */
export const tn5250Deps = {
  getPassword: (connectionName: string): Promise<string | undefined> => getPassword(connectionName),
  checkCertificate: (info: { host: string; port: number; certificate: Buffer; authorized: boolean }) =>
    checkTlsCertificate({ host: info.host, port: info.port, certificate: info.certificate, authorized: info.authorized })
};

const LOCAL_KEYS = new Set(["TAB", "BACKTAB", "HOME", "RESET", "ERASEEOF", "FIELDEXIT"]);
const CONNECTION_NAME = { type: "string", description: "Saved IBM i connection name (defaults to the active connection)." };
const TIMEOUT_MS = { type: "number", description: "How long to wait for the host, in milliseconds." };
const FIELD_ID = {
  type: "string",
  description: "Field id from readScreen (for example \"r6c53\"), its 1-based index, or \"command\" for a recognised command line (===>)."
};

const tools: ToolModule["tools"] = [
  {
    name: "ibmi.tn5250.connect",
    description:
      "Open a real TN5250 (5250 green-screen) session to the saved connection's host and return the first screen. " +
      "Port and TLS come from the connection settings tn5250Port / tn5250Tls (default 23, or 992 with TLS). " +
      "signOn=true signs on with the connection's stored user and password (never passed as arguments); it counts as sending keys, so read-only connections refuse it.",
    inputSchema: {
      type: "object",
      properties: {
        connectionName: CONNECTION_NAME,
        port: { type: "number", description: "Override the telnet port (1-65535)." },
        tls: { type: "boolean", description: "Override TLS (default: tn5250Tls setting, else true for port 992)." },
        signOn: { type: "boolean", default: false, description: "Sign on with the stored credentials." },
        deviceName: { type: "string", description: "Virtual device name to request (1-10 characters)." },
        screenSize: { type: "string", enum: ["24x80", "27x132"], description: "27x132 announces an IBM-3477-FC display." },
        timeoutMs: TIMEOUT_MS,
        approve: { type: "boolean", description: "Set true to approve guarded-policy operations (signOn)." }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ibmi.tn5250.readScreen",
    description:
      "Read the current 5250 screen: text rows, cursor, keyboard state and the input fields (id, position, length, label, protected/hidden flags, value). " +
      "Hidden (non-display, password-style) field contents are never returned.",
    inputSchema: { type: "object", properties: { connectionName: CONNECTION_NAME }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ibmi.tn5250.setField",
    description:
      "Fill an input field on the local screen (nothing is sent until sendKeys presses an AID key such as Enter). " +
      "Identify the field by fieldId or by row/col. useStoredPassword=true fills a hidden field with the connection's stored password.",
    inputSchema: {
      type: "object",
      properties: {
        connectionName: CONNECTION_NAME,
        fieldId: FIELD_ID,
        row: { type: "number", description: "1-based row of any position in the field." },
        col: { type: "number", description: "1-based column of any position in the field." },
        value: { type: "string" },
        useStoredPassword: { type: "boolean", description: "Fill a hidden field with the stored password instead of value." }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ibmi.tn5250.sendKeys",
    description:
      "Type text at the cursor and/or press keys, then wait for the host to answer. keys is a space-separated list: local keys " +
      "(Tab, BackTab, Home, Reset, EraseEOF, FieldExit) and at most one AID key at the end (Enter, F1-F24, PageUp, PageDown, Clear, Help, Print, Attn, SysReq). " +
      "Pressing an AID key sends the screen to the IBM i: read-only connections refuse it, and text on a recognised command line (===>) is checked against the command policy as cl.run.",
    inputSchema: {
      type: "object",
      properties: {
        connectionName: CONNECTION_NAME,
        text: { type: "string", description: "Text typed at the cursor before the keys." },
        keys: { type: "string", description: "Keys to press, for example \"Enter\", \"F3\" or \"Tab Tab Enter\"." },
        cursorRow: { type: "number", description: "Move the cursor here (1-based) before typing." },
        cursorCol: { type: "number", description: "Move the cursor here (1-based) before typing." },
        timeoutMs: TIMEOUT_MS,
        approve: { type: "boolean", description: "Set true to approve guarded-policy operations." }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: "ibmi.tn5250.waitFor",
    description:
      "Wait until text appears on the screen and/or the keyboard unlocks (the host is waiting for input). With no text it waits for the keyboard.",
    inputSchema: {
      type: "object",
      properties: {
        connectionName: CONNECTION_NAME,
        text: { type: "string", description: "Case-insensitive text to look for on any row." },
        keyboardUnlocked: { type: "boolean", description: "Also require the keyboard to be unlocked (default true when text is empty)." },
        timeoutMs: TIMEOUT_MS
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ibmi.tn5250.snapshot",
    description: "Capture the screen as plain text plus the structured screen (hidden fields are blanked).",
    inputSchema: { type: "object", properties: { connectionName: CONNECTION_NAME }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "ibmi.tn5250.disconnect",
    description: "Close the TN5250 session (the IBM i ends or disconnects the interactive job as configured for the device).",
    inputSchema: { type: "object", properties: { connectionName: CONNECTION_NAME }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

async function handle(ctx: McpContext, name: string, args: any) {
  switch (name) {
    case "ibmi.tn5250.connect":
      return connect(ctx, args || {});
    case "ibmi.tn5250.readScreen":
      return json(sessionView(requireSession(ctx, args)));
    case "ibmi.tn5250.setField":
      return setField(ctx, args || {});
    case "ibmi.tn5250.sendKeys":
      return sendKeys(ctx, args || {});
    case "ibmi.tn5250.waitFor":
      return waitFor(ctx, args || {});
    case "ibmi.tn5250.snapshot": {
      const session = requireSession(ctx, args);
      const view = sessionView(session);
      return json({ capturedAt: new Date().toISOString(), connectionName: session.connectionName, plainText: view.text.join("\n"), screen: view });
    }
    case "ibmi.tn5250.disconnect": {
      const connectionName = getConnectionName(ctx, args);
      const existed = closeSession(connectionName);
      return json({ disconnected: existed, connectionName });
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function connect(ctx: McpContext, args: any) {
  const connectionName = getConnectionName(ctx, args);
  const existing = sessions.get(connectionName);
  if (existing && !existing.client.closed) {
    return json({ reused: true, ...sessionView(existing) });
  }
  if (existing) sessions.delete(connectionName);

  const stored = await ctx.store.getConnection(connectionName);
  if (!stored) throw new Error(`Unknown connection: ${connectionName}`);
  const globalSettings = typeof (ctx.store as any).getSettings === "function" ? await (ctx.store as any).getSettings() : {};
  const settings = { ...(globalSettings || {}), ...(stored.settings || {}) } as Record<string, any>;

  const tlsSetting = typeof args.tls === "boolean" ? args.tls : typeof settings.tn5250Tls === "boolean" ? settings.tn5250Tls : undefined;
  const portSetting = args.port ?? settings.tn5250Port;
  const port = portSetting !== undefined ? requirePort(portSetting) : tlsSetting ? 992 : 23;
  const useTls = tlsSetting ?? port === 992;
  const deviceName = optionalDeviceName(args.deviceName ?? settings.tn5250DeviceName);
  const terminalType: TerminalType = args.screenSize === "27x132" ? "IBM-3477-FC" : "IBM-3179-2";
  const timeoutMs = clampNumber(args.timeoutMs, 20000, 1000, 120000);

  let password: string | undefined;
  if (args.signOn) {
    const conn = await ctx.ensureActive(connectionName);
    enforceWritable(ctx, conn, "tn5250.signOn", { ...args, connectionName });
    password = await tn5250Deps.getPassword(connectionName);
    if (!password) throw new Error(`No stored password for ${connectionName}; signOn needs the connection's saved password`);
  }

  const client = new Tn5250Client({
    host: stored.host,
    port,
    tls: useTls,
    terminalType,
    deviceName,
    // The password is only offered in the telnet negotiation when it is encrypted by TLS.
    autoSignOn: password && useTls ? { user: stored.username, password } : undefined,
    connectTimeoutMs: timeoutMs,
    checkCertificate: info => tn5250Deps.checkCertificate(info)
  });
  await client.connect();
  const session: Session = { connectionName, host: stored.host, port, tls: useTls, client, createdAt: new Date().toISOString() };
  sessions.set(connectionName, session);

  try {
    let settled = await client.waitForSettled(timeoutMs);
    let signOn: Record<string, any> | undefined;
    if (password) {
      signOn = { method: client.autoSignOnOffered ? "telnet-environment" : "sign-on-screen" };
      const form = signOnFields(client.screen);
      if (form && settled) {
        if (client.screen.inputInhibited) client.screen.reset();
        client.screen.setFieldValue(form.user, stored.username);
        client.screen.setFieldValue(form.password, password);
        client.screen.cursor = form.password.start;
        client.sendKey("ENTER");
        session.lastKey = "ENTER";
        settled = await client.waitForSettled(timeoutMs);
        signOn.method = "sign-on-screen";
      }
      signOn.stillOnSignOnScreen = Boolean(signOnFields(client.screen));
    }
    return json({ ...sessionView(session), settled, ...(signOn ? { signOn } : {}) });
  } catch (err) {
    closeSession(connectionName);
    throw err;
  }
}

/** The user and password fields of a sign-on style screen, if this is one. */
function signOnFields(screen: Screen) {
  const inputs = screen.inputFields();
  const password = inputs.find(f => f.hidden);
  if (!password) return undefined;
  const user = inputs.filter(f => !f.hidden && f.start < password.start).pop();
  return user ? { user, password } : undefined;
}

async function setField(ctx: McpContext, args: any) {
  const session = requireOpenSession(ctx, args);
  const screen = session.client.screen;
  const field = resolveField(screen, args);
  if (!field) throw new Error(`TN5250 field not found: ${describeFieldRef(args)}`);
  if (field.bypass) throw new Error(`TN5250 field ${screen.fieldId(field)} is protected`);
  let value: string;
  if (args.useStoredPassword) {
    if (!field.hidden) throw new Error("useStoredPassword can only fill a hidden (non-display) field");
    const password = await tn5250Deps.getPassword(session.connectionName);
    if (!password) throw new Error(`No stored password for ${session.connectionName}`);
    value = password;
  } else {
    if (typeof args.value !== "string") throw new Error("value is required (or useStoredPassword=true)");
    value = args.value;
  }
  if (screen.inputInhibited) screen.reset();
  screen.setFieldValue(field, value);
  return json(sessionView(session));
}

async function sendKeys(ctx: McpContext, args: any) {
  const session = requireOpenSession(ctx, args);
  const { client } = session;
  const screen = client.screen;
  const keys = parseKeys(args.keys);
  const text = typeof args.text === "string" ? args.text : undefined;
  if (keys.length === 0 && !text) throw new Error("keys or text is required");

  const aidIndex = keys.findIndex(isAidKey);
  for (const key of keys) {
    if (!LOCAL_KEYS.has(key) && !isAidKey(key)) throw new Error(`Unsupported key: ${key}`);
  }
  if (aidIndex >= 0 && aidIndex !== keys.length - 1) {
    throw new Error("Only one AID key (Enter, F1-F24, PageUp, ...) is allowed, and it must be the last key");
  }
  const timeoutMs = clampNumber(args.timeoutMs, 30000, 250, 300000);

  const autoReset = screen.inputInhibited;
  if (autoReset) screen.reset();
  if (args.cursorRow !== undefined || args.cursorCol !== undefined) {
    screen.setCursor(Number(args.cursorRow ?? screen.rowCol(screen.cursor).row), Number(args.cursorCol ?? screen.rowCol(screen.cursor).col));
  }
  if (text) screen.typeText(text);

  const localKeys = aidIndex >= 0 ? keys.slice(0, aidIndex) : keys;
  for (const key of localKeys) applyLocalKey(screen, key);

  let settled: boolean | undefined;
  const aidKey = aidIndex >= 0 ? keys[aidIndex] : undefined;
  if (aidKey) {
    if (screen.keyboardLocked && !screen.inputInhibited && !["ATTN", "SYSREQ"].includes(aidKey)) {
      throw new Error("The keyboard is locked (the host has not finished); use ibmi.tn5250.waitFor first, or Attn/SysReq");
    }
    const conn = await ctx.ensureActive(session.connectionName);
    const gateArgs = { ...args, connectionName: session.connectionName };
    const aid = aidForKey(aidKey);
    const commands = aid !== undefined && !AID_WITHOUT_DATA.has(aid) ? commandLineEntries(screen) : [];
    if (commands.length > 0) {
      // Text on a command line is run as CL by the host, so it gets the cl.run checks.
      for (const command of commands) enforceWritable(ctx, conn, "cl.run", { ...gateArgs, command, environment: "ile" });
    } else {
      enforceWritable(ctx, conn, "tn5250.sendKeys", gateArgs);
    }
    client.sendKey(aidKey);
    session.lastKey = aidKey;
    settled = await client.waitForSettled(timeoutMs);
  }
  return json({
    ...sessionView(session),
    ...(aidKey ? { sent: aidKey, settled } : {}),
    ...(autoReset ? { autoReset: true } : {})
  });
}

async function waitFor(ctx: McpContext, args: any) {
  const session = requireSession(ctx, args);
  const { client } = session;
  const timeoutMs = clampNumber(args?.timeoutMs, 5000, 100, 300000);
  const text = typeof args?.text === "string" && args.text.length > 0 ? args.text.toLowerCase() : undefined;
  const needUnlock = typeof args?.keyboardUnlocked === "boolean" ? args.keyboardUnlocked : !text;
  const matched = await client.waitFor(() => {
    if (text && !client.screen.renderRows().some(row => row.toLowerCase().includes(text))) return false;
    return !needUnlock || client.isReady();
  }, timeoutMs);
  return json({ matched, text: args?.text, keyboardUnlocked: needUnlock, timeoutMs, screen: sessionView(session) });
}

function applyLocalKey(screen: Screen, key: string) {
  switch (key) {
    case "TAB": screen.tab(); break;
    case "BACKTAB": screen.backTab(); break;
    case "HOME": screen.home(); break;
    case "RESET": screen.reset(); break;
    case "ERASEEOF": screen.eraseToEndOfField(); break;
    case "FIELDEXIT": screen.fieldExit(); break;
  }
}

function isAidKey(key: string) {
  return key === "ATTN" || key === "SYSREQ" || aidForKey(key) !== undefined;
}

function parseKeys(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return String(value)
    .split(/[\s,+]+/)
    .map(part => part.trim().toUpperCase().replace(/[_-]/g, ""))
    .filter(Boolean);
}

/**
 * Text in command lines (fields labelled ===>). Unmodified ones are included
 * too, since a Read Input Fields response sends every field.
 */
function commandLineEntries(screen: Screen) {
  const rows = screen.renderRows();
  return screen.fields
    .filter(f => screen.isCommandLine(f, rows))
    .map(f => screen.fieldText(f).trim())
    .filter(Boolean);
}

function resolveField(screen: Screen, args: any): Tn5250Field | undefined {
  if (args?.fieldId !== undefined && args.fieldId !== null && String(args.fieldId).trim() !== "") {
    const id = String(args.fieldId).trim().toLowerCase();
    if (id === "command") {
      const rows = screen.renderRows();
      return screen.fields.find(f => screen.isCommandLine(f, rows));
    }
    if (/^\d+$/.test(id)) return screen.fields[Number(id) - 1];
    const match = /^r(\d+)c(\d+)$/.exec(id);
    if (match) return screen.fields.find(f => screen.fieldId(f) === `r${Number(match[1])}c${Number(match[2])}`);
    return undefined;
  }
  if (args?.row !== undefined && args?.col !== undefined) {
    return screen.fieldAt(screen.address(Number(args.row), Number(args.col)));
  }
  throw new Error("fieldId or row and col are required");
}

function describeFieldRef(args: any) {
  return args?.fieldId !== undefined ? String(args.fieldId) : `row ${args?.row} column ${args?.col}`;
}

function sessionView(session: Session) {
  const { client } = session;
  return {
    connectionName: session.connectionName,
    host: session.host,
    port: session.port,
    tls: session.tls,
    terminalType: client.terminalType,
    connected: !client.closed,
    ...(client.closed ? { closeReason: client.closeReason } : {}),
    lastKey: session.lastKey,
    ...client.screen.view(),
    ...(client.screen.warnings.length > 0 ? { warnings: client.screen.warnings.slice(-5) } : {})
  };
}

function requireSession(ctx: McpContext, args: any): Session {
  const connectionName = getConnectionName(ctx, args);
  const session = sessions.get(connectionName);
  if (!session) throw new Error(`TN5250 session for ${connectionName} not found. Call ibmi.tn5250.connect first.`);
  return session;
}

function requireOpenSession(ctx: McpContext, args: any): Session {
  const session = requireSession(ctx, args);
  if (session.client.closed) {
    throw new Error(`TN5250 session for ${session.connectionName} is closed (${session.client.closeReason}). Call ibmi.tn5250.connect again.`);
  }
  return session;
}

function closeSession(connectionName: string) {
  const session = sessions.get(connectionName);
  if (!session) return false;
  session.client.close();
  sessions.delete(connectionName);
  return true;
}

function requirePort(value: unknown) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid TN5250 port: ${value}`);
  return port;
}

function optionalDeviceName(value: unknown) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const name = String(value).trim().toUpperCase();
  if (!/^[A-Z#@$][A-Z0-9#@$_]{0,9}$/.test(name)) throw new Error(`Invalid deviceName: ${value}`);
  return name;
}

/**
 * Hide what is typed into hidden (non-display) fields from logs and audit.
 * When the target field cannot be determined the value is hidden too.
 */
function redactArgs(ctx: McpContext, name: string, args: any) {
  if (!args || typeof args !== "object") return args;
  if (name !== "ibmi.tn5250.setField" && name !== "ibmi.tn5250.sendKeys") return args;
  let hidden = true;
  try {
    const session = sessions.get(args.connectionName || ctx.activeName || "");
    if (session) {
      const screen = session.client.screen;
      if (name === "ibmi.tn5250.setField") {
        const field = resolveField(screen, args);
        hidden = !field || field.hidden;
      } else {
        const cursor = args.cursorRow !== undefined || args.cursorCol !== undefined
          ? screen.address(Number(args.cursorRow ?? screen.rowCol(screen.cursor).row), Number(args.cursorCol ?? screen.rowCol(screen.cursor).col))
          : screen.cursor;
        const field = screen.fieldAt(cursor);
        hidden = !field || field.hidden;
      }
    }
  } catch {
    hidden = true;
  }
  if (!hidden) return args;
  const copy = { ...args };
  if (name === "ibmi.tn5250.setField" && "value" in copy) copy.value = REDACTED;
  if (name === "ibmi.tn5250.sendKeys" && "text" in copy) copy.text = REDACTED;
  return copy;
}

function onDisconnect(connectionName?: string) {
  if (connectionName) {
    closeSession(connectionName);
    return;
  }
  for (const name of [...sessions.keys()]) closeSession(name);
}

export const tn5250Module: ToolModule = { tools, handle, redactArgs, onDisconnect };
