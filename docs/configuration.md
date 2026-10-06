# Configuration

Config file is stored under the user config directory:
- Windows: `%APPDATA%\mcp-for-i\config.json`
- macOS: `~/Library/Application Support/mcp-for-i/config.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/mcp-for-i/config.json`

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

## Control plane

- `MCP_FOR_I_CONTROL_HOST` (default `127.0.0.1`) and `MCP_FOR_I_CONTROL_PORT` (default `3980`) set where the control plane listens. The background-service launchers record the port configured when `mcp-for-i control enable` ran; the Bash launcher also honours `MCP_FOR_I_CONTROL_PORT` at start-up.
- The API token lives in `controlplane.token` in the same directory as `config.json`. See [security](security.md#control-plane).
