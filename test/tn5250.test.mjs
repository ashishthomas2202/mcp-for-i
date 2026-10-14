import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { getTools, handleTool } from "../dist/mcp/tools.js";
import { redactModuleArgs } from "../dist/mcp/modules/index.js";
import { tn5250Deps } from "../dist/mcp/modules/tn5250.js";
import {
  Screen,
  Tn5250Client,
  aidForKey,
  checkTlsCertificate,
  datastream,
  ebcdicToString,
  stringToEbcdic,
  telnet
} from "../dist/ibmi/tn5250/index.js";

const { IAC, DO, WILL, SB, SE, EOR } = telnet;
const E = text => Buffer.from(stringToEbcdic(text));
const B = bytes => Buffer.from(bytes);
const sba = (row, col) => [0x11, row, col];

/** A host record: GDS header + data. */
function gds(data, opcode = datastream.OP_PUT_GET) {
  return datastream.buildGdsRecord(opcode, data);
}

function apply(screen, data, opcode) {
  return screen.process(datastream.parseGdsRecord(gds(data, opcode)));
}

// Sign-on display: user field (row 6, col 53, monocase) and a non-display
// password field (row 7, col 53), cursor in the user field, then Read MDT Fields.
function signOnScreen() {
  return Buffer.concat([
    B([0x04, 0x40, 0x04, 0x11, 0x00, 0x18]),
    B([0x01, 0x07, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00]),
    B([...sba(1, 36), 0x22]), E("Sign On"), B([0x20]),
    B(sba(6, 17)), E("User  . . . . . . . . . . . . . ."),
    B([...sba(6, 52), 0x1d, 0x40, 0x20, 0x24, 0x00, 0x0a]),
    B([...sba(6, 63), 0x20]),
    B(sba(7, 17)), E("Password  . . . . . . . . . . . ."),
    B([...sba(7, 52), 0x1d, 0x40, 0x00, 0x27, 0x00, 0x0a]),
    B([...sba(7, 63), 0x20]),
    B([0x13, 6, 53]),
    B([0x04, 0x52, 0x00, 0x00])
  ]);
}

// Main menu with a command line ("===>") at row 21, column 7.
function mainMenu() {
  return Buffer.concat([
    B([0x04, 0x40, 0x04, 0x11, 0x00, 0x18]),
    B([0x01, 0x07, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00]),
    B(sba(1, 2)), E("MAIN"), B(sba(1, 33)), E("IBM i Main Menu"),
    B(sba(20, 2)), E("Selection or command"),
    B(sba(21, 2)), E("===>"),
    B([...sba(21, 6), 0x1d, 0x40, 0x00, 0x20, 0x00, 0x46]),
    B([...sba(21, 77), 0x20]),
    B([0x13, 21, 7]),
    B([0x04, 0x52, 0x00, 0x00])
  ]);
}

// ---------------------------------------------------------------- EBCDIC

test("CCSID 37 round-trips every displayable byte", () => {
  for (let byte = 0x40; byte <= 0xfe; byte += 1) {
    const ch = ebcdicToString([byte]);
    assert.equal(stringToEbcdic(ch)[0], byte === 0x41 ? 0x41 : byte, `byte 0x${byte.toString(16)}`);
  }
  assert.deepEqual([...stringToEbcdic("Sign On")], [0xe2, 0x89, 0x87, 0x95, 0x40, 0xd6, 0x95]);
  assert.equal(ebcdicToString([0xc1, 0x81, 0xf0, 0x7c, 0x5b, 0xba, 0xbb, 0x4a]), "Aa0@$[]¢");
  assert.equal(ebcdicToString([0x00, 0x20, 0x3f]), "   ");
  assert.throws(() => stringToEbcdic("€"), /cannot be represented/);
});

// ---------------------------------------------------------------- telnet

