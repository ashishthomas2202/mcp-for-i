/**
 * Secret redaction for logs and audit records.
 *
 * Keys are matched case-insensitively by substring, so `newPassword`,
 * `db_pwd` and `apiKey` are all caught. String values are also scanned for
 * secrets embedded in CL commands, SQL text and command lines.
 */

export const REDACTED = "***REDACTED***";

const SECRET_KEY_PARTS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "api-key",
  "privatekey",
  "private_key",
  "passphrase",
  "authorization",
  "signingkey",
  "credential"
];

export function isSecretKey(key: string): boolean {
  const lower = String(key || "").toLowerCase();
  return SECRET_KEY_PARTS.some(part => lower.includes(part));
}

const SECRET_WORDS = "[\\w-]*(?:password|passwd|pwd|secret|token|apikey|api_key|passphrase)[\\w-]*";

const TEXT_RULES: Array<{ pattern: RegExp; replace: (...groups: string[]) => string }> = [
  // CL keyword parameters: PASSWORD(x), PWD('x'), NEWPWD(x), OLDPWD(x), RMTPWD(x) ...
  {
    pattern: /\b([A-Z0-9]*PWD|PASSWORD|PASSWD|PASSPHRASE)(\s*\(\s*)('(?:[^']|'')*'|[^)]*)(\))/gi,
    replace: (_m, kw, open, _value, close) => `${kw}${open}${REDACTED}${close}`
  },
  // SQL: SET ENCRYPTION PASSWORD = 'x', PASSWORD 'x', ... USING 'x'
  {
    pattern: /\b(PASSWORD|USING)(\s*=?\s*)'(?:[^']|'')*'/gi,
    replace: (_m, kw, sep) => `${kw}${sep}'${REDACTED}'`
  },
  // Command-line flags: --password=x, --password x, -pwd x
  {
    pattern: new RegExp(`(?<![\\w-])(--?${SECRET_WORDS})(=|\\s+)("[^"]*"|'[^']*'|[^\\s,;&]+)`, "gi"),
    replace: (_m, flag, sep) => `${flag}${sep}${REDACTED}`
  },
  // key=value / key: value / "key":"value" pairs
  {
    pattern: new RegExp(`(\\b${SECRET_WORDS}"?)(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,;&"']+)`, "gi"),
    replace: (_m, key, sep) => `${key}${sep}${REDACTED}`
  },
  // HTTP authorization values
  {
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replace: (_m, scheme) => `${scheme} ${REDACTED}`
  }
];

/** Redact secrets embedded in a free-text value. */
export function redactSecretsInText(text: string): string {
  let out = String(text);
  for (const rule of TEXT_RULES) {
    out = out.replace(rule.pattern, (...args: any[]) => rule.replace(...(args.slice(0, -2) as string[])));
  }
  return out;
}

/** Deep-copy a value, redacting secret keys and secrets inside strings. */
export function redactSecrets(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(redactSecrets);
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : redactSecrets(value);
    }
    return out;
  }
  if (typeof input === "string") return redactSecretsInText(input);
  return input;
}
