#!/usr/bin/env node
import { startControlPlaneServer } from "./server.js";

const server = await startControlPlaneServer();
process.stderr.write(`mcp-for-i control plane running at http://${server.host}:${server.port}\n`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