test("telnet parser separates negotiation, subnegotiation and EOR records", () => {
  const parser = new telnet.TelnetParser();
  const events = parser.push(B([IAC, DO, 24, IAC, SB, 24, 1, IAC, SE, 0x00, 0x01, IAC, IAC]));
  assert.deepEqual(events.map(e => e.type), ["command", "subnegotiation"]);
  assert.equal(events[0].option, 24);
  assert.deepEqual([...events[1].data], [1]);
  const more = parser.push(B([0x02, IAC, EOR]));
  assert.equal(more.length, 1);
  assert.deepEqual([...more[0].data], [0x00, 0x01, 0xff, 0x02]);
  assert.deepEqual([...telnet.frameRecord(B([0x01, 0xff]))], [0x01, 0xff, 0xff, IAC, EOR]);
});

test("NEW-ENVIRON SEND is parsed, including the RFC 4777 IBMRSEED seed", () => {
  const seed = [0x5a, 2, 3, 0, 9, 8, 7, 6];
  const body = B([telnet.ENV_USERVAR, ...Buffer.from("IBMRSEED"), ...seed, telnet.ENV_VAR, telnet.ENV_USERVAR]);
  const parsed = telnet.parseEnvSend(body);
  assert.deepEqual([...parsed.serverSeed], seed);
  assert.deepEqual(parsed.requested.map(r => r.name), ["IBMRSEED", "", ""]);
  const withValue = telnet.parseEnvSend(B([telnet.ENV_USERVAR, ...Buffer.from("IBMRSEED"), telnet.ENV_VALUE, ...seed]));
  assert.deepEqual([...withValue.serverSeed], seed);

  const is = telnet.envIs([{ kind: "var", name: "USER", value: Buffer.from("AB") }, { kind: "uservar", name: "X", value: B([0x01]) }]);
  assert.deepEqual([...is], [IAC, SB, 39, 0, 0, 0x55, 0x53, 0x45, 0x52, 1, 0x41, 0x42, 3, 0x58, 1, 2, 1, IAC, SE]);
});

// ---------------------------------------------------------------- screen

test("sign-on screen: text, fields, attributes, cursor and keyboard state", () => {
  const screen = new Screen();
  const responses = apply(screen, signOnScreen());
  assert.equal(responses.length, 0);
  const view = screen.view();
  assert.equal(view.rows, 24);
  assert.equal(view.cols, 80);
  assert.match(view.text[0], /^\s+Sign On\s*$/);
  assert.equal(view.text[0].indexOf("Sign On"), 36);
  assert.match(view.text[5], /User  \. \. \./);
  assert.deepEqual(view.cursor, { row: 6, col: 53 });
  assert.equal(view.keyboardLocked, false);
  assert.equal(view.readPending, true);
  assert.equal(view.fields.length, 2);
  const [user, password] = view.fields;
  assert.deepEqual(
    { id: user.id, row: user.row, col: user.col, length: user.length, label: user.label, hidden: user.hidden, protected: user.protected },
    { id: "r6c53", row: 6, col: 53, length: 10, label: "User", hidden: false, protected: false }
  );
  assert.equal(password.id, "r7c53");
  assert.equal(password.label, "Password");
  assert.equal(password.hidden, true);
  assert.equal("value" in password, false);
  assert.equal(password.hasValue, false);
});

test("typing and Enter build a Read MDT Fields response; hidden text never shows", () => {
  const screen = new Screen();
  apply(screen, signOnScreen());
  screen.typeText("qsecofr");
  const [user, password] = screen.fields;
  assert.equal(screen.fieldText(user).trimEnd(), "QSECOFR", "monocase field uppercases");
  screen.setFieldValue(password, "s3cret");
  screen.setCursor(7, 53);

  const view = screen.view();
  assert.equal(view.fields[1].hasValue, true);
  assert.equal(JSON.stringify(view).includes("s3cret"), false);
  assert.equal(view.text[6].includes("s3cret"), false);

  const record = datastream.parseGdsRecord(screen.buildAidResponse(aidForKey("Enter")));
  assert.equal(record.opcode, datastream.OP_PUT_GET);
  const expected = [7, 53, 0xf1, 0x11, 6, 53, ...E("QSECOFR"), 0x11, 7, 53, ...E("s3cret")];
  assert.deepEqual([...record.data], expected);
  assert.equal(screen.keyboardLocked, true);
  assert.equal(screen.pendingRead, null);
  assert.throws(() => screen.typeText("x"), /keyboard is locked/);
});

