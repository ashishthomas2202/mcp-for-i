import { McpContext } from "./context.js";
import { LocalLanguageActions } from "../ibmi/LocalLanguageActions.js";
import { CompileTools } from "../ibmi/CompileTools.js";
import { Search } from "../ibmi/Search.js";
import { Action } from "../ibmi/types.js";
import { setPassword, deletePassword } from "../security/credentialStore.js";

export function getTools() {
  return [
    {
      name: "ibmi.connect",
      description: "Connect to an IBM i system.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Saved connection name" },
          host: { type: "string" },
          port: { type: "number", default: 22 },
          username: { type: "string" },
          password: { type: "string" },
          privateKeyPath: { type: "string" },
          storePassword: { type: "boolean", default: false }
        },
        required: []
      }
    },
    {
      name: "ibmi.disconnect",
      description: "Disconnect from the active IBM i system.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "ibmi.connections.list",
      description: "List saved IBM i connections.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "ibmi.connections.add",
      description: "Add a saved IBM i connection.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          host: { type: "string" },
          port: { type: "number", default: 22 },
          username: { type: "string" },
          password: { type: "string" },
          privateKeyPath: { type: "string" },
          settings: { type: "object" },
          storePassword: { type: "boolean", default: true }
        },
        required: ["name", "host", "username"]
      }
    },
    {
      name: "ibmi.connections.update",
      description: "Update a saved IBM i connection.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          host: { type: "string" },
          port: { type: "number" },
          username: { type: "string" },
          password: { type: "string" },
          privateKeyPath: { type: "string" },
          settings: { type: "object" },
          storePassword: { type: "boolean", default: false }
        },
        required: ["name"]
      }
    },
    {
      name: "ibmi.connections.delete",
      description: "Delete a saved IBM i connection.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"]
      }
    },
    {
      name: "ibmi.qsys.libraries.list",
      description: "List libraries.",
      inputSchema: { type: "object", properties: { filter: { type: "string" } } }
    },
    {
      name: "ibmi.qsys.objects.list",
      description: "List objects in a library.",
      inputSchema: {
        type: "object",
        properties: {
          library: { type: "string" },
          types: { type: "array", items: { type: "string" } }
        },
        required: ["library"]
      }
    },
    {
      name: "ibmi.qsys.sourcefiles.list",
      description: "List source physical files in a library.",
      inputSchema: {
        type: "object",
        properties: { library: { type: "string" } },
        required: ["library"]
      }
    },
    {
      name: "ibmi.qsys.members.list",
      description: "List members in a source file.",
      inputSchema: {
        type: "object",
        properties: { library: { type: "string" }, sourceFile: { type: "string" } },
        required: ["library", "sourceFile"]
      }
    },
    {
      name: "ibmi.qsys.members.read",
      description: "Read a member.",
      inputSchema: {
        type: "object",
        properties: { library: { type: "string" }, sourceFile: { type: "string" }, member: { type: "string" } },
        required: ["library", "sourceFile", "member"]
      }
    },
    {
      name: "ibmi.qsys.members.write",
      description: "Write a member.",
      inputSchema: {
        type: "object",
        properties: { library: { type: "string" }, sourceFile: { type: "string" }, member: { type: "string" }, content: { type: "string" } },
        required: ["library", "sourceFile", "member", "content"]
      }
    },
    {
      name: "ibmi.qsys.members.create",
      description: "Create a member.",
      inputSchema: {
        type: "object",
        properties: { library: { type: "string" }, sourceFile: { type: "string" }, member: { type: "string" }, srctype: { type: "string" } },
        required: ["library", "sourceFile", "member"]
      }
    },
    {
      name: "ibmi.qsys.members.rename",
      description: "Rename a member.",
      inputSchema: {
        type: "object",
        properties: { library: { type: "string" }, sourceFile: { type: "string" }, member: { type: "string" }, newMember: { type: "string" } },
        required: ["library", "sourceFile", "member", "newMember"]
      }
    },
    {
      name: "ibmi.qsys.members.delete",
      description: "Delete a member.",
      inputSchema: {
        type: "object",
        properties: { library: { type: "string" }, sourceFile: { type: "string" }, member: { type: "string" } },
        required: ["library", "sourceFile", "member"]
      }
    },
    {
      name: "ibmi.qsys.sourcefiles.create",
      description: "Create a source physical file.",
      inputSchema: {
        type: "object",
        properties: { library: { type: "string" }, sourceFile: { type: "string" }, rcdlen: { type: "number" } },
        required: ["library", "sourceFile"]
      }
    },
    {
      name: "ibmi.qsys.libraries.create",
      description: "Create a library.",
      inputSchema: { type: "object", properties: { library: { type: "string" } }, required: ["library"] }
    },
    {
      name: "ibmi.ifs.list",
      description: "List an IFS directory.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    },
    {
      name: "ibmi.ifs.read",
      description: "Read an IFS file.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    },
    {
      name: "ibmi.ifs.write",
      description: "Write an IFS file.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }
    },
    {
      name: "ibmi.ifs.mkdir",
      description: "Create an IFS directory.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    },
    {
      name: "ibmi.ifs.delete",
      description: "Delete an IFS file or directory.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, recursive: { type: "boolean" } }, required: ["path"] }
    },
    {
      name: "ibmi.ifs.upload",
      description: "Upload a local file to IFS.",
      inputSchema: { type: "object", properties: { localPath: { type: "string" }, remotePath: { type: "string" } }, required: ["localPath", "remotePath"] }
    },
    {
      name: "ibmi.ifs.download",
      description: "Download an IFS file to local path.",
      inputSchema: { type: "object", properties: { remotePath: { type: "string" }, localPath: { type: "string" } }, required: ["remotePath", "localPath"] }
    },
    {
      name: "ibmi.search.members",
      description: "Search in source members.",
      inputSchema: {
        type: "object",
        properties: {
          library: { type: "string" },
          sourceFile: { type: "string" },
          term: { type: "string" },
          members: { type: ["string", "array"], items: { type: "string" } }
        },
        required: ["library", "sourceFile", "term"]
      }
    },
    {
      name: "ibmi.search.ifs",
      description: "Search in IFS.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, term: { type: "string" } }, required: ["path", "term"] }
    },
    {
      name: "ibmi.find.ifs",
      description: "Find files by name in IFS.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, term: { type: "string" } }, required: ["path", "term"] }
    },
    {
      name: "ibmi.actions.list",
      description: "List available actions.",
      inputSchema: { type: "object", properties: { type: { type: "string" }, extension: { type: "string" } } }
    },
    {
      name: "ibmi.actions.run",
      description: "Run an action.",
      inputSchema: {
        type: "object",
        properties: {
          actionName: { type: "string" },
          action: { type: "object" },
          targetType: { type: "string", enum: ["member", "streamfile", "file"] },
          targetPath: { type: "string" },
          library: { type: "string" },
          sourceFile: { type: "string" },
          member: { type: "string" },
          extension: { type: "string" }
        },
        required: ["targetType", "targetPath"]
      }
    }
    ,
    {
      name: "ibmi.actions.save",
      description: "Create or update a custom action.",
      inputSchema: { type: "object", properties: { action: { type: "object" } }, required: ["action"] }
    },
    {
      name: "ibmi.actions.delete",
      description: "Delete a custom action by name.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
    }
  ];
}

export async function handleTool(ctx: McpContext, name: string, args: any) {
  switch (name) {
    case "ibmi.connect": {
      if (args?.name && !args?.host) {
        await ctx.connectByName(args.name);
        return result(`Connected to ${args.name}`);
      }
      const connection = {
        name: args.name || `${args.username}@${args.host}`,
        host: args.host,
        port: args.port || 22,
        username: args.username,
        password: args.password,
        privateKeyPath: args.privateKeyPath
      };
      if (args.storePassword && args.password) {
        await setPassword(connection.name, args.password);
      }
      await ctx.connect(connection);
      return result(`Connected to ${connection.name}`);
    }
    case "ibmi.disconnect": {
      await ctx.disconnect();
      return result("Disconnected");
    }
    case "ibmi.connections.list": {
      const list = await ctx.store.listConnections();
      return json(list);
    }
    case "ibmi.connections.add": {
      await ctx.store.upsertConnection({
        name: args.name,
        host: args.host,
        port: args.port || 22,
        username: args.username,
        privateKeyPath: args.privateKeyPath,
        settings: args.settings
      });
      if (args.storePassword && args.password) {
        await setPassword(args.name, args.password);
      }
      return result(`Connection ${args.name} saved`);
    }
    case "ibmi.connections.update": {
      const existing = await ctx.store.getConnection(args.name);
      if (!existing) throw new Error(`Connection ${args.name} not found`);
      await ctx.store.upsertConnection({
        ...existing,
        host: args.host ?? existing.host,
        port: args.port ?? existing.port,
        username: args.username ?? existing.username,
        privateKeyPath: args.privateKeyPath ?? existing.privateKeyPath,
        settings: args.settings ?? existing.settings
      });
      if (args.storePassword && args.password) {
        await setPassword(args.name, args.password);
      }
      return result(`Connection ${args.name} updated`);
    }
    case "ibmi.connections.delete": {
      await ctx.store.deleteConnection(args.name);
      await deletePassword(args.name);
      return result(`Connection ${args.name} deleted`);
    }
    case "ibmi.qsys.libraries.list": {
      const conn = ctx.ensureActive();
      const data = await conn.content.getLibraries(args.filter || "*");
      return json(data);
    }
    case "ibmi.qsys.objects.list": {
      const conn = ctx.ensureActive();
      const data = await conn.content.getObjectList(args.library, args.types || ["*ALL"]);
      return json(data);
    }
    case "ibmi.qsys.sourcefiles.list": {
      const conn = ctx.ensureActive();
      const data = await conn.content.getObjectList(args.library, ["*SRCPF"]);
      return json(data);
    }
    case "ibmi.qsys.members.list": {
      const conn = ctx.ensureActive();
      const data = await conn.content.getMemberList({ library: args.library, sourceFile: args.sourceFile });
      return json(data);
    }
    case "ibmi.qsys.members.read": {
      const conn = ctx.ensureActive();
      const content = await conn.content.downloadMemberContent(args.library, args.sourceFile, args.member);
      return result(content);
    }
    case "ibmi.qsys.members.write": {
      const conn = ctx.ensureActive();
      await conn.content.uploadMemberContent(args.library, args.sourceFile, args.member, args.content);
      return result("OK");
    }
    case "ibmi.qsys.members.create": {
      const conn = ctx.ensureActive();
      await conn.content.createMember(args.library, args.sourceFile, args.member, args.srctype);
      return result("OK");
    }
    case "ibmi.qsys.members.rename": {
      const conn = ctx.ensureActive();
      await conn.content.renameMember(args.library, args.sourceFile, args.member, args.newMember);
      return result("OK");
    }
    case "ibmi.qsys.members.delete": {
      const conn = ctx.ensureActive();
      await conn.content.deleteMember(args.library, args.sourceFile, args.member);
      return result("OK");
    }
    case "ibmi.qsys.sourcefiles.create": {
      const conn = ctx.ensureActive();
      await conn.content.createSourceFile(args.library, args.sourceFile, args.rcdlen || 112);
      return result("OK");
    }
    case "ibmi.qsys.libraries.create": {
      const conn = ctx.ensureActive();
      await conn.content.createLibrary(args.library);
      return result("OK");
    }
    case "ibmi.ifs.list": {
      const conn = ctx.ensureActive();
      const data = await conn.content.getFileList(args.path);
      return json(data);
    }
    case "ibmi.ifs.read": {
      const conn = ctx.ensureActive();
      const data = await conn.content.downloadStreamfileRaw(args.path);
      return result(Buffer.from(data).toString("utf8"));
    }
    case "ibmi.ifs.write": {
      const conn = ctx.ensureActive();
      await conn.content.writeStreamfileRaw(args.path, args.content);
      return result("OK");
    }
    case "ibmi.ifs.mkdir": {
      const conn = ctx.ensureActive();
      if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
      await conn.sendCommand({ command: `mkdir -p ${args.path}` });
      return result("OK");
    }
    case "ibmi.ifs.delete": {
      const conn = ctx.ensureActive();
      if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
      const flag = args.recursive ? "-rf" : "-f";
      await conn.sendCommand({ command: `rm ${flag} ${args.path}` });
      return result("OK");
    }
    case "ibmi.ifs.upload": {
      const conn = ctx.ensureActive();
      if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
      await conn.client!.putFile(args.localPath, args.remotePath);
      return result("OK");
    }
    case "ibmi.ifs.download": {
      const conn = ctx.ensureActive();
      await conn.client!.getFile(args.localPath, args.remotePath);
      return result("OK");
    }
    case "ibmi.search.members": {
      const conn = ctx.ensureActive();
      const members = args.members || "*";
      const data = await Search.searchMembers(conn, args.library, args.sourceFile, args.term, members, false);
      return json(data);
    }
    case "ibmi.search.ifs": {
      const conn = ctx.ensureActive();
      const data = await Search.searchIFS(conn, args.path, args.term);
      return json(data);
    }
    case "ibmi.find.ifs": {
      const conn = ctx.ensureActive();
      const data = await Search.findIFS(conn, args.path, args.term);
      return json(data);
    }
    case "ibmi.actions.list": {
      let actions = await listActions(ctx);
      if (args?.type) {
        actions = actions.filter(a => (a.type || "member") === args.type);
      }
      if (args?.extension) {
        const ext = String(args.extension).toUpperCase();
        actions = actions.filter(a => !a.extensions || a.extensions.includes("GLOBAL") || a.extensions.map(e => e.toUpperCase()).includes(ext));
      }
      return json(actions);
    }
    case "ibmi.actions.run": {
      const conn = ctx.ensureActive();
      const action = await resolveAction(ctx, args);
      if (!action) throw new Error("Action not found");

      const envVars: Record<string, string> = {};
      const targetPath = args.targetPath as string;
      const targetType = args.targetType as string;

      if (targetType === "file") {
        throw new Error("Local file actions are not supported in this MCP server (use streamfile or member).");
      }

      if (targetType === "streamfile") {
        envVars["&FULLPATH"] = targetPath;
        const base = targetPath.split("/").pop() || targetPath;
        envVars["&BASENAME"] = base;
        envVars["&NAME"] = base.includes(".") ? base.substring(0, base.lastIndexOf(".")) : base;
        envVars["&EXT"] = base.includes(".") ? base.substring(base.lastIndexOf(".") + 1) : "";
        envVars["&RELATIVEPATH"] = targetPath;
      }

      if (targetType === "member") {
        const lib = args.library;
        const src = args.sourceFile;
        const mbr = args.member || targetPath.split("/").pop();
        envVars["&LIBRARY"] = lib;
        envVars["&SRCFILE"] = src;
        envVars["&NAME"] = mbr;
        envVars["&EXT"] = args.extension || "";
        envVars["&FULLPATH"] = `${lib}/${src}/${mbr}`;
      }

      const resultCmd = await CompileTools.runCommand(conn, {
        command: action.command,
        environment: action.environment,
        env: envVars
      });

      return json(resultCmd);
    }
    case "ibmi.actions.save": {
      const action = args.action as Action;
      if (!action?.name) throw new Error("Action must include a name");
      await ctx.store.upsertAction(action);
      return result(`Action ${action.name} saved`);
    }
    case "ibmi.actions.delete": {
      await ctx.store.deleteAction(args.name);
      return result(`Action ${args.name} deleted`);
    }
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function listActions(ctx: McpContext) {
  const builtins = Object.values(LocalLanguageActions).flat();
  const custom = await ctx.store.listActions();
  return [...builtins, ...custom];
}

async function resolveAction(ctx: McpContext, args: any): Promise<Action | undefined> {
  if (args.action) return args.action as Action;
  if (!args.actionName) return undefined;
  const actions = await listActions(ctx);
  return actions.find(a => a.name === args.actionName);
}

function result(text: string) {
  return { content: [{ type: "text", text }] };
}

function json(obj: any) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}
