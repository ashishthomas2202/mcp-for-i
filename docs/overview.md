# MCP-for-i Overview

MCP-for-i is a local MCP server that exposes IBM i operations as MCP tools. It mirrors the core capabilities of the Code for IBM i VS Code extension but is designed for agent-driven workflows (e.g., Codex CLI) over MCP stdio.

Key capabilities (Phase 1):
- Connect/disconnect to IBM i
- Browse libraries/objects/members
- Read/write members and IFS files
- Run compile actions (RPG/COBOL/C/CL/SQL)
- Search members and IFS

The server runs locally and connects to IBM i via SSH + QSH/PASE + SQL (QZDFMDB2).
