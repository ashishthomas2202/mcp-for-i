import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { ConfirmationRequest, ConfirmHandler } from "./context.js";

/** How long a confirmation prompt waits for the person before the operation is refused. */
export const CONFIRMATION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Ask the person through the MCP client (elicitation) before a guarded
 * operation runs. Clients that don't support elicitation get "unsupported",
 * which refuses the operation.
 */
export function createElicitationConfirm(server: Server, timeoutMs = CONFIRMATION_TIMEOUT_MS): ConfirmHandler {
  return async request => {
    if (!server.getClientCapabilities()?.elicitation) return "unsupported";
    const result = await server.request(
      {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: confirmationMessage(request),
          requestedSchema: request.allowSession
            ? {
              type: "object",
              properties: {
                allowForSession: {
                  type: "boolean",
                  title: "Allow this kind of change on this connection until the server restarts",
                  default: false
                }
              }
            }
            : { type: "object", properties: {} }
        }
      },
      ElicitResultSchema,
      { timeout: timeoutMs }
    );
    return {
      allowed: result.action === "accept",
      forSession: result.action === "accept" && result.content?.allowForSession === true
    };
  };
}

export function confirmationMessage(request: ConfirmationRequest) {
  const what = request.operation === "shell.run"
    ? "run a shell command"
    : `perform a guarded operation (${request.operation})`;
  const lines = [`The agent wants to ${what} on IBM i connection "${request.connectionName || "(active)"}".`];
  if (request.toolName) lines.push(`Tool: ${request.toolName}`);
  lines.push(...request.details);
  lines.push("", "Accept to let it run. Decline to stop it.");
  return lines.join("\n");
}
