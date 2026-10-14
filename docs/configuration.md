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
- `readOnlyMode`: boolean. When true, every tool that changes the system is refused, including `ibmi.sql.execute`, `ibmi.cl.run` and every AID key sent by `ibmi.tn5250.sendKeys`.
- `tempLibrary`: string
- `tempDir`: string
- `autoClearTempData`: boolean
- `sourceFileCCSID`: string (default `*FILE`)
- `enableSourceDates`: boolean (Phase 2+)
- `sourceReadMaxBytes`: number (default `2000000`): largest member, in UTF-8 bytes after trimming trailing blanks, that a full `members.read` returns. Larger members fail with `SOURCE_TOO_LARGE` and the agent is told to read line ranges or search instead. `0` disables the byte cap.
- `sourceReadMaxLines`: number (default `50000`): the same cap in lines. Checked against the catalog row count before any content is downloaded. `0` disables the line cap.
- `homeDirectory`: string
- `libraryList`: string[]
- `currentLibrary`: string
- `customVariables`: list of `{ name, value }`
- `sqlTransport`: `auto` (default), `mapepire` or `qzdfmdb2`. How SQL and SQL-run CL are executed; see "Persistent SQL job (Mapepire)" below.
- `mapepireMode`: `auto` (default), `daemon` or `ssh`.
- `mapepirePort`: number (default `8076`), the Mapepire server port for `daemon` mode.
- `mapepireServerPath`: path of `mapepire-server.jar` on the IBM i for `ssh` mode (default: `/QOpenSys/pkgs/lib/mapepire/mapepire-server.jar`, then `/opt/mapepire/lib/mapepire/mapepire-server.jar`).
- `mapepireJavaPath`: Java for `ssh` mode (default: the newest of jdk21, jdk17, jdk11, jdk80 under `/QOpenSys/QIBM/ProdData/JavaVM`).
- `allowedLocalRoots`: string[] (global settings only; see "Local file access" below)
- `tn5250Port`: number. TN5250 telnet port (default 23, or 992 when `tn5250Tls` is true).
- `tn5250Tls`: boolean. Use TLS for TN5250 (default true when the port is 992).
- `tn5250DeviceName`: string. Virtual device name requested for TN5250 sessions (1-10 characters).

`tempLibrary` remains accepted for configuration compatibility. Source member reads and source-date writes now use job-local `QTEMP` objects and do not require a persistent `ILEDITOR` library.

## Persistent SQL job (Mapepire)

