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

## Connections
Connections are stored without passwords. Passwords are stored in OS keychain (or in-session fallback). Each connection can include optional `settings` overrides.

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
      }
    }
  ]
}
```
