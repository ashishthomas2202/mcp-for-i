# Master Plan: Secure, Full-Capability MCP-for-i

## Vision
Build `mcp-for-i` into a production-grade IBM i agent platform where:
1. Secrets are managed outside LLM prompts.
2. Sessions stay warm with sliding inactivity timeout (default 30 minutes).
3. Tooling reaches broad user-equivalent capability (DB2, CL/QSYS/IFS, deploy, diagnostics, 5250 roadmap).
4. Policy is guarded-by-default with explicit approval for risky operations.
5. UI-driven onboarding and updates manage MCP + skills lifecycle.

## Locked Decisions
1. UI is part of onboarding/control-plane.
2. Full 5250 automation is in scope (phased delivery).
3. Default policy profile is `guarded`.
4. Session idle timeout defaults to 30 minutes and extends on use.
5. No IBM i-side service install is required.
6. Cross-platform target; Windows-first acceptable if sequencing demands.

## Phases

### Phase 0: Hardening + Build/Test Correctness
- Fix shell/SQL injection vectors and unsafe command interpolation.
- Add runtime tool-argument validation.
- Remove ESM/runtime defects.
- Make config writes queued/retry-safe and temp-file based.
- Split default tests (fast unit by default, full suite as explicit script).
- Improve repo hygiene defaults.

### Phase 1: Secure Onboarding UI + Local Control Plane
- UI for install, connection profile lifecycle, credential onboarding, update actions.
- Local control plane to mediate UI and MCP runtime.
- Secret isolation: no plaintext credential persistence; no credential-first chat flows.

### Phase 2: Session Lifecycle
- Multi-session tracking and keepalive.
- Sliding inactivity timeout + configurable TTL.
- Session tools: list/status/keepalive/terminate.

### Phase 3: Data/Execution Surface
- `ibmi.sql.query` (read-only + cursor pagination).
- `ibmi.sql.execute` (guarded write execution).
- `ibmi.cl.run` (guarded command execution).
- Diagnostics + ops primitives (`parseEvfevent`, `joblog`, spool read/list).

### Phase 4: Deploy + Diagnostics Parity
- Strengthen deploy compare/sync semantics.
- Add diagnostics normalization and robust action execution mapping.

### Phase 5: TN5250 Engine
- Connection, screen model, input primitives, waits/retries.
- Guardrails for risky interactive transactions.

### Phase 6: Agent Skills + Safe Autonomy
- Task-to-skill routing and safe autonomy controls.

### Phase 7: Packaging + Updater Distribution
- Installer/updater across Windows/macOS/Linux.
- GitHub-backed MCP and skills update channels with rollback safety.

## Current Status
- Phase 0: in progress (core injection/validation/build fixes landed; additional hardening pass still open)
- Phase 1: complete (control-plane UI + secure profile onboarding + keychain secret isolation + secret-arg blocking + legacy plaintext credential migration + post-launch UX polish: auto-reconnect after install/update, runtime version badges, clearer status, row-level delete)
- Pre-Phase-2 release prep: complete (npm metadata migration to personal GitHub account, npm/global-safe update behavior with Windows self-update scheduling, npm-facing docs refresh)
- Release automation: complete (one-command auto-bump + publish + tag push workflow via npm scripts)
- Phase 2: complete (pooled async session manager, sliding inactivity timeout, heartbeat + transient reconnect strategy, session tooling, and control-plane UI observability/settings)
- Phase 3: in progress (SQL/CL/joblog/spool/diagnostics tool surface added with guard hooks)
- Phase 4-7: pending
