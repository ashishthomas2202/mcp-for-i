import type { McpContext } from "../context.js";
import { bulkMembersModule } from "./bulkMembers.js";

/**
 * A group of tools that lives in its own file. getTools() appends every
 * module's definitions, and handleTool() routes calls for those names to the
 * module's handler, so new tool groups never have to edit the big switch.
 */
export type ToolModule = {
  tools: Array<{ name: string; description: string; inputSchema: Record<string, any>; annotations?: Record<string, any> }>;
  handle: (ctx: McpContext, name: string, args: any) => Promise<any>;
};

// Feature modules register here, one import and one array entry each.
export const toolModules: ToolModule[] = [
  bulkMembersModule
];

export function findToolModule(name: string): ToolModule | undefined {
  return toolModules.find(module => module.tools.some(tool => tool.name === name));
}
