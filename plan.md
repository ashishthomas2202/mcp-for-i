# MCP-for-i (Client-Side MCP for IBM i) — Implementation Plan

## Summary
Build a local MCP server named `mcp-for-i` under `C:\Users\pgmashish\projects\mcp\mcp-for-i` that mirrors Code for IBM i capabilities, exposing them as MCP tools/resources so Codex CLI can perform the same IBM i operations. The server runs on the user’s laptop, connects to IBM i via SSH + QSH/PASE + SQL (when available), and stores credentials securely in OS keychain (via `keytar`). Phase 1 ships core operations + actions + search; subsequent phases add deploy, environment/profile management, library list tools, debug, and terminal emulation.

## Architecture Overview
- Runtime: Node.js + TypeScript
- MCP transport: stdio
- Core subsystems (ported/reused from Code for IBM i):
  - IBMiConnection (SSH, QSH/PASE command exec, SQL access)
  - IBMiContent (member/streamfile operations)
  - Actions + variable expansion
  - Search (members/IFS)
  - Diagnostics parsing (EVFEVENT)
- Persistence:
  - Config/settings in JSON under user config folder
  - Credentials in OS keychain via `keytar` (fallback to session-only if unavailable)
- Tooling:
  - MCP tools mirror Code for IBM i operations with minimal mapping layer

## Phase 1 Scope (Core + Actions + Search)
### Core Tools (MCP)
1. Connection
   - `ibmi.connect`
   - `ibmi.disconnect`
   - `ibmi.connections.list`
   - `ibmi.connections.add`
   - `ibmi.connections.update`
   - `ibmi.connections.delete`

2. QSYS / Member Operations
   - `ibmi.qsys.libraries.list`
   - `ibmi.qsys.objects.list`
   - `ibmi.qsys.sourcefiles.list`
   - `ibmi.qsys.members.list`
   - `ibmi.qsys.members.read`
   - `ibmi.qsys.members.write`
   - `ibmi.qsys.members.create`
   - `ibmi.qsys.members.rename`
   - `ibmi.qsys.members.delete`
   - `ibmi.qsys.sourcefiles.create`
   - `ibmi.qsys.libraries.create`

3. IFS Operations
   - `ibmi.ifs.list`
   - `ibmi.ifs.read`
   - `ibmi.ifs.write`
   - `ibmi.ifs.mkdir`
   - `ibmi.ifs.delete`
   - `ibmi.ifs.upload`
   - `ibmi.ifs.download`

4. Actions / Compile
   - `ibmi.actions.list`
   - `ibmi.actions.run`
   - `ibmi.actions.create/update/delete`
   - Built-in action set from Code for IBM i (RPG/COBOL/C/CL/SQL etc.)

5. Search
   - `ibmi.search.members`
   - `ibmi.search.ifs`
   - `ibmi.find.ifs`

6. Diagnostics
   - `ibmi.diagnostics.parseEvfevent`
   - Optionally `ibmi.diagnostics.fromServer` (if EVFEVENT table present)

### Resources (Optional in Phase 1)
- Expose `ibmi://` resources for quick listing of libraries, objects, IFS paths (read-only).

## Phase 2 Scope (Additions)
- Deployment tools (DeployTools, tar upload/extract, CCSID fixups)
- Environment profiles + custom variables
- Library list management
- Connection profile actions (set LIBL command)
- Go-To-File (agent version): resolve a member/IFS path with validation

## Phase 3 Scope (Advanced)
- Debug (batch + SEP, IBM i Debug integration via service)
- 5250 terminal emulation (PASE only for MCP; full 5250 may be out of scope for MCP)
- Sandbox URI handler equivalents (MCP auth flow)

## Detailed Implementation Steps

### 1) Create Project Skeleton
- Folder: `C:\Users\pgmashish\projects\mcp\mcp-for-i`
- Standard Node/TS project:
  - `package.json`
  - `tsconfig.json`
  - `src/` with `index.ts` MCP entrypoint
  - `src/mcp/` for tool registry
  - `src/ibmi/` for IBM i core logic (ported)

### 2) Port/Reuse Code for IBM i Core
Port (with minimal adaptation) from current Code for IBM i repo:
- `src/api/IBMi.ts`
- `src/api/IBMiContent.ts`
- `src/api/Search.ts`
- `src/api/CompileTools.ts`
- `src/api/variables.ts`
- `src/api/errors/parser.ts`
- `src/filesystems/local/LocalLanguageActions.ts`
- Any related helpers (Tools, QSYS path parsing)

Adjust:
- Remove VS Code dependencies
- Replace config and secret storage with MCP server config + `keytar`
- Replace UI flows with MCP input parameters

### 3) MCP Tool Layer
- Implement tool registry (`registerTools`)
- Each MCP tool maps 1:1 to a core function
- Normalize errors into MCP error payloads
- Validate inputs with JSON schema

### 4) Config & Storage
- Config stored in JSON:
  - Connections list
  - Settings: temp library, CCSID, readOnlyMode, source dates, etc.
- Credentials:
  - `keytar` for Windows/macOS/Linux
  - If keychain unavailable, fallback to “session only” (warn)

### 5) Security Model
- Store only encrypted credentials (keychain)
- Optional: allow “no-store” flag per connection
- Mask credentials in logs
- Enforce read-only mode if configured

### 6) Docs (in `/docs`)
- `docs/overview.md` — what MCP-for-i is
- `docs/installation.md` — setup, keychain deps (`libsecret` on Linux)
- `docs/configuration.md` — connections/settings
- `docs/tools.md` — full tool catalog + examples
- `docs/security.md` — credential handling
- `docs/examples.md` — Codex CLI examples and common flows

## Public API / Interface Changes
- Introduce MCP tool schema for each operation (see Phase 1 tool list).
- Configuration JSON schema for settings and connections.
- No UI; all actions are parameterized tools.

## Test Plan
### Unit Tests
- QSYS path parsing
- Variable expansion
- EVFEVENT parsing
- Action selection + filtering
- Search output parsing

### Integration Tests (optional but recommended)
- Connect to a test IBM i system
- Read/write member
- Run action (compile)
- Search members/IFS
- Download/upload IFS file

## Acceptance Criteria
- Codex CLI can connect via MCP and:
  - List libraries/objects/members
  - Read/write members and IFS files
  - Run compile actions
  - Search members/IFS
- Credentials stored securely (keychain)
- Cross-platform support (Windows, macOS, Linux; Linux requires libsecret)

## Assumptions & Defaults
- Transport: MCP stdio
- Stack: Node.js + TypeScript
- Security: keychain via `keytar`, fallback to session-only
- Phase 1 scope: core + actions + search
- No UI in MCP (programmatic tools only)
