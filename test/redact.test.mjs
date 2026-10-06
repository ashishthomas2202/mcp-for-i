import test from "node:test";
import assert from "node:assert/strict";
import { isSecretKey, redactSecrets, redactSecretsInText } from "../dist/security/redact.js";
import { redact } from "../dist/mcp/logger.js";

test("secret key names are matched case-insensitively by substring", () => {
  for (const key of ["password", "newPassword", "db_pwd", "PASSWD", "apiKey", "API_KEY", "privateKeyPath", "passphrase", "accessToken", "clientSecret", "signingKey"]) {
    assert.ok(isSecretKey(key), key);
  }
  for (const key of ["path", "library", "keys", "messageKey", "command"]) {
    assert.ok(!isSecretKey(key), key);
  }
});

test("CL password parameters are redacted inside commands", () => {
  const out = redactSecretsInText("CHGUSRPRF USRPRF(BOB) PASSWORD(Secret1) TEXT('x')");
  assert.ok(!out.includes("Secret1"), out);
  assert.match(out, /USRPRF\(BOB\)/);
  assert.match(out, /TEXT\('x'\)/);

  const quoted = redactSecretsInText("CHGPWD CURPWD('old pw') NEWPWD('new)pw') ");
  assert.ok(!quoted.includes("old pw") && !quoted.includes("new)pw"), quoted);
  assert.ok(!redactSecretsInText("CRTUSRPRF USRPRF(A) pwd(abc123)").includes("abc123"));
});

test("SQL and command-line secrets are redacted", () => {
  const sql = redactSecretsInText("SET ENCRYPTION PASSWORD = 'hunter2'; CONNECT TO X USER U USING 'pw2'");
  assert.ok(!sql.includes("hunter2") && !sql.includes("pw2"), sql);
  assert.ok(!redactSecretsInText("SET ENCRYPTION PASSWORD 'abc'").includes("abc"));
  assert.ok(!redactSecretsInText("tool --password=topsecret --user x").includes("topsecret"));
  assert.ok(!redactSecretsInText("tool --password topsecret").includes("topsecret"));
  assert.ok(!redactSecretsInText("token=abcdef123 other=1").includes("abcdef123"));
  assert.ok(!redactSecretsInText('{"password":"p@ss"}').includes("p@ss"));
  assert.ok(!redactSecretsInText("Authorization: Bearer abcdefghijklmnop").includes("abcdefghijklmnop"));
  assert.equal(redactSecretsInText("DSPLIB LIB(QGPL)"), "DSPLIB LIB(QGPL)");
  assert.equal(redactSecretsInText("select * from qsys2.user_info"), "select * from qsys2.user_info");
});

test("redactSecrets redacts nested keys and string values", () => {
  const out = redactSecrets({
    command: "CHGUSRPRF USRPRF(A) PASSWORD(xyz)",
    nested: { newPassword: "abc", list: ["PWD(qq)"] },
    count: 3
  });
  assert.equal(out.nested.newPassword, "***REDACTED***");
  assert.ok(!JSON.stringify(out).includes("xyz"));
  assert.ok(!JSON.stringify(out).includes("qq)"));
  assert.equal(out.count, 3);
});

test("logger redaction covers values as well as keys", () => {
  const out = redact({ sql: "SET ENCRYPTION PASSWORD = 'zzz'", newPwd: "a" });
  assert.ok(!JSON.stringify(out).includes("zzz"));
  assert.equal(out.newPwd, "***REDACTED***");
});
