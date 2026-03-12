import { LocalLanguageActions } from "../ibmi/LocalLanguageActions.js";
import { CompileTools } from "../ibmi/CompileTools.js";
import { Search } from "../ibmi/Search.js";
import { Tools } from "../ibmi/Tools.js";
import { ConnectionService } from "../controlplane/connectionService.js";
import { log } from "./logger.js";
import fs from "fs/promises";
import path from "path";
const CUSTOM_VARIABLE_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string" },
        value: { type: "string" }
    },
    required: ["name", "value"]
};
const OBJECT_FILTER_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string" },
        library: { type: "string" },
        object: { type: "string" },
        types: { type: "array", items: { type: "string" } },
        member: { type: "string" },
        memberType: { type: "string" },
        protected: { type: "boolean" },
        filterType: { type: "string", enum: ["simple", "regex"] }
    },
    required: ["name", "library", "object", "types", "member"]
};
const SETTINGS_SCHEMA = {
    type: "object",
    properties: {
        readOnlyMode: { type: "boolean" },
        tempLibrary: { type: "string" },
        tempDir: { type: "string" },
        autoClearTempData: { type: "boolean" },
        sourceFileCCSID: { type: "string" },
        sqlJobCcsid: { type: ["string", "number"] },
        enableSourceDates: { type: "boolean" },
        homeDirectory: { type: "string" },
        libraryList: { type: "array", items: { type: "string" } },
        currentLibrary: { type: "string" },
        customVariables: { type: "array", items: CUSTOM_VARIABLE_SCHEMA },
        objectFilters: { type: "array", items: OBJECT_FILTER_SCHEMA },
        ifsShortcuts: { type: "array", items: { type: "string" } },
        debugPort: { type: "number" },
        debugSepPort: { type: "number" },
        sessionIdleMinutes: { type: "number" },
        sessionPingSeconds: { type: "number" },
        sessionReconnectAttempts: { type: "number" }
    }
};
const POLICY_SCHEMA = {
    type: "object",
    properties: {
        profile: { type: "string", enum: ["read-only", "guarded", "power-user"] },
        requireApprovalFor: { type: "array", items: { type: "string" } },
        allowCommands: { type: "array", items: { type: "string" } },
        denyCommands: { type: "array", items: { type: "string" } },
        allowLibraries: { type: "array", items: { type: "string" } },
        denyLibraries: { type: "array", items: { type: "string" } },
        allowPaths: { type: "array", items: { type: "string" } },
        denyPaths: { type: "array", items: { type: "string" } }
    }
};
const ACTION_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string" },
        command: { type: "string" },
        type: { type: "string", enum: ["member", "streamfile", "object", "file"] },
        environment: { type: "string", enum: ["ile", "qsh", "pase"] },
        extensions: { type: "array", items: { type: "string" } },
        deployFirst: { type: "boolean" },
        postDownload: { type: "array", items: { type: "string" } },
        runOnProtected: { type: "boolean" },
        outputToFile: { type: "string" }
    },
    required: ["name", "command", "environment"]
};
const PROFILE_SCHEMA = {
    type: "object",
    properties: {
        name: { type: "string" },
        currentLibrary: { type: "string" },
        libraryList: { type: "array", items: { type: "string" } },
        customVariables: { type: "array", items: CUSTOM_VARIABLE_SCHEMA }
    },
    required: ["name"]
};
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
                    settings: SETTINGS_SCHEMA,
                    policy: POLICY_SCHEMA
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
                    settings: SETTINGS_SCHEMA,
                    policy: POLICY_SCHEMA
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
                    action: ACTION_SCHEMA,
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
            inputSchema: { type: "object", properties: { action: ACTION_SCHEMA }, required: ["action"] }
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
                properties: { connectionName: { type: "string" }, profile: PROFILE_SCHEMA },
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
            inputSchema: { type: "object", properties: { connectionName: { type: "string" }, filter: OBJECT_FILTER_SCHEMA }, required: ["filter"] }
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
            inputSchema: {
                type: "object",
                properties: {
                    localPath: { type: "string" },
                    remotePath: { type: "string" },
                    overwrite: { type: "boolean", default: false },
                    dryRun: { type: "boolean", default: false },
                    deleteExtraRemote: { type: "boolean", default: false }
                },
                required: ["localPath", "remotePath"]
            }
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
                    timeoutMs: { type: "number" },
                    includeMetadata: { type: "boolean" },
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
                    timeoutMs: { type: "number" },
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
                    timeoutMs: { type: "number" },
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
    return tools
        .map(withGuardedApprovalHint)
        .map(withStrictInputSchema);
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
            return json(await ctx.keepaliveSession(args?.connectionName));
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
            const conn = await ctx.ensureActive(args?.connectionName);
            const data = await conn.content.getLibraries(args.filter || "*");
            return json(data);
        }
        case "ibmi.qsys.objects.list": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const data = await conn.content.getObjectList(args.library, args.types || ["*ALL"]);
            return json(data);
        }
        case "ibmi.qsys.sourcefiles.list": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const data = await conn.content.getObjectList(args.library, ["*SRCPF"]);
            return json(data);
        }
        case "ibmi.qsys.members.list": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const data = await conn.content.getMemberList({ library: args.library, sourceFile: args.sourceFile });
            return json(data);
        }
        case "ibmi.qsys.members.read": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const content = await conn.content.downloadMemberContent(args.library, args.sourceFile, args.member);
            return result(content);
        }
        case "ibmi.qsys.members.write": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            await conn.content.uploadMemberContent(args.library, args.sourceFile, args.member, args.content);
            return result("OK");
        }
        case "ibmi.qsys.members.create": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            await conn.content.createMember(args.library, args.sourceFile, args.member, args.srctype);
            return result("OK");
        }
        case "ibmi.qsys.members.rename": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            await conn.content.renameMember(args.library, args.sourceFile, args.member, args.newMember);
            return result("OK");
        }
        case "ibmi.qsys.members.delete": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            await conn.content.deleteMember(args.library, args.sourceFile, args.member);
            return result("OK");
        }
        case "ibmi.qsys.sourcefiles.create": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            await conn.content.createSourceFile(args.library, args.sourceFile, args.rcdlen || 112);
            return result("OK");
        }
        case "ibmi.qsys.libraries.create": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            await conn.content.createLibrary(args.library);
            return result("OK");
        }
        case "ibmi.ifs.list": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const data = await conn.content.getFileList(args.path);
            return json(data);
        }
        case "ibmi.ifs.read": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const data = await conn.content.downloadStreamfileRaw(args.path);
            return result(Buffer.from(data).toString("utf8"));
        }
        case "ibmi.ifs.write": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const op = resolveIfsWriteOperation(args.path);
            enforceWritable(ctx, conn, op, args);
            await conn.content.writeStreamfileRaw(args.path, args.content);
            return result("OK");
        }
        case "ibmi.ifs.mkdir": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const op = resolveIfsWriteOperation(args.path);
            enforceWritable(ctx, conn, op, args);
            await conn.sendCommand({ command: `mkdir -p ${Tools.escapePath(args.path)}` });
            return result("OK");
        }
        case "ibmi.ifs.delete": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "ifs.delete", args);
            const flag = args.recursive ? "-rf" : "-f";
            await conn.sendCommand({ command: `rm ${flag} ${Tools.escapePath(args.path)}` });
            return result("OK");
        }
        case "ibmi.ifs.upload": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const op = resolveIfsWriteOperation(args.remotePath);
            enforceWritable(ctx, conn, op, args);
            await conn.client.putFile(args.localPath, args.remotePath);
            return result("OK");
        }
        case "ibmi.ifs.download": {
            const conn = await ctx.ensureActive(args?.connectionName);
            await conn.client.getFile(args.localPath, args.remotePath);
            return result("OK");
        }
        case "ibmi.search.members": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const members = args.members || "*";
            const data = await Search.searchMembers(conn, args.library, args.sourceFile, args.term, members, false);
            return json(data);
        }
        case "ibmi.search.ifs": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const data = await Search.searchIFS(conn, args.path, args.term);
            return json(data ?? { term: args.term, hits: [] });
        }
        case "ibmi.find.ifs": {
            const conn = await ctx.ensureActive(args?.connectionName);
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
            const conn = await ctx.ensureActive(args?.connectionName);
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
                const lib = requireQsysName(conn, args.library, "library");
                const src = requireQsysName(conn, args.sourceFile, "sourceFile");
                const mbr = requireQsysName(conn, args.member || targetPath.split("/").pop(), "member");
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
            return json(mapActionExecution(action, targetType, targetPath, resultCmd));
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
                activeConfig = (await ctx.ensureActive(name)).getConfig();
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
            const active = await ctx.ensureActive(name);
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
            const active = await ctx.ensureActive(name);
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
            const active = await ctx.ensureActive(name);
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
            const active = await ctx.ensureActive(name);
            enforceWritable(ctx, active, "qsys.write", args);
            await updateConnectionSettings(ctx, name, { currentLibrary: lib });
            if (args.applyToJob) {
                await applyLibraryList(active, undefined, lib);
            }
            return result("OK");
        }
        case "ibmi.libl.validate": {
            const conn = await ctx.ensureActive(args?.connectionName);
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
            const active = await ctx.ensureActive(name);
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
            const conn = await ctx.ensureActive(args?.connectionName);
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
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "deploy.sync", args);
            await conn.client.putDirectory(args.localPath, args.remotePath, { recursive: true, concurrency: 5 });
            return result("OK");
        }
        case "ibmi.deploy.uploadFiles": {
            const conn = await ctx.ensureActive(args?.connectionName);
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
            const conn = await ctx.ensureActive(args?.connectionName);
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
            const conn = await ctx.ensureActive(args?.connectionName);
            const port = clampNumber(conn.getConfig().debugPort, 8005, 1, 65535);
            const rows = await conn.runSQL(`select job_name, local_port from qsys2.netstat_job_info where local_port = ${port} and remote_address = '0.0.0.0' fetch first 1 row only`);
            if (rows.length === 0)
                return json({ running: false, port });
            return json({ running: true, port, job: rows[0].JOB_NAME });
        }
        case "ibmi.debug.startService": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const submitOptions = `JOBQ(QSYS/QUSRNOMAX) JOBD(QSYS/QSYSJOBD) OUTQ(QUSRSYS/QDBGSRV) USER(QDBGSRV)`;
            const cmd = `QSYS/SBMJOB JOB(QDBGSRV) SYSLIBL(*SYSVAL) CURLIB(*USRPRF) INLLIBL(*JOBD) ${submitOptions} CMD(QSH CMD('/QIBM/ProdData/IBMiDebugService/bin/startDebugService.sh'))`;
            const res = await conn.sendQsh({ command: `system \"${cmd}\"` });
            return json(res);
        }
        case "ibmi.debug.stopService": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const res = await conn.sendCommand({ command: `/QIBM/ProdData/IBMiDebugService/bin/stopDebugService.sh` });
            return json(res);
        }
        case "ibmi.deploy.compare": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const localPath = String(args.localPath);
            const remotePath = String(args.remotePath);
            const comparison = await compareDeployTrees(conn, localPath, remotePath);
            return json(comparison);
        }
        case "ibmi.deploy.sync": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "deploy.sync", args);
            const localPath = String(args.localPath);
            const remotePath = String(args.remotePath);
            const overwrite = Boolean(args.overwrite);
            const dryRun = Boolean(args.dryRun);
            const deleteExtraRemote = Boolean(args.deleteExtraRemote);
            const comparison = await compareDeployTrees(conn, localPath, remotePath);
            const uploadSet = new Set(comparison.onlyLocal);
            if (overwrite) {
                comparison.changed.forEach(entry => uploadSet.add(entry.path));
                comparison.unresolved.forEach(entry => uploadSet.add(entry.path));
            }
            const uploadPlan = Array.from(uploadSet).sort((a, b) => a.localeCompare(b));
            const skipChanged = overwrite ? [] : comparison.changed.map(entry => entry.path).sort((a, b) => a.localeCompare(b));
            const unresolved = overwrite ? [] : comparison.unresolved.map(entry => entry.path).sort((a, b) => a.localeCompare(b));
            const deletePlan = deleteExtraRemote ? [...comparison.onlyRemote] : [];
            const uploaded = [];
            const deleted = [];
            const errors = [];
            if (!dryRun) {
                const createdDirs = new Set();
                for (const rel of uploadPlan) {
                    const localFile = path.join(localPath, rel);
                    const remoteFile = joinRemotePath(remotePath, rel);
                    const remoteDir = remoteFile.split("/").slice(0, -1).join("/");
                    try {
                        if (!createdDirs.has(remoteDir)) {
                            await conn.sendCommand({ command: `mkdir -p ${Tools.escapePath(remoteDir)}` });
                            createdDirs.add(remoteDir);
                        }
                        await conn.client.putFile(localFile, remoteFile);
                        uploaded.push(rel);
                    }
                    catch (err) {
                        errors.push({ operation: "upload", path: rel, message: err?.message || String(err) });
                    }
                }
                for (const rel of deletePlan) {
                    const remoteFile = joinRemotePath(remotePath, rel);
                    try {
                        await conn.sendCommand({ command: `rm -f ${Tools.escapePath(remoteFile)}` });
                        deleted.push(rel);
                    }
                    catch (err) {
                        errors.push({ operation: "delete", path: rel, message: err?.message || String(err) });
                    }
                }
            }
            return json({
                ok: errors.length === 0,
                mode: { overwrite, deleteExtraRemote, dryRun },
                comparison,
                planned: {
                    upload: uploadPlan,
                    delete: deletePlan,
                    skippedChanged: skipChanged,
                    unresolved
                },
                applied: {
                    uploaded: dryRun ? [] : uploaded,
                    deleted: dryRun ? [] : deleted
                },
                errors
            });
        }
        case "ibmi.sql.query": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const pageSize = clampNumber(args?.pageSize, 200, 1, 5000);
            const maxRows = clampNumber(args?.maxRows, 1000, 1, 20000);
            const timeoutMs = clampNumber(args?.timeoutMs, 45000, 1000, 300000);
            const includeMetadata = Boolean(args?.includeMetadata);
            if (args?.cursor) {
                const next = ctx.consumeSqlCursor(String(args.cursor), pageSize);
                return json({
                    rows: next.rows,
                    cursor: next.cursor,
                    ...(includeMetadata
                        ? { metadata: { source: "cursor", pageSize, timeoutMs } }
                        : {})
                });
            }
            if (!args?.sql)
                throw new Error("sql is required when cursor is not provided");
            const sql = String(args.sql);
            if (!isReadOnlySql(sql))
                throw new Error("ibmi.sql.query only supports read-only SQL");
            const startedAt = Date.now();
            const rows = await withTimeout(conn.runSQL(sql), timeoutMs, `SQL query timed out after ${timeoutMs}ms`);
            const limited = rows.slice(0, maxRows);
            const firstPage = limited.slice(0, pageSize);
            const cursorInfo = ctx.createSqlCursor(limited, pageSize);
            const executionMs = Date.now() - startedAt;
            return json({
                rows: firstPage,
                cursor: cursorInfo.cursor,
                totalRows: limited.length,
                truncated: rows.length > limited.length,
                ...(includeMetadata
                    ? {
                        metadata: {
                            statementType: getSqlStatementType(sql),
                            columns: getRowColumns(firstPage),
                            pageSize,
                            maxRows,
                            timeoutMs,
                            executionMs
                        }
                    }
                    : {})
            });
        }
        case "ibmi.sql.execute": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforcePolicyOperation(ctx, "sql.write", args);
            const sql = String(args.sql);
            const timeoutMs = clampNumber(args?.timeoutMs, 45000, 1000, 300000);
            const statementType = getSqlStatementType(sql);
            const startedAt = Date.now();
            try {
                const rows = await withTimeout(conn.runSQL(sql), timeoutMs, `SQL execute timed out after ${timeoutMs}ms`);
                const executionMs = Date.now() - startedAt;
                const affectedRows = inferAffectedRows(rows);
                log("info", "audit.sql.execute", {
                    connectionName: args?.connectionName || ctx.activeName,
                    readOnly: isReadOnlySql(sql),
                    statementType,
                    timeoutMs,
                    affectedRows
                });
                return json({
                    ok: true,
                    statementType,
                    timeoutMs,
                    executionMs,
                    affectedRows,
                    returnedRows: rows.length,
                    rows
                });
            }
            catch (err) {
                const safe = toSafeSqlError(err, sql, timeoutMs);
                log("error", "audit.sql.execute.failed", {
                    connectionName: args?.connectionName || ctx.activeName,
                    statementType,
                    errorType: safe.type,
                    code: safe.code
                });
                return toolError(`SQL execute failed (${safe.type})`, safe);
            }
        }
        case "ibmi.cl.run": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforcePolicyOperation(ctx, "cl.run", args);
            const command = String(args.command || "");
            if (!command.trim())
                throw new Error("command is required");
            const environment = String(args.environment || "ile");
            const cwd = args.cwd ? String(args.cwd) : undefined;
            const timeoutMs = clampNumber(args?.timeoutMs, 45000, 1000, 300000);
            let cmdResult;
            if (environment === "pase") {
                cmdResult = await withTimeout(conn.sendCommand({ command, directory: cwd }), timeoutMs, `CL command timed out after ${timeoutMs}ms`);
            }
            else if (environment === "qsh") {
                cmdResult = await withTimeout(conn.sendQsh({ command, directory: cwd }), timeoutMs, `CL command timed out after ${timeoutMs}ms`);
            }
            else {
                try {
                    await withTimeout(conn.runSQL(`CALL QSYS2.QCMDEXC(${Tools.sqlString(command)})`), timeoutMs, `CL command timed out after ${timeoutMs}ms`);
                    cmdResult = { code: 0, signal: null, stdout: "", stderr: "", command };
                }
                catch (err) {
                    cmdResult = { code: 1, signal: null, stdout: "", stderr: err?.message || String(err), command };
                }
            }
            log("info", "audit.cl.run", { connectionName: args?.connectionName || ctx.activeName, environment });
            return json({
                ok: cmdResult?.code === 0,
                timeoutMs,
                environment,
                ...cmdResult
            });
        }
        case "ibmi.diagnostics.parseEvfevent": {
            return json(parseEvfevent(String(args.content)));
        }
        case "ibmi.joblog.get": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const limit = clampNumber(args?.limit, 200, 1, 5000);
            const rows = await conn.runSQL(`select message_id, message_text, severity, message_timestamp from table(qsys2.joblog_info('*')) order by message_timestamp desc fetch first ${limit} rows only`);
            return json(rows.map(normalizeJoblogRow));
        }
        case "ibmi.spool.list": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const limit = clampNumber(args?.limit, 200, 1, 5000);
            const rows = await conn.runSQL(`select job_name, spooled_file_name, spooled_file_number, output_queue_name, total_pages, file_status from qsys2.output_queue_entries fetch first ${limit} rows only`);
            return json(rows.map(normalizeSpoolEntry));
        }
        case "ibmi.spool.read": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const limit = clampNumber(args?.limit, 200, 1, 5000);
            const jobName = Tools.sqlString(String(args.jobName));
            const fileName = Tools.sqlString(String(args.spooledFileName));
            const fileNbr = clampNumber(args.spooledFileNumber, 1, 1, 999999999);
            const rows = await conn.runSQL(`select line_number, spooled_data from table(qsys2.display_spooled_file_data(${jobName}, ${fileName}, ${fileNbr})) fetch first ${limit} rows only`);
            return json(rows.map(normalizeSpoolLine));
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
    return {
        content: [{ type: "text", text }],
        structuredContent: { ok: true, text }
    };
}
function json(obj) {
    return {
        content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
        structuredContent: { ok: true, data: obj }
    };
}
function toolError(message, error) {
    return {
        isError: true,
        content: [{ type: "text", text: message }],
        structuredContent: {
            ok: false,
            error: {
                message,
                ...(error || {})
            }
        }
    };
}
function getConnectionName(ctx, args) {
    const name = args?.connectionName || ctx.activeName;
    if (!name)
        throw new Error("connectionName is required (no active connection)");
    return name;
}
function requireQsysName(conn, value, label) {
    const raw = String(value || "").trim().toUpperCase();
    if (!raw)
        throw new Error(`${label} is required`);
    if (!conn.validQsysName(raw))
        throw new Error(`Invalid ${label}: ${raw}`);
    return raw;
}
async function updateConnectionSettings(ctx, name, update) {
    const conn = await ctx.store.getConnection(name);
    if (!conn)
        throw new Error(`Connection ${name} not found`);
    conn.settings = { ...(conn.settings || {}), ...stripUndefined(update) };
    await ctx.store.upsertConnection(conn);
    try {
        const active = await ctx.ensureActive(name);
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
async function compareDeployTrees(conn, localRoot, remoteRoot) {
    const local = await listLocalFiles(localRoot);
    const remote = await listRemoteFiles(conn, remoteRoot);
    const onlyLocal = [];
    const onlyRemote = [];
    const identical = [];
    const changed = [];
    const unresolved = [];
    const localKeys = new Set(local.keys());
    const remoteKeys = new Set(remote.keys());
    for (const rel of localKeys) {
        if (!remoteKeys.has(rel)) {
            onlyLocal.push(rel);
            continue;
        }
        const l = local.get(rel);
        const r = remote.get(rel);
        if (typeof l.size === "number" && typeof r.size === "number") {
            if (l.size === r.size) {
                identical.push(rel);
            }
            else {
                changed.push({ path: rel, localSize: l.size, remoteSize: r.size, reason: "size_mismatch" });
            }
        }
        else {
            unresolved.push({ path: rel, localSize: l.size, remoteSize: r.size, reason: "unknown_size" });
        }
    }
    for (const rel of remoteKeys) {
        if (!localKeys.has(rel)) {
            onlyRemote.push(rel);
        }
    }
    onlyLocal.sort((a, b) => a.localeCompare(b));
    onlyRemote.sort((a, b) => a.localeCompare(b));
    identical.sort((a, b) => a.localeCompare(b));
    changed.sort((a, b) => a.path.localeCompare(b.path));
    unresolved.sort((a, b) => a.path.localeCompare(b.path));
    return {
        localRoot: path.resolve(localRoot),
        remoteRoot: remoteRoot.replace(/\/$/, ""),
        onlyLocal,
        onlyRemote,
        identical,
        changed,
        unresolved,
        summary: {
            localFiles: local.size,
            remoteFiles: remote.size,
            onlyLocal: onlyLocal.length,
            onlyRemote: onlyRemote.length,
            identical: identical.length,
            changed: changed.length,
            unresolved: unresolved.length
        }
    };
}
async function listLocalFiles(root) {
    const resolvedRoot = path.resolve(root);
    const results = new Map();
    async function walk(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            const rel = path.relative(resolvedRoot, full).replace(/\\/g, "/");
            if (entry.isDirectory()) {
                await walk(full);
            }
            else {
                const stat = await fs.stat(full);
                results.set(rel, { path: rel, size: stat.size });
            }
        }
    }
    await walk(resolvedRoot);
    return results;
}
async function listRemoteFiles(conn, remoteRoot) {
    const normalizedRoot = remoteRoot.replace(/\/$/, "");
    const find = conn.remoteFeatures.find || "/QOpenSys/pkgs/bin/find";
    const stat = conn.remoteFeatures.stat;
    if (stat) {
        const statCmd = `${find} ${Tools.escapePath(normalizedRoot)} -type f -exec ${stat} -c '%n|%s' {} \\;`;
        const statRes = await conn.sendCommand({ command: statCmd });
        if (statRes.code === 0) {
            const mapped = parseRemoteStatLines(statRes.stdout || "", normalizedRoot);
            if (mapped.size > 0)
                return mapped;
        }
    }
    const res = await conn.sendCommand({ command: `${find} ${Tools.escapePath(normalizedRoot)} -type f -print` });
    if (res.code !== 0) {
        throw new Error(res.stderr || `Failed to list remote files under ${normalizedRoot}`);
    }
    const mapped = new Map();
    const lines = String(res.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
        const rel = toRelativeRemotePath(line, normalizedRoot);
        mapped.set(rel, { path: rel });
    }
    return mapped;
}
function parseRemoteStatLines(output, remoteRoot) {
    const mapped = new Map();
    const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
        const split = line.lastIndexOf("|");
        if (split < 0)
            continue;
        const absolute = line.substring(0, split);
        const sizeText = line.substring(split + 1);
        const size = Number(sizeText);
        const rel = toRelativeRemotePath(absolute, remoteRoot);
        mapped.set(rel, { path: rel, size: Number.isFinite(size) ? size : undefined });
    }
    return mapped;
}
function toRelativeRemotePath(absolutePath, remoteRoot) {
    const trimmedRoot = remoteRoot.replace(/\/$/, "");
    const normalizedPath = absolutePath.replace(/\\/g, "/");
    if (normalizedPath === trimmedRoot)
        return "";
    if (normalizedPath.startsWith(`${trimmedRoot}/`)) {
        return normalizedPath.substring(trimmedRoot.length + 1);
    }
    return normalizedPath.replace(/^[\\/]/, "");
}
function joinRemotePath(root, rel) {
    const base = root.replace(/\/$/, "");
    return `${base}/${rel}`.replace(/\\/g, "/");
}
function mapActionExecution(action, targetType, targetPath, result) {
    const diagnostics = normalizeCommandDiagnostics(result);
    const code = Number(result?.code);
    const ok = Number.isFinite(code) ? code === 0 : false;
    const status = ok ? (diagnostics.some(d => d.severity === "ERROR") ? "warning" : "success") : "error";
    return {
        ...result,
        ok,
        status,
        action: {
            name: action.name,
            type: action.type || "member",
            environment: action.environment
        },
        target: {
            type: targetType,
            path: targetPath
        },
        diagnostics
    };
}
function normalizeCommandDiagnostics(result) {
    const stdout = String(result?.stdout || "");
    const stderr = String(result?.stderr || "");
    const diagnostics = [
        ...extractDiagnostics(stdout, "stdout"),
        ...extractDiagnostics(stderr, "stderr")
    ];
    return diagnostics.slice(0, 500);
}
function extractDiagnostics(text, stream) {
    const diagnostics = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line)
            continue;
        const codeMatch = line.match(/\b(CPF\d{4}|SQL\d{4}|RNX\d{4}|MCH\d{4}|RNQ\d{4})\b/i);
        diagnostics.push({
            stream,
            severity: inferSeverity(line),
            code: codeMatch ? codeMatch[1].toUpperCase() : undefined,
            message: line
        });
    }
    return diagnostics;
}
function inferSeverity(line) {
    const text = line.toUpperCase();
    if (/(ERROR|FAILED|EXCEPTION|SEV\s*[4-9]|SEVERITY\s*[4-9])/.test(text))
        return "ERROR";
    if (/(WARN|WARNING|SEV\s*[1-3]|SEVERITY\s*[1-3])/.test(text))
        return "WARN";
    return "INFO";
}
function normalizeJoblogRow(row) {
    return {
        ...row,
        source: "joblog",
        id: String(row.MESSAGE_ID || ""),
        text: String(row.MESSAGE_TEXT || ""),
        severity: Number.isFinite(Number(row.SEVERITY)) ? Number(row.SEVERITY) : null,
        timestamp: row.MESSAGE_TIMESTAMP ? String(row.MESSAGE_TIMESTAMP) : undefined
    };
}
function normalizeSpoolEntry(row) {
    return {
        ...row,
        source: "spool",
        jobName: String(row.JOB_NAME || ""),
        spooledFileName: String(row.SPOOLED_FILE_NAME || ""),
        spooledFileNumber: Number(row.SPOOLED_FILE_NUMBER || 0),
        outputQueue: String(row.OUTPUT_QUEUE_NAME || ""),
        totalPages: Number.isFinite(Number(row.TOTAL_PAGES)) ? Number(row.TOTAL_PAGES) : null,
        status: String(row.FILE_STATUS || "")
    };
}
function normalizeSpoolLine(row) {
    return {
        ...row,
        source: "spool",
        lineNumber: Number.isFinite(Number(row.LINE_NUMBER)) ? Number(row.LINE_NUMBER) : null,
        text: String(row.SPOOLED_DATA || "")
    };
}
function clampNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}
async function withTimeout(promise, timeoutMs, timeoutMessage) {
    let timeoutHandle;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeoutHandle = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
            })
        ]);
    }
    finally {
        if (timeoutHandle)
            clearTimeout(timeoutHandle);
    }
}
function getSqlStatementType(sql) {
    const stripped = sql
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .split("\n")
        .filter(line => !line.trim().startsWith("--"))
        .join(" ")
        .trim();
    const token = stripped.split(/\s+/)[0] || "UNKNOWN";
    return token.toUpperCase();
}
function getRowColumns(rows) {
    if (!Array.isArray(rows) || rows.length === 0)
        return [];
    return Object.keys(rows[0] || {});
}
function inferAffectedRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0)
        return null;
    const candidateKeys = [
        "ROWS_AFFECTED",
        "ROW_COUNT",
        "AFFECTED_ROWS",
        "NUM_ROWS",
        "NUMBER_ROWS"
    ];
    const first = rows[0] || {};
    for (const key of candidateKeys) {
        const value = first[key];
        if (typeof value === "number" && Number.isFinite(value))
            return value;
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return null;
}
function toSafeSqlError(err, sql, timeoutMs) {
    const message = err?.message || String(err);
    const lower = String(message).toLowerCase();
    let type = "unknown_error";
    if (lower.includes("timed out"))
        type = "timeout";
    else if (lower.includes("blocked by policy"))
        type = "policy_error";
    else if (lower.includes("transport closed") || lower.includes("not connected") || lower.includes("socket"))
        type = "connection_error";
    else if (err?.name === "SqlError" || /sql\d{4}/i.test(message) || /sqlstate/i.test(message))
        type = "sql_error";
    const sqlStateMatch = String(message).match(/sqlstate[^a-z0-9]*([0-9a-z]{5})/i);
    const codeMatch = String(message).match(/\b([A-Z]{2,}\d{3,5})\b/);
    return {
        type,
        message,
        statementType: getSqlStatementType(sql),
        timeoutMs,
        sqlState: sqlStateMatch ? sqlStateMatch[1].toUpperCase() : undefined,
        code: codeMatch ? codeMatch[1].toUpperCase() : undefined
    };
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
function withStrictInputSchema(tool) {
    const schema = strictifySchema(tool.inputSchema || { type: "object", properties: {} });
    return { ...tool, inputSchema: schema };
}
function strictifySchema(schema) {
    const next = { ...schema };
    if (isObjectSchema(next) && typeof next.additionalProperties === "undefined") {
        next.additionalProperties = false;
    }
    if (next.properties) {
        const strictProps = {};
        for (const [key, child] of Object.entries(next.properties)) {
            strictProps[key] = strictifySchema(child);
        }
        next.properties = strictProps;
    }
    if (next.items) {
        next.items = strictifySchema(next.items);
    }
    return next;
}
function isObjectSchema(schema) {
    if (!schema.type)
        return false;
    if (Array.isArray(schema.type))
        return schema.type.includes("object");
    return schema.type === "object";
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
                source: "evfevent",
                line: Number(match[1]),
                column: Number(match[2]),
                code: match[3],
                severity: (match[4] || "ERROR").toUpperCase(),
                message: match[5] || line
            });
        }
        else {
            diagnostics.push({ source: "evfevent", severity: inferSeverity(line), message: line });
        }
    }
    return diagnostics;
}
