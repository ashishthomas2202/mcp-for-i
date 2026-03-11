# MCP-for-i

Local MCP server for IBM i, mirroring core Code for IBM i capabilities. See `docs/` for setup and usage.

## Install As CLI Package

Install globally:

```bash
npm i -g mcp-for-i
```

Run control-plane UI server:

```bash
mcp-for-i-control serve
```

Then open:

```text
http://127.0.0.1:3980
```

### Background Startup (Windows)

Configure autostart at login and launch now:

```bash
mcp-for-i-control setup
```

Check status:

```bash
mcp-for-i-control status
```

Disable autostart:

```bash
mcp-for-i-control remove
```

## Control Plane UI

Run the local onboarding/control UI:

```bash
npm run start:controlplane
```

Then open `http://127.0.0.1:3980`.
