import { LocalLanguageActions } from "../ibmi/LocalLanguageActions.js";
import { CompileTools } from "../ibmi/CompileTools.js";
import { Search } from "../ibmi/Search.js";
import { Tools } from "../ibmi/Tools.js";
import { ConnectionService } from "../controlplane/connectionService.js";
import { log } from "./logger.js";
import { exportAuditRecords, listAuditRecords, purgeAuditRecords, verifyAuditChain } from "./audit.js";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
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
const tn5250Sessions = new Map();
const TN5250_MAX_LINES = 30;
const TN5250_MAX_HISTORY = 20;
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
            name: "ibmi.spool.hold",
            description: "Hold a spool file entry.",
            inputSchema: {
                type: "object",
                properties: {
                    jobName: { type: "string" },
                    spooledFileName: { type: "string" },
                    spooledFileNumber: { type: "number" },
                    connectionName: { type: "string" }
                },
                required: ["jobName", "spooledFileName", "spooledFileNumber"]
            }
        },
        {
            name: "ibmi.spool.release",
            description: "Release a held spool file entry.",
            inputSchema: {
                type: "object",
                properties: {
                    jobName: { type: "string" },
                    spooledFileName: { type: "string" },
                    spooledFileNumber: { type: "number" },
                    connectionName: { type: "string" }
                },
                required: ["jobName", "spooledFileName", "spooledFileNumber"]
            }
        },
        {
            name: "ibmi.spool.delete",
            description: "Delete a spool file entry.",
            inputSchema: {
                type: "object",
                properties: {
                    jobName: { type: "string" },
                    spooledFileName: { type: "string" },
                    spooledFileNumber: { type: "number" },
                    connectionName: { type: "string" }
                },
                required: ["jobName", "spooledFileName", "spooledFileNumber"]
            }
        },
        {
            name: "ibmi.spool.move",
            description: "Move a spool file entry to another output queue.",
            inputSchema: {
                type: "object",
                properties: {
                    jobName: { type: "string" },
                    spooledFileName: { type: "string" },
                    spooledFileNumber: { type: "number" },
                    outQueueLibrary: { type: "string" },
                    outQueue: { type: "string" },
                    connectionName: { type: "string" }
                },
                required: ["jobName", "spooledFileName", "spooledFileNumber", "outQueueLibrary", "outQueue"]
            }
        },
        {
            name: "ibmi.jobs.list",
            description: "List active jobs with optional filters.",
            inputSchema: {
                type: "object",
                properties: {
                    subsystem: { type: "string" },
                    userName: { type: "string" },
                    status: { type: "string" },
                    limit: { type: "number" },
                    connectionName: { type: "string" }
                }
            }
        },
        {
            name: "ibmi.jobs.hold",
            description: "Hold a job.",
            inputSchema: {
                type: "object",
                properties: {
                    jobName: { type: "string" },
                    holdOnJobQueue: { type: "boolean", default: false },
                    connectionName: { type: "string" }
                },
                required: ["jobName"]
            }
        },
        {
            name: "ibmi.jobs.release",
            description: "Release a held job.",
            inputSchema: {
                type: "object",
                properties: {
                    jobName: { type: "string" },
                    connectionName: { type: "string" }
                },
                required: ["jobName"]
            }
        },
        {
            name: "ibmi.jobs.end",
            description: "End a job.",
            inputSchema: {
                type: "object",
                properties: {
                    jobName: { type: "string" },
                    option: { type: "string", enum: ["*CNTRLD", "*IMMED"], default: "*CNTRLD" },
                    delaySeconds: { type: "number", default: 30 },
                    connectionName: { type: "string" }
                },
                required: ["jobName"]
            }
        },
        {
            name: "ibmi.subsystems.list",
            description: "List active subsystems and active job counts.",
            inputSchema: {
                type: "object",
                properties: {
                    limit: { type: "number" },
                    connectionName: { type: "string" }
                }
            }
        },
        {
            name: "ibmi.subsystems.status",
            description: "Get runtime status details for one subsystem.",
            inputSchema: {
                type: "object",
                properties: {
                    subsystem: { type: "string" },
                    limit: { type: "number" },
                    connectionName: { type: "string" }
                },
                required: ["subsystem"]
            }
        },
        {
            name: "ibmi.subsystems.start",
            description: "Start a subsystem from subsystem description.",
            inputSchema: {
                type: "object",
                properties: {
                    subsystemDescription: { type: "string" },
                    connectionName: { type: "string" }
                },
                required: ["subsystemDescription"]
            }
        },
        {
            name: "ibmi.subsystems.end",
            description: "End a subsystem.",
            inputSchema: {
                type: "object",
                properties: {
                    subsystem: { type: "string" },
                    option: { type: "string", enum: ["*CNTRLD", "*IMMED"], default: "*CNTRLD" },
                    delaySeconds: { type: "number", default: 30 },
                    connectionName: { type: "string" }
                },
                required: ["subsystem"]
            }
        },
        {
            name: "ibmi.msgq.read",
            description: "Read messages from a message queue.",
            inputSchema: {
                type: "object",
                properties: {
                    library: { type: "string", default: "QSYS" },
                    messageQueue: { type: "string", default: "QSYSOPR" },
                    limit: { type: "number" },
                    connectionName: { type: "string" }
                }
            }
        },
        {
            name: "ibmi.msgq.send",
            description: "Send a message to a message queue.",
            inputSchema: {
                type: "object",
                properties: {
                    library: { type: "string", default: "QSYS" },
                    messageQueue: { type: "string", default: "QSYSOPR" },
                    message: { type: "string" },
                    messageType: { type: "string", enum: ["*INFO", "*INQ", "*COMP", "*DIAG"], default: "*INFO" },
                    connectionName: { type: "string" }
                },
                required: ["message"]
            }
        },
        {
            name: "ibmi.msgq.reply",
            description: "Reply to an inquiry message by key.",
            inputSchema: {
                type: "object",
                properties: {
                    library: { type: "string", default: "QSYS" },
                    messageQueue: { type: "string", default: "QSYSOPR" },
                    messageKey: { type: "string" },
                    reply: { type: "string" },
                    connectionName: { type: "string" }
                },
                required: ["messageKey", "reply"]
            }
        },
        {
            name: "ibmi.locks.list",
            description: "List lock/contention entries with optional filters.",
            inputSchema: {
                type: "object",
                properties: {
                    objectLibrary: { type: "string" },
                    objectName: { type: "string" },
                    objectType: { type: "string" },
                    member: { type: "string" },
                    limit: { type: "number" },
                    connectionName: { type: "string" }
                }
            }
        },
        {
            name: "ibmi.authority.object.get",
            description: "Get authority details for an object.",
            inputSchema: {
                type: "object",
                properties: {
                    library: { type: "string" },
                    object: { type: "string" },
                    objectType: { type: "string", default: "*FILE" },
                    limit: { type: "number" },
                    connectionName: { type: "string" }
                },
                required: ["library", "object"]
            }
        },
        {
            name: "ibmi.dataqueue.send",
            description: "Send an entry to a data queue.",
            inputSchema: {
                type: "object",
                properties: {
                    library: { type: "string" },
                    queue: { type: "string" },
                    message: { type: "string" },
                    connectionName: { type: "string" }
                },
                required: ["library", "queue", "message"]
            }
        },
        {
            name: "ibmi.dataqueue.receive",
            description: "Receive (or peek) an entry from a data queue.",
            inputSchema: {
                type: "object",
                properties: {
                    library: { type: "string" },
                    queue: { type: "string" },
                    waitSeconds: { type: "number", default: 0 },
                    remove: { type: "boolean", default: true },
                    connectionName: { type: "string" }
                },
                required: ["library", "queue"]
            }
        },
        {
            name: "ibmi.dataarea.read",
            description: "Read data area metadata and value.",
            inputSchema: {
                type: "object",
                properties: {
                    library: { type: "string" },
                    dataArea: { type: "string" },
                    connectionName: { type: "string" }
                },
                required: ["library", "dataArea"]
            }
        },
        {
            name: "ibmi.dataarea.write",
            description: "Write value into a data area.",
            inputSchema: {
                type: "object",
                properties: {
                    library: { type: "string" },
                    dataArea: { type: "string" },
                    value: { type: "string" },
                    startPosition: { type: "number", default: 1 },
                    length: { type: "number" },
                    connectionName: { type: "string" }
                },
                required: ["library", "dataArea", "value"]
            }
        },
        {
            name: "ibmi.audit.list",
            description: "Read MCP tool audit records.",
            inputSchema: {
                type: "object",
                properties: {
                    limit: { type: "number" },
                    tool: { type: "string" },
                    status: { type: "string", enum: ["ok", "error"] },
                    connectionName: { type: "string" },
                    correlationId: { type: "string" },
                    since: { type: "string" }
                }
            }
        },
        {
            name: "ibmi.audit.verify",
            description: "Verify audit record hash-chain integrity.",
            inputSchema: { type: "object", properties: {} }
        },
        {
            name: "ibmi.audit.export",
            description: "Export audit records for compliance review.",
            inputSchema: {
                type: "object",
                properties: {
                    outputPath: { type: "string" },
                    format: { type: "string", enum: ["jsonl", "json", "csv"] },
                    limit: { type: "number" },
                    tool: { type: "string" },
                    status: { type: "string", enum: ["ok", "error"] },
                    connectionName: { type: "string" },
                    correlationId: { type: "string" },
                    since: { type: "string" }
                },
                required: ["outputPath"]
            }
        },
        {
            name: "ibmi.audit.purge",
            description: "Purge audit records older than a timestamp (with optional dry run).",
            inputSchema: {
                type: "object",
                properties: {
                    before: { type: "string" },
                    dryRun: { type: "boolean" },
                    approve: { type: "boolean" }
                },
                required: ["before"]
            }
        },
        {
            name: "ibmi.journal.objects.list",
            description: "List journal and journal receiver objects in a library.",
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
            name: "ibmi.journal.entries.query",
            description: "Read normalized entries from a journal.",
            inputSchema: {
                type: "object",
                properties: {
                    journalLibrary: { type: "string" },
                    journal: { type: "string" },
                    objectLibrary: { type: "string" },
                    objectName: { type: "string" },
                    journalCode: { type: "string" },
                    entryType: { type: "string" },
                    userName: { type: "string" },
                    jobName: { type: "string" },
                    programName: { type: "string" },
                    limit: { type: "number" },
                    sinceSequence: { type: "number" },
                    sinceTimestamp: { type: "string" },
                    connectionName: { type: "string" }
                },
                required: ["journalLibrary", "journal"]
            }
        },
        {
            name: "ibmi.qaudjrn.events.query",
            description: "Query QAUDJRN security/compliance events with normalized output.",
            inputSchema: {
                type: "object",
                properties: {
                    journalCode: { type: "string" },
                    entryType: { type: "string" },
                    userName: { type: "string" },
                    jobName: { type: "string" },
                    programName: { type: "string" },
                    limit: { type: "number" },
                    sinceSequence: { type: "number" },
                    sinceTimestamp: { type: "string" },
                    connectionName: { type: "string" }
                }
            }
        },
        {
            name: "ibmi.journal.receiver.create",
            description: "Create a journal receiver.",
            inputSchema: {
                type: "object",
                properties: {
                    library: { type: "string" },
                    receiver: { type: "string" },
                    threshold: { type: "number" },
                    connectionName: { type: "string" }
                },
                required: ["library", "receiver"]
            }
        },
        {
            name: "ibmi.journal.create",
            description: "Create a journal and attach it to a receiver.",
            inputSchema: {
                type: "object",
                properties: {
                    library: { type: "string" },
                    journal: { type: "string" },
                    receiverLibrary: { type: "string" },
                    receiver: { type: "string" },
                    connectionName: { type: "string" }
                },
                required: ["library", "journal", "receiverLibrary", "receiver"]
            }
        },
        {
            name: "ibmi.journal.receiver.change",
            description: "Switch a journal to a new receiver.",
            inputSchema: {
                type: "object",
                properties: {
                    journalLibrary: { type: "string" },
                    journal: { type: "string" },
                    receiverLibrary: { type: "string" },
                    receiver: { type: "string" },
                    connectionName: { type: "string" }
                },
                required: ["journalLibrary", "journal", "receiverLibrary", "receiver"]
            }
        },
        {
            name: "ibmi.journal.startPf",
            description: "Start journaling for a physical file.",
            inputSchema: {
                type: "object",
                properties: {
                    library: { type: "string" },
                    file: { type: "string" },
                    journalLibrary: { type: "string" },
                    journal: { type: "string" },
                    images: { type: "string", enum: ["*AFTER", "*BOTH"] },
                    connectionName: { type: "string" }
                },
                required: ["library", "file", "journalLibrary", "journal"]
            }
        },
        {
            name: "ibmi.journal.endPf",
            description: "End journaling for a physical file.",
            inputSchema: {
                type: "object",
                properties: {
                    library: { type: "string" },
                    file: { type: "string" },
                    connectionName: { type: "string" }
                },
                required: ["library", "file"]
            }
        },
        {
            name: "ibmi.journal.startIfs",
            description: "Start journaling for an IFS object.",
            inputSchema: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    objectType: { type: "string", enum: ["*STMF", "*DIR"], default: "*STMF" },
                    journalLibrary: { type: "string" },
                    journal: { type: "string" },
                    connectionName: { type: "string" }
                },
                required: ["path", "journalLibrary", "journal"]
            }
        },
        {
            name: "ibmi.journal.endIfs",
            description: "End journaling for an IFS object.",
            inputSchema: {
                type: "object",
                properties: {
                    path: { type: "string" },
                    objectType: { type: "string", enum: ["*STMF", "*DIR"], default: "*STMF" },
                    connectionName: { type: "string" }
                },
                required: ["path"]
            }
        },
        {
            name: "ibmi.journal.receivers.retention",
            description: "Apply retention policy to detached journal receivers.",
            inputSchema: {
                type: "object",
                properties: {
                    journalLibrary: { type: "string" },
                    journal: { type: "string" },
                    retentionDays: { type: "number" },
                    maxDeletes: { type: "number" },
                    dryRun: { type: "boolean", default: true },
                    connectionName: { type: "string" }
                },
                required: ["journalLibrary", "journal", "retentionDays"]
            }
        },
        {
            name: "ibmi.compliance.report.generate",
            description: "Generate a compliance report preset and optional signed evidence bundle.",
            inputSchema: {
                type: "object",
                properties: {
                    preset: { type: "string", enum: ["phase6_baseline", "qaudjrn_daily", "journal_retention"], default: "phase6_baseline" },
                    sinceTimestamp: { type: "string" },
                    auditLimit: { type: "number" },
                    qaudLimit: { type: "number" },
                    outputPath: { type: "string" },
                    sign: { type: "boolean", default: false },
                    signingKey: { type: "string" },
                    includeRaw: { type: "boolean", default: false },
                    connectionName: { type: "string" }
                }
            }
        },
        {
            name: "ibmi.tn5250.connect",
            description: "Connect to a TN5250 command session.",
            inputSchema: { type: "object", properties: { connectionName: { type: "string" } } }
        },
        {
            name: "ibmi.tn5250.readScreen",
            description: "Read TN5250 screen model.",
            inputSchema: { type: "object", properties: { connectionName: { type: "string" } } }
        },
        {
            name: "ibmi.tn5250.setField",
            description: "Set TN5250 field value.",
            inputSchema: {
                type: "object",
                properties: { fieldId: { type: "string" }, value: { type: "string" }, connectionName: { type: "string" } },
                required: ["fieldId", "value"]
            }
        },
        {
            name: "ibmi.tn5250.sendKeys",
            description: "Send TN5250 keys.",
            inputSchema: {
                type: "object",
                properties: { keys: { type: "string" }, timeoutMs: { type: "number" }, connectionName: { type: "string" }, approve: { type: "boolean" } },
                required: ["keys"]
            }
        },
        {
            name: "ibmi.tn5250.waitFor",
            description: "Wait for TN5250 text condition.",
            inputSchema: { type: "object", properties: { text: { type: "string" }, timeoutMs: { type: "number" }, connectionName: { type: "string" } } }
        },
        {
            name: "ibmi.tn5250.snapshot",
            description: "Capture TN5250 snapshot.",
            inputSchema: { type: "object", properties: { connectionName: { type: "string" } } }
        },
        {
            name: "ibmi.tn5250.disconnect",
            description: "Disconnect TN5250 session.",
            inputSchema: { type: "object", properties: { connectionName: { type: "string" } } }
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
            const name = args?.connectionName || ctx.activeName;
            await ctx.disconnect(args?.connectionName);
            if (name) {
                tn5250Sessions.delete(name);
            }
            else {
                tn5250Sessions.clear();
            }
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
            const name = args?.connectionName || ctx.activeName;
            await ctx.terminateSession(args?.connectionName);
            if (name)
                tn5250Sessions.delete(name);
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
            let files;
            try {
                files = await conn.content.getObjectList(args.library, ["*FILE"]);
            }
            catch {
                try {
                    const allObjects = await conn.content.getObjectList(args.library, ["*ALL"]);
                    files = allObjects.filter((obj) => String(obj?.type || "").toUpperCase() === "*FILE");
                }
                catch {
                    const rows = await conn.runSQL(`select system_table_name as name, coalesce(table_text, '') as text from qsys2.systables where upper(system_table_schema)=${Tools.sqlString(String(args.library || "").toUpperCase())} fetch first 5000 rows only`);
                    files = rows.map((row) => ({
                        library: String(args.library || "").toUpperCase(),
                        name: String(row?.NAME || row?.SYSTEM_TABLE_NAME || ""),
                        type: "*FILE",
                        text: String(row?.TEXT || row?.TABLE_TEXT || ""),
                        attribute: ""
                    }));
                }
            }
            const sourceByAttr = files.filter((obj) => {
                const attr = String(obj?.attribute || "").toUpperCase();
                return attr === "PF-SRC" || attr === "SOURCE";
            });
            if (sourceByAttr.length > 0)
                return json(sourceByAttr);
            const sourceByName = files.filter((obj) => String(obj?.name || "").toUpperCase().endsWith("SRC"));
            return json(sourceByName.length > 0 ? sourceByName : files);
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
            const cmdResult = await runClCommand(conn, command, environment, cwd, timeoutMs);
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
            const rows = await querySpoolEntries(conn, limit);
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
        case "ibmi.spool.hold": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const command = buildSpoolCommand("HLDSPFL", args);
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({ ok: cmdResult.code === 0, command, ...cmdResult });
        }
        case "ibmi.spool.release": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const command = buildSpoolCommand("RLSSPLF", args);
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({ ok: cmdResult.code === 0, command, ...cmdResult });
        }
        case "ibmi.spool.delete": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const command = buildSpoolCommand("DLTSPLF", args);
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({ ok: cmdResult.code === 0, command, ...cmdResult });
        }
        case "ibmi.spool.move": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const baseCommand = buildSpoolCommand("CHGSPLFA", args);
            const outQueueLibrary = requireIbmObjectName(args.outQueueLibrary, "outQueueLibrary");
            const outQueue = requireIbmObjectName(args.outQueue, "outQueue");
            const command = `${baseCommand} OUTQ(${outQueueLibrary}/${outQueue})`;
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({ ok: cmdResult.code === 0, command, ...cmdResult });
        }
        case "ibmi.jobs.list": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const limit = clampNumber(args?.limit, 200, 1, 5000);
            const rows = await queryJobs(conn, {
                subsystem: args?.subsystem,
                userName: args?.userName,
                status: args?.status,
                limit
            });
            return json(rows);
        }
        case "ibmi.jobs.hold": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const jobName = requireJobName(args.jobName);
            const hold = Boolean(args?.holdOnJobQueue) ? "*JOBQ" : "*NO";
            const command = `HLDJOB JOB(${jobName}) HOLD(${hold})`;
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({ ok: cmdResult.code === 0, command, ...cmdResult });
        }
        case "ibmi.jobs.release": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const jobName = requireJobName(args.jobName);
            const command = `RLSJOB JOB(${jobName})`;
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({ ok: cmdResult.code === 0, command, ...cmdResult });
        }
        case "ibmi.jobs.end": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const jobName = requireJobName(args.jobName);
            const option = String(args?.option || "*CNTRLD").toUpperCase();
            if (option !== "*CNTRLD" && option !== "*IMMED") {
                throw new Error("option must be *CNTRLD or *IMMED");
            }
            const delaySeconds = clampNumber(args?.delaySeconds, 30, 0, 99999);
            const command = `ENDJOB JOB(${jobName}) OPTION(${option}) DELAY(${delaySeconds})`;
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({ ok: cmdResult.code === 0, command, ...cmdResult });
        }
        case "ibmi.subsystems.list": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const limit = clampNumber(args?.limit, 200, 1, 5000);
            const rows = await querySubsystemSummary(conn, limit);
            return json(rows);
        }
        case "ibmi.subsystems.status": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const subsystem = requireIbmObjectName(args.subsystem, "subsystem");
            const limit = clampNumber(args?.limit, 500, 1, 5000);
            const rows = await queryJobs(conn, { subsystem, limit });
            return json({
                subsystem,
                activeJobs: rows.length,
                jobs: rows
            });
        }
        case "ibmi.subsystems.start": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const subsystemDescription = requireQualifiedObject(args.subsystemDescription, "subsystemDescription");
            const command = `STRSBS SBSD(${subsystemDescription.library}/${subsystemDescription.object})`;
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({ ok: cmdResult.code === 0, command, ...cmdResult });
        }
        case "ibmi.subsystems.end": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const subsystem = requireIbmObjectName(args.subsystem, "subsystem");
            const option = String(args?.option || "*CNTRLD").toUpperCase();
            if (option !== "*CNTRLD" && option !== "*IMMED") {
                throw new Error("option must be *CNTRLD or *IMMED");
            }
            const delaySeconds = clampNumber(args?.delaySeconds, 30, 0, 99999);
            const command = `ENDSBS SBS(${subsystem}) OPTION(${option}) DELAY(${delaySeconds})`;
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({ ok: cmdResult.code === 0, command, ...cmdResult });
        }
        case "ibmi.msgq.read": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const library = requireIbmObjectName(args?.library || "QSYS", "library");
            const messageQueue = requireIbmObjectName(args?.messageQueue || "QSYSOPR", "messageQueue");
            const limit = clampNumber(args?.limit, 200, 1, 5000);
            const rows = await queryMessageQueueEntries(conn, { library, messageQueue, limit });
            return json(rows);
        }
        case "ibmi.msgq.send": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const library = requireIbmObjectName(args?.library || "QSYS", "library");
            const messageQueue = requireIbmObjectName(args?.messageQueue || "QSYSOPR", "messageQueue");
            const messageType = String(args?.messageType || "*INFO").toUpperCase();
            if (!["*INFO", "*INQ", "*COMP", "*DIAG"].includes(messageType)) {
                throw new Error("messageType must be *INFO, *INQ, *COMP, or *DIAG");
            }
            const message = String(args.message || "");
            if (!message.trim())
                throw new Error("message is required");
            const mappedMessageType = messageType === "*INQ" ? "*INQ" : "*INFO";
            const command = mappedMessageType === "*INQ"
                ? `SNDMSG MSG(${quoteClString(message)}) TOMSGQ(${library}/${messageQueue}) MSGTYPE(*INQ) RPYMSGQ(${library}/${messageQueue})`
                : `SNDMSG MSG(${quoteClString(message)}) TOMSGQ(${library}/${messageQueue}) MSGTYPE(*INFO)`;
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({ ok: cmdResult.code === 0, command, requestedMessageType: messageType, mappedMessageType, ...cmdResult });
        }
        case "ibmi.msgq.reply": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const library = requireIbmObjectName(args?.library || "QSYS", "library");
            const messageQueue = requireIbmObjectName(args?.messageQueue || "QSYSOPR", "messageQueue");
            const messageKey = requireMessageKey(args.messageKey);
            const reply = String(args.reply || "");
            if (!reply.trim())
                throw new Error("reply is required");
            const command = `SNDRPY MSGKEY(${messageKey}) MSGQ(${library}/${messageQueue}) RPY(${quoteClString(reply)})`;
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({ ok: cmdResult.code === 0, command, ...cmdResult });
        }
        case "ibmi.locks.list": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const limit = clampNumber(args?.limit, 200, 1, 5000);
            const rows = await queryLockEntries(conn, {
                objectLibrary: args?.objectLibrary,
                objectName: args?.objectName,
                objectType: args?.objectType,
                member: args?.member,
                limit
            });
            return json(rows);
        }
        case "ibmi.authority.object.get": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const library = requireIbmObjectName(args.library, "library");
            const object = requireIbmObjectName(args.object, "object");
            const objectType = String(args?.objectType || "*FILE").toUpperCase();
            const limit = clampNumber(args?.limit, 500, 1, 5000);
            const rows = await queryObjectAuthorities(conn, { library, object, objectType, limit });
            return json(rows);
        }
        case "ibmi.dataqueue.send": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const library = requireIbmObjectName(args.library, "library");
            const queue = requireIbmObjectName(args.queue, "queue");
            const message = String(args.message || "");
            if (!message)
                throw new Error("message is required");
            try {
                await conn.runSQL(`call qsys2.send_data_queue(${Tools.sqlString(message)}, ${Tools.sqlString(queue)}, ${Tools.sqlString(library)})`);
                return json({
                    ok: true,
                    method: "qsys2.send_data_queue",
                    library,
                    queue,
                    messageLength: message.length
                });
            }
            catch {
                const command = `SNDDTAQ DTAQ(${library}/${queue}) DTA(${quoteClString(message)})`;
                const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
                return json({ ok: cmdResult.code === 0, method: "cl.snddtaq", command, ...cmdResult });
            }
        }
        case "ibmi.dataqueue.receive": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const library = requireIbmObjectName(args.library, "library");
            const queue = requireIbmObjectName(args.queue, "queue");
            const waitSeconds = clampNumber(args?.waitSeconds, 0, 0, 999999);
            const remove = Boolean(args?.remove ?? true);
            const rows = await queryDataQueueEntries(conn, { library, queue, waitSeconds, remove });
            return json(rows);
        }
        case "ibmi.dataarea.read": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const library = requireIbmObjectName(args.library, "library");
            const dataArea = requireIbmObjectName(args.dataArea, "dataArea");
            const rows = await queryDataAreaInfo(conn, { library, dataArea });
            return json(rows);
        }
        case "ibmi.dataarea.write": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const library = requireIbmObjectName(args.library, "library");
            const dataArea = requireIbmObjectName(args.dataArea, "dataArea");
            const value = String(args.value || "");
            const startPosition = clampNumber(args?.startPosition, 1, 1, 2000);
            const length = clampNumber(args?.length, Math.max(value.length, 1), 1, 2000);
            const command = `CHGDTAARA DTAARA(${library}/${dataArea} (${startPosition} ${length})) VALUE(${quoteClString(value)})`;
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({ ok: cmdResult.code === 0, command, ...cmdResult });
        }
        case "ibmi.audit.list": {
            const data = await listAuditRecords({
                limit: args?.limit,
                tool: args?.tool,
                status: args?.status,
                connectionName: args?.connectionName,
                correlationId: args?.correlationId,
                since: args?.since
            });
            return json(data);
        }
        case "ibmi.audit.verify": {
            const verification = await verifyAuditChain();
            return json(verification);
        }
        case "ibmi.audit.export": {
            const exported = await exportAuditRecords({
                outputPath: String(args.outputPath),
                format: args?.format,
                filter: {
                    limit: args?.limit,
                    tool: args?.tool,
                    status: args?.status,
                    connectionName: args?.connectionName,
                    correlationId: args?.correlationId,
                    since: args?.since
                }
            });
            return json(exported);
        }
        case "ibmi.audit.purge": {
            if (!Boolean(args?.dryRun) && !Boolean(args?.approve)) {
                throw new Error("ibmi.audit.purge requires approve=true unless dryRun=true.");
            }
            const purged = await purgeAuditRecords({
                before: String(args.before),
                dryRun: Boolean(args?.dryRun)
            });
            return json(purged);
        }
        case "ibmi.journal.objects.list": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const data = await conn.content.getObjectList(args.library, args.types || ["*JRN", "*JRNRCV"]);
            return json(data);
        }
        case "ibmi.journal.entries.query": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const journalLibrary = requireIbmObjectName(args.journalLibrary, "journalLibrary");
            const journal = requireIbmObjectName(args.journal, "journal");
            const objectLibrary = args?.objectLibrary ? requireIbmObjectName(args.objectLibrary, "objectLibrary") : undefined;
            const objectName = args?.objectName ? requireIbmObjectName(args.objectName, "objectName") : undefined;
            const journalCode = args?.journalCode ? requireJournalCode(args.journalCode) : undefined;
            const entryType = args?.entryType ? requireJournalEntryType(args.entryType) : undefined;
            const userName = args?.userName ? requireIbmObjectName(args.userName, "userName") : undefined;
            const jobName = args?.jobName ? String(args.jobName).trim().toUpperCase() : undefined;
            const programName = args?.programName ? requireIbmObjectName(args.programName, "programName") : undefined;
            const limit = clampNumber(args?.limit, 200, 1, 5000);
            const sinceSequence = Number.isFinite(Number(args?.sinceSequence)) ? Number(args.sinceSequence) : undefined;
            const sinceTimestamp = args?.sinceTimestamp ? String(args.sinceTimestamp) : undefined;
            const rows = await queryJournalEntries(conn, {
                journalLibrary,
                journal,
                objectLibrary,
                objectName,
                journalCode,
                entryType,
                userName,
                jobName,
                programName,
                limit,
                sinceSequence,
                sinceTimestamp
            });
            return json(rows);
        }
        case "ibmi.qaudjrn.events.query": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const journalCode = args?.journalCode ? requireJournalCode(args.journalCode) : undefined;
            const entryType = args?.entryType ? requireJournalEntryType(args.entryType) : undefined;
            const userName = args?.userName ? requireIbmObjectName(args.userName, "userName") : undefined;
            const jobName = args?.jobName ? String(args.jobName).trim().toUpperCase() : undefined;
            const programName = args?.programName ? requireIbmObjectName(args.programName, "programName") : undefined;
            const limit = clampNumber(args?.limit, 200, 1, 5000);
            const sinceSequence = Number.isFinite(Number(args?.sinceSequence)) ? Number(args.sinceSequence) : undefined;
            const sinceTimestamp = args?.sinceTimestamp ? String(args.sinceTimestamp) : undefined;
            const events = await queryJournalEntries(conn, {
                journalLibrary: "QSYS",
                journal: "QAUDJRN",
                journalCode,
                entryType,
                userName,
                jobName,
                programName,
                limit,
                sinceSequence,
                sinceTimestamp
            });
            return json({
                events,
                summary: summarizeQaudjrnEvents(events)
            });
        }
        case "ibmi.journal.receiver.create": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const lib = requireIbmObjectName(args.library, "library");
            const rcv = requireIbmObjectName(args.receiver, "receiver");
            const threshold = clampNumber(args?.threshold, 1000000, 1, 1000000000);
            const command = `CRTJRNRCV JRNRCV(${lib}/${rcv}) THRESHOLD(${threshold})`;
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({
                ok: cmdResult.code === 0,
                command,
                ...cmdResult
            });
        }
        case "ibmi.journal.create": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const lib = requireIbmObjectName(args.library, "library");
            const jrn = requireIbmObjectName(args.journal, "journal");
            const rcvLib = requireIbmObjectName(args.receiverLibrary, "receiverLibrary");
            const rcv = requireIbmObjectName(args.receiver, "receiver");
            const command = `CRTJRN JRN(${lib}/${jrn}) JRNRCV(${rcvLib}/${rcv})`;
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({
                ok: cmdResult.code === 0,
                command,
                ...cmdResult
            });
        }
        case "ibmi.journal.receiver.change": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const jrnLib = requireIbmObjectName(args.journalLibrary, "journalLibrary");
            const jrn = requireIbmObjectName(args.journal, "journal");
            const rcvLib = requireIbmObjectName(args.receiverLibrary, "receiverLibrary");
            const rcv = requireIbmObjectName(args.receiver, "receiver");
            const command = `CHGJRN JRN(${jrnLib}/${jrn}) JRNRCV(${rcvLib}/${rcv})`;
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({
                ok: cmdResult.code === 0,
                command,
                ...cmdResult
            });
        }
        case "ibmi.journal.startPf": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const lib = requireIbmObjectName(args.library, "library");
            const file = requireIbmObjectName(args.file, "file");
            const jrnLib = requireIbmObjectName(args.journalLibrary, "journalLibrary");
            const jrn = requireIbmObjectName(args.journal, "journal");
            const images = String(args?.images || "*BOTH").toUpperCase();
            if (images !== "*AFTER" && images !== "*BOTH") {
                throw new Error("images must be *AFTER or *BOTH");
            }
            const command = `STRJRNPF FILE(${lib}/${file}) JRN(${jrnLib}/${jrn}) IMAGES(${images})`;
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({
                ok: cmdResult.code === 0,
                command,
                ...cmdResult
            });
        }
        case "ibmi.journal.endPf": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const lib = requireIbmObjectName(args.library, "library");
            const file = requireIbmObjectName(args.file, "file");
            const command = `ENDJRNPF FILE(${lib}/${file})`;
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({
                ok: cmdResult.code === 0,
                command,
                ...cmdResult
            });
        }
        case "ibmi.journal.startIfs": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const objectType = requireIfsJournalObjectType(args?.objectType);
            const journalLibrary = requireIbmObjectName(args.journalLibrary, "journalLibrary");
            const journal = requireIbmObjectName(args.journal, "journal");
            const objectPath = requireIfsPath(args.path, "path");
            const command = `STRJRNOBJ OBJ((${quoteClString(objectPath)} ${objectType})) JRN(${journalLibrary}/${journal})`;
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({
                ok: cmdResult.code === 0,
                command,
                ...cmdResult
            });
        }
        case "ibmi.journal.endIfs": {
            const conn = await ctx.ensureActive(args?.connectionName);
            enforceWritable(ctx, conn, "qsys.write", args);
            const objectType = requireIfsJournalObjectType(args?.objectType);
            const objectPath = requireIfsPath(args.path, "path");
            const command = `ENDJRNOBJ OBJ((${quoteClString(objectPath)} ${objectType}))`;
            const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
            return json({
                ok: cmdResult.code === 0,
                command,
                ...cmdResult
            });
        }
        case "ibmi.journal.receivers.retention": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const journalLibrary = requireIbmObjectName(args.journalLibrary, "journalLibrary");
            const journal = requireIbmObjectName(args.journal, "journal");
            const retentionDays = clampNumber(args?.retentionDays, 30, 1, 36500);
            const maxDeletes = clampNumber(args?.maxDeletes, 50, 1, 500);
            const dryRun = Boolean(args?.dryRun);
            if (!dryRun && !Boolean(args?.approve)) {
                throw new Error("ibmi.journal.receivers.retention requires approve=true unless dryRun=true.");
            }
            const plan = await planJournalReceiverRetention(conn, {
                journalLibrary,
                journal,
                retentionDays
            });
            const candidates = plan.candidates.slice(0, maxDeletes);
            if (dryRun || candidates.length === 0) {
                return json({
                    ok: true,
                    dryRun,
                    retentionDays,
                    maxDeletes,
                    totalCandidates: plan.candidates.length,
                    candidates
                });
            }
            enforceWritable(ctx, conn, "qsys.write", args);
            const deleted = [];
            for (const candidate of candidates) {
                const command = `DLTJRNRCV JRNRCV(${candidate.receiverLibrary}/${candidate.receiver}) DLTOPT(*IGNINQMSG)`;
                const result = await runClCommand(conn, command, "ile", undefined, 45000);
                deleted.push({
                    receiverLibrary: candidate.receiverLibrary,
                    receiver: candidate.receiver,
                    ok: result.code === 0,
                    error: result.code === 0 ? undefined : String(result.stderr || "")
                });
            }
            return json({
                ok: deleted.every(item => item.ok),
                dryRun: false,
                retentionDays,
                maxDeletes,
                totalCandidates: plan.candidates.length,
                deleted
            });
        }
        case "ibmi.compliance.report.generate": {
            const conn = await ctx.ensureActive(args?.connectionName);
            const preset = String(args?.preset || "phase6_baseline");
            const sinceTimestamp = args?.sinceTimestamp ? String(args.sinceTimestamp) : undefined;
            const auditLimit = clampNumber(args?.auditLimit, 1000, 1, 10000);
            const qaudLimit = clampNumber(args?.qaudLimit, 1000, 1, 10000);
            const includeRaw = Boolean(args?.includeRaw);
            const report = await buildComplianceReport(conn, {
                preset,
                sinceTimestamp,
                auditLimit,
                qaudLimit,
                includeRaw
            });
            if (!args?.outputPath) {
                return json(report);
            }
            const outputPath = path.resolve(String(args.outputPath));
            await fs.mkdir(path.dirname(outputPath), { recursive: true });
            await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
            let signaturePath;
            let digestPath;
            let signature;
            if (Boolean(args?.sign)) {
                const signingKey = String(args?.signingKey || process.env.MCP_FOR_I_EVIDENCE_SIGNING_KEY || "");
                if (!signingKey) {
                    throw new Error("sign=true requires signingKey or MCP_FOR_I_EVIDENCE_SIGNING_KEY.");
                }
                const payload = JSON.stringify(report);
                signature = signEvidencePayload(payload, signingKey);
                signaturePath = `${outputPath}.sig`;
                digestPath = `${outputPath}.sha256`;
                await fs.writeFile(signaturePath, `${signature}\n`, "utf8");
                await fs.writeFile(digestPath, `${sha256Hex(payload)}\n`, "utf8");
            }
            return json({
                ok: true,
                preset,
                outputPath,
                signed: Boolean(args?.sign),
                signaturePath,
                digestPath,
                signature
            });
        }
        case "ibmi.tn5250.connect": {
            const name = getConnectionName(ctx, args);
            await ctx.ensureActive(name);
            const session = ensureTn5250Session(name);
            appendTn5250Message(session, `Session ready for ${name}.`);
            return json(session.screen);
        }
        case "ibmi.tn5250.readScreen": {
            const session = requireTn5250Session(ctx, args);
            return json(session.screen);
        }
        case "ibmi.tn5250.setField": {
            const session = requireTn5250Session(ctx, args);
            const field = findTn5250Field(session, args.fieldId);
            if (!field)
                throw new Error(`TN5250 field not found: ${args.fieldId}`);
            if (field.protected)
                throw new Error(`TN5250 field is protected: ${field.id}`);
            const value = String(args.value || "");
            field.value = value.length > field.length ? value.substring(0, field.length) : value;
            touchTn5250Session(session);
            return json(session.screen);
        }
        case "ibmi.tn5250.sendKeys": {
            const session = requireTn5250Session(ctx, args);
            const conn = await ctx.ensureActive(session.connectionName);
            const keys = parseTn5250Keys(args.keys);
            const timeoutMs = clampNumber(args?.timeoutMs, 45000, 1000, 300000);
            const commandField = findTn5250Field(session, "command");
            session.screen.lastKeys = keys;
            session.screen.status = "busy";
            touchTn5250Session(session);
            for (const key of keys) {
                if (key === "ENTER" || key === "RETURN") {
                    const command = String(commandField?.value || "").trim();
                    if (!command) {
                        appendTn5250Message(session, "No command entered.");
                        continue;
                    }
                    enforcePolicyOperation(ctx, "cl.run", {
                        ...args,
                        command,
                        connectionName: session.connectionName
                    });
                    const cmdResult = await runClCommand(conn, command, "ile", undefined, timeoutMs);
                    const recent = await readRecentJoblogMessages(conn, 5);
                    const messages = recent.map((row) => {
                        const id = String(row.MESSAGE_ID || "");
                        const text = String(row.MESSAGE_TEXT || "");
                        return id ? `[${id}] ${text}` : text;
                    });
                    session.screen.commandHistory.unshift({
                        at: new Date().toISOString(),
                        command,
                        ok: cmdResult.code === 0,
                        code: cmdResult.code,
                        stderr: cmdResult.stderr ? String(cmdResult.stderr) : undefined,
                        messages: messages.slice(0, 5)
                    });
                    if (session.screen.commandHistory.length > TN5250_MAX_HISTORY) {
                        session.screen.commandHistory = session.screen.commandHistory.slice(0, TN5250_MAX_HISTORY);
                    }
                    appendTn5250Message(session, `${cmdResult.code === 0 ? "OK" : "ERROR"}: ${command}`);
                    for (const line of messages.slice(0, 3)) {
                        appendTn5250Message(session, line);
                    }
                    if (commandField)
                        commandField.value = "";
                    continue;
                }
                if (key === "CLEAR" || key === "F3" || key === "F12") {
                    resetTn5250Screen(session, `Cleared via ${key}.`);
                    continue;
                }
                if (key === "TAB") {
                    rotateTn5250Cursor(session);
                    continue;
                }
                appendTn5250Message(session, `Unsupported key: ${key}`);
            }
            session.screen.status = "ready";
            touchTn5250Session(session);
            return json(session.screen);
        }
        case "ibmi.tn5250.waitFor": {
            const session = requireTn5250Session(ctx, args);
            const timeoutMs = clampNumber(args?.timeoutMs, 5000, 250, 120000);
            const pattern = args?.text ? String(args.text) : "";
            if (!pattern) {
                return json({ matched: true, timeoutMs, screen: session.screen });
            }
            const matched = await waitForTn5250Text(session, pattern, timeoutMs);
            return json({ matched, text: pattern, timeoutMs, screen: session.screen });
        }
        case "ibmi.tn5250.snapshot": {
            const session = requireTn5250Session(ctx, args);
            return json({
                capturedAt: new Date().toISOString(),
                connectionName: session.connectionName,
                plainText: renderTn5250Screen(session.screen),
                screen: session.screen
            });
        }
        case "ibmi.tn5250.disconnect": {
            const name = resolveTn5250SessionName(ctx, args);
            if (!name)
                throw new Error("connectionName is required (no active session)");
            const existed = tn5250Sessions.delete(name);
            return json({ disconnected: existed, connectionName: name });
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
async function runClCommand(conn, command, environment, cwd, timeoutMs) {
    if (environment === "pase") {
        return await withTimeout(conn.sendCommand({ command, directory: cwd }), timeoutMs, `CL command timed out after ${timeoutMs}ms`);
    }
    if (environment === "qsh") {
        return await withTimeout(conn.sendQsh({ command, directory: cwd }), timeoutMs, `CL command timed out after ${timeoutMs}ms`);
    }
    try {
        await withTimeout(conn.runSQL(`CALL QSYS2.QCMDEXC(${Tools.sqlString(command)})`), timeoutMs, `CL command timed out after ${timeoutMs}ms`);
        return { code: 0, signal: null, stdout: "", stderr: "", command };
    }
    catch (err) {
        return { code: 1, signal: null, stdout: "", stderr: err?.message || String(err), command };
    }
}
async function readRecentJoblogMessages(conn, limit) {
    try {
        const capped = clampNumber(limit, 5, 1, 20);
        return await conn.runSQL(`select message_id, message_text, severity, message_timestamp from table(qsys2.joblog_info('*')) order by message_timestamp desc fetch first ${capped} rows only`);
    }
    catch {
        return [];
    }
}
async function queryJournalEntries(conn, options) {
    let rows;
    try {
        rows = await queryJournalEntriesViaDisplayJournal(conn, options);
    }
    catch {
        rows = await queryJournalEntriesViaOutfile(conn, options);
    }
    let normalized = rows.map(normalizeJournalEntry);
    if (options.objectLibrary) {
        normalized = normalized.filter(row => (row.objectLibrary || "") === options.objectLibrary);
    }
    if (options.objectName) {
        normalized = normalized.filter(row => (row.objectName || "") === options.objectName);
    }
    if (options.journalCode) {
        normalized = normalized.filter(row => (row.journalCode || "") === options.journalCode);
    }
    if (options.entryType) {
        normalized = normalized.filter(row => (row.entryType || "") === options.entryType);
    }
    if (options.userName) {
        normalized = normalized.filter(row => (row.userName || "") === options.userName);
    }
    if (options.jobName) {
        normalized = normalized.filter(row => (row.jobName || "").includes(options.jobName));
    }
    if (options.programName) {
        normalized = normalized.filter(row => (row.programName || "") === options.programName);
    }
    if (typeof options.sinceSequence === "number") {
        normalized = normalized.filter(row => typeof row.sequence === "number" && row.sequence >= options.sinceSequence);
    }
    if (options.sinceTimestamp) {
        const cutoff = Date.parse(options.sinceTimestamp);
        if (Number.isFinite(cutoff)) {
            normalized = normalized.filter(row => {
                if (!row.timestamp)
                    return false;
                const value = Date.parse(row.timestamp);
                return Number.isFinite(value) && value >= cutoff;
            });
        }
    }
    normalized.sort((a, b) => {
        const aSeq = typeof a.sequence === "number" ? a.sequence : -1;
        const bSeq = typeof b.sequence === "number" ? b.sequence : -1;
        if (aSeq !== bSeq)
            return bSeq - aSeq;
        const aTs = a.timestamp ? Date.parse(a.timestamp) : -1;
        const bTs = b.timestamp ? Date.parse(b.timestamp) : -1;
        return bTs - aTs;
    });
    return normalized.slice(0, options.limit);
}
async function queryJobs(conn, options) {
    const scanLimit = Math.min(options.limit * 5, 5000);
    const rows = [];
    const activeWhere = buildJobWhereClause(options, {
        subsystem: "SUBSYSTEM",
        userName: "AUTHORIZATION_NAME",
        status: "JOB_STATUS"
    });
    try {
        const activeRows = await conn.runSQL(`select * from table(qsys2.active_job_info())${activeWhere} fetch first ${scanLimit} rows only`);
        rows.push(...activeRows.map((row) => normalizeActiveJobRow(row)));
    }
    catch {
        // Continue with job_info fallback.
    }
    const allWhere = buildJobWhereClause(options, {
        subsystem: "JOB_SUBSYSTEM",
        userName: "JOB_USER",
        status: "JOB_STATUS"
    });
    try {
        const allRows = await conn.runSQL(`select * from table(qsys2.job_info('*ALL'))${allWhere} fetch first ${scanLimit} rows only`);
        const seen = new Set(rows.map((row) => String(row.jobName || "")));
        for (const row of allRows.map((raw) => normalizeActiveJobRow(raw))) {
            const key = String(row.jobName || "");
            if (!key || seen.has(key))
                continue;
            rows.push(row);
            seen.add(key);
        }
    }
    catch {
        // Some systems may not provide job_info as a table function.
    }
    return rows.slice(0, options.limit);
}
function buildJobWhereClause(options, columns) {
    const predicates = [];
    if (options.subsystem) {
        const subsystem = String(options.subsystem).trim().toUpperCase();
        if (subsystem)
            predicates.push(`upper(${columns.subsystem})=${Tools.sqlString(subsystem)}`);
    }
    if (options.userName) {
        const userName = String(options.userName).trim().toUpperCase();
        if (userName)
            predicates.push(`upper(${columns.userName})=${Tools.sqlString(userName)}`);
    }
    if (options.status) {
        const status = String(options.status).trim().toUpperCase().replace(/'/g, "''");
        if (status)
            predicates.push(`upper(${columns.status}) like '%${status}%'`);
    }
    return predicates.length > 0 ? ` where ${predicates.join(" and ")}` : "";
}
async function querySubsystemSummary(conn, limit) {
    const jobs = await queryJobs(conn, { limit: 5000 });
    const counts = new Map();
    for (const job of jobs) {
        const subsystem = String(job.subsystem || "").trim().toUpperCase() || "UNKNOWN";
        counts.set(subsystem, (counts.get(subsystem) || 0) + 1);
    }
    const rows = Array.from(counts.entries())
        .map(([subsystem, activeJobs]) => ({ subsystem, activeJobs }))
        .sort((a, b) => a.subsystem.localeCompare(b.subsystem));
    return rows.slice(0, limit);
}
function normalizeActiveJobRow(row) {
    return {
        source: "job",
        jobName: toNullableString(pickFirst(row, ["JOB_NAME", "QUALIFIED_JOB_NAME", "JOB"])),
        subsystem: toNullableString(pickFirst(row, ["SUBSYSTEM", "SUBSYSTEM_NAME", "JOB_SUBSYSTEM"])),
        status: toNullableString(pickFirst(row, ["JOB_STATUS", "STATUS"])),
        function: toNullableString(pickFirst(row, ["FUNCTION", "CURRENT_FUNCTION"])),
        userName: toNullableString(pickFirst(row, ["AUTHORIZATION_NAME", "USER_NAME", "CURRENT_USER", "JOB_USER"])),
        type: toNullableString(pickFirst(row, ["JOB_TYPE", "TYPE"])),
        cpuSeconds: toNullableNumber(pickFirst(row, ["CPU_TIME", "TOTAL_CPU_TIME", "ELAPSED_TOTAL_SECONDS"]))
    };
}
async function queryMessageQueueEntries(conn, options) {
    let rows;
    try {
        rows = await conn.runSQL(`select * from table(qsys2.message_queue_info(message_queue_name => ${Tools.sqlString(options.messageQueue)}, message_queue_library => ${Tools.sqlString(options.library)})) fetch first ${options.limit} rows only`);
    }
    catch {
        rows = await conn.runSQL(`select * from qsys2.message_queue_info where upper(message_queue_name)=${Tools.sqlString(options.messageQueue)} and upper(message_queue_library)=${Tools.sqlString(options.library)} fetch first ${options.limit} rows only`);
    }
    return rows.map(normalizeMessageQueueEntry);
}
async function querySpoolEntries(conn, limit) {
    const queries = [
        `select * from qsys2.output_queue_entries fetch first ${limit} rows only`,
        `select * from table(qsys2.output_queue_entries()) fetch first ${limit} rows only`,
        `select job_name, spooled_file_name, spooled_file_number, output_queue_name, total_pages, file_status from qsys2.output_queue_entries fetch first ${limit} rows only`,
        `select job_name, spooled_file_name, spooled_file_number, output_queue_name, total_pages, cast('' as varchar(10)) as file_status from qsys2.output_queue_entries fetch first ${limit} rows only`,
        `select job_name, spooled_file_name, cast(0 as integer) as spooled_file_number, output_queue_name, total_pages, file_status from qsys2.output_queue_entries fetch first ${limit} rows only`,
        `select job_name, spooled_file_name, cast(0 as integer) as spooled_file_number, output_queue_name, total_pages, cast('' as varchar(10)) as file_status from qsys2.output_queue_entries fetch first ${limit} rows only`,
        `select * from qsys2.spooled_file_info fetch first ${limit} rows only`,
        `select * from table(qsys2.spooled_file_info()) fetch first ${limit} rows only`
    ];
    let lastError;
    for (const sql of queries) {
        try {
            return await conn.runSQL(sql);
        }
        catch (err) {
            lastError = err;
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError || "Unable to read spool entries"));
}
function normalizeMessageQueueEntry(row) {
    return {
        source: "msgq",
        messageKey: toNullableString(pickFirst(row, ["MESSAGE_KEY", "MSGKEY"])),
        messageId: toNullableString(pickFirst(row, ["MESSAGE_ID", "MSGID"])),
        messageType: toNullableString(pickFirst(row, ["MESSAGE_TYPE", "MSGTYPE"])),
        severity: toNullableNumber(pickFirst(row, ["SEVERITY", "MSGSEV"])),
        text: toNullableString(pickFirst(row, ["MESSAGE_TEXT", "MSGTEXT"])),
        senderUser: toNullableString(pickFirst(row, ["FROM_USER", "FROM_USER_PROFILE", "SENDER_USER_PROFILE"])),
        sentAt: toNullableString(pickFirst(row, ["MESSAGE_TIMESTAMP", "SENT_TIMESTAMP"]))
    };
}
async function queryLockEntries(conn, options) {
    let rows;
    try {
        rows = await conn.runSQL(`select * from table(qsys2.object_lock_info()) fetch first ${Math.min(options.limit, 500)} rows only`);
    }
    catch {
        rows = await conn.runSQL(`select * from qsys2.object_lock_info fetch first ${Math.min(options.limit, 500)} rows only`);
    }
    let normalized = rows.map(normalizeLockEntry);
    if (options.objectLibrary)
        normalized = normalized.filter(row => (row.objectLibrary || "") === String(options.objectLibrary).toUpperCase());
    if (options.objectName)
        normalized = normalized.filter(row => (row.objectName || "") === String(options.objectName).toUpperCase());
    if (options.objectType)
        normalized = normalized.filter(row => (row.objectType || "") === String(options.objectType).toUpperCase());
    if (options.member)
        normalized = normalized.filter(row => (row.member || "") === String(options.member).toUpperCase());
    return normalized.slice(0, options.limit);
}
function normalizeLockEntry(row) {
    return {
        source: "lock",
        objectLibrary: toNullableString(pickFirst(row, ["OBJECT_SCHEMA", "OBJECT_LIBRARY", "OBJLIB"])),
        objectName: toNullableString(pickFirst(row, ["OBJECT_NAME", "OBJNAME"])),
        objectType: toNullableString(pickFirst(row, ["OBJECT_TYPE", "OBJTYPE"])),
        member: toNullableString(pickFirst(row, ["MEMBER_NAME", "MEMBER"])),
        lockState: toNullableString(pickFirst(row, ["LOCK_STATE", "LOCK_STATUS", "STATUS"])),
        lockScope: toNullableString(pickFirst(row, ["LOCK_SCOPE", "SCOPE"])),
        lockHolderJob: toNullableString(pickFirst(row, ["JOB_NAME", "LOCK_JOB_NAME"])),
        lockHolderUser: toNullableString(pickFirst(row, ["USER_NAME", "AUTHORIZATION_NAME"]))
    };
}
async function queryObjectAuthorities(conn, options) {
    const rows = await conn.runSQL(`select * from qsys2.object_privileges where upper(object_schema)=${Tools.sqlString(options.library)} and upper(object_name)=${Tools.sqlString(options.object)} fetch first ${options.limit} rows only`);
    let normalized = rows.map(normalizeObjectAuthorityRow);
    if (options.objectType) {
        normalized = normalized.filter((row) => !row.objectType || row.objectType === options.objectType);
    }
    return normalized;
}
function normalizeObjectAuthorityRow(row) {
    return {
        source: "authority",
        objectLibrary: toNullableString(pickFirst(row, ["OBJECT_SCHEMA", "OBJECT_LIBRARY"])),
        objectName: toNullableString(pickFirst(row, ["OBJECT_NAME"])),
        objectType: toNullableString(pickFirst(row, ["OBJECT_TYPE"])),
        grantee: toNullableString(pickFirst(row, ["GRANTEE", "AUTHORIZATION_NAME"])),
        grantor: toNullableString(pickFirst(row, ["GRANTOR"])),
        authority: toNullableString(pickFirst(row, ["OBJECT_AUTHORITY", "DATA_AUTHORITY", "PRIVILEGE_TYPE"])),
        inherited: toNullableString(pickFirst(row, ["IS_GRANTABLE", "INHERITED"])),
        raw: row
    };
}
async function queryDataQueueEntries(conn, options) {
    let rows;
    try {
        rows = await conn.runSQL(`select * from table(qsys2.receive_data_queue(${Tools.sqlString(options.queue)}, ${Tools.sqlString(options.library)}, ${Tools.sqlString(options.remove ? "YES" : "NO")}, ${options.waitSeconds})) fetch first 1 rows only`);
    }
    catch {
        try {
            rows = await conn.runSQL(`select * from table(qsys2.receive_data_queue(${Tools.sqlString(options.queue)}, ${Tools.sqlString(options.library)})) fetch first 1 rows only`);
        }
        catch {
            try {
                rows = await conn.runSQL(`select * from table(qsys2.data_queue_entries(${Tools.sqlString(options.queue)}, ${Tools.sqlString(options.library)})) fetch first 1 rows only`);
            }
            catch {
                rows = await conn.runSQL(`select * from qsys2.data_queue_entries where upper(data_queue_name)=${Tools.sqlString(options.queue)} and upper(data_queue_library)=${Tools.sqlString(options.library)} fetch first 1 rows only`);
            }
        }
    }
    return rows.map(normalizeDataQueueEntry);
}
function normalizeDataQueueEntry(row) {
    return {
        source: "dataqueue",
        message: toNullableString(pickFirst(row, ["MESSAGE_DATA", "DATA_QUEUE_ENTRY", "DATA"])),
        sender: toNullableString(pickFirst(row, ["SENDER_JOB_NAME", "SENDER_USER_PROFILE"])),
        sentAt: toNullableString(pickFirst(row, ["ENQUEUE_TIMESTAMP", "TIMESTAMP"])),
        key: toNullableString(pickFirst(row, ["KEY_DATA", "KEY"]))
    };
}
async function queryDataAreaInfo(conn, options) {
    let rows;
    try {
        rows = await conn.runSQL(`select * from table(qsys2.data_area_info(data_area_name => ${Tools.sqlString(options.dataArea)}, data_area_library => ${Tools.sqlString(options.library)}))`);
    }
    catch {
        rows = await conn.runSQL(`select * from qsys2.data_area_info where upper(data_area_name)=${Tools.sqlString(options.dataArea)} and upper(data_area_library)=${Tools.sqlString(options.library)}`);
    }
    return rows.map(normalizeDataAreaInfoRow);
}
function normalizeDataAreaInfoRow(row) {
    return {
        source: "dataarea",
        library: toNullableString(pickFirst(row, ["DATA_AREA_LIBRARY", "OBJECT_SCHEMA"])),
        dataArea: toNullableString(pickFirst(row, ["DATA_AREA_NAME", "OBJECT_NAME"])),
        type: toNullableString(pickFirst(row, ["DATA_AREA_TYPE", "OBJECT_TYPE"])),
        length: toNullableNumber(pickFirst(row, ["LENGTH", "DATA_AREA_LENGTH"])),
        value: toNullableString(pickFirst(row, ["CHARACTER_VALUE", "VALUE", "DECIMAL_VALUE"])),
        updatedAt: toNullableString(pickFirst(row, ["LAST_CHANGED_TIMESTAMP", "CHANGE_TIMESTAMP"]))
    };
}
function buildSpoolCommand(commandName, args) {
    const jobName = requireJobName(args.jobName);
    const spooledFileName = requireIbmObjectName(args.spooledFileName, "spooledFileName");
    const rawNumber = Number(args.spooledFileNumber);
    const spooledFileNumber = Number.isFinite(rawNumber) && rawNumber > 0
        ? String(Math.floor(rawNumber))
        : "*LAST";
    return `${commandName} FILE(${spooledFileName}) JOB(${jobName}) SPLNBR(${spooledFileNumber})`;
}
async function queryJournalEntriesViaDisplayJournal(conn, options) {
    const sampleSize = Math.min(options.limit * 5, 5000);
    const rows = await conn.runSQL(`select * from table(qsys2.display_journal(journal_name => ${Tools.sqlString(options.journal)}, journal_library => ${Tools.sqlString(options.journalLibrary)})) fetch first ${sampleSize} rows only`);
    return rows;
}
async function queryJournalEntriesViaOutfile(conn, options) {
    const outfile = `MCPJ${String(Math.floor(Math.random() * 90000) + 10000)}`;
    const fileFilter = options.objectLibrary && options.objectName
        ? ` FILE((${options.objectLibrary}/${options.objectName}))`
        : "";
    const command = `DSPJRN JRN(${options.journalLibrary}/${options.journal}) OUTPUT(*OUTFILE) OUTFILE(QTEMP/${outfile})${fileFilter}`;
    const result = await runClCommand(conn, command, "ile", undefined, 45000);
    if (result.code !== 0) {
        throw new Error(result.stderr || "Unable to query journal entries");
    }
    const rows = await conn.runSQL(`select * from QTEMP.${outfile}`);
    return rows;
}
function normalizeJournalEntry(row) {
    const sequence = toNullableNumber(pickFirst(row, ["SEQUENCE_NUMBER", "JOURNAL_SEQUENCE_NUMBER", "JOSEQN", "JRN_SEQUENCE"]));
    const timestamp = toNullableString(pickFirst(row, ["ENTRY_TIMESTAMP", "TIMESTAMP", "JOTSTP", "JOURNAL_TIMESTAMP"]));
    const journalCode = toNullableString(pickFirst(row, ["JOURNAL_CODE", "JOCODE", "JRN_CODE"]));
    const entryType = toNullableString(pickFirst(row, ["JOURNAL_ENTRY_TYPE", "JOENTT", "ENTRY_TYPE"]));
    const objectLibrary = toNullableString(pickFirst(row, ["OBJECT_LIBRARY", "JOLIB", "OBJLIB"]));
    const objectName = toNullableString(pickFirst(row, ["OBJECT_NAME", "JOOBJ", "OBJNAME"]));
    const objectType = toNullableString(pickFirst(row, ["OBJECT_TYPE", "JOOBJT", "OBJTYPE"]));
    const jobName = toNullableString(pickFirst(row, ["JOB_NAME", "JOJOB", "JOB"]));
    const userName = toNullableString(pickFirst(row, ["USER_NAME", "JOUSER", "USER"]));
    const programName = toNullableString(pickFirst(row, ["PROGRAM_NAME", "JOPGM", "PROGRAM"]));
    return {
        source: "journal",
        sequence,
        timestamp,
        journalCode,
        entryType,
        objectLibrary,
        objectName,
        objectType,
        jobName,
        userName,
        programName
    };
}
function pickFirst(row, keys) {
    for (const key of keys) {
        if (typeof row[key] !== "undefined" && row[key] !== null)
            return row[key];
    }
    return undefined;
}
function toNullableNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}
function toNullableString(value) {
    if (typeof value === "undefined" || value === null)
        return null;
    const text = String(value).trim();
    return text.length > 0 ? text : null;
}
function ensureTn5250Session(connectionName) {
    const existing = tn5250Sessions.get(connectionName);
    if (existing) {
        touchTn5250Session(existing);
        return existing;
    }
    const now = new Date().toISOString();
    const session = {
        connectionName,
        createdAt: Date.now(),
        screen: {
            sessionId: `tn5250:${connectionName}`,
            connectionName,
            title: "MCP TN5250 Command Session",
            status: "ready",
            textLines: [
                `Connected to ${connectionName}.`,
                "Set field 'command' (or fieldId '1') and send Enter.",
                "Supported keys: Enter, Tab, F3, F12, Clear."
            ],
            fields: [
                {
                    id: "command",
                    label: "Command",
                    value: "",
                    row: 20,
                    col: 2,
                    length: 512,
                    protected: false
                }
            ],
            cursorFieldId: "command",
            lastKeys: [],
            commandHistory: [],
            updatedAt: now
        }
    };
    tn5250Sessions.set(connectionName, session);
    return session;
}
function requireTn5250Session(ctx, args) {
    const name = resolveTn5250SessionName(ctx, args);
    if (!name)
        throw new Error("connectionName is required (no active session)");
    const session = tn5250Sessions.get(name);
    if (!session) {
        throw new Error(`TN5250 session for ${name} not found. Call ibmi.tn5250.connect first.`);
    }
    return session;
}
function resolveTn5250SessionName(ctx, args) {
    return args?.connectionName || ctx.activeName;
}
function findTn5250Field(session, fieldId) {
    const normalized = String(fieldId || "").trim().toLowerCase();
    if (!normalized)
        return undefined;
    const aliases = normalized === "1" ? ["command", "1"] : [normalized];
    return session.screen.fields.find(field => {
        const id = field.id.toLowerCase();
        return aliases.includes(id);
    });
}
function parseTn5250Keys(value) {
    const raw = String(value || "").trim();
    if (!raw)
        throw new Error("keys is required");
    return raw
        .split(/[,\s+]+/)
        .map(part => part.trim().toUpperCase())
        .filter(Boolean);
}
function touchTn5250Session(session) {
    session.screen.updatedAt = new Date().toISOString();
    tn5250Sessions.set(session.connectionName, session);
}
function appendTn5250Message(session, message) {
    session.screen.textLines.unshift(message);
    if (session.screen.textLines.length > TN5250_MAX_LINES) {
        session.screen.textLines = session.screen.textLines.slice(0, TN5250_MAX_LINES);
    }
    touchTn5250Session(session);
}
function resetTn5250Screen(session, message) {
    const commandField = findTn5250Field(session, "command");
    if (commandField)
        commandField.value = "";
    session.screen.textLines = [message, `Connected to ${session.connectionName}.`];
    session.screen.cursorFieldId = "command";
    session.screen.lastKeys = [];
    touchTn5250Session(session);
}
function rotateTn5250Cursor(session) {
    const fields = session.screen.fields;
    if (fields.length === 0)
        return;
    const idx = fields.findIndex(field => field.id === session.screen.cursorFieldId);
    const next = idx >= 0 ? (idx + 1) % fields.length : 0;
    session.screen.cursorFieldId = fields[next].id;
    touchTn5250Session(session);
}
async function waitForTn5250Text(session, text, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const needle = String(text).toLowerCase();
    while (Date.now() <= deadline) {
        const haystack = renderTn5250Screen(session.screen).toLowerCase();
        if (haystack.includes(needle))
            return true;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return false;
}
function renderTn5250Screen(screen) {
    const lines = [];
    lines.push(`${screen.title} (${screen.status})`);
    lines.push(...screen.textLines);
    for (const field of screen.fields) {
        lines.push(`${field.label}[${field.id}]=${field.value}`);
    }
    return lines.join("\n");
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
function requireJobName(value) {
    const jobName = String(value || "").trim().toUpperCase();
    if (!jobName)
        throw new Error("jobName is required");
    if (!/^[A-Z0-9#@$*._-]+\/[A-Z0-9#@$*._-]+\/[A-Z0-9#@$*._-]+$/.test(jobName)) {
        throw new Error(`Invalid jobName: ${value}`);
    }
    return jobName;
}
function requireQualifiedObject(value, label) {
    const raw = String(value || "").trim().toUpperCase();
    if (!raw)
        throw new Error(`${label} is required`);
    const parts = raw.split("/");
    if (parts.length !== 2) {
        throw new Error(`Invalid ${label}: expected LIB/OBJECT format`);
    }
    return {
        library: requireIbmObjectName(parts[0], `${label} library`),
        object: requireIbmObjectName(parts[1], `${label} object`)
    };
}
function requireMessageKey(value) {
    const raw = String(value || "").trim();
    if (!raw)
        throw new Error("messageKey is required");
    const directHex = raw.toUpperCase();
    if (/^[0-9A-F]{4,64}$/.test(directHex)) {
        return `X'${directHex}'`;
    }
    const prefixed = raw.toUpperCase();
    const match = prefixed.match(/^X'([0-9A-F]{4,64})'$/);
    if (match) {
        return `X'${match[1]}'`;
    }
    throw new Error(`Invalid messageKey: ${value}`);
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
        jobName: toNullableString(pickFirst(row, ["JOB_NAME", "JOB"])) || "",
        spooledFileName: toNullableString(pickFirst(row, ["SPOOLED_FILE_NAME", "SPOOLED_FILE", "SPLF_NAME"])) || "",
        spooledFileNumber: toNullableNumber(pickFirst(row, ["SPOOLED_FILE_NUMBER", "SPLF_NUMBER", "FILE_NUMBER"])),
        outputQueue: toNullableString(pickFirst(row, ["OUTPUT_QUEUE_NAME", "OUTQ_NAME", "OUTPUT_QUEUE"])) || "",
        totalPages: toNullableNumber(pickFirst(row, ["TOTAL_PAGES", "PAGES"])),
        status: toNullableString(pickFirst(row, ["FILE_STATUS", "STATUS"])) || ""
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
function isMissingColumnError(err, column) {
    const message = String(err?.message || err || "").toUpperCase();
    return message.includes("42703") && message.includes(column.toUpperCase());
}
function requireIfsPath(value, label) {
    const pathValue = String(value || "").trim();
    if (!pathValue.startsWith("/")) {
        throw new Error(`Invalid ${label}: must be an absolute IFS path`);
    }
    if (pathValue.includes("\n") || pathValue.includes("\r")) {
        throw new Error(`Invalid ${label}: multiline path is not allowed`);
    }
    return pathValue;
}
function requireIfsJournalObjectType(value) {
    const objectType = String(value || "*STMF").trim().toUpperCase();
    if (objectType !== "*STMF" && objectType !== "*DIR") {
        throw new Error("objectType must be *STMF or *DIR");
    }
    return objectType;
}
function quoteClString(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}
function requireIbmObjectName(value, label) {
    const name = String(value || "").trim().toUpperCase();
    if (!/^[A-Z#@$][A-Z0-9#@$]{0,9}$/.test(name)) {
        throw new Error(`Invalid ${label}: ${value}`);
    }
    return name;
}
function requireJournalCode(value) {
    const code = String(value || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{1,4}$/.test(code)) {
        throw new Error(`Invalid journalCode: ${value}`);
    }
    return code;
}
function requireJournalEntryType(value) {
    const entryType = String(value || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{1,10}$/.test(entryType)) {
        throw new Error(`Invalid entryType: ${value}`);
    }
    return entryType;
}
async function planJournalReceiverRetention(conn, options) {
    const rows = await queryJournalReceiverInfo(conn, options.journalLibrary, options.journal);
    const cutoff = Date.now() - options.retentionDays * 24 * 60 * 60 * 1000;
    const candidates = rows
        .filter((row) => {
        if (!row.receiverLibrary || !row.receiver)
            return false;
        if (!row.detachTimestamp)
            return false;
        const detachMs = Date.parse(row.detachTimestamp);
        return Number.isFinite(detachMs) && detachMs <= cutoff;
    })
        .map((row) => ({
        receiverLibrary: row.receiverLibrary,
        receiver: row.receiver,
        attachTimestamp: row.attachTimestamp,
        detachTimestamp: row.detachTimestamp
    }));
    return {
        journalLibrary: options.journalLibrary,
        journal: options.journal,
        retentionDays: options.retentionDays,
        cutoffTimestamp: new Date(cutoff).toISOString(),
        scanned: rows.length,
        candidates
    };
}
async function queryJournalReceiverInfo(conn, journalLibrary, journal) {
    try {
        const rows = await conn.runSQL(`select * from table(qsys2.journal_receiver_info(journal_name => ${Tools.sqlString(journal)}, journal_library => ${Tools.sqlString(journalLibrary)}))`);
        return rows.map(normalizeJournalReceiverInfoRow);
    }
    catch {
        const rows = await conn.runSQL(`select * from qsys2.journal_receiver_info where upper(journal_name)=${Tools.sqlString(journal)} and upper(journal_library)=${Tools.sqlString(journalLibrary)}`);
        return rows.map(normalizeJournalReceiverInfoRow);
    }
}
function normalizeJournalReceiverInfoRow(row) {
    return {
        receiverLibrary: toNullableString(pickFirst(row, ["JOURNAL_RECEIVER_LIBRARY", "RECEIVER_LIBRARY", "JRNRCV_LIBRARY"])),
        receiver: toNullableString(pickFirst(row, ["JOURNAL_RECEIVER", "JOURNAL_RECEIVER_NAME", "RECEIVER_NAME", "JRNRCV_NAME"])),
        attachTimestamp: toNullableString(pickFirst(row, ["ATTACH_TIMESTAMP", "ATTACHED_TIMESTAMP"])),
        detachTimestamp: toNullableString(pickFirst(row, ["DETACH_TIMESTAMP", "DETACHED_TIMESTAMP"]))
    };
}
async function buildComplianceReport(conn, options) {
    const preset = normalizeCompliancePreset(options.preset);
    const sinceTimestamp = options.sinceTimestamp || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const audit = await listAuditRecords({
        since: sinceTimestamp,
        limit: options.auditLimit
    });
    const auditVerify = await verifyAuditChain();
    const qaudRows = await queryJournalEntries(conn, {
        journalLibrary: "QSYS",
        journal: "QAUDJRN",
        limit: options.qaudLimit,
        sinceTimestamp
    });
    const report = {
        source: "compliance",
        preset,
        generatedAt: new Date().toISOString(),
        sinceTimestamp,
        audit: {
            verify: auditVerify,
            total: audit.total,
            returned: audit.records.length,
            byStatus: summarizeByKey(audit.records, "status"),
            byTool: summarizeByKey(audit.records, "tool")
        },
        qaudjrn: {
            returned: qaudRows.length,
            byCode: summarizeByKey(qaudRows, "journalCode"),
            byEntryType: summarizeByKey(qaudRows, "entryType"),
            byUser: summarizeByKey(qaudRows, "userName")
        }
    };
    if (options.includeRaw) {
        report["raw"] = {
            auditRecords: audit.records,
            qaudjrnEvents: qaudRows
        };
    }
    return report;
}
function normalizeCompliancePreset(value) {
    const preset = String(value || "phase6_baseline").trim().toLowerCase();
    if (preset === "phase6_baseline" || preset === "qaudjrn_daily" || preset === "journal_retention") {
        return preset;
    }
    throw new Error(`Unsupported compliance preset: ${value}`);
}
function summarizeByKey(rows, key) {
    const summary = {};
    for (const row of rows) {
        const value = String(row?.[key] || "UNKNOWN").trim() || "UNKNOWN";
        summary[value] = (summary[value] || 0) + 1;
    }
    return summary;
}
function summarizeQaudjrnEvents(events) {
    return {
        total: events.length,
        byCode: summarizeByKey(events, "journalCode"),
        byEntryType: summarizeByKey(events, "entryType"),
        byUser: summarizeByKey(events, "userName")
    };
}
function signEvidencePayload(payload, signingKey) {
    return crypto.createHmac("sha256", signingKey).update(payload).digest("hex");
}
function sha256Hex(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
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
    "ibmi.libl.set",
    "ibmi.libl.add",
    "ibmi.libl.remove",
    "ibmi.libl.setCurrent",
    "ibmi.journal.receiver.create",
    "ibmi.journal.create",
    "ibmi.journal.receiver.change",
    "ibmi.journal.startPf",
    "ibmi.journal.endPf",
    "ibmi.journal.startIfs",
    "ibmi.journal.endIfs",
    "ibmi.journal.receivers.retention",
    "ibmi.audit.purge",
    "ibmi.ifs.write",
    "ibmi.ifs.mkdir",
    "ibmi.ifs.delete",
    "ibmi.ifs.upload",
    "ibmi.actions.run",
    "ibmi.profiles.activate",
    "ibmi.spool.hold",
    "ibmi.spool.release",
    "ibmi.spool.delete",
    "ibmi.spool.move",
    "ibmi.jobs.hold",
    "ibmi.jobs.release",
    "ibmi.jobs.end",
    "ibmi.subsystems.start",
    "ibmi.subsystems.end",
    "ibmi.msgq.send",
    "ibmi.msgq.reply",
    "ibmi.dataqueue.send",
    "ibmi.dataarea.write",
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
