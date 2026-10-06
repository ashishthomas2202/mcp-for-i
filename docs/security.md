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
- `readOnlyMode` prevents write operations on members/IFS.
- Connection policies support `read-only`, `guarded`, and `power-user` modes.
- Guarded mode requires `approve: true` for configured risky operations.

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