test("AID codes, data-less keys and Read Input Fields responses", () => {
  assert.equal(aidForKey("F1"), 0x31);
  assert.equal(aidForKey("f12"), 0x3c);
  assert.equal(aidForKey("F13"), 0xb1);
  assert.equal(aidForKey("F24"), 0xbc);
  assert.equal(aidForKey("PageUp"), 0xf4);
  assert.equal(aidForKey("PageDown"), 0xf5);
  assert.equal(aidForKey("Clear"), 0xbd);
  assert.equal(aidForKey("Help"), 0xf3);
  assert.equal(aidForKey("F25"), undefined);
  assert.equal(aidForKey("Tab"), undefined);

  const screen = new Screen();
  apply(screen, signOnScreen());
  screen.typeText("ab");
  const clear = datastream.parseGdsRecord(screen.buildAidResponse(aidForKey("Clear")));
  assert.deepEqual([...clear.data], [6, 55, 0xbd], "Clear sends no field data");

  // Read Input Fields: every input field, no SBA orders, nulls as blanks.
  apply(screen, B([0x04, 0x42, 0x00, 0x00]));
  assert.equal(screen.keyboardLocked, false);
  const read = datastream.parseGdsRecord(screen.buildAidResponse(aidForKey("Enter")));
  assert.equal(read.data.length, 3 + 20);
  assert.deepEqual([...read.data.subarray(3, 5)], [...E("AB")]);
  assert.equal(read.data[12], 0x40);
});

test("CC1 resets MDT flags and an unlock-free write keeps the keyboard locked", () => {
  const screen = new Screen();
  apply(screen, signOnScreen());
  screen.typeText("abc");
  assert.equal(screen.fields[0].modified, true);
  // WTD with CC1 = reset MDT of non-bypass fields (0x40), CC2 = 0 (no unlock).
  apply(screen, B([0x04, 0x11, 0x40, 0x00, ...sba(2, 2), ...E("x")]));
  assert.equal(screen.fields[0].modified, false);
  assert.equal(screen.keyboardLocked, true);
  assert.equal(screen.fieldText(screen.fields[0]).trimEnd(), "ABC", "data is kept");
  // CC1 = 0x80: null non-bypass fields with MDT on.
  apply(screen, B([0x04, 0x11, 0x00, 0x08]));
  screen.typeText("zz");
  apply(screen, B([0x04, 0x11, 0x80, 0x08]));
  assert.equal(screen.fieldText(screen.fields[0]).trim(), "");
});

test("repeat to address, erase to address and insert cursor orders", () => {
  const screen = new Screen();
  apply(screen, B([0x04, 0x40, 0x04, 0x11, 0x00, 0x08, ...sba(3, 1), 0x02, 3, 10, ...E("-"), ...sba(3, 5), 0x03, 3, 6, 0x01, 0x13, 3, 2]));
  assert.equal(screen.view().text[2].substring(0, 12), "----  ----  ");
  assert.deepEqual(screen.view().cursor, { row: 3, col: 2 });
});

test("write error code inhibits input until reset restores the error line", () => {
  const screen = new Screen();
  apply(screen, signOnScreen());
  apply(screen, B([0x04, 0x21, 0x22, ...E("CPF1120 User QX does not exist."), 0x20, 0x04, 0x52, 0x00, 0x00]));
  const view = screen.view();
  assert.equal(view.inputInhibited, true);
  assert.match(view.errorLine, /CPF1120/);
  assert.match(view.text[23], /CPF1120/);
  assert.throws(() => screen.typeText("x"), /RESET/);
  screen.reset();
  assert.equal(screen.inputInhibited, false);
  assert.equal(screen.view().text[23].trim(), "");
  screen.typeText("ok");
});

