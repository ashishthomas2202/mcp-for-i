# Configuration

Config file is stored under the user config directory:
- Windows: `%APPDATA%\mcp-for-i\config.json`
- macOS: `~/Library/Application Support/mcp-for-i/config.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/mcp-for-i/config.json`

### How the config file is written
- Defaults are created only when `config.json` does not exist (an empty file counts as missing).
- If the file exists but cannot be parsed, it is never overwritten. A copy is saved next to it as `config.json.corrupt-<timestamp>` and every config operation fails with an error naming the file, until the file is repaired or removed.
- Writes are atomic: the new content goes to a temporary file in the same folder, is flushed to disk, and is renamed over `config.json`. On Windows the rename is retried when antivirus or the search indexer briefly locks the file; there is no non-atomic fallback.
- Every change (connections, settings, actions, profiles) re-reads the file and writes it back while holding `config.json.lock`, so the MCP server, the control plane and the CLI can update the config at the same time without losing each other's changes. A lock left behind by a crashed process is taken over after 30 seconds, or immediately if its process no longer exists.

## Settings
Default settings (editable in the config file):
- `readOnlyMode`: boolean
- `tempLibrary`: string
- `tempDir`: string
- `autoClearTempData`: boolean
- `sourceFileCCSID`: string (default `*FILE`)
- `enableSourceDates`: boolean (Phase 2+)
- `homeDirectory`: string
- `libraryList`: string[]
- `currentLibrary`: string
- `customVariables`: list of `{ name, value }`

`tempLibrary` remains accepted for configuration compatibility. Source member reads and source-date writes now use job-local `QTEMP` objects and do not require a persistent `ILEDITOR` library.

## IBM Documentation

Official documentation needs no credentials. The built-in catalog covers IBM i 7.4, 7.5, and 7.6 roots for the site map, manuals, RPG, CL, APIs, IBM i SQL services, security, database performance, and IFS commands. Optional environment settings:

- `MCP_FOR_I_IBM_DOCS_SEEDS`: JSON array of additional `{ title, url, release, categories, keywords }` entries. Every URL is still restricted to `https://www.ibm.com/docs/`.
- `MCP_FOR_I_IBM_DOCS_CACHE_DIR`: override the local documentation cache directory.

`ibmi.docs.search` is local/indexed by default. Use `freshness: "prefer-live"` for a bounded refresh of matching catalog entries. `ibmi.docs.open` uses cached content by default; use `freshness: "require-live"` when a live fetch is required.

## Connections
Connections are stored without passwords. Passwords are stored in OS keychain (or in-session fallback). Each connection can include optional `settings` overrides.
The control plane health response and Overview page report whether password storage is persistent (`keychain`) or process-only (`session`).
WSL users should note that Linux Secret Service is separate from Windows Credential Manager; if WSL has no working keychain, passwords must be re-entered after the process exits.
Set `MCP_FOR_I_CREDENTIAL_STORE=session` to force process-only password storage even when a keychain is available.
Set `MCP_FOR_I_CREDENTIAL_STORE=keychain` to require the OS keychain. In this mode saving or reading a password fails with a clear error when the keychain is unavailable, instead of silently keeping the password in memory where other processes (for example the MCP server) cannot see it. The default mode (`auto`) keeps the in-memory fallback.
Older config files may contain a plaintext `password` on a connection. It is moved to the keychain when the config is loaded and removed from the file only after the keychain confirms it was stored. Without a persistent keychain the plaintext stays in the file (a warning is printed to stderr) and is moved on a later run once a keychain is available.
Connections can also define policy, for example:
- `read-only`
- `guarded` (default; approvals required for risky operations)
- `power-user`

Example:
```json
{
  "connections": [
    {
      "name": "DEV400",
      "host": "dev400.myco.com",
      "port": 22,
      "username": "DEVUSER",
      "privateKeyPath": "C:/keys/id_rsa",
      "settings": {
        "readOnlyMode": false
      },
      "policy": {
        "profile": "guarded",
        "requireApprovalFor": ["sql.write", "cl.run", "deploy.sync"]
      },
      "profiles": [
        {
          "name": "projectA",
          "currentLibrary": "PROJALIB",
          "libraryList": ["QSYS", "QGPL", "PROJALIB"],
          "customVariables": [{ "name": "ENV", "value": "DEV" }]
        }
      ],
      "currentProfile": "projectA"
    }
  ]
}
```

## Audit log files
The audit log lives in `<configDir>/audit/` (or next to `MCP_FOR_I_AUDIT_LOG_PATH` when set):
- `tool-audit.jsonl`: one record per tool call.
- `tool-audit.key`: per-install secret used to sign records (HMAC-SHA256), created on first use with owner-only permissions. Set `MCP_FOR_I_AUDIT_KEY_PATH` to keep it elsewhere. Losing or replacing it makes existing records unverifiable.
- `tool-audit.anchor.json`: signed checkpoint with the first record hash, the last sequence number and the last hash, updated on every append and purge.
- `tool-audit.head`: last record hash (kept for older versions).
- `tool-audit.lock`: held briefly while appending, purging or verifying, so several MCP processes write one chain.
