# Configuration

Config file is stored under the user config directory:
- Windows: `%APPDATA%\mcp-for-i\config.json`
- macOS: `~/Library/Application Support/mcp-for-i/config.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/mcp-for-i/config.json`

## Settings
Default settings (editable in the config file):
- `readOnlyMode`: boolean. When true, every tool that changes the system is refused, including `ibmi.sql.execute`, `ibmi.cl.run` and `ibmi.tn5250.sendKeys`.
- `tempLibrary`: string
- `tempDir`: string
- `autoClearTempData`: boolean
- `sourceFileCCSID`: string (default `*FILE`)
- `enableSourceDates`: boolean (Phase 2+)
- `homeDirectory`: string
- `libraryList`: string[]
- `currentLibrary`: string
- `customVariables`: list of `{ name, value }`
- `allowedLocalRoots`: string[] (global settings only; see "Local file access" below)

`tempLibrary` remains accepted for configuration compatibility. Source member reads and source-date writes now use job-local `QTEMP` objects and do not require a persistent `ILEDITOR` library.

## Local file access

Tools that read or write files on your PC (`ibmi.ifs.upload`, `ibmi.ifs.download`, `ibmi.deploy.*`, `ibmi.audit.export` and `ibmi.compliance.report.generate`) only accept local paths inside the allowed local roots. Paths are resolved first: `..` and `~` are expanded and symlinks are followed, so a link that points outside a root is refused.

Allowed roots, first match wins:
1. `MCP_FOR_I_ALLOWED_LOCAL_ROOTS`: a list of directories separated by the OS path delimiter (`;` on Windows, `:` elsewhere).
2. `allowedLocalRoots` in the global `settings` of `config.json`.
3. Default: the server's working directory and your home directory. A working directory that is a drive or filesystem root is ignored.

These locations are always refused, even inside an allowed root: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.config/gcloud`, `~/.config/gh`, any `credentials` file under `~/.config`, `~/.netrc`, `~/.git-credentials`, `~/.pgpass`, `~/.npmrc`, `~/.pypirc`, the mcp-for-i config directory, and on Windows `%APPDATA%` plus everything in `%LOCALAPPDATA%` except its `Temp` folder (macOS: `~/Library/Keychains`).

Example:
```json
{
  "settings": {
    "allowedLocalRoots": ["C:/work/ibmi-projects", "D:/exports"]
  }
}
```

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

Policy lists (all optional, matched case-insensitively):
- `denyCommands` / `allowCommands`: CL command names. A library qualifier is ignored on both sides, so `DLTLIB` also blocks `QSYS/DLTLIB` and `*LIBL/DLTLIB`. A trailing `*` makes a generic entry (`DLT*`). When `allowCommands` is not empty, only listed commands may run, and QSH/PASE commands are refused because they cannot be verified. The lists apply to `ibmi.cl.run`, `ibmi.tn5250.sendKeys`, the expanded command of `ibmi.actions.run`, and CL embedded in SQL (lines starting with `@` and `QCMDEXC` calls; a `QCMDEXC` call whose command is not a string literal is refused while a command list is set).
- `denyLibraries` / `allowLibraries`: library names, with optional trailing `*`. They apply to every tool argument that names a library (`library`, `journalLibrary`, `libraryList`, qualified `LIB/OBJ` values, `/QSYS.LIB/<lib>.LIB/...` paths). With `allowLibraries` set, special values such as `*LIBL` and generic names are refused because they cannot be checked.
- `denyPaths` / `allowPaths`: absolute IFS paths. An entry covers the path and everything below it; `*` matches within one path segment. With `allowPaths` set, relative paths are refused. Remote symlinks are not resolved.
- Deny entries always win over allow entries.

Example:
```json
"policy": {
  "profile": "guarded",
  "denyCommands": ["DLTLIB", "CLRLIB", "PWRDWNSYS"],
  "allowLibraries": ["DEV*", "QGPL", "QTEMP"],
  "allowPaths": ["/home/devuser", "/tmp"]
}
```

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
