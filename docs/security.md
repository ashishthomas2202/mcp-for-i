# Security

- Credentials are stored in OS keychain via `keytar` (Windows Credential Manager, macOS Keychain, Linux libsecret).
- Credential storage is selected at runtime from the Node process environment:
  - Windows Node from PowerShell, `cmd`, or Git Bash uses Windows Credential Manager.
  - macOS Node uses macOS Keychain.
  - Linux Node uses Linux Secret Service.
  - WSL Node is Linux and uses the WSL distro's Linux Secret Service, not Windows Credential Manager.
- Keychain availability is checked as an actual read operation, not only as a module import.
- In the default `auto` mode, if the keychain is unavailable or a keychain operation fails, credentials are stored in memory for the current process only.
- With `MCP_FOR_I_CREDENTIAL_STORE=keychain`, there is no in-memory fallback: saving, reading or deleting a password fails with an error when the keychain is unavailable.
- In WSL, `keytar` uses the Linux Secret Service inside the distro. It does not automatically use Windows Credential Manager. For persistent credentials in WSL, configure Linux libsecret/Secret Service, use SSH keys, or run MCP-for-i from Windows.
- Set `MCP_FOR_I_CREDENTIAL_STORE=session` to force process-only password storage.
- Passwords are never written to the config file.
- `readOnlyMode` refuses every tool that changes the system: member and IFS writes, `ibmi.sql.execute`, `ibmi.cl.run`, `ibmi.tn5250.sendKeys`, `ibmi.actions.run`, and destructive data-queue receives.
- Connection policies support `read-only`, `guarded`, and `power-user` modes.
- Guarded mode requires `approve: true` for configured risky operations.
- Command, library and IFS path allow/deny lists are enforced. CL command names are normalized (trimmed, uppercased, library qualifier removed) before matching, and the command lists also apply to the expanded command of `ibmi.actions.run` and to CL embedded in SQL (`@` lines and `QCMDEXC`). See [configuration](configuration.md) for the exact rules.
- `ibmi.tn5250.*` is a CL command console, not a 5250 emulator. Every command entered goes through the same read-only and command-policy checks as `ibmi.cl.run`.

## Control plane

The local control plane (`mcp-for-i control`) only accepts requests from its own Web UI and CLI:

- A random per-install token is created on first start and stored next to the config file as `controlplane.token` (owner-only file mode where the platform supports it). Every `/api` call must send it in the `X-MCP-For-I-Token` header. The Web UI gets it in the page it is served; the CLI reads it from the file. Delete the file and restart the control plane to rotate it.
- `GET /api/health` answers without the token so launchers can check liveness, but it only returns `{ ok, service }` unless the token is sent.
- The `Host` header must be `localhost`, `127.0.0.1` or `[::1]` with the control-plane port (blocks DNS rebinding), and a cross-origin `Origin` header is rejected.
- Request bodies must be `application/json` and at most 1 MB (larger bodies get `413`).
- Changing a saved connection's host, port or username requires entering its password again in the same request, so a stored password cannot be redirected to another server. Adding a connection never overwrites an existing one.
- Skills updates only accept `https://`, `ssh://` or `user@host:path` repository URLs and branch names that follow git's ref-name rules.
- Update and service jobs return `202` right away; poll `GET /api/runtime/status` for progress.

## SSH host key verification

- The first time a host is connected, its SSH host key fingerprint (OpenSSH `SHA256:...` format) is stored per `host:port` in `known_hosts.json` in the mcp-for-i config directory (the folder that holds `config.json`: `%APPDATA%\mcp-for-i` on Windows, `~/Library/Application Support/mcp-for-i` on macOS, `$XDG_CONFIG_HOME/mcp-for-i` or `~/.config/mcp-for-i` on Linux).
- On every later connection the presented key must match. If it does not, the connection is refused with an error showing the stored and presented fingerprints. This can mean a man-in-the-middle attack.
- To accept a key change that you expect (system rebuilt, SSH keys regenerated), compare the new fingerprint with the one on the IBM i (run `ssh-keygen -lf` on the host key `.pub` file in the OpenSSH `etc` directory there), then either:
  - set `MCP_FOR_I_ACCEPT_NEW_HOSTKEY` for one start of the server and connect again, then unset it. Accepted values, comma separated: `host:port` or `host` (that host only), the new `SHA256:...` fingerprint (only that key), or `1`/`true` (any host; avoid this); or
  - remove the host's entry from `known_hosts.json`; the next connection trusts the key it sees.