By default every SQL statement (and every CL command run through SQL) starts a new QZDFMDB2 job over SSH, so a library list change, the current library, QTEMP objects and the job log are gone by the next call. When [Mapepire](https://mapepire-ibmi.github.io/) is installed on the IBM i, mcp-for-i keeps one database job per connection instead:

- The job is opened on the first SQL call of a session (not at connect time) and reused by `ibmi.sql.query`, `ibmi.sql.execute`, `ibmi.cl.run` (environment `ile`), `ibmi.joblog.get` and every other tool that runs SQL. Statements run one at a time in it.
- Before the first statement, the connection's `libraryList` and `currentLibrary` (from the active profile or settings) are applied with one `CHGLIBL LIBL(...) CURLIB(...)` (`CHGCURLIB` when the list is empty). It is applied again only when that setting changes, so a library list change made with `ibmi.cl.run` stays in effect until then.
- If a library in the setting does not exist (`CHGLIBL` then fails as a whole), the list is applied without it and `ibmi.session.status` shows `sqlJob.libraryListWarning` naming the missing libraries. SQL keeps working.
- Every CL command (`ibmi.cl.run`, `@` lines in SQL, a literal `CALL QSYS2.QCMDEXC('...')` statement, `ibmi.libl.*`) runs in this job, so its library list changes apply to later SQL and CL. Unqualified names resolve through the library list (system naming).
- `ibmi.libl.set`, `ibmi.libl.add`, `ibmi.libl.remove`, `ibmi.libl.setCurrent`, `ibmi.libl.move`, `ibmi.libl.prune`, `ibmi.libl.runProfileCommand` and `ibmi.profiles.activate` update the setting, so the next SQL or CL call uses the new list either way; `applyToJob: true` applies it immediately and returns any missing-library warning.
- `ibmi.joblog.get` reads this job's log (`QSYS2.JOBLOG_INFO('*')`), so it shows the messages of earlier calls. It leaves out `MCH3401 Cannot resolve to object PPTT`, which the database logs on every statement on some systems.
- Commitment control is off (`transaction isolation: none`), as with QZDFMDB2.
- When a `timeoutMs` is reached, the statement is cancelled on the IBM i with `QSYS2.CANCEL_SQL` (run from a separate QZDFMDB2 job). If it is still running 5 seconds later, the job is ended and a new one is opened on the next call (QTEMP and ad-hoc job changes are lost; the configured library list is applied again).
- If the job ends (network drop, server restart), the next call opens a new one. A read-only statement that was interrupted this way is retried once; a write is not retried.
- `ibmi.disconnect` and `ibmi.session.terminate` end the job. `ibmi.session.status` (field `sqlJob`) and `ibmi.session.bootstrap` (`transports.sqlJob`) show which transport is in use, the job name and the last error.
- Tools that run CL through a qsh `system` command (for example some source and object helpers) still run in their own job.

In `ssh` mode Mapepire first connects with its in-process CLI connection, which ignores the JDBC properties (so SQL naming) and runs each SQL request on its own thread; on IBM i the library list belongs to the thread, so a `CHGLIBL` run that way is lost when the request ends. mcp-for-i therefore switches the job to Mapepire's TCP technique right after it starts: a database host server job (`QZDASOINIT`, as in `daemon` mode) on the same system, signed on as the same user, where system naming applies and the library list persists. `sqlJob.technique` in `ibmi.session.status` shows `tcp`. This needs the database host server (`*DATABASE`, `STRHOSTSVR`) to be running. If the switch fails the CLI connection is kept (`technique: cli`): CL still keeps its library list changes because it is sent as a Mapepire CL request, which runs on the thread later SQL requests inherit from, but SQL naming applies, so unqualified table names resolve to the current schema instead of the library list.

Without the persistent job (QZDFMDB2, every call a new job) the configured library list is still applied: each SQL batch starts with `@CHGLIBL LIBL(...) CURLIB(...)` in the same QZDFMDB2 job, and CL that falls back to a qsh `system` command gets it through the qsh `liblist` builtin first. The list is checked once per setting value (one extra call); libraries that do not exist are left out and reported in `sqlJob.libraryListWarning`. QZDFMDB2 uses SQL naming, so there unqualified table names resolve to the current schema (normally the user profile name), not the library list; qualify them or use the Mapepire job.

`sqlTransport`:
- `auto` (default): use Mapepire when it can be reached, otherwise QZDFMDB2. The first failure is remembered for the session, so later calls go straight to QZDFMDB2 without waiting; reconnect to try again.
- `mapepire`: always use Mapepire; SQL fails with the reason when it cannot be opened.
- `qzdfmdb2`: never use Mapepire (the previous behaviour).

`mapepireMode`:
- `daemon`: connects to the Mapepire server (`mapepirePort`, default 8076) over TLS with the connection's user and password. Needs a password; key-only connections cannot use it.
- `ssh`: starts `mapepire-server.jar` in single-user mode over the connection's existing SSH session (`java -jar ... --single`). Works with key-based logins and needs no open port or running service, only the JAR and Java on the IBM i. Startup takes a few seconds (one JVM per session). Nothing is uploaded to the IBM i.
- `auto` (default): `daemon` when the connection has a password, falling back to `ssh` if the server is not reachable; `ssh` for key-only connections.

The daemon's server certificate is trusted on first use: Mapepire generates a self-signed certificate, so its fingerprint is stored in `known_hosts.json` (under `certificates`) the first time and must match afterwards (see [security](security.md)). Certificates from a public CA are checked the normal way. Certificate errors are never ignored.

### Installing Mapepire on the IBM i

Mapepire is an open-source database server for IBM i. In short, from an SSH session with the IBM i open-source package manager (yum) installed, as a user allowed to install packages:

```sh
yum install mapepire-server        # installs /QOpenSys/pkgs/lib/mapepire/mapepire-server.jar
# daemon mode only: run it as a service with Service Commander
/QOpenSys/pkgs/bin/sc start mapepire
```

The daemon listens on port 8076 and needs Java 11 or later. For `ssh` mode the package install is enough; no service has to run. See the Mapepire documentation for running it at IPL, certificates and any port or exit-point rules at your site.

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
- `MCP_FOR_I_IBM_DOCS_CACHE_TTL_DAYS`: days before a cached documentation page is fetched again (default 7). An expired copy is still served, with a warning, when the refresh fails.

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

Policy lists (all optional, matched case-insensitively):
- `denyCommands` / `allowCommands`: CL command names. A library qualifier is ignored on both sides, so `DLTLIB` also blocks `QSYS/DLTLIB` and `*LIBL/DLTLIB`. A trailing `*` makes a generic entry (`DLT*`). When `allowCommands` is not empty, only listed commands may run, and QSH/PASE commands are refused because they cannot be verified. The lists apply to `ibmi.cl.run`, text on a recognised `===>` command line when `ibmi.tn5250.sendKeys` presses an AID key (other 5250 input cannot be checked; see [security](security.md)), the expanded command of `ibmi.actions.run`, and CL embedded in SQL (lines starting with `@` and `QCMDEXC` calls; a `QCMDEXC` call whose command is not a string literal is refused while a command list is set).
- `denyLibraries` / `allowLibraries`: library names, with optional trailing `*`. They apply to every tool argument that names a library (`library`, `journalLibrary`, `libraryList`, qualified `LIB/OBJ` values, `/QSYS.LIB/<lib>.LIB/...` paths). With `allowLibraries` set, special values such as `*LIBL` and generic names are refused because they cannot be checked.
- `denyPaths` / `allowPaths`: absolute IFS paths. An entry covers the path and everything below it; `*` matches within one path segment. With `allowPaths` set, relative paths are refused. Remote symlinks are not resolved.
- Deny entries always win over allow entries.

Approvals under `guarded`:
- `requireApprovalFor`: operations that ask the user first (default `["sql.write", "cl.run", "deploy.sync", "ifs.delete", "qsys.write"]`).
- `approvalMode`: `"prompt"` (default) asks the user through the MCP client and ignores the agent's `approve` flag. `"agent"` accepts `approve: true` from the agent instead, for clients that can't show prompts.
- The policy can only be changed in the web UI or in this file, not by the agent.

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

## Audit log files
The audit log lives in `<configDir>/audit/` (or next to `MCP_FOR_I_AUDIT_LOG_PATH` when set):
- `tool-audit.jsonl`: one record per tool call.
- `tool-audit.key`: per-install secret used to sign records (HMAC-SHA256), created on first use with owner-only permissions. Set `MCP_FOR_I_AUDIT_KEY_PATH` to keep it elsewhere. Losing or replacing it makes existing records unverifiable.
- `tool-audit.anchor.json`: signed checkpoint with the first record hash, the last sequence number and the last hash, updated on every append and purge.
- `tool-audit.head`: last record hash (kept for older versions).
- `tool-audit.lock`: held briefly while appending, purging or verifying, so several MCP processes write one chain.
