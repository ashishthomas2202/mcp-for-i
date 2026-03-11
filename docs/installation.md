# Installation

## Prerequisites
- Node.js 18+ recommended
- IBM i SSH access (22)
- On Linux: `libsecret` (for keychain via `keytar`)

## Install
1. Clone or copy this repo
2. Install dependencies:
   - `npm install`
3. Build:
   - `npm run build`
4. Run:
   - `node dist/index.js`

## Control Plane UI (Onboarding + Updates)
Run local control plane:

- `npm run start:controlplane`

Open:

- `http://127.0.0.1:3980`

Use the UI to add/edit/delete/rename connections, manage keychain passwords, and run MCP/skills update actions.

## MCP (stdio) usage
Configure your MCP client (e.g., Codex CLI) to run `mcp-for-i` via stdio. Example (pseudo-config):

```json
{
  "mcpServers": {
    "mcp-for-i": {
      "command": "mcp-for-i"
    }
  }
}
```

If you run from source, use:

```json
{
  "command": "node",
  "args": ["C:/Users/pgmashish/projects/mcp/mcp-for-i/dist/index.js"]
}
```

## Logging (opt‑in)
Logging is **disabled by default**. Enable it via env vars or CLI flags:

- Env flags:
  - `MCP_FOR_I_LOG_ENABLED=1`
  - `MCP_FOR_I_LOG` = path to log file
  - `MCP_FOR_I_LOG_LEVEL` = `error|warn|info|debug` (default `info`)
  - `MCP_FOR_I_LOG_STDERR=1` to log to stderr (set `0` to disable)
- CLI flags (when running `node dist/index.js` directly):
  - `--log` (stderr, info level)
  - `--log-level=debug`
  - `--log-file=C:/path/to/log.txt`