test("non-display attribute hides output text that is not in a field", () => {
  const screen = new Screen();
  apply(screen, B([0x04, 0x40, 0x04, 0x11, 0x00, 0x08, ...sba(2, 1), 0x27, ...E("hidden"), 0x20, ...E("shown")]));
  assert.equal(screen.view().text[1].trim(), "shown");
});

test("5250 query, save/restore screen and clear unit alternate", () => {
  const screen = new Screen();
  apply(screen, signOnScreen());

  const [query] = apply(screen, B([0x04, 0xf3, 0x00, 0x05, 0xd9, 0x70, 0x00]), datastream.OP_NO_OP);
  const reply = datastream.parseGdsRecord(query);
  assert.equal(reply.data[2], 0x88, "inbound WSF AID");
  assert.equal(reply.data.readUInt16BE(3), 0x3a);
  assert.equal(reply.data.length, 3 + 0x3a);
  assert.deepEqual([...reply.data.subarray(5, 8)], [0xd9, 0x70, 0x80]);
  assert.equal(ebcdicToString(reply.data.subarray(30, 37)), "3179002");

  screen.typeText("before");
  const [saved] = apply(screen, B([0x04, 0x02]));
  const savePayload = datastream.parseGdsRecord(saved).data;
  assert.deepEqual([...savePayload.subarray(0, 2)], [0x04, 0x12]);

  apply(screen, mainMenu());
  assert.match(screen.view().text[0], /Main Menu/);
  // The host restores by sending our payload back.
  apply(screen, savePayload);
  assert.match(screen.view().text[0], /Sign On/);
  assert.equal(screen.fieldText(screen.fields[0]).trimEnd(), "BEFORE");

  apply(screen, B([0x04, 0x20, 0x00]));
  assert.equal(screen.rows, 27);
  assert.equal(screen.cols, 132);
});

test("a bad buffer address is reported as a warning, not a crash", () => {
  const screen = new Screen();
  apply(screen, B([0x04, 0x11, 0x00, 0x08, ...sba(30, 1), ...E("x")]));
  assert.match(screen.warnings.join("\n"), /outside the 24x80 screen/);
});

test("command line detection and local keys", () => {
  const screen = new Screen();
  apply(screen, mainMenu());
  const view = screen.view();
  assert.equal(view.fields[0].commandLine, true);
  assert.equal(view.fields[0].label, "===>");
  assert.deepEqual(view.cursor, { row: 21, col: 7 });
  screen.typeText("WRKACTJOB");
  screen.home();
  assert.deepEqual(screen.view().cursor, { row: 21, col: 7 });
  screen.eraseToEndOfField();
  assert.equal(screen.fieldText(screen.fields[0]).trim(), "");
});

// ---------------------------------------------------------------- TLS trust