- A damaged `known_hosts.json` is never silently reset; connections fail until it is fixed or removed.

## SQL handling

- SQL text is sent to QZDFMDB2 on the SSH channel's standard input. It is never placed inside the shell command line.
- `ibmi.sql.query` accepts exactly one `SELECT`, `WITH` or `VALUES` statement (an optional trailing `;` is allowed). It rejects:
  - more than one statement;
  - lines starting with `@` (these run CL commands through QCMDEXC);
  - any reference to `QCMDEXC`;
  - data-change table references such as `FINAL TABLE (INSERT ...)`, `NEW TABLE (UPDATE ...)` and `OLD TABLE (DELETE ...)`;
  - unterminated strings or comments, and a `;` inside a string or comment (QZDFMDB2 splits statements on `;` itself).
- The check is lexical. A `SELECT` can still call a user-defined function that changes data; use object authority and a read-only connection profile to restrict that.

## Local file access

Tools that touch files on your PC only accept paths inside the allowed local roots (default: the working directory and your home directory). Paths are fully resolved, including `..` and symlinks, before the check. Credential stores such as `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/*/credentials`, the mcp-for-i config directory and (on Windows) `%APPDATA%` are always refused. Set `MCP_FOR_I_ALLOWED_LOCAL_ROOTS` or `settings.allowedLocalRoots` to narrow or change the roots. Files inside a directory passed to `ibmi.deploy.uploadDirectory` are uploaded as they are found; keep symlinks to outside locations out of deploy folders.

## IFS deletes

`ibmi.ifs.delete` refuses empty or relative paths, paths containing `..` or wildcards, `/`, any top-level directory, `/QSYS.LIB/<lib>.LIB`, second-level directories under `/QOpenSys` and `/QIBM`, and IBM product and system library locations.

## Shell quoting

Action commands in the `ile` environment are passed to `system` as a single-quoted shell word, so quotes, backticks and `$` in a command or target path cannot start another shell command. Streamfile action targets must be absolute IFS paths without quotes, backticks, `$`, backslashes, `;`, `|`, `&`, `<`, `>` or control characters.

## Secret redaction

Logs and audit records redact secrets by key name (case-insensitive substring match on `password`, `passwd`, `pwd`, `secret`, `token`, `apikey`, `privatekey`, `passphrase`, `authorization` and similar) and inside values: CL parameters such as `PASSWORD(...)`, `PWD(...)`, `NEWPWD(...)` and `CURPWD(...)`, SQL `PASSWORD '...'`, `SET ENCRYPTION PASSWORD` and `USING '...'`, command-line flags like `--password=...`, `key=value` pairs and `Bearer` tokens.

## Audit log integrity
- Every tool call is appended to a hash chain. New records (`version: 2`) carry a sequence number and are signed with HMAC-SHA256 using a per-install key (`tool-audit.key`, owner-only permissions), so the chain cannot be recomputed without the key.
- A signed anchor file records the first record hash, the last sequence number and the last hash. `ibmi.audit.verify` uses it to detect records removed from the start or the end of the log, sequence gaps, edited records, and a modified or missing anchor. If the anchor has to be rebuilt, the rebuild is recorded and keeps being reported by verify.
- Records written by older versions (`version: 1`, unkeyed) are verified with the old algorithm and reported as a `legacy` segment. An unkeyed record after keyed records is reported as a failure.
- Appends, purges and verification take a lock file, and the previous hash is read from the log under that lock, so several MCP processes extend one chain. A failed append is reported to the caller and does not stop later appends.
- Purges run inside the same lock and keep the remaining records unchanged; the anchor is moved to the new first record.
- `ibmi.audit.list` and `ibmi.audit.export` skip unparseable lines and return their count as `skippedLines`; verify reports them as failures.
- The key file protects against edits by anyone who cannot read it. A local user or process with access to the key can still rewrite the log; copy exports to separate storage for stronger guarantees.
