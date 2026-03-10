import { McpContext } from "./context.js";
import { LocalLanguageActions } from "../ibmi/LocalLanguageActions.js";
import { CompileTools } from "../ibmi/CompileTools.js";
import { Search } from "../ibmi/Search.js";
import { Action } from "../ibmi/types.js";
import { setPassword, deletePassword } from "../security/credentialStore.js";
import fs from "fs/promises";
import path from "path";

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
    ,
    {
      name: "ibmi.libl.get",
      description: "Get current library list settings.",
      inputSchema: { type: "object", properties: { connectionName: { type: "string" } } }
    },
    {
      name: "ibmi.libl.set",
      description: "Set library list and/or current library.",
      inputSchema: {
        type: "object",
        properties: {
          connectionName: { type: "string" },
          libraryList: { type: "array", items: { type: "string" } },
          currentLibrary: { type: "string" },
          applyToJob: { type: "boolean", default: false }
        }
      }
    },
    {
      name: "ibmi.libl.add",
      description: "Add a library to the library list.",
      inputSchema: {
        type: "object",
        properties: { connectionName: { type: "string" }, library: { type: "string" }, applyToJob: { type: "boolean", default: false } },
        required: ["library"]
      }
    },
    {
      name: "ibmi.libl.remove",
      description: "Remove a library from the library list.",
      inputSchema: {
        type: "object",
        properties: { connectionName: { type: "string" }, library: { type: "string" }, applyToJob: { type: "boolean", default: false } },
        required: ["library"]
      }
    },
    {
      name: "ibmi.libl.setCurrent",
      description: "Set current library.",
      inputSchema: {
        type: "object",
        properties: { connectionName: { type: "string" }, library: { type: "string" }, applyToJob: { type: "boolean", default: false } },
        required: ["library"]
      }
    },
    {
      name: "ibmi.libl.validate",
      description: "Validate a library list.",
      inputSchema: {
        type: "object",
        properties: { libraryList: { type: "array", items: { type: "string" } } },
        required: ["libraryList"]
      }
    },
    {
      name: "ibmi.profiles.list",
      description: "List connection profiles.",
      inputSchema: { type: "object", properties: { connectionName: { type: "string" } } }
    },
    {
      name: "ibmi.profiles.save",
      description: "Create or update a connection profile.",
      inputSchema: {
        type: "object",
        properties: { connectionName: { type: "string" }, profile: { type: "object" } },
        required: ["profile"]
      }
    },
    {
      name: "ibmi.profiles.delete",
      description: "Delete a connection profile.",
      inputSchema: {
        type: "object",
        properties: { connectionName: { type: "string" }, name: { type: "string" } },
        required: ["name"]
      }
    },
    {
      name: "ibmi.profiles.activate",
      description: "Activate a profile for a connection.",
      inputSchema: {
        type: "object",
        properties: { connectionName: { type: "string" }, name: { type: "string" }, applyToJob: { type: "boolean", default: false } },
        required: ["name"]
      }
    },
    {
      name: "ibmi.resolve.path",
      description: "Resolve a member or IFS path and return details if it exists.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    },
    {
      name: "ibmi.deploy.uploadDirectory",
      description: "Upload a local directory to IFS.",
      inputSchema: {
        type: "object",
        properties: { localPath: { type: "string" }, remotePath: { type: "string" } },
        required: ["localPath", "remotePath"]
      }
    },
    {
      name: "ibmi.deploy.uploadFiles",
      description: "Upload local files to a remote directory.",
      inputSchema: {
        type: "object",
        properties: { localFiles: { type: "array", items: { type: "string" } }, remoteDirectory: { type: "string" } },
        required: ["localFiles", "remoteDirectory"]
      }
    },
    {
      name: "ibmi.deploy.setCcsid",
      description: "Set CCSID for a remote path (recursive).",
      inputSchema: {
        type: "object",
        properties: { remotePath: { type: "string" }, ccsid: { type: "string", default: "1208" } },
        required: ["remotePath"]
      }
    }
    ,
    {
      name: "ibmi.filters.list",
      description: "List object filters.",
      inputSchema: { type: "object", properties: { connectionName: { type: "string" } } }
    },
    {
      name: "ibmi.filters.save",
      description: "Create or update an object filter.",
      inputSchema: { type: "object", properties: { connectionName: { type: "string" }, filter: { type: "object" } }, required: ["filter"] }
    },
    {
      name: "ibmi.filters.delete",
      description: "Delete an object filter by name.",
      inputSchema: { type: "object", properties: { connectionName: { type: "string" }, name: { type: "string" } }, required: ["name"] }
    },
    {
      name: "ibmi.ifs.shortcuts.list",
      description: "List IFS shortcuts.",
      inputSchema: { type: "object", properties: { connectionName: { type: "string" } } }
    },
    {
      name: "ibmi.ifs.shortcuts.add",
      description: "Add an IFS shortcut.",
      inputSchema: { type: "object", properties: { connectionName: { type: "string" }, path: { type: "string" } }, required: ["path"] }
    },
    {
      name: "ibmi.ifs.shortcuts.delete",
      description: "Delete an IFS shortcut.",
      inputSchema: { type: "object", properties: { connectionName: { type: "string" }, path: { type: "string" } }, required: ["path"] }
    },
    {
      name: "ibmi.debug.status",
      description: "Check IBM i debug service status.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "ibmi.debug.startService",
      description: "Start IBM i debug service (best-effort).",
      inputSchema: { type: "object", properties: { submitOptions: { type: "string" }, javaHome: { type: "string" } } }
    },
    {
      name: "ibmi.debug.stopService",
      description: "Stop IBM i debug service (best-effort).",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "ibmi.deploy.compare",
      description: "Compare local and remote directories (by relative paths).",
      inputSchema: { type: "object", properties: { localPath: { type: "string" }, remotePath: { type: "string" } }, required: ["localPath", "remotePath"] }
    },
    {
      name: "ibmi.deploy.sync",
      description: "Sync local directory to remote (upload missing or overwrite).",
      inputSchema: { type: "object", properties: { localPath: { type: "string" }, remotePath: { type: "string" }, overwrite: { type: "boolean", default: false } }, required: ["localPath", "remotePath"] }
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
      if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
      await conn.content.uploadMemberContent(args.library, args.sourceFile, args.member, args.content);
      return result("OK");
    }
    case "ibmi.qsys.members.create": {
      const conn = ctx.ensureActive();
      if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
      await conn.content.createMember(args.library, args.sourceFile, args.member, args.srctype);
      return result("OK");
    }
    case "ibmi.qsys.members.rename": {
      const conn = ctx.ensureActive();
      if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
      await conn.content.renameMember(args.library, args.sourceFile, args.member, args.newMember);
      return result("OK");
    }
    case "ibmi.qsys.members.delete": {
      const conn = ctx.ensureActive();
      if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
      await conn.content.deleteMember(args.library, args.sourceFile, args.member);
      return result("OK");
    }
    case "ibmi.qsys.sourcefiles.create": {
      const conn = ctx.ensureActive();
      if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
      await conn.content.createSourceFile(args.library, args.sourceFile, args.rcdlen || 112);
      return result("OK");
    }
    case "ibmi.qsys.libraries.create": {
      const conn = ctx.ensureActive();
      if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
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
      if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
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
      return json(data ?? { term: args.term, hits: [] });
    }
    case "ibmi.find.ifs": {
      const conn = ctx.ensureActive();
      const data = await Search.findIFS(conn, args.path, args.term);
      return json(data ?? { term: args.term, hits: [] });
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
      if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
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
        const lib = String(args.library || "").toUpperCase();
        const src = String(args.sourceFile || "").toUpperCase();
        const mbr = String(args.member || targetPath.split("/").pop() || "").toUpperCase();
        const ext = String(args.extension || "");
        envVars["&LIBRARY"] = lib;
        envVars["&SRCFILE"] = src;
        envVars["&NAME"] = mbr;
        envVars["&EXT"] = ext;
        envVars["&EXTL"] = ext.toLowerCase();
        envVars["&FULLPATH"] = `${lib}/${src}/${mbr}`;
        envVars["&OPENLIB"] = lib;
        envVars["&OPENLIBL"] = lib.toLowerCase();
        envVars["&OPENSPF"] = src;
        envVars["&OPENSPFL"] = src.toLowerCase();
        envVars["&OPENMBR"] = mbr;
        envVars["&OPENMBRL"] = mbr.toLowerCase();
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
    case "ibmi.libl.get": {
      const name = getConnectionName(ctx, args);
      const conn = await ctx.store.getConnection(name);
      if (!conn) throw new Error(`Connection ${name} not found`);
      const settings = conn.settings || {};
      return json({
        currentLibrary: settings.currentLibrary ?? ctx.active?.getConfig().currentLibrary,
        libraryList: settings.libraryList ?? ctx.active?.getConfig().libraryList ?? []
      });
    }
    case "ibmi.libl.set": {
      const name = getConnectionName(ctx, args);
      await updateConnectionSettings(ctx, name, {
        currentLibrary: args.currentLibrary,
        libraryList: args.libraryList
      });
      if (args.applyToJob) {
        const conn = ctx.ensureActive();
        await applyLibraryList(conn, args.libraryList, args.currentLibrary);
      }
      return result("OK");
    }
    case "ibmi.libl.add": {
      const name = getConnectionName(ctx, args);
      const conn = await ctx.store.getConnection(name);
      if (!conn) throw new Error(`Connection ${name} not found`);
      const list = conn.settings?.libraryList || [];
      const lib = String(args.library).toUpperCase();
      if (!list.includes(lib)) list.push(lib);
      await updateConnectionSettings(ctx, name, { libraryList: list });
      if (args.applyToJob) {
        const active = ctx.ensureActive();
        await applyLibraryList(active, list, conn.settings?.currentLibrary);
      }
      return result("OK");
    }
    case "ibmi.libl.remove": {
      const name = getConnectionName(ctx, args);
      const conn = await ctx.store.getConnection(name);
      if (!conn) throw new Error(`Connection ${name} not found`);
      const list = (conn.settings?.libraryList || []).filter(l => l !== String(args.library).toUpperCase());
      await updateConnectionSettings(ctx, name, { libraryList: list });
      if (args.applyToJob) {
        const active = ctx.ensureActive();
        await applyLibraryList(active, list, conn.settings?.currentLibrary);
      }
      return result("OK");
    }
    case "ibmi.libl.setCurrent": {
      const name = getConnectionName(ctx, args);
      const lib = String(args.library).toUpperCase();
      await updateConnectionSettings(ctx, name, { currentLibrary: lib });
      if (args.applyToJob) {
        const active = ctx.ensureActive();
        await applyLibraryList(active, undefined, lib);
      }
      return result("OK");
    }
    case "ibmi.libl.validate": {
      const conn = ctx.ensureActive();
      const bad = await conn.content.validateLibraryList(args.libraryList);
      return json({ badLibraries: bad });
    }
    case "ibmi.profiles.list": {
      const name = getConnectionName(ctx, args);
      const profiles = await ctx.store.listProfiles(name);
      return json(profiles);
    }
    case "ibmi.profiles.save": {
      const name = getConnectionName(ctx, args);
      const profile = args.profile;
      if (!profile?.name) throw new Error("Profile must include a name");
      await ctx.store.saveProfile(name, profile);
      return result(`Profile ${profile.name} saved`);
    }
    case "ibmi.profiles.delete": {
      const name = getConnectionName(ctx, args);
      await ctx.store.deleteProfile(name, args.name);
      return result(`Profile ${args.name} deleted`);
    }
    case "ibmi.profiles.activate": {
      const name = getConnectionName(ctx, args);
      const connInfo = await ctx.store.getConnection(name);
      if (!connInfo) throw new Error(`Connection ${name} not found`);
      const profile = (connInfo.profiles || []).find(p => p.name === args.name);
      if (!profile) throw new Error(`Profile ${args.name} not found`);

      await ctx.store.setCurrentProfile(name, args.name);
      await updateConnectionSettings(ctx, name, {
        currentLibrary: profile.currentLibrary,
        libraryList: profile.libraryList,
        customVariables: profile.customVariables
      });

      if (args.applyToJob) {
        const active = ctx.ensureActive();
        await applyLibraryList(active, profile.libraryList, profile.currentLibrary);
      }
      return result(`Profile ${args.name} activated`);
    }
    case "ibmi.resolve.path": {
      const conn = ctx.ensureActive();
      const pathStr = String(args.path);
      if (pathStr.startsWith("/")) {
        const isDir = await conn.content.testStreamFile(pathStr, "d");
        const isFile = await conn.content.testStreamFile(pathStr, "e");
        return json({ type: "ifs", exists: isDir || isFile, kind: isDir ? "directory" : isFile ? "streamfile" : "unknown", path: pathStr });
      }
      const parts = pathStr.split("/").filter(Boolean);
      if (parts.length < 3) throw new Error("Member path should be LIB/FILE/MEMBER(.ext)");
      const lib = parts.length === 4 ? parts[1] : parts[0];
      const file = parts.length === 4 ? parts[2] : parts[1];
      const memberPart = parts.length === 4 ? parts[3] : parts[2];
      const member = memberPart.includes(".") ? memberPart.substring(0, memberPart.indexOf(".")) : memberPart;
      const info = await conn.content.getMemberInfo(lib, file, member);
      return json({ type: "member", exists: Boolean(info), details: info || { library: lib, file, name: member } });
    }
    case "ibmi.deploy.uploadDirectory": {
      const conn = ctx.ensureActive();
      if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
      await conn.client!.putDirectory(args.localPath, args.remotePath, { recursive: true, concurrency: 5 });
      return result("OK");
    }
    case "ibmi.deploy.uploadFiles": {
      const conn = ctx.ensureActive();
      if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
      const remoteDir = String(args.remoteDirectory);
      for (const file of args.localFiles || []) {
        const base = String(file).split(/[\\/]/).pop();
        const remotePath = `${remoteDir}/${base}`;
        await conn.client!.putFile(String(file), remotePath);
      }
      return result("OK");
    }
    case "ibmi.deploy.setCcsid": {
      const conn = ctx.ensureActive();
      if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
      const setccsid = conn.remoteFeatures.setccsid;
      if (!setccsid) throw new Error("setccsid not available on remote system");
      const ccsid = args.ccsid || "1208";
      await conn.sendCommand({ command: `${setccsid} -R ${ccsid} ${args.remotePath}` });
      return result("OK");
    }
    case "ibmi.filters.list": {
      const name = getConnectionName(ctx, args);
      const connInfo = await ctx.store.getConnection(name);
      if (!connInfo) throw new Error(`Connection ${name} not found`);
      return json(connInfo.settings?.objectFilters || []);
    }
    case "ibmi.filters.save": {
      const name = getConnectionName(ctx, args);
      const connInfo = await ctx.store.getConnection(name);
      if (!connInfo) throw new Error(`Connection ${name} not found`);
      const filter = args.filter;
      if (!filter?.name) throw new Error("Filter must include a name");
      const list = connInfo.settings?.objectFilters || [];
      const idx = list.findIndex((f: any) => f.name === filter.name);
      if (idx >= 0) list[idx] = filter; else list.push(filter);
      await updateConnectionSettings(ctx, name, { objectFilters: list });
      return result(`Filter ${filter.name} saved`);
    }
    case "ibmi.filters.delete": {
      const name = getConnectionName(ctx, args);
      const connInfo = await ctx.store.getConnection(name);
      if (!connInfo) throw new Error(`Connection ${name} not found`);
      const list = (connInfo.settings?.objectFilters || []).filter((f: any) => f.name !== args.name);
      await updateConnectionSettings(ctx, name, { objectFilters: list });
      return result(`Filter ${args.name} deleted`);
    }
    case "ibmi.ifs.shortcuts.list": {
      const name = getConnectionName(ctx, args);
      const connInfo = await ctx.store.getConnection(name);
      if (!connInfo) throw new Error(`Connection ${name} not found`);
      return json(connInfo.settings?.ifsShortcuts || []);
    }
    case "ibmi.ifs.shortcuts.add": {
      const name = getConnectionName(ctx, args);
      const connInfo = await ctx.store.getConnection(name);
      if (!connInfo) throw new Error(`Connection ${name} not found`);
      const list = connInfo.settings?.ifsShortcuts || [];
      if (!list.includes(args.path)) list.push(args.path);
      await updateConnectionSettings(ctx, name, { ifsShortcuts: list });
      return result("OK");
    }
    case "ibmi.ifs.shortcuts.delete": {
      const name = getConnectionName(ctx, args);
      const connInfo = await ctx.store.getConnection(name);
      if (!connInfo) throw new Error(`Connection ${name} not found`);
      const list = (connInfo.settings?.ifsShortcuts || []).filter((p: string) => p !== args.path);
      await updateConnectionSettings(ctx, name, { ifsShortcuts: list });
      return result("OK");
    }
    case "ibmi.debug.status": {
      const conn = ctx.ensureActive();
      const port = conn.getConfig().debugPort || 8005;
      const rows = await conn.runSQL(`select job_name, local_port from qsys2.netstat_job_info where local_port = ${port} and remote_address = '0.0.0.0' fetch first 1 row only`);
      if (rows.length === 0) return json({ running: false, port });
      return json({ running: true, port, job: rows[0].JOB_NAME });
    }
    case "ibmi.debug.startService": {
      const conn = ctx.ensureActive();
      if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
      const javaHome = args.javaHome ? `export JAVA_HOME=${args.javaHome};` : ``;
      const submitOptions = args.submitOptions || `JOBQ(QSYS/QUSRNOMAX) JOBD(QSYS/QSYSJOBD) OUTQ(QUSRSYS/QDBGSRV) USER(QDBGSRV)`;
      const cmd = `QSYS/SBMJOB JOB(QDBGSRV) SYSLIBL(*SYSVAL) CURLIB(*USRPRF) INLLIBL(*JOBD) ${submitOptions} CMD(QSH CMD('${javaHome}/QIBM/ProdData/IBMiDebugService/bin/startDebugService.sh'))`;
      const res = await conn.sendQsh({ command: `system \"${cmd}\"` });
      return json(res);
    }
    case "ibmi.debug.stopService": {
      const conn = ctx.ensureActive();
      if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
      const res = await conn.sendCommand({ command: `/QIBM/ProdData/IBMiDebugService/bin/stopDebugService.sh` });
      return json(res);
    }
    case "ibmi.deploy.compare": {
      const conn = ctx.ensureActive();
      const localPath = String(args.localPath);
      const remotePath = String(args.remotePath);
      const localFiles = await listLocalFiles(localPath);
      const remoteFiles = await listRemoteFiles(conn, remotePath);
      const localSet = new Set(localFiles);
      const remoteSet = new Set(remoteFiles);
      const onlyLocal = localFiles.filter(f => !remoteSet.has(f));
      const onlyRemote = remoteFiles.filter(f => !localSet.has(f));
      const common = localFiles.filter(f => remoteSet.has(f));
      return json({ onlyLocal, onlyRemote, common });
    }
    case "ibmi.deploy.sync": {
      const conn = ctx.ensureActive();
      if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
      const localPath = String(args.localPath);
      const remotePath = String(args.remotePath);
      const overwrite = Boolean(args.overwrite);

      const localFiles = await listLocalFiles(localPath);
      const remoteFiles = await listRemoteFiles(conn, remotePath);
      const remoteSet = new Set(remoteFiles);

      for (const rel of localFiles) {
        if (!overwrite && remoteSet.has(rel)) continue;
        const localFile = require("path").join(localPath, rel);
        const remoteFile = `${remotePath}/${rel}`.replace(/\\/g, "/");
        await conn.client!.putFile(localFile, remoteFile);
      }

      return result("OK");
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

function getConnectionName(ctx: McpContext, args: any): string {
  const name = args?.connectionName || ctx.activeName;
  if (!name) throw new Error("connectionName is required (no active connection)");
  return name;
}

async function updateConnectionSettings(ctx: McpContext, name: string, update: Record<string, any>) {
  const conn = await ctx.store.getConnection(name);
  if (!conn) throw new Error(`Connection ${name} not found`);
  conn.settings = { ...(conn.settings || {}), ...stripUndefined(update) };
  await ctx.store.upsertConnection(conn);
  if (ctx.active && ctx.activeName === name) {
    ctx.active.setConfig({ ...ctx.active.getConfig(), ...conn.settings });
  }
}

async function applyLibraryList(conn: any, libraryList?: string[], currentLibrary?: string) {
  if (libraryList && libraryList.length > 0) {
    const libs = libraryList.map((l: string) => l.toUpperCase()).join(" ");
    await conn.sendQsh({ command: `system \"CHGLIBL LIBL(${libs})\"` });
  }
  if (currentLibrary) {
    const lib = String(currentLibrary).toUpperCase();
    await conn.sendQsh({ command: `system \"CHGCURLIB ${lib}\"` });
  }
}

function stripUndefined(obj: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function listLocalFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        results.push(rel);
      }
    }
  }
  await walk(root);
  return results;
}

async function listRemoteFiles(conn: any, remoteRoot: string): Promise<string[]> {
  const find = conn.remoteFeatures.find || "/QOpenSys/pkgs/bin/find";
  const res = await conn.sendCommand({ command: `${find} ${remoteRoot} -type f -print` });
  const lines = res.stdout.split("\n").map((l: string) => l.trim()).filter(Boolean);
  return lines.map((line: string) => line.replace(remoteRoot.replace(/\/$/, ""), "").replace(/^[\\/]/, ""));
}
