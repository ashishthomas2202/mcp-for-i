# MCP-for-i

`mcp-for-i` is a local MCP server + control plane for IBM i workflows. It provides secure connection onboarding, keychain-backed credentials, cross-platform runtime update controls, and IBM i tools for agent-driven operations.

## Install

The npm package name is `mcp-for-i`.

Install globally from npm:

```bash
npm i -g mcp-for-i
```

Verify commands:

```bash
mcp-for-i --help
mcp-for-i-control help
```

Supported shells and terminals include PowerShell, `cmd`, Git Bash, Bash, Zsh, and WSL shells, across Windows, macOS, and Linux.

## Quick Start

1. Open the local control plane:

```bash
mcp-for-i control
```

`mcp-for-i control` will start the control server in the background if needed, then open the UI. If a browser cannot be opened in the current environment, it prints the local URL instead.

2. The default local UI URL is:

```text
http://127.0.0.1:3980
```

3. Add IBM i connection profiles in the UI. Passwords are stored in the OS keychain, not plain config.

WSL note: persistent password storage requires a working Linux Secret Service inside the WSL distro. WSL does not automatically use Windows Credential Manager; when no keychain is available, MCP-for-i keeps passwords only for the current process and the control plane shows a warning.

Credential storage adapts to the Node runtime: Windows Node from PowerShell, `cmd`, or Git Bash uses Windows Credential Manager; macOS uses Keychain; Linux uses Secret Service; WSL uses the WSL distro's Linux Secret Service.

## Control Commands

From an npm install or a git checkout build, these commands are the supported control entrypoints:

```bash
mcp-for-i control
mcp-for-i control status
mcp-for-i control enable
mcp-for-i control disable
```

Equivalent direct control-plane binary commands:

```bash
mcp-for-i-control open
mcp-for-i-control status
mcp-for-i-control enable
mcp-for-i-control disable
mcp-for-i-control serve
```

Behavior by environment:
- Windows: `enable` registers a Startup entry.
- macOS: `enable` registers a LaunchAgent.
- Linux: `enable` uses a user `systemd` service when available.
- WSL: `enable` installs a guarded `.bashrc` hook that starts the control plane on interactive Bash shell launch.

## Add To Coding Clients

The control-plane UI now includes a `Clients` tab with one-click setup for:
- `Codex Desktop / CLI`
- `Claude Code` when the `claude` CLI is installed
- `VS Code / GitHub Copilot` when the `code` CLI is installed

It also includes manual guidance for:
- `Project Bob`
- other MCP clients that use generic JSON/TOML stdio server configuration

The UI writes or invokes the local client-specific setup on the same machine where the control plane is running. If a client CLI is not installed, the UI falls back to showing the exact launch command/snippet to use manually.

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

## Control Plane Updates

The control plane intentionally stays narrow:

- `Update MCP`
  - If running from a git checkout: pulls latest changes from `origin/<current-branch>`, then installs/builds.
  - If running as an npm-installed package: upgrades the global npm package to latest.
  - On Windows global installs, update still runs in a detached updater to avoid file-lock (`EBUSY`) errors during self-update.
- `Update Skills`
  - Pulls or clones the configured skills repository and branch into the local `skills` directory.

For npm installs and manual upgrades, prefer standard npm commands such as `npm i -g mcp-for-i@latest`.

## Development (Git Checkout)

For contributors working from source:

```bash
npm install
npm run build
npm test
npm run start:controlplane
```

You can also use the built artifacts directly after build:

```bash
node dist/index.js
node dist/index.js control
node dist/controlplane/index.js open
```

## Automated Release (No Manual Version Bump)

Use the release script instead of raw `npm publish`. The script publishes the `mcp-for-i` npm package.

Before releasing, verify npm auth and the currently published version:

```bash
npm whoami
npm view mcp-for-i version
```

If `npm whoami` fails, run `npm login` first.

Patch release:

```bash
npm run release:patch
```

Minor release:

```bash
npm run release:minor
```

Major release:

```bash
npm run release:major
```

What it does:
- Verifies git working tree is clean.
- Runs `npm test` (unless `--skip-tests` is passed).
- Checks npm published version.
- Auto-bumps version only when local version is not ahead.
- Publishes to npm.
- Pushes commit/tag to GitHub.

Optional flags:

```bash
npm run release:patch -- --skip-tests
npm run release:patch -- --otp=123456
npm run release:patch -- --no-push
```

OTP is only needed when the npm account has two-factor authentication enabled for publishing. If npm asks for a one-time password, use the current code from the authenticator app or recovery method configured on the npm account, then rerun with `--otp=<code>`. If the account does not have publish-time 2FA enabled, no OTP is needed.

## Security Model

- Credential-bearing direct tool arguments are blocked for connection creation/update flows.
- Passwords are stored in keychain when available; failed or missing keychain access falls back to process-only session storage with a visible control-plane warning.
- Control plane is local-first (`127.0.0.1` by default).
- Guarded policy profile is the default for operational safety.
- Tool schemas are strict (`additionalProperties: false`) with runtime argument validation, including nested connection/action/filter/profile payloads.
- QSYS object names and source settings are validated before command execution to reduce interpolation and injection risk.

## Fast Source Investigation

The existing member tools remain compatible: an unchanged `ibmi.qsys.members.list` call still returns an array, and an unchanged `ibmi.qsys.members.read` call still returns source text. New callers can opt into faster, bounded workflows:

- `ibmi.session.bootstrap` returns connection, release, library-list, policy, transport, and capability information in one call.
- `ibmi.source.resolve` finds an exact member across likely source files without returning an entire source-file inventory.
- `ibmi.source.inspect` performs up to eight metadata, outline, search, range-read, and dependency operations over one consistent member snapshot.
- `ibmi.qsys.members.list` supports exact/prefix/contains/source-type/change-time filtering and keyset paging with `responseFormat: "page"`.
- `ibmi.qsys.members.read` supports ranges, context, metadata, SHA-256, and version checks with `responseFormat: "structured"`.
- `ibmi.qsys.members.write` accepts `expectedVersion` or `expectedSha256` to prevent a stale analysis from overwriting newer source.

Source-date reads use an ephemeral `QTEMP` alias in the same database job. If that path is unavailable, the server falls back to a complete UTF-8 `CPYTOSTMF` read; it never reconstructs a member from search matches.

## IBM i Documentation

`ibmi.docs.search` and `ibmi.docs.open` provide a release-aware, cached catalog of allowlisted official IBM documentation. The same catalog and topic content are exposed as MCP resources under `ibmi-docs://`. Documentation results include their official canonical URL, content version/checksum, and observation time. When local coverage is insufficient, search results explicitly recommend a web fallback instead of presenting cached material as exhaustive.

## Links

- Main repo: [ashishthomas2202/mcp-for-i](https://github.com/ashishthomas2202/mcp-for-i)
- Skills repo: [ashishthomas2202/mcp-for-i-skills](https://github.com/ashishthomas2202/mcp-for-i-skills)
- Docs: `docs/`
- Full capability guide: `docs/capabilities.md`
