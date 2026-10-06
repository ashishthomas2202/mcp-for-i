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
- Passwords are never written to the config file. Plaintext passwords found in older config files are moved to the keychain and removed from the file only after the keychain confirms the save; without a persistent keychain they are left in place (with a warning) rather than lost.
- The config file is written atomically with owner-only permissions, never overwritten after a failed read, and updated under a cross-process lock.
- `readOnlyMode` prevents write operations on members/IFS.
- Connection policies support `read-only`, `guarded`, and `power-user` modes.
- Guarded mode requires `approve: true` for configured risky operations.

## Audit log integrity
- Every tool call is appended to a hash chain. New records (`version: 2`) carry a sequence number and are signed with HMAC-SHA256 using a per-install key (`tool-audit.key`, owner-only permissions), so the chain cannot be recomputed without the key.
- A signed anchor file records the first record hash, the last sequence number and the last hash. `ibmi.audit.verify` uses it to detect records removed from the start or the end of the log, sequence gaps, edited records, and a modified or missing anchor. If the anchor has to be rebuilt, the rebuild is recorded and keeps being reported by verify.
- Records written by older versions (`version: 1`, unkeyed) are verified with the old algorithm and reported as a `legacy` segment. An unkeyed record after keyed records is reported as a failure.
- Appends, purges and verification take a lock file, and the previous hash is read from the log under that lock, so several MCP processes extend one chain. A failed append is reported to the caller and does not stop later appends.
- Purges run inside the same lock and keep the remaining records unchanged; the anchor is moved to the new first record.
- `ibmi.audit.list` and `ibmi.audit.export` skip unparseable lines and return their count as `skippedLines`; verify reports them as failures.
- The key file protects against edits by anyone who cannot read it. A local user or process with access to the key can still rewrite the log; copy exports to separate storage for stronger guarantees.
