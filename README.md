# MCP-for-i

`mcp-for-i` is a local MCP server + control plane for IBM i workflows. It provides secure connection onboarding, keychain-backed credentials, runtime update controls, and IBM i tools for agent-driven operations.

## Install

Install globally from npm:

```bash
npm i -g mcp-for-i
```

Verify commands:

```bash
mcp-for-i --help
mcp-for-i-control help
```

## Quick Start

1. Start the local control plane:

```bash
mcp-for-i-control serve
```

2. Open the UI at:

```text
http://127.0.0.1:3980
```

3. Add IBM i connection profiles in the UI. Passwords are stored in the OS keychain, not plain config.

## Background Startup (Windows)

Enable startup at login:

```bash
mcp-for-i-control setup
```

Check status:

```bash
mcp-for-i-control status
```

Disable startup:

```bash
mcp-for-i-control remove
```

## Update and Version Management

Update to latest globally:

```bash
npm i -g mcp-for-i@latest
```

Install a specific version:

```bash
npm i -g mcp-for-i@0.1.1
```

Rollback example:

```bash
npm i -g mcp-for-i@0.1.0
```

Check current installed version:

```bash
mcp-for-i --version
```

## Control Plane Runtime Actions

In the UI, runtime buttons behave as follows:

- `Install/Repair MCP`
  - If running from a git checkout: runs local dependency repair/build.
  - If running as npm-installed package: runs global npm install/repair for latest package.
- `Update MCP`
  - If running from a git checkout: pulls latest changes from `origin/<current-branch>`, then installs/builds.
  - If running as npm-installed package: upgrades global npm package to latest.
- `Update Skills`
  - Pulls/clones the configured skills repository and branch into the local `skills` directory.

## Development (Git Checkout)

For contributors working from source:

```bash
npm install
npm run build
npm test
npm run start:controlplane
```

## Security Model

- Credential-bearing direct tool arguments are blocked for connection creation/update flows.
- Passwords are stored in keychain when available.
- Control plane is local-first (`127.0.0.1` by default).
- Guarded policy profile is the default for operational safety.

## Links

- Main repo: [ashishthomas2202/mcp-for-i](https://github.com/ashishthomas2202/mcp-for-i)
- Skills repo: [ashishthomas2202/mcp-for-i-skills](https://github.com/ashishthomas2202/mcp-for-i-skills)
- Docs: `docs/`
