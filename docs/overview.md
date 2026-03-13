# MCP-for-i Overview

MCP-for-i is a local MCP server and control plane that exposes IBM i operations as MCP tools for agent-driven workflows (Codex CLI/Desktop and other MCP clients).

Current platform scope includes:
- Secure onboarding and connection lifecycle management.
- Guarded policy and approval-gated operations.
- Session lifecycle controls with keepalive/reconnect behavior.
- QSYS, IFS, search, deploy, SQL/CL, diagnostics, and TN5250 command-session tooling.
- Audit-chain integrity features plus journaling and compliance-report tooling.
- IBM i operations-control tooling for spool/job/subsystem/message-queue lifecycles, lock/authority visibility, and data queue/data area operations.

For the complete up-to-date feature inventory, see:
- `docs/capabilities.md`
- `docs/tools.md`
