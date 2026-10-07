import type { McpContext } from "../context.js";
import { tn5250Module } from "./tn5250.js";

/**
 * A group of tools that lives in its own file. getTools() appends every
 * module's definitions, and handleTool() routes calls for those names to the
 * module's handler, so new tool groups never have to edit the big switch.
 */
export type ToolModule = {
  tools: Array<{ name: string; description: string; inputSchema: Record<string, any>; annotations?: Record<string, any> }>;
  handle: (ctx: McpContext, name: string, args: any) => Promise<any>;
  /**
   * Optional: rewrite a call's arguments before they are logged or audited,
   * for secrets only the module can recognise. Must not mutate `args`.
   */
  redactArgs?: (ctx: McpContext, name: string, args: any) => any;
  /** Optional: called after ibmi.disconnect / ibmi.session.terminate (undefined name = all). */
  onDisconnect?: (connectionName?: string) => void;
};

// Feature modules register here, one import and one array entry each.
export const toolModules: ToolModule[] = [tn5250Module];

export function findToolModule(name: string): ToolModule | undefined {
  return toolModules.find(module => module.tools.some(tool => tool.name === name));
}

/** Arguments with module-specific secrets removed, ready for generic redaction. */
export function redactModuleArgs(ctx: McpContext, name: string, args: any) {
  const module = findToolModule(name);
  if (!module?.redactArgs) return args;
  try {
    return module.redactArgs(ctx, name, args);
  } catch {
    return args;
  }
}

export function notifyModulesOfDisconnect(connectionName?: string) {
  for (const module of toolModules) {
    try {
      module.onDisconnect?.(connectionName);
    } catch {
      // a module's cleanup must not break disconnecting
    }
  }
}
