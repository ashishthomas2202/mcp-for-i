# Security

- Credentials are stored in OS keychain via `keytar` (Windows Credential Manager, macOS Keychain, Linux libsecret).
- Credential storage is selected at runtime from the Node process environment:
  - Windows Node from PowerShell, `cmd`, or Git Bash uses Windows Credential Manager.
  - macOS Node uses macOS Keychain.
  - Linux Node uses Linux Secret Service.
  - WSL Node is Linux and uses the WSL distro's Linux Secret Service, not Windows Credential Manager.
- Keychain availability is checked as an actual read operation, not only as a module import.
- If keychain is unavailable or a keychain operation fails, credentials are stored in memory for the current process only.
- In WSL, `keytar` uses the Linux Secret Service inside the distro. It does not automatically use Windows Credential Manager. For persistent credentials in WSL, configure Linux libsecret/Secret Service, use SSH keys, or run MCP-for-i from Windows.
- Set `MCP_FOR_I_CREDENTIAL_STORE=session` to force process-only password storage.
- Passwords are never written to the config file.
- `readOnlyMode` refuses every tool that changes the system: member and IFS writes, `ibmi.sql.execute`, `ibmi.cl.run`, `ibmi.tn5250.sendKeys`, `ibmi.actions.run`, and destructive data-queue receives.
- Connection policies support `read-only`, `guarded`, and `power-user` modes.
- Guarded mode requires `approve: true` for configured risky operations.
- Command, library and IFS path allow/deny lists are enforced. CL command names are normalized (trimmed, uppercased, library qualifier removed) before matching, and the command lists also apply to the expanded command of `ibmi.actions.run` and to CL embedded in SQL (`@` lines and `QCMDEXC`). See [configuration](configuration.md) for the exact rules.
- `ibmi.tn5250.*` is a CL command console, not a 5250 emulator. Every command entered goes through the same read-only and command-policy checks as `ibmi.cl.run`.

## Local file access

Tools that touch files on your PC only accept paths inside the allowed local roots (default: the working directory and your home directory). Paths are fully resolved, including `..` and symlinks, before the check. Credential stores such as `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/*/credentials`, the mcp-for-i config directory and (on Windows) `%APPDATA%` are always refused. Set `MCP_FOR_I_ALLOWED_LOCAL_ROOTS` or `settings.allowedLocalRoots` to narrow or change the roots. Files inside a directory passed to `ibmi.deploy.uploadDirectory` are uploaded as they are found; keep symlinks to outside locations out of deploy folders.

## IFS deletes

`ibmi.ifs.delete` refuses empty or relative paths, paths containing `..` or wildcards, `/`, any top-level directory, `/QSYS.LIB/<lib>.LIB`, second-level directories under `/QOpenSys` and `/QIBM`, and IBM product and system library locations.

## Shell quoting

Action commands in the `ile` environment are passed to `system` as a single-quoted shell word, so quotes, backticks and `$` in a command or target path cannot start another shell command. Streamfile action targets must be absolute IFS paths without quotes, backticks, `$`, backslashes, `;`, `|`, `&`, `<`, `>` or control characters.

## Secret redaction

Logs and audit records redact secrets by key name (case-insensitive substring match on `password`, `passwd`, `pwd`, `secret`, `token`, `apikey`, `privatekey`, `passphrase`, `authorization` and similar) and inside values: CL parameters such as `PASSWORD(...)`, `PWD(...)`, `NEWPWD(...)` and `CURPWD(...)`, SQL `PASSWORD '...'`, `SET ENCRYPTION PASSWORD` and `USING '...'`, command-line flags like `--password=...`, `key=value` pairs and `Bearer` tokens.
