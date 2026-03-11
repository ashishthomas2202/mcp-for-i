import { LocalLanguageActions } from "../ibmi/LocalLanguageActions.js";
import { CompileTools } from "../ibmi/CompileTools.js";
import { Search } from "../ibmi/Search.js";
import { Tools } from "../ibmi/Tools.js";
import { ConnectionService } from "../controlplane/connectionService.js";
import { log } from "./logger.js";
import fs from "fs/promises";
import path from "path";
export function getTools() {
    const tools = [
        {
            name: "ibmi.connect",
            description: "Connect to a saved IBM i connection by name.",
            inputSchema: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Saved connection name" }
                },
                required: ["name"],
                additionalProperties: false
            }
        },
        {
            name: "ibmi.disconnect",
            description: "Disconnect from the active IBM i system.",
            inputSchema: { type: "object", properties: { connectionName: { type: "string" } } }
        },
        {
            name: "ibmi.session.list",
            description: "List connected IBM i sessions.",
            inputSchema: { type: "object", properties: {} }
        },
        {
            name: "ibmi.session.status",
            description: "Get status for a connected session.",
            inputSchema: { type: "object", properties: { connectionName: { type: "string" } } }
        },
        {
            name: "ibmi.session.keepalive",
            description: "Extend inactivity timeout for a session.",
            inputSchema: { type: "object", properties: { connectionName: { type: "string" } } }
        },
        {
            name: "ibmi.session.terminate",
            description: "Terminate a session.",
            inputSchema: { type: "object", properties: { connectionName: { type: "string" } } }
        },
        {
            name: "ibmi.connections.list",
            description: "List saved IBM i connections.",
            inputSchema: { type: "object", properties: {} }
        },
        {
            name: "ibmi.connections.add",
            description: "Add a saved IBM i connection (credentials are managed via local control-plane UI).",
            inputSchema: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    host: { type: "string" },
                    port: { type: "number", default: 22 },
                    username: { type: "string" },
                    privateKeyPath: { type: "string" },
                    settings: { type: "object" },
                    policy: { type: "object" }
                },
                required: ["name", "host", "username"],
                additionalProperties: false
            }
        },
        {
            name: "ibmi.connections.update",
            description: "Update a saved IBM i connection (credentials are managed via local control-plane UI).",
            inputSchema: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    host: { type: "string" },
                    port: { type: "number" },
                    username: { type: "string" },
                    privateKeyPath: { type: "string" },
                    settings: { type: "object" },
                    policy: { type: "object" }
                },
                required: ["name"],
                additionalProperties: false
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
        },
        {
            name: "ibmi.actions.save",
            description: "Create or update a custom action.",
            inputSchema: { type: "object", properties: { action: { type: "object" } }, required: ["action"] }
        },
        {
            name: "ibmi.actions.delete",
            description: "Delete a custom action by name.",
            inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
        },
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
        },
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
            inputSchema: { type: "object", properties: { connectionName: { type: "string" }, approve: { type: "boolean" } } }
        },
        {
            name: "ibmi.debug.stopService",
            description: "Stop IBM i debug service (best-effort).",
            inputSchema: { type: "object", properties: { connectionName: { type: "string" }, approve: { type: "boolean" } } }
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
        },
        {
            name: "ibmi.sql.query",
            description: "Run a read-only SQL query (supports cursor pagination).",
            inputSchema: {
                type: "object",
                properties: {
                    sql: { type: "string" },
                    cursor: { type: "string" },
                    pageSize: { type: "number" },
                    maxRows: { type: "number" },
                    connectionName: { type: "string" }
                }
            }
        },
        {
            name: "ibmi.sql.execute",
            description: "Run SQL statements with guarded policy checks.",
            inputSchema: {
                type: "object",
                properties: {
                    sql: { type: "string" },
                    connectionName: { type: "string" },
                    approve: { type: "boolean" }
                },
                required: ["sql"]
            }
        },
        {
            name: "ibmi.cl.run",
            description: "Run arbitrary CL command with policy checks.",
            inputSchema: {
                type: "object",
                properties: {
                    command: { type: "string" },
                    environment: { type: "string", enum: ["ile", "qsh", "pase"] },
                    cwd: { type: "string" },
                    connectionName: { type: "string" },
                    approve: { type: "boolean" }
                },
                required: ["command"]
            }
        },
        {
            name: "ibmi.diagnostics.parseEvfevent",
            description: "Parse EVFEVENT text into structured diagnostics.",
            inputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }
        },
        {
            name: "ibmi.joblog.get",
            description: "Read recent job log messages for the current job.",
            inputSchema: { type: "object", properties: { connectionName: { type: "string" }, limit: { type: "number" } } }
        },
        {
            name: "ibmi.spool.list",
            description: "List spool file entries.",
            inputSchema: { type: "object", properties: { connectionName: { type: "string" }, limit: { type: "number" } } }
        },
        {
            name: "ibmi.spool.read",
            description: "Read line data for a spool file entry.",
            inputSchema: {
                type: "object",
                properties: {
                    jobName: { type: "string" },
                    spooledFileName: { type: "string" },
                    spooledFileNumber: { type: "number" },
                    limit: { type: "number" },
                    connectionName: { type: "string" }
                },
                required: ["jobName", "spooledFileName", "spooledFileNumber"]
            }
        },
        {
            name: "ibmi.tn5250.connect",
            description: "Connect to TN5250 (phase scaffold).",
            inputSchema: { type: "object", properties: { connectionName: { type: "string" } } }
        },
        {
            name: "ibmi.tn5250.readScreen",
            description: "Read TN5250 screen model (phase scaffold).",
            inputSchema: { type: "object", properties: {} }
        },
        {
            name: "ibmi.tn5250.setField",
            description: "Set TN5250 field (phase scaffold).",
            inputSchema: { type: "object", properties: { fieldId: { type: "string" }, value: { type: "string" } }, required: ["fieldId", "value"] }
        },
        {
            name: "ibmi.tn5250.sendKeys",
            description: "Send TN5250 keys (phase scaffold).",
            inputSchema: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] }
        },
        {
            name: "ibmi.tn5250.waitFor",
            description: "Wait for TN5250 condition (phase scaffold).",
            inputSchema: { type: "object", properties: { text: { type: "string" }, timeoutMs: { type: "number" } } }
        },
        {
            name: "ibmi.tn5250.snapshot",
            description: "Capture TN5250 snapshot (phase scaffold).",
            inputSchema: { type: "object", properties: {} }
        },
        {
            name: "ibmi.tn5250.disconnect",
            description: "Disconnect TN5250 session (phase scaffold).",
            inputSchema: { type: "object", properties: {} }
        }
    ];
    return tools.map(withGuardedApprovalHint);
}
export async function handleTool(ctx, name, args) {
    const connections = new ConnectionService(ctx.store);
    switch (name) {
        case "ibmi.connect": {
            if (!args?.name)
                throw new Error("name is required");
            if (args?.host || args?.username || args?.password || args?.privateKeyPath) {
                throw new Error("Direct credential/host arguments are disabled. Save a connection and connect by name.");
            }
            await ctx.connectByName(args.name);
            return result(`Connected to ${args.name}`);
        }
        case "ibmi.disconnect": {
            await ctx.disconnect(args?.connectionName);
            return result("Disconnected");
        }
        case "ibmi.session.list": {
            return json(ctx.listSessions());
        }
        case "ibmi.session.status": {
            return json(ctx.statusSession(args?.connectionName));
        }
        case "ibmi.session.keepalive": {
            return json(ctx.keepaliveSession(args?.connectionName));
        }
        case "ibmi.session.terminate": {
            await ctx.terminateSession(args?.connectionName);
            return result("Terminated");
        }
        case "ibmi.connections.list": {
            const list = await connections.list();
            return json(list);
        }
        case "ibmi.connections.add": {
            rejectCredentialArgs(args, "ibmi.connections.add");
            await connections.add(args);
            return result(`Connection ${args.name} saved`);
        }
        case "ibmi.connections.update": {
            rejectCredentialArgs(args, "ibmi.connections.update");
            await connections.update(args.name, args);
            return result(`Connection ${args.name} updated`);
        }
        case "ibmi.connections.delete": {
            await ctx.disconnect(args.name);
            await connections.delete(args.name);
            return result(`Connection ${args.name} deleted`);
        }
        case "ibmi.qsys.libraries.list": {
            const conn = ctx.ensureActive(args?.connectionName);
            const data = await conn.content.getLibraries(args.filter || "*");
            return json(data);
        }
        case "ibmi.qsys.objects.list": {
            const conn = ctx.ensureActive(args?.connectionName);
            const data = await conn.content.getObjectList(args.library, args.types || ["*ALL"]);
            return json(data);
        }
        case "ibmi.qsys.sourcefiles.list": {
            const conn = ctx.ensureActive(args?.connectionName);
            const data = await conn.content.getObjectList(args.library, ["*SRCPF"]);
            return json(data);
        }
        case "ibmi.qsys.members.list": {
            const conn = ctx.ensureActive(args?.connectionName);
            const data = await conn.content.getMemberList({ library: args.library, sourceFile: args.sourceFile });
            return json(data);
        }
        case "ibmi.qsys.members.read": {
            const conn = ctx.ensureActive(args?.connectionName);
            const content = await conn.content.downloadMemberContent(args.library, args.sourceFile, args.member);
            return result(content);
        }
        case "ibmi.qsys.members.write": {
            const conn = ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            await conn.content.uploadMemberContent(args.library, args.sourceFile, args.member, args.content);
            return result("OK");
        }
        case "ibmi.qsys.members.create": {
            const conn = ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            await conn.content.createMember(args.library, args.sourceFile, args.member, args.srctype);
            return result("OK");
        }
        case "ibmi.qsys.members.rename": {
            const conn = ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            await conn.content.renameMember(args.library, args.sourceFile, args.member, args.newMember);
            return result("OK");
        }
        case "ibmi.qsys.members.delete": {
            const conn = ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            await conn.content.deleteMember(args.library, args.sourceFile, args.member);
            return result("OK");
        }
        case "ibmi.qsys.sourcefiles.create": {
            const conn = ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            await conn.content.createSourceFile(args.library, args.sourceFile, args.rcdlen || 112);
            return result("OK");
        }
        case "ibmi.qsys.libraries.create": {
            const conn = ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            await conn.content.createLibrary(args.library);
            return result("OK");
        }
        case "ibmi.ifs.list": {
            const conn = ctx.ensureActive(args?.connectionName);
            const data = await conn.content.getFileList(args.path);
            return json(data);
        }
        case "ibmi.ifs.read": {
            const conn = ctx.ensureActive(args?.connectionName);
            const data = await conn.content.downloadStreamfileRaw(args.path);
            return result(Buffer.from(data).toString("utf8"));
        }
        case "ibmi.ifs.write": {
            const conn = ctx.ensureActive(args?.connectionName);
            const op = resolveIfsWriteOperation(args.path);
            enforceWritable(ctx, conn, op, args);
            await conn.content.writeStreamfileRaw(args.path, args.content);
            return result("OK");
        }
        case "ibmi.ifs.mkdir": {
            const conn = ctx.ensureActive(args?.connectionName);
            const op = resolveIfsWriteOperation(args.path);
            enforceWritable(ctx, conn, op, args);
            await conn.sendCommand({ command: `mkdir -p ${Tools.escapePath(args.path)}` });
            return result("OK");
        }
        case "ibmi.ifs.delete": {
            const conn = ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "ifs.delete", args);
            const flag = args.recursive ? "-rf" : "-f";
            await conn.sendCommand({ command: `rm ${flag} ${Tools.escapePath(args.path)}` });
            return result("OK");
        }
        case "ibmi.ifs.upload": {
            const conn = ctx.ensureActive(args?.connectionName);
            const op = resolveIfsWriteOperation(args.remotePath);
            enforceWritable(ctx, conn, op, args);
            await conn.client.putFile(args.localPath, args.remotePath);
            return result("OK");
        }
        case "ibmi.ifs.download": {
            const conn = ctx.ensureActive(args?.connectionName);
            await conn.client.getFile(args.localPath, args.remotePath);
            return result("OK");
        }
        case "ibmi.search.members": {
            const conn = ctx.ensureActive(args?.connectionName);
            const members = args.members || "*";
            const data = await Search.searchMembers(conn, args.library, args.sourceFile, args.term, members, false);
            return json(data);
        }
        case "ibmi.search.ifs": {
            const conn = ctx.ensureActive(args?.connectionName);
            const data = await Search.searchIFS(conn, args.path, args.term);
            return json(data ?? { term: args.term, hits: [] });
        }
        case "ibmi.find.ifs": {
            const conn = ctx.ensureActive(args?.connectionName);
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
            const conn = ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const action = await resolveAction(ctx, args);
            if (!action)
                throw new Error("Action not found");
            const envVars = {};
            const targetPath = args.targetPath;
            const targetType = args.targetType;
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
            const action = args.action;
            if (!action?.name)
                throw new Error("Action must include a name");
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
            if (!conn)
                throw new Error(`Connection ${name} not found`);
            const settings = conn.settings || {};
            let activeConfig = {};
            try {
                activeConfig = ctx.ensureActive(name).getConfig();
            }
            catch {
                activeConfig = {};
            }
            return json({
                currentLibrary: settings.currentLibrary ?? activeConfig.currentLibrary,
                libraryList: settings.libraryList ?? activeConfig.libraryList ?? []
            });
        }
        case "ibmi.libl.set": {
            const name = getConnectionName(ctx, args);
            const active = ctx.ensureActive(name);
            enforceWritable(ctx, active, "qsys.write", args);
            await updateConnectionSettings(ctx, name, {
                currentLibrary: args.currentLibrary,
                libraryList: args.libraryList
            });
            if (args.applyToJob) {
                await applyLibraryList(active, args.libraryList, args.currentLibrary);
            }
            return result("OK");
        }
        case "ibmi.libl.add": {
            const name = getConnectionName(ctx, args);
            const conn = await ctx.store.getConnection(name);
            if (!conn)
                throw new Error(`Connection ${name} not found`);
            const list = conn.settings?.libraryList || [];
            const lib = String(args.library).toUpperCase();
            if (!list.includes(lib))
                list.push(lib);
            const active = ctx.ensureActive(name);
            enforceWritable(ctx, active, "qsys.write", args);
            await updateConnectionSettings(ctx, name, { libraryList: list });
            if (args.applyToJob) {
                await applyLibraryList(active, list, conn.settings?.currentLibrary);
            }
            return result("OK");
        }
        case "ibmi.libl.remove": {
            const name = getConnectionName(ctx, args);
            const conn = await ctx.store.getConnection(name);
            if (!conn)
                throw new Error(`Connection ${name} not found`);
            const list = (conn.settings?.libraryList || []).filter(l => l !== String(args.library).toUpperCase());
            const active = ctx.ensureActive(name);
            enforceWritable(ctx, active, "qsys.write", args);
            await updateConnectionSettings(ctx, name, { libraryList: list });
            if (args.applyToJob) {
                await applyLibraryList(active, list, conn.settings?.currentLibrary);
            }
            return result("OK");
        }
        case "ibmi.libl.setCurrent": {
            const name = getConnectionName(ctx, args);
            const lib = String(args.library).toUpperCase();
            const active = ctx.ensureActive(name);
            enforceWritable(ctx, active, "qsys.write", args);
            await updateConnectionSettings(ctx, name, { currentLibrary: lib });
            if (args.applyToJob) {
                await applyLibraryList(active, undefined, lib);
            }
            return result("OK");
        }
        case "ibmi.libl.validate": {
            const conn = ctx.ensureActive(args?.connectionName);
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
            if (!profile?.name)
                throw new Error("Profile must include a name");
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
            if (!connInfo)
                throw new Error(`Connection ${name} not found`);
            const profile = (connInfo.profiles || []).find(p => p.name === args.name);
            if (!profile)
                throw new Error(`Profile ${args.name} not found`);
            const active = ctx.ensureActive(name);
            enforceWritable(ctx, active, "qsys.write", args);
            await ctx.store.setCurrentProfile(name, args.name);
            await updateConnectionSettings(ctx, name, {
                currentLibrary: profile.currentLibrary,
                libraryList: profile.libraryList,
                customVariables: profile.customVariables
            });
            if (args.applyToJob) {
                await applyLibraryList(active, profile.libraryList, profile.currentLibrary);
            }
            return result(`Profile ${args.name} activated`);
        }
        case "ibmi.resolve.path": {
            const conn = ctx.ensureActive(args?.connectionName);
            const pathStr = String(args.path);
            if (pathStr.startsWith("/")) {
                const isDir = await conn.content.testStreamFile(pathStr, "d");
                const isFile = await conn.content.testStreamFile(pathStr, "e");
                return json({ type: "ifs", exists: isDir || isFile, kind: isDir ? "directory" : isFile ? "streamfile" : "unknown", path: pathStr });
            }
            const parts = pathStr.split("/").filter(Boolean);
            if (parts.length < 3)
                throw new Error("Member path should be LIB/FILE/MEMBER(.ext)");
            const lib = parts.length === 4 ? parts[1] : parts[0];
            const file = parts.length === 4 ? parts[2] : parts[1];
            const memberPart = parts.length === 4 ? parts[3] : parts[2];
            const member = memberPart.includes(".") ? memberPart.substring(0, memberPart.indexOf(".")) : memberPart;
            const info = await conn.content.getMemberInfo(lib, file, member);
            return json({ type: "member", exists: Boolean(info), details: info || { library: lib, file, name: member } });
        }
        case "ibmi.deploy.uploadDirectory": {
            const conn = ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "deploy.sync", args);
            await conn.client.putDirectory(args.localPath, args.remotePath, { recursive: true, concurrency: 5 });
            return result("OK");
        }
        case "ibmi.deploy.uploadFiles": {
            const conn = ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "deploy.sync", args);
            const remoteDir = String(args.remoteDirectory);
            for (const file of args.localFiles || []) {
                const base = String(file).split(/[\\/]/).pop();
                const remotePath = `${remoteDir}/${base}`;
                await conn.client.putFile(String(file), remotePath);
            }
            return result("OK");
        }
        case "ibmi.deploy.setCcsid": {
            const conn = ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "deploy.sync", args);
            const setccsid = conn.remoteFeatures.setccsid;
            if (!setccsid)
                throw new Error("setccsid not available on remote system");
            const ccsid = args.ccsid || "1208";
            await conn.sendCommand({ command: `${setccsid} -R ${Tools.shellQuote(ccsid)} ${Tools.escapePath(args.remotePath)}` });
            return result("OK");
        }
        case "ibmi.filters.list": {
            const name = getConnectionName(ctx, args);
            const connInfo = await ctx.store.getConnection(name);
            if (!connInfo)
                throw new Error(`Connection ${name} not found`);
            return json(connInfo.settings?.objectFilters || []);
        }
        case "ibmi.filters.save": {
            const name = getConnectionName(ctx, args);
            const connInfo = await ctx.store.getConnection(name);
            if (!connInfo)
                throw new Error(`Connection ${name} not found`);
            const filter = args.filter;
            if (!filter?.name)
                throw new Error("Filter must include a name");
            const list = connInfo.settings?.objectFilters || [];
            const idx = list.findIndex((f) => f.name === filter.name);
            if (idx >= 0)
                list[idx] = filter;
            else
                list.push(filter);
            await updateConnectionSettings(ctx, name, { objectFilters: list });
            return result(`Filter ${filter.name} saved`);
        }
        case "ibmi.filters.delete": {
            const name = getConnectionName(ctx, args);
            const connInfo = await ctx.store.getConnection(name);
            if (!connInfo)
                throw new Error(`Connection ${name} not found`);
            const list = (connInfo.settings?.objectFilters || []).filter((f) => f.name !== args.name);
            await updateConnectionSettings(ctx, name, { objectFilters: list });
            return result(`Filter ${args.name} deleted`);
        }
        case "ibmi.ifs.shortcuts.list": {
            const name = getConnectionName(ctx, args);
            const connInfo = await ctx.store.getConnection(name);
            if (!connInfo)
                throw new Error(`Connection ${name} not found`);
            return json(connInfo.settings?.ifsShortcuts || []);
        }
        case "ibmi.ifs.shortcuts.add": {
            const name = getConnectionName(ctx, args);
            const connInfo = await ctx.store.getConnection(name);
            if (!connInfo)
                throw new Error(`Connection ${name} not found`);
            const list = connInfo.settings?.ifsShortcuts || [];
            if (!list.includes(args.path))
                list.push(args.path);
            await updateConnectionSettings(ctx, name, { ifsShortcuts: list });
            return result("OK");
        }
        case "ibmi.ifs.shortcuts.delete": {
            const name = getConnectionName(ctx, args);
            const connInfo = await ctx.store.getConnection(name);
            if (!connInfo)
                throw new Error(`Connection ${name} not found`);
            const list = (connInfo.settings?.ifsShortcuts || []).filter((p) => p !== args.path);
            await updateConnectionSettings(ctx, name, { ifsShortcuts: list });
            return result("OK");
        }
        case "ibmi.debug.status": {
            const conn = ctx.ensureActive(args?.connectionName);
            const port = conn.getConfig().debugPort || 8005;
            const rows = await conn.runSQL(`select job_name, local_port from qsys2.netstat_job_info where local_port = ${port} and remote_address = '0.0.0.0' fetch first 1 row only`);
            if (rows.length === 0)
                return json({ running: false, port });
            return json({ running: true, port, job: rows[0].JOB_NAME });
        }
        case "ibmi.debug.startService": {
            const conn = ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const submitOptions = `JOBQ(QSYS/QUSRNOMAX) JOBD(QSYS/QSYSJOBD) OUTQ(QUSRSYS/QDBGSRV) USER(QDBGSRV)`;
            const cmd = `QSYS/SBMJOB JOB(QDBGSRV) SYSLIBL(*SYSVAL) CURLIB(*USRPRF) INLLIBL(*JOBD) ${submitOptions} CMD(QSH CMD('/QIBM/ProdData/IBMiDebugService/bin/startDebugService.sh'))`;
            const res = await conn.sendQsh({ command: `system \"${cmd}\"` });
            return json(res);
        }
        case "ibmi.debug.stopService": {
            const conn = ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const res = await conn.sendCommand({ command: `/QIBM/ProdData/IBMiDebugService/bin/stopDebugService.sh` });
            return json(res);
        }
        case "ibmi.deploy.compare": {
            const conn = ctx.ensureActive(args?.connectionName);
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
            const conn = ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "deploy.sync", args);
            const localPath = String(args.localPath);
            const remotePath = String(args.remotePath);
            const overwrite = Boolean(args.overwrite);
            const localFiles = await listLocalFiles(localPath);
            const remoteFiles = await listRemoteFiles(conn, remotePath);
            const remoteSet = new Set(remoteFiles);
            const createdDirs = new Set();
            for (const rel of localFiles) {
                if (!overwrite && remoteSet.has(rel))
                    continue;
                const localFile = path.join(localPath, rel);
                const remoteFile = `${remotePath}/${rel}`.replace(/\\/g, "/");
                const remoteDir = remoteFile.split("/").slice(0, -1).join("/");
                if (!createdDirs.has(remoteDir)) {
                    await conn.sendCommand({ command: `mkdir -p ${Tools.escapePath(remoteDir)}` });
                    createdDirs.add(remoteDir);
                }
                await conn.client.putFile(localFile, remoteFile);
            }
            return result("OK");
        }
        case "ibmi.sql.query": {
            const conn = ctx.ensureActive(args?.connectionName);
            const pageSize = clampNumber(args?.pageSize, 200, 1, 5000);
            const maxRows = clampNumber(args?.maxRows, 1000, 1, 20000);
            if (args?.cursor) {
                const next = ctx.consumeSqlCursor(String(args.cursor), pageSize);
                return json({ rows: next.rows, cursor: next.cursor });
            }
            if (!args?.sql)
                throw new Error("sql is required when cursor is not provided");
            const sql = String(args.sql);
            if (!isReadOnlySql(sql))
                throw new Error("ibmi.sql.query only supports read-only SQL");
            const rows = await conn.runSQL(sql);
            const limited = rows.slice(0, maxRows);
            const firstPage = limited.slice(0, pageSize);
            const cursorInfo = ctx.createSqlCursor(limited, pageSize);
            return json({
                rows: firstPage,
                cursor: cursorInfo.cursor,
                totalRows: limited.length,
                truncated: rows.length > limited.length
            });
        }
        case "ibmi.sql.execute": {
            const conn = ctx.ensureActive(args?.connectionName);
            enforcePolicyOperation(ctx, "sql.write", args);
            const sql = String(args.sql);
            const rows = await conn.runSQL(sql);
            log("info", "audit.sql.execute", { connectionName: args?.connectionName || ctx.activeName, readOnly: isReadOnlySql(sql) });
            return json({ ok: true, rows });
        }
        case "ibmi.cl.run": {
            const conn = ctx.ensureActive(args?.connectionName);
            enforcePolicyOperation(ctx, "cl.run", args);
            const command = String(args.command || "");
            if (!command.trim())
                throw new Error("command is required");
            const environment = String(args.environment || "ile");
            const cwd = args.cwd ? String(args.cwd) : undefined;
            let cmdResult;
            if (environment === "pase") {
                cmdResult = await conn.sendCommand({ command, directory: cwd });
            }
            else if (environment === "qsh") {
                cmdResult = await conn.sendQsh({ command, directory: cwd });
            }
            else {
                try {
                    await conn.runSQL(`CALL QSYS2.QCMDEXC(${Tools.sqlString(command)})`);
                    cmdResult = { code: 0, signal: null, stdout: "", stderr: "", command };
                }
                catch (err) {
                    cmdResult = { code: 1, signal: null, stdout: "", stderr: err?.message || String(err), command };
                }
            }
            log("info", "audit.cl.run", { connectionName: args?.connectionName || ctx.activeName, environment });
            return json(cmdResult);
        }
        case "ibmi.diagnostics.parseEvfevent": {
            return json(parseEvfevent(String(args.content)));
        }
        case "ibmi.joblog.get": {
            const conn = ctx.ensureActive(args?.connectionName);
            const limit = clampNumber(args?.limit, 200, 1, 5000);
            const rows = await conn.runSQL(`select message_id, message_text, severity, message_timestamp from table(qsys2.joblog_info('*')) order by message_timestamp desc fetch first ${limit} rows only`);
            return json(rows);
        }
        case "ibmi.spool.list": {
            const conn = ctx.ensureActive(args?.connectionName);
            const limit = clampNumber(args?.limit, 200, 1, 5000);
            const rows = await conn.runSQL(`select job_name, spooled_file_name, spooled_file_number, output_queue_name, total_pages, file_status from qsys2.output_queue_entries fetch first ${limit} rows only`);
            return json(rows);
        }
        case "ibmi.spool.read": {
            const conn = ctx.ensureActive(args?.connectionName);
            const limit = clampNumber(args?.limit, 200, 1, 5000);
            const jobName = Tools.sqlString(String(args.jobName));
            const fileName = Tools.sqlString(String(args.spooledFileName));
            const fileNbr = clampNumber(args.spooledFileNumber, 1, 1, 999999999);
            const rows = await conn.runSQL(`select line_number, spooled_data from table(qsys2.display_spooled_file_data(${jobName}, ${fileName}, ${fileNbr})) fetch first ${limit} rows only`);
            return json(rows);
        }
        case "ibmi.tn5250.connect":
        case "ibmi.tn5250.readScreen":
        case "ibmi.tn5250.setField":
        case "ibmi.tn5250.sendKeys":
        case "ibmi.tn5250.waitFor":
        case "ibmi.tn5250.snapshot":
        case "ibmi.tn5250.disconnect": {
            throw new Error("TN5250 engine is not implemented yet in this build.");
        }
    }
    throw new Error(`Unknown tool: ${name}`);
}
async function listActions(ctx) {
    const builtins = Object.values(LocalLanguageActions).flat();
    const custom = await ctx.store.listActions();
    return [...builtins, ...custom];
}
async function resolveAction(ctx, args) {
    if (args.action)
        return args.action;
    if (!args.actionName)
        return undefined;
    const actions = await listActions(ctx);
    return actions.find(a => a.name === args.actionName);
}
function rejectCredentialArgs(args, toolName) {
    if (!args || typeof args !== "object")
        return;
    if (typeof args.password === "string" && args.password.length > 0) {
        throw new Error(`${toolName} does not accept password. Use the local control-plane UI to set credentials securely.`);
    }
    if (typeof args.storePassword !== "undefined") {
        throw new Error(`${toolName} does not accept storePassword. Credentials must be managed via local control-plane UI.`);
    }
}
function result(text) {
    return { content: [{ type: "text", text }] };
}
function json(obj) {
    return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}