test("TLS certificates are CA-verified or pinned on first use", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tn5250-certs-"));
  const filePath = path.join(dir, "known_tls_certs.json");
  const certA = Buffer.from("certificate-a");
  const certB = Buffer.from("certificate-b");
  assert.equal((await checkTlsCertificate({ host: "h", port: 992, certificate: certB, authorized: true, filePath })).status, "ca-verified");
  assert.equal((await checkTlsCertificate({ host: "h", port: 992, certificate: certA, authorized: false, filePath, acceptNew: "" })).status, "added");
  assert.equal((await checkTlsCertificate({ host: "h", port: 992, certificate: certA, authorized: false, filePath, acceptNew: "" })).status, "trusted");
  await assert.rejects(checkTlsCertificate({ host: "h", port: 992, certificate: certB, authorized: false, filePath, acceptNew: "" }), /has changed/);
  assert.equal((await checkTlsCertificate({ host: "h", port: 992, certificate: certB, authorized: false, filePath, acceptNew: "h:992" })).status, "replaced");
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fake host

// Self-signed test-only certificate (CN=tn5250-test.invalid).
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgX8M4SeJhWq5FAeMW
eq2p2tTriVUvvkq6YZN5cWRj9NOhRANCAARnziclqr0zBdKprGfJNGrJxEKi7/9O
bom8q44CxR5EpCgjF/7jhFrOrQoV1Nrgm5x14KkAHfEYUENP5rnfRPHy
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBlDCCATmgAwIBAgIUZCbsavPg6tZsfIpAWZtTuHkQ01YwCgYIKoZIzj0EAwIw
HjEcMBoGA1UEAwwTdG41MjUwLXRlc3QuaW52YWxpZDAgFw0yNjEwMDcwMDE5NTla
GA8yMTI2MDkxMzAwMTk1OVowHjEcMBoGA1UEAwwTdG41MjUwLXRlc3QuaW52YWxp
ZDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABGfOJyWqvTMF0qmsZ8k0asnEQqLv
/05uibyrjgLFHkSkKCMX/uOEWs6tChXU2uCbnHXgqQAd8RhQQ0/mud9E8fKjUzBR
MB0GA1UdDgQWBBRif3z5LJGud9LSu9cHoccHZ8JQ5TAfBgNVHSMEGDAWgBRif3z5
LJGud9LSu9cHoccHZ8JQ5TAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kA
MEYCIQCkhtAQ0Vz4kKjwhLkORaNkLa47t/Q0Hx2QGHR+gBXwgQIhAJwXoO0YBI1A
jz9wKOnpCWiDV1O1xQ6qEmbbiWkkkfLx
-----END CERTIFICATE-----
`;

/** A fake TN5250 server: negotiates like IBM i, then runs `onRecord` for each client record. */
async function startFakeHost({ firstScreen = signOnScreen(), onRecord, secure = false } = {}) {
  const events = new EventEmitter();
  const host = { records: [], env: [], terminalType: undefined, closed: false, events, socket: undefined };
  const listener = socket => {
    host.socket = socket;
    const parser = new telnet.TelnetParser();
    const negotiation = [
      IAC, DO, 24, IAC, DO, 39,
      IAC, SB, 24, 1, IAC, SE,
      IAC, SB, 39, 1, 0, 3, IAC, SE,
      IAC, DO, 25, IAC, WILL, 25, IAC, DO, 0, IAC, WILL, 0
    ];
    socket.write(B(negotiation));
    socket.on("data", chunk => {
      for (const event of parser.push(chunk)) {
        if (event.type === "subnegotiation" && event.option === 24) {
          host.terminalType = event.data.subarray(1).toString("ascii");
          socket.write(telnet.frameRecord(gds(firstScreen)));
        } else if (event.type === "subnegotiation" && event.option === 39) {
          host.env.push(event.data);
        } else if (event.type === "record") {
          const record = datastream.parseGdsRecord(event.data);
          host.records.push(record);
          const reply = onRecord?.(record, host);
          if (reply) socket.write(telnet.frameRecord(gds(reply)));
        }
        events.emit("event", event);
      }
    });
    socket.on("close", () => {
      host.closed = true;
      events.emit("close");
    });
  };
  const server = secure ? tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, listener) : net.createServer(listener);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  host.port = server.address().port;
  host.stop = () => new Promise(resolve => {
    host.socket?.destroy();
    server.close(resolve);
  });
  return host;
}

function fakeContext(port, { readOnlyMode = false, policy = { profile: "power-user" } } = {}) {
  const state = { readOnlyMode, policy };
  const conn = { getConfig: () => ({ readOnlyMode: state.readOnlyMode }) };
  const ctx = {
    activeName: "DEV",
    store: {
      getConnection: async name => (name === "DEV"
        ? { name: "DEV", host: "127.0.0.1", port: 22, username: "DEVUSER", settings: { tn5250Port: port } }
        : undefined),
      getSettings: async () => ({})
    },
    ensureActive: async () => conn,
    getPolicy: () => state.policy,
    resolvePolicy: async () => state.policy
  };
  return { ctx, state };
}

const data = response => response.structuredContent.data;

test("client negotiates terminal type, environment, EOR and binary with the host", async () => {
  const host = await startFakeHost();
  const client = new Tn5250Client({ host: "127.0.0.1", port: host.port, deviceName: "MCPDSP01" });
  await client.connect();
  assert.equal(await client.waitForSettled(5000), true);
  assert.equal(host.terminalType, "IBM-3179-2");
  assert.deepEqual(client.negotiated, { binary: true, eor: true, terminalType: true, newEnviron: true });
  const env = host.env[0].toString("latin1");
  assert.match(env, /DEVNAME\x01MCPDSP01/);
  assert.match(env, /CODEPAGE\x0137/);
  assert.doesNotMatch(env, /IBMSUBSPW/, "no credentials without auto sign-on");
  assert.match(client.screen.view().text[0], /Sign On/);
  client.close();
  await host.stop();
});

test("auto sign-on offers USER, empty IBMRSEED and IBMSUBSPW in NEW-ENVIRON", () => {
  const client = new Tn5250Client({ host: "h", port: 992, tls: true, autoSignOn: { user: "DEVUSER", password: "pw" } });
  const values = client.environment();
  assert.deepEqual(values.map(v => `${v.kind}:${v.name}=${Buffer.from(v.value).toString("ascii")}`).slice(-3), [
    "var:USER=DEVUSER",
    "uservar:IBMRSEED=",
    "uservar:IBMSUBSPW=pw"
  ]);
});

test("tools: connect with sign-on, command policy, read-only gate and disconnect", async () => {
  const host = await startFakeHost({
    onRecord: record => (record.data[2] === 0xf1 ? mainMenu() : undefined)
  });
  const { ctx, state } = fakeContext(host.port, { policy: { profile: "power-user", denyCommands: ["DLTLIB"] } });
  const realGetPassword = tn5250Deps.getPassword;
  tn5250Deps.getPassword = async () => "s3cret";
  try {
    const connected = await handleTool(ctx, "ibmi.tn5250.connect", { signOn: true, timeoutMs: 5000 });
    const view = data(connected);
    assert.equal(view.signOn.method, "sign-on-screen");
    assert.equal(view.signOn.stillOnSignOnScreen, false);
    assert.match(view.text[0], /IBM i Main Menu/);
    assert.equal(JSON.stringify(connected).includes("s3cret"), false);

    const signOnRecord = host.records[0];
    assert.deepEqual([...signOnRecord.data.subarray(0, 3)], [7, 53, 0xf1]);
    const fields = signOnRecord.data.subarray(3);
    assert.ok(fields.includes(E("DEVUSER")), "user sent");
    assert.ok(fields.includes(E("s3cret")), "stored password sent to the host");

    // Allowed command on the command line.
    await handleTool(ctx, "ibmi.tn5250.setField", { fieldId: "command", value: "DSPLIB QGPL" });
    const sent = data(await handleTool(ctx, "ibmi.tn5250.sendKeys", { keys: "Enter", timeoutMs: 5000 }));
    assert.equal(sent.sent, "ENTER");
    assert.equal(sent.settled, true);
    assert.ok(host.records[1].data.includes(E("DSPLIB QGPL")));

    // Denied command: nothing is sent.
    await handleTool(ctx, "ibmi.tn5250.sendKeys", { text: "QSYS/DLTLIB X", timeoutMs: 5000 });
    await assert.rejects(handleTool(ctx, "ibmi.tn5250.sendKeys", { keys: "Enter" }), /Blocked by policy: cl.run \(command DLTLIB is in denyCommands\)/);
    assert.equal(host.records.length, 2);

    // Read-only refuses every AID key, local keys still work.
    state.readOnlyMode = true;
    await assert.rejects(handleTool(ctx, "ibmi.tn5250.sendKeys", { keys: "F3" }), /read-only mode/);
    await handleTool(ctx, "ibmi.tn5250.sendKeys", { keys: "Home EraseEOF" });
    assert.equal(host.records.length, 2);

    const waited = data(await handleTool(ctx, "ibmi.tn5250.waitFor", { text: "main menu", timeoutMs: 1000 }));
    assert.equal(waited.matched, true);
    const missing = data(await handleTool(ctx, "ibmi.tn5250.waitFor", { text: "not on screen", timeoutMs: 150 }));
    assert.equal(missing.matched, false);

    const snapshot = data(await handleTool(ctx, "ibmi.tn5250.snapshot", {}));
    assert.match(snapshot.plainText, /Selection or command/);
    assert.equal(snapshot.plainText.split("\n").length, 24);

    const closed = data(await handleTool(ctx, "ibmi.tn5250.disconnect", {}));
    assert.equal(closed.disconnected, true);
    await new Promise(resolve => (host.closed ? resolve() : host.events.once("close", resolve)));
    await assert.rejects(handleTool(ctx, "ibmi.tn5250.readScreen", {}), /not found/);
  } finally {
    tn5250Deps.getPassword = realGetPassword;
    await handleTool(ctx, "ibmi.tn5250.disconnect", {}).catch(() => undefined);
    await host.stop();
  }
});

test("tools: hidden field input is redacted for logs, stored password fills only hidden fields", async () => {
  const host = await startFakeHost();
  const { ctx, state } = fakeContext(host.port, { readOnlyMode: true });
  const realGetPassword = tn5250Deps.getPassword;
  tn5250Deps.getPassword = async () => "s3cret";
  try {
    // Read-only connections can still open and read a session, but not sign on.
    await assert.rejects(handleTool(ctx, "ibmi.tn5250.connect", { signOn: true }), /read-only mode/);
    state.readOnlyMode = false;
    const view = data(await handleTool(ctx, "ibmi.tn5250.connect", { timeoutMs: 5000 }));
    assert.equal(view.fields.length, 2);

    const pwArgs = { fieldId: "r7c53", value: "typed-secret" };
    assert.equal(redactModuleArgs(ctx, "ibmi.tn5250.setField", pwArgs).value, "***REDACTED***");
    assert.equal(pwArgs.value, "typed-secret", "caller's args are not mutated");
    assert.equal(redactModuleArgs(ctx, "ibmi.tn5250.setField", { fieldId: "r6c53", value: "DEVUSER" }).value, "DEVUSER");
    assert.equal(redactModuleArgs(ctx, "ibmi.tn5250.setField", { fieldId: "2", value: "x" }).value, "***REDACTED***");
    assert.equal(redactModuleArgs(ctx, "ibmi.tn5250.sendKeys", { text: "pw", cursorRow: 7, cursorCol: 55 }).text, "***REDACTED***");
    assert.equal(redactModuleArgs(ctx, "ibmi.tn5250.sendKeys", { text: "DEVUSER" }).text, "DEVUSER");
    assert.equal(redactModuleArgs(ctx, "ibmi.tn5250.setField", { fieldId: "r9c9", value: "unknown" }).value, "***REDACTED***");

    await assert.rejects(handleTool(ctx, "ibmi.tn5250.setField", { fieldId: "r6c53", useStoredPassword: true }), /only fill a hidden/);
    const filled = data(await handleTool(ctx, "ibmi.tn5250.setField", { fieldId: "r7c53", useStoredPassword: true }));
    assert.equal(filled.fields[1].hasValue, true);
    assert.equal(JSON.stringify(filled).includes("s3cret"), false);

    await assert.rejects(handleTool(ctx, "ibmi.tn5250.setField", { fieldId: "r6c53", value: "ABCDEFGHIJK" }), /holds 10/);
    await assert.rejects(handleTool(ctx, "ibmi.tn5250.sendKeys", { keys: "Enter Tab" }), /must be the last key/);
    await assert.rejects(handleTool(ctx, "ibmi.tn5250.sendKeys", { keys: "Bogus" }), /Unsupported key/);

    const reused = data(await handleTool(ctx, "ibmi.tn5250.connect", {}));
    assert.equal(reused.reused, true);

    // ibmi.disconnect closes the 5250 session too.
    ctx.disconnect = async () => undefined;
    await handleTool(ctx, "ibmi.disconnect", { connectionName: "DEV" });
    await assert.rejects(handleTool(ctx, "ibmi.tn5250.readScreen", {}), /not found/);
  } finally {
    tn5250Deps.getPassword = realGetPassword;
    await handleTool(ctx, "ibmi.tn5250.disconnect", {}).catch(() => undefined);
    await host.stop();
  }
});

test("tools: TLS session pins a self-signed certificate and offers auto sign-on", async () => {
  const host = await startFakeHost({ secure: true, firstScreen: mainMenu() });
  const { ctx } = fakeContext(host.port);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tn5250-tls-"));
  const filePath = path.join(dir, "known_tls_certs.json");
  const real = { getPassword: tn5250Deps.getPassword, checkCertificate: tn5250Deps.checkCertificate };
  tn5250Deps.getPassword = async () => "s3cret";
  tn5250Deps.checkCertificate = info => checkTlsCertificate({ ...info, filePath, acceptNew: "" });
  try {
    const view = data(await handleTool(ctx, "ibmi.tn5250.connect", { tls: true, signOn: true, timeoutMs: 5000 }));
    assert.equal(view.tls, true);
    assert.equal(view.signOn.method, "telnet-environment");
    assert.equal(view.signOn.stillOnSignOnScreen, false);
    assert.match(view.text[0], /Main Menu/);
    const env = host.env[0].toString("latin1");
    assert.match(env, /USERDEVUSER/);
    assert.match(env, /IBMSUBSPWs3cret/);
    const pinned = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.match(pinned.hosts[`127.0.0.1:${host.port}`].fingerprint, /^SHA256:/);
  } finally {
    Object.assign(tn5250Deps, real);
    await handleTool(ctx, "ibmi.tn5250.disconnect", {}).catch(() => undefined);
    await host.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("plain telnet never offers the password in the telnet negotiation", async () => {
  const host = await startFakeHost({ onRecord: record => (record.data[2] === 0xf1 ? mainMenu() : undefined) });
  const { ctx } = fakeContext(host.port);
  const realGetPassword = tn5250Deps.getPassword;
  tn5250Deps.getPassword = async () => "s3cret";
  try {
    await handleTool(ctx, "ibmi.tn5250.connect", { signOn: true, timeoutMs: 5000 });
    assert.doesNotMatch(host.env[0].toString("latin1"), /IBMSUBSPW|s3cret/);
  } finally {
    tn5250Deps.getPassword = realGetPassword;
    await handleTool(ctx, "ibmi.tn5250.disconnect", {}).catch(() => undefined);
    await host.stop();
  }
});

test("tn5250 tool definitions are annotated and describe a real 5250 session", () => {
  const tools = getTools().filter(t => t.name.startsWith("ibmi.tn5250."));
  assert.deepEqual(tools.map(t => t.name).sort(), [
    "ibmi.tn5250.connect", "ibmi.tn5250.disconnect", "ibmi.tn5250.readScreen", "ibmi.tn5250.sendKeys",
    "ibmi.tn5250.setField", "ibmi.tn5250.snapshot", "ibmi.tn5250.waitFor"
  ]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.ok(tool.inputSchema.properties.connectionName, tool.name);
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", tool.name);
    assert.equal(tool.annotations.openWorldHint, false, tool.name);
    assert.doesNotMatch(tool.description, /simulated/i);
  }
  assert.equal(tools.find(t => t.name === "ibmi.tn5250.sendKeys").annotations.destructiveHint, true);
});
