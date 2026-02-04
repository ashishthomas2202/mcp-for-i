# Security

- Credentials are stored in OS keychain via `keytar` (Windows Credential Manager, macOS Keychain, Linux libsecret).
- If keychain is unavailable, credentials are stored in memory for the current session only.
- Passwords are never written to the config file.
- `readOnlyMode` prevents write operations on members/IFS.