function getConnectionName(ctx, args) {
    const name = args?.connectionName || ctx.activeName;
    if (!name)
        throw new Error("connectionName is required (no active connection)");
    return name;
}
async function updateConnectionSettings(ctx, name, update) {
    const conn = await ctx.store.getConnection(name);
    if (!conn)
        throw new Error(`Connection ${name} not found`);
    conn.settings = { ...(conn.settings || {}), ...stripUndefined(update) };
    await ctx.store.upsertConnection(conn);
    try {
        const active = ctx.ensureActive(name);
        active.setConfig({ ...active.getConfig(), ...conn.settings });
    }
    catch {
        // No active session for this connection.
    }
}
async function applyLibraryList(conn, libraryList, currentLibrary) {
    if (libraryList && libraryList.length > 0) {
        const normalized = libraryList.map((l) => String(l).toUpperCase());
        const invalid = normalized.find((l) => !conn.validQsysName(l));
        if (invalid)
            throw new Error(`Invalid library name: ${invalid}`);
        const libs = normalized.join(" ");
        await conn.sendQsh({ command: `system \"CHGLIBL LIBL(${libs})\"` });
    }
    if (currentLibrary) {
        const lib = String(currentLibrary).toUpperCase();
        if (!conn.validQsysName(lib))
            throw new Error(`Invalid current library: ${lib}`);
        await conn.sendQsh({ command: `system \"CHGCURLIB ${lib}\"` });
    }
}
function stripUndefined(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined)
            out[k] = v;
    }
    return out;
}
async function listLocalFiles(root) {
    const results = [];
    async function walk(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            const rel = path.relative(root, full).replace(/\\/g, "/");
            if (entry.isDirectory()) {
                await walk(full);
            }
            else {
                results.push(rel);
            }
        }
    }
    await walk(root);
    return results;
}
async function listRemoteFiles(conn, remoteRoot) {
    const find = conn.remoteFeatures.find || "/QOpenSys/pkgs/bin/find";
    const res = await conn.sendCommand({ command: `${find} ${Tools.escapePath(remoteRoot)} -type f -print` });
    const lines = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.map((line) => line.replace(remoteRoot.replace(/\/$/, ""), "").replace(/^[\\/]/, ""));
}
function clampNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}
function isReadOnlySql(sql) {
    const stripped = sql
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .split("\n")
        .filter(line => !line.trim().startsWith("--"))
        .join(" ")
        .trim()
        .toLowerCase();
    return stripped.startsWith("select ") || stripped.startsWith("with ") || stripped.startsWith("values ");
}
function enforceWritable(ctx, conn, operation, args) {
    if (conn.getConfig().readOnlyMode)
        throw new Error("Connection is in read-only mode");
    enforcePolicyOperation(ctx, operation, args);
}
function enforcePolicyOperation(ctx, operation, args) {
    const policy = ctx.getPolicy(args?.connectionName);
    if (policy.profile === "read-only") {
        throw new Error(`Blocked by policy (${policy.profile}): ${operation}`);
    }
    if (isDeniedByPolicy(policy, operation, args)) {
        throw new Error(`Blocked by policy: ${operation}`);
    }
    if (requiresApproval(policy, operation) && !Boolean(args?.approve)) {
        throw new Error(`Operation '${operation}' requires approve=true under '${policy.profile}' policy.`);
    }
}
function requiresApproval(policy, operation) {
    if (policy.profile !== "guarded")
        return false;
    const requires = policy.requireApprovalFor || [];
    return requires.includes(operation);
}
function isDeniedByPolicy(policy, operation, args) {
    const denyCommands = (policy.denyCommands || []).map(v => v.toLowerCase());
    if (operation === "cl.run" && args?.command) {
        const command = String(args.command).toLowerCase();
        if (denyCommands.some(prefix => command.startsWith(prefix)))
            return true;
    }
    return false;
}
const APPROVAL_HINT_TOOLS = new Set([
    "ibmi.qsys.members.write",
    "ibmi.qsys.members.create",
    "ibmi.qsys.members.rename",
    "ibmi.qsys.members.delete",
    "ibmi.qsys.sourcefiles.create",
    "ibmi.qsys.libraries.create",
    "ibmi.ifs.write",
    "ibmi.ifs.mkdir",
    "ibmi.ifs.delete",
    "ibmi.ifs.upload",
    "ibmi.actions.run",
    "ibmi.profiles.activate",
    "ibmi.deploy.uploadDirectory",
    "ibmi.deploy.uploadFiles",
    "ibmi.deploy.setCcsid",
    "ibmi.deploy.sync",
    "ibmi.sql.execute",
    "ibmi.cl.run"
]);
function withGuardedApprovalHint(tool) {
    if (!APPROVAL_HINT_TOOLS.has(tool.name))
        return tool;
    const schema = tool.inputSchema || { type: "object", properties: {} };
    if (!schema.properties)
        schema.properties = {};
    if (!schema.properties.approve) {
        schema.properties.approve = {
            type: "boolean",
            description: "Set true to approve guarded-policy operations."
        };
    }
    return { ...tool, inputSchema: schema };
}
function resolveIfsWriteOperation(pathValue) {
    const target = String(pathValue || "");
    if (/^\/qsys\.lib\//i.test(target)) {
        return "qsys.write";
    }
    return "ifs.write";
}
function parseEvfevent(content) {
    const diagnostics = [];
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (!line.trim())
            continue;
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+([A-Z0-9]+)\s+(INFO|WARN|ERROR)?\s*(.*)$/i);
        if (match) {
            diagnostics.push({
                line: Number(match[1]),
                column: Number(match[2]),
                code: match[3],
                severity: (match[4] || "ERROR").toUpperCase(),
                message: match[5] || line
            });
        }
        else {
            diagnostics.push({ message: line });
        }
    }
    return diagnostics;
}
