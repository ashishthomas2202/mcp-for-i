import { McpContext } from "./context.js";
import { findToolModule, toolModules } from "./modules/index.js";
import { runActionTool } from "./modules/compile.js";
import { parseEvfevent } from "../ibmi/evfevent.js";
import { LocalLanguageActions } from "../ibmi/LocalLanguageActions.js";
import { CompileTools } from "../ibmi/CompileTools.js";
import { Search } from "../ibmi/Search.js";
import { ibmDocs } from "../ibmi/IbmDocs.js";
import { MemberSnapshot } from "../ibmi/IBMiContent.js";
import { Action } from "../ibmi/types.js";
import { Tools } from "../ibmi/Tools.js";
import { checkReadOnlySql, getSqlStatementType as parseSqlStatementType } from "../ibmi/sqlParse.js";
import { ConnectionPolicy } from "../config/store.js";
import { ConnectionService } from "../controlplane/connectionService.js";
import { log } from "./logger.js";
import { assertSafeIfsDeletePath, checkClCommand, checkClCommands, checkResourcePolicy, checkShellCommand, checkSqlEmbeddedCl } from "./policy.js";
import { configuredLocalRoots, LocalPathMode, resolveAllowedLocalPath } from "../security/localPaths.js";
import { exportAuditRecords, listAuditRecords, purgeAuditRecords, verifyAuditChain } from "./audit.js";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  additionalProperties?: boolean;
  description?: string;
  default?: unknown;
};

const CUSTOM_VARIABLE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    value: { type: "string" }
  },
  required: ["name", "value"]
};

const OBJECT_FILTER_SCHEMA: JsonSchema = {
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

const SETTINGS_SCHEMA: JsonSchema = {
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

const POLICY_SCHEMA: JsonSchema = {
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

const ACTION_SCHEMA: JsonSchema = {
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

const PROFILE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    currentLibrary: { type: "string" },
    libraryList: { type: "array", items: { type: "string" } },
    customVariables: { type: "array", items: CUSTOM_VARIABLE_SCHEMA }
  },
  required: ["name"]
};

const LINE_RANGE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    start: { type: "number" },
    end: { type: "number" }
  },
  required: ["start", "end"]
};

const SOURCE_INSPECTION_OPERATION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    operation: { type: "string", enum: ["metadata", "outline", "search", "read_ranges", "dependencies"] },
    query: { type: "string" },
    terms: { type: "array", items: { type: "string" } },
    ranges: { type: "array", items: LINE_RANGE_SCHEMA },
    before: { type: "number" },
    after: { type: "number" },
    maxMatches: { type: "number" }
  },
  required: ["operation"]
};

type Tn5250Field = {
  id: string;
  label: string;
  value: string;
  row: number;
  col: number;
  length: number;
  protected?: boolean;
};

type Tn5250HistoryEntry = {
  at: string;
  command: string;
  ok: boolean;
  code: number;
  stderr?: string;
  messages: string[];
};

type Tn5250Screen = {
  sessionId: string;
  connectionName: string;
  title: string;
  status: "ready" | "busy";
  textLines: string[];
  fields: Tn5250Field[];
  cursorFieldId: string;
  lastKeys: string[];
  commandHistory: Tn5250HistoryEntry[];
  updatedAt: string;
};

type Tn5250Session = {
  connectionName: string;
  createdAt: number;
  screen: Tn5250Screen;
};

const tn5250Sessions = new Map<string, Tn5250Session>();
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
      name: "ibmi.session.bootstrap",
      description: "Return connection, IBM i release, library-list, policy, and transport capabilities in one call.",
      inputSchema: {
        type: "object",
        properties: { connectionName: { type: "string" } },
        required: ["connectionName"]
      }
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
        properties: {
          connectionName: { type: "string" },
          library: { type: "string" },
          sourceFile: { type: "string" },
          member: { type: "string" },
          memberPrefix: { type: "string" },
          memberContains: { type: "string" },
          sourceTypes: { type: "array", items: { type: "string" } },
          changedSince: { type: "string" },
          limit: { type: "number" },
          cursor: { type: "string" },
          responseFormat: { type: "string", enum: ["legacy-array", "page"] }
        },
        required: ["library", "sourceFile"]
      }
    },
    {
      name: "ibmi.qsys.members.read",
      description: "Read a member.",
      inputSchema: {
        type: "object",
        properties: {
          connectionName: { type: "string" },
          library: { type: "string" },
          sourceFile: { type: "string" },
          member: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
          ranges: { type: "array", items: LINE_RANGE_SCHEMA },
          before: { type: "number" },
          after: { type: "number" },
          metadataOnly: { type: "boolean" },
          expectedVersion: { type: "string" },
          expectedSha256: { type: "string" },
          forceFresh: { type: "boolean" },
          responseFormat: { type: "string", enum: ["text", "structured"] }
        },
        required: ["library", "sourceFile", "member"]
      }
    },
    {
      name: "ibmi.qsys.members.write",
      description: "Write a member.",
      inputSchema: {
        type: "object",
        properties: {
          connectionName: { type: "string" }, library: { type: "string" }, sourceFile: { type: "string" }, member: { type: "string" }, content: { type: "string" },
          expectedVersion: { type: "string" }, expectedSha256: { type: "string" }
        },
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
      description: "Read an IFS file. Text is returned as-is; files that are not valid UTF-8 text are returned base64-encoded. Files larger than maxBytes are refused (use ibmi.ifs.download).",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          maxBytes: { type: "number", description: "Maximum file size to read (default 1048576, max 16777216)." },
          encoding: { type: "string", enum: ["auto", "utf8", "base64"], default: "auto" }
        },
        required: ["path"]
      }
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
          connectionName: { type: "string" },
          library: { type: "string" },
          sourceFile: { type: "string" },
          term: { type: "string" },
          terms: { type: "array", items: { type: "string" } },
          members: { type: ["string", "array"], items: { type: "string" } },
          caseSensitive: { type: "boolean" },
          before: { type: "number" },
          after: { type: "number" },
          maxMatches: { type: "number" }
        },
        required: ["library", "sourceFile"]
      }
    },
    {
      name: "ibmi.source.resolve",
      description: "Resolve an exact source member across candidate source files without listing every member.",
      inputSchema: {
        type: "object",
        properties: {
          connectionName: { type: "string" },
          library: { type: "string" },
          member: { type: "string" },
          candidateSourceFiles: { type: "array", items: { type: "string" } },
          sourceTypes: { type: "array", items: { type: "string" } },
          limit: { type: "number" }
        },
        required: ["connectionName", "library", "member"]
      }
    },
    {
      name: "ibmi.source.inspect",
      description: "Resolve and inspect one source member with batched metadata, outline, search, ranges, and dependency operations.",
      inputSchema: {
        type: "object",
        properties: {
          connectionName: { type: "string" },
          library: { type: "string" },
          sourceFile: { type: "string" },
          member: { type: "string" },
          candidateSourceFiles: { type: "array", items: { type: "string" } },
          sourceTypes: { type: "array", items: { type: "string" } },
          operations: { type: "array", items: SOURCE_INSPECTION_OPERATION_SCHEMA },
          expectedVersion: { type: "string" },
          expectedSha256: { type: "string" },
          forceFresh: { type: "boolean" }
        },
        required: ["connectionName", "library", "member", "operations"]
      }
    },
    {
      name: "ibmi.docs.search",
      description: "Search the release-aware catalog and cache of official IBM i documentation.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          connectionName: { type: "string" },
          releases: { type: "array", items: { type: "string" } },
          categories: { type: "array", items: { type: "string" } },
          limit: { type: "number" },
          cursor: { type: "string" },
          freshness: { type: "string", enum: ["indexed", "prefer-live"] }
        },
        required: ["query"]
      }
    },
    {
      name: "ibmi.docs.open",
      description: "Open and cache an allowlisted official IBM i documentation page.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string" },
          url: { type: "string" },
          expectedVersion: { type: "string" },
          requireLive: { type: "boolean" },
          freshness: { type: "string", enum: ["allow-cached", "require-live"] },
          section: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
          maxCharacters: { type: "number" }
        }
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
      description:
        "Run an action (for example a compile) against a source member or an IFS streamfile. " +
        "Member targets set &OPENLIB/&OPENSPF/&OPENMBR/&EXT/&NAME; streamfile targets set &FULLPATH/&RELATIVEPATH/&NAME/&EXT. " +
        "When the command uses OPTION(*EVENTF) the EVFEVENT file is read and errors are returned grouped by file with line, column, severity and message id. " +
        "Honours the action's deployFirst (with localWorkspace + remoteWorkspace), postDownload (to downloadTo or localWorkspace) and outputToFile. " +
        "Set includeListing to also return the compile listing spooled file.",
      inputSchema: {
        type: "object",
        properties: {
          actionName: { type: "string" },
          action: ACTION_SCHEMA,
          targetType: { type: "string", enum: ["member", "streamfile", "file"] },
          targetPath: { type: "string", description: "Streamfile: absolute IFS path. Member: LIB/FILE/MEMBER[.TYPE] (or use library/sourceFile/member)." },
          library: { type: "string" },
          sourceFile: { type: "string" },
          member: { type: "string" },
          extension: { type: "string", description: "Member type (looked up when omitted) or streamfile extension." },
          cwd: { type: "string", description: "Remote working directory for streamfile actions (default remoteWorkspace, then the home directory)." },
          localWorkspace: { type: "string", description: "Local project folder, used by deployFirst, postDownload and relative outputToFile paths." },
          remoteWorkspace: { type: "string", description: "IFS folder the local workspace deploys to." },
          downloadTo: { type: "string", description: "Local folder for postDownload outputs (default localWorkspace)." },
          evfeventLibrary: { type: "string", description: "Override the EVFEVENT library (default: the compiled object's library)." },
          evfeventMember: { type: "string", description: "Override the EVFEVENT member (default: the compiled object's name)." },
          includeListing: { type: "boolean", description: "Also return the compile listing spooled file." },
          listingMaxLines: { type: "number" }
        },
        required: ["targetType"]
      }
    }
    ,
    {
      name: "ibmi.actions.save",
      description: "Create or update a custom action.",
      inputSchema: { type: "object", properties: { action: ACTION_SCHEMA }, required: ["action"] }
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
      description: "Parse EVFEVENT (compiler events file) records into errors grouped by source file, with line, column, severity and message id. Errors in SQL precompiler temp files are mapped back to the original source.",
      inputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }
    },
    {
      name: "ibmi.joblog.get",
      description: "Read recent job log messages for the current job.",
      inputSchema: { type: "object", properties: { connectionName: { type: "string" }, limit: { type: "number" } } }
    },
    {
      name: "ibmi.spool.list",
      description: "List spool file entries, newest first, optionally filtered by user, output queue or job.",
      inputSchema: {
        type: "object",
        properties: {
          connectionName: { type: "string" },
          limit: { type: "number" },
          userName: { type: "string", description: "User profile that owns the spooled files." },
          outputQueue: { type: "string", description: "Output queue name." },
          outputQueueLibrary: { type: "string", description: "Output queue library." },
          jobName: { type: "string", description: "Qualified job name (number/user/name) or a simple job name." }
        }
      }
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
      description: "Peek at (default) or receive an entry from a data queue. remove=true takes the entry off the queue and needs a writable connection.",
      inputSchema: {
        type: "object",
        properties: {
          library: { type: "string" },
          queue: { type: "string" },
          waitSeconds: { type: "number", default: 0, description: "Seconds to wait for an entry (0 to 60)." },
          remove: { type: "boolean", default: false },
          approve: { type: "boolean", description: "Set true to approve guarded-policy operations (remove=true)." },
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
      description: "Read normalized journal entries, newest first. Filters are applied on the IBM i before the row limit.",
      inputSchema: {
        type: "object",
        properties: {
          journalLibrary: { type: "string" },
          journal: { type: "string" },
          objectLibrary: { type: "string" },
          objectName: { type: "string" },
          objectType: { type: "string", description: "Object type for the object filter (default *FILE)." },
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
      description: "Open the CL command console for a connection. This is a simulated CL command console (commands run through QCMDEXC), not real 5250 emulation: it cannot display or drive green-screen programs.",
      inputSchema: { type: "object", properties: { connectionName: { type: "string" } } }
    },
    {
      name: "ibmi.tn5250.readScreen",
      description: "Read the CL command console's simulated screen (command field, messages and history). Not a real 5250 screen.",
      inputSchema: { type: "object", properties: { connectionName: { type: "string" } } }
    },
    {
      name: "ibmi.tn5250.setField",
      description: "Set a field on the CL command console, normally the 'command' field. Not a real 5250 field.",
      inputSchema: {
        type: "object",
        properties: { fieldId: { type: "string" }, value: { type: "string" }, connectionName: { type: "string" } },
        required: ["fieldId", "value"]
      }
    },
    {
      name: "ibmi.tn5250.sendKeys",
      description: "Send keys to the CL command console. ENTER runs the command field as a CL command through QCMDEXC (subject to read-only mode and command policy); CLEAR, F3 and F12 clear it. This is a simulated CL command console (commands run through QCMDEXC), not real 5250 emulation: it cannot display or drive green-screen programs.",
      inputSchema: {
        type: "object",
        properties: { keys: { type: "string" }, timeoutMs: { type: "number" }, connectionName: { type: "string" }, approve: { type: "boolean" } },
        required: ["keys"]
      }
    },
    {
      name: "ibmi.tn5250.waitFor",
      description: "Wait until text appears in the CL command console's message area. Not a real 5250 screen.",
      inputSchema: { type: "object", properties: { text: { type: "string" }, timeoutMs: { type: "number" }, connectionName: { type: "string" } } }
    },
    {
      name: "ibmi.tn5250.snapshot",
      description: "Capture the CL command console state as text. Not a real 5250 screen.",
      inputSchema: { type: "object", properties: { connectionName: { type: "string" } } }
    },
    {
      name: "ibmi.tn5250.disconnect",
      description: "Close the CL command console for a connection.",
      inputSchema: { type: "object", properties: { connectionName: { type: "string" } } }
    }
  ];
  return [...tools, ...toolModules.flatMap(module => module.tools)]
    .map(withGuardedApprovalHint)
    .map(withSourceConnectionName)
    .map(withStrictInputSchema);
}

export async function handleTool(ctx: McpContext, name: string, args: any) {
  const connections = new ConnectionService(ctx.store);
  await enforceResourcePolicy(ctx, name, args);
  const toolModule = findToolModule(name);
  if (toolModule) return toolModule.handle(ctx, name, args);
  switch (name) {
    case "ibmi.connect": {
      if (!args?.name) throw new Error("name is required");
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
      } else {
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
      if (name) tn5250Sessions.delete(name);
      return result("Terminated");
    }
    case "ibmi.session.bootstrap": {
      const conn = await ctx.ensureActive(args.connectionName);
      const system = await readSystemFacts(conn);
      const config = conn.getConfig();
      return json({
        connectionName: conn.currentConnectionName,
        host: conn.currentHost,
        systemName: system.systemName,
        effectiveUser: system.effectiveUser || conn.currentUser,
        release: system.release,
        currentLibrary: config.currentLibrary || "QGPL",
        libraryList: config.libraryList || [],
        defaultUserLibraries: conn.defaultUserLibraries,
        ccsid: config.sqlJobCcsid ?? 1208,
        sourceFileCcsid: config.sourceFileCCSID || "*FILE",
        policy: ctx.getPolicy(args.connectionName),
        transports: { sql: "QZDFMDB2", sourceRead: ["sql-member", "cpytostmf"] },
        remoteFeatures: conn.remoteFeatures,
        capabilities: {
          version: "1",
          memberPaging: true,
          rangedMemberRead: true,
          multiTermSearch: true,
          sourceResolve: true,
          sourceInspect: true,
          optimisticConcurrency: true,
          ibmDocs: true
        },
        validatedAt: new Date().toISOString()
      });
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
      let files: any[];
      try {
        files = await conn.content.getObjectList(args.library, ["*FILE"]);
      } catch {
        try {
          const allObjects = await conn.content.getObjectList(args.library, ["*ALL"]);
          files = allObjects.filter((obj: any) => String(obj?.type || "").toUpperCase() === "*FILE");
        } catch {
          const rows = await conn.runSQL(
            `select system_table_name as name, coalesce(table_text, '') as text from qsys2.systables where upper(system_table_schema)=${Tools.sqlString(String(args.library || "").toUpperCase())} fetch first 5000 rows only`
          );
          files = rows.map((row: any) => ({
            library: String(args.library || "").toUpperCase(),
            name: String(row?.NAME || row?.SYSTEM_TABLE_NAME || ""),
            type: "*FILE",
            text: String(row?.TEXT || row?.TABLE_TEXT || ""),
            attribute: ""
          }));
        }
      }
      const sourceByAttr = files.filter((obj: any) => {
        const attr = String(obj?.attribute || "").toUpperCase();
        return attr === "PF-SRC" || attr === "SOURCE";
      });
      if (sourceByAttr.length > 0) return json(sourceByAttr);

      const sourceByName = files.filter((obj: any) => String(obj?.name || "").toUpperCase().endsWith("SRC"));
      return json(sourceByName.length > 0 ? sourceByName : files);
    }
    case "ibmi.qsys.members.list": {
      const conn = await ctx.ensureActive(args?.connectionName);
      const data = hasMemberListExtensions(args)
        ? await conn.content.getMemberListPage({
          library: args.library,
          sourceFile: args.sourceFile,
          member: args.member,
          memberPrefix: args.memberPrefix,
          memberContains: args.memberContains,
          sourceTypes: args.sourceTypes,
          changedSince: args.changedSince,
          limit: args.limit,
          cursor: args.cursor
        })
        : await conn.content.getMemberList({ library: args.library, sourceFile: args.sourceFile });
      return json(data);
    }
    case "ibmi.qsys.members.read": {
      const conn = await ctx.ensureActive(args?.connectionName);
      if (!hasStructuredMemberReadOptions(args)) {
        const content = await conn.content.downloadMemberContent(args.library, args.sourceFile, args.member);
        return result(content);
      }
      const snapshot = await conn.content.getMemberSnapshot(args.library, args.sourceFile, args.member, Boolean(args.forceFresh));
      const conflict = memberVersionConflict(snapshot, args);
      if (conflict) return json(conflict);
      return json(formatMemberRead(snapshot, args));
    }
    case "ibmi.qsys.members.write": {
      const conn = await ctx.ensureActive(args?.connectionName);
      enforceWritable(ctx, conn, "qsys.write", args);
      if (args.expectedVersion || args.expectedSha256) {
        const snapshot = await conn.content.getMemberSnapshot(args.library, args.sourceFile, args.member, true);
        const conflict = memberVersionConflict(snapshot, args);
        if (conflict) return json(conflict);
      }
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
      const maxBytes = clampNumber(args?.maxBytes, IFS_READ_DEFAULT_MAX_BYTES, 1, IFS_READ_HARD_MAX_BYTES);
      const encoding = String(args?.encoding || "auto").toLowerCase();
      if (!["auto", "utf8", "base64"].includes(encoding)) throw new Error("encoding must be auto, utf8 or base64");
      const knownSize = await statIfsFileSize(conn, String(args.path));
      if (knownSize !== undefined && knownSize > maxBytes) {
        return toolError(
          `File is ${knownSize} bytes, which is more than maxBytes (${maxBytes}). Raise maxBytes or use ibmi.ifs.download.`,
          { path: args.path, size: knownSize, maxBytes }
        );
      }
      const data = Buffer.from(await conn.content.downloadStreamfileRaw(args.path));
      if (data.length > maxBytes) {
        return toolError(
          `File is ${data.length} bytes, which is more than maxBytes (${maxBytes}). Raise maxBytes or use ibmi.ifs.download.`,
          { path: args.path, size: data.length, maxBytes }
        );
      }
      const text = encoding === "base64" ? undefined : decodeUtf8Text(data);
      if (text !== undefined) return result(text);
      if (encoding === "utf8") {
        return toolError("File is not valid UTF-8 text; read it with encoding=base64.", { path: args.path, size: data.length });
      }
      return json({ path: args.path, size: data.length, encoding: "base64", content: data.toString("base64") });
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
      requireCommandSuccess(await conn.sendCommand({ command: `mkdir -p ${Tools.escapePath(args.path)}` }), "mkdir");
      return result("OK");
    }
    case "ibmi.ifs.delete": {
      const conn = await ctx.ensureActive(args?.connectionName);
      enforceWritable(ctx, conn, "ifs.delete", args);
      const deletePath = assertSafeIfsDeletePath(args.path);
      const flag = args.recursive ? "-rf" : "-f";
      requireCommandSuccess(await conn.sendCommand({ command: `rm ${flag} ${Tools.escapePath(deletePath)}` }), "rm");
      return result("OK");
    }
    case "ibmi.ifs.upload": {
      const conn = await ctx.ensureActive(args?.connectionName);
      const op = resolveIfsWriteOperation(args.remotePath);
      enforceWritable(ctx, conn, op, args);
      const localPath = await guardLocalPath(ctx, args.localPath, "read");
      await conn.client!.putFile(localPath, args.remotePath);
      return result("OK");
    }
    case "ibmi.ifs.download": {
      const conn = await ctx.ensureActive(args?.connectionName);
      const localPath = await guardLocalPath(ctx, args.localPath, "write");
      await conn.client!.getFile(localPath, args.remotePath);
      return result("OK");
    }
    case "ibmi.search.members": {
      const conn = await ctx.ensureActive(args?.connectionName);
      const members = args.members || "*";
      const terms = normalizeSearchTerms(args);
      const data = await Search.searchMembersTerms(conn, args.library, args.sourceFile, terms, members, false, {
        caseSensitive: Boolean(args.caseSensitive),
        before: args.before,
        after: args.after
      });
      const maximum = Math.max(1, Math.min(5_000, Math.floor(args.maxMatches || 500)));
      let seen = 0;
      data.hits = data.hits.map(hit => ({
        ...hit,
        lines: hit.lines.filter(() => seen++ < maximum)
      })).filter(hit => hit.lines.length > 0);
      return json(data);
    }
    case "ibmi.source.resolve": {
      const conn = await ctx.ensureActive(args.connectionName);
      const candidates = await conn.content.resolveMembers({
        library: args.library,
        member: args.member,
        candidateSourceFiles: args.candidateSourceFiles,
        sourceTypes: args.sourceTypes,
        limit: args.limit
      });
      rankMemberCandidates(candidates, args.candidateSourceFiles);
      return json({
        status: candidates.length === 0 ? "not-found" : candidates.length === 1 ? "found" : "ambiguous",
        library: String(args.library).toUpperCase(),
        member: String(args.member).toUpperCase(),
        candidates,
        returned: candidates.length,
        observedAt: new Date().toISOString()
      });
    }
    case "ibmi.source.inspect": {
      const conn = await ctx.ensureActive(args.connectionName);
      const operations = Array.isArray(args.operations) ? args.operations : [];
      if (operations.length < 1 || operations.length > 8) throw new Error("Provide between 1 and 8 inspection operations");
      let sourceFile = args.sourceFile ? String(args.sourceFile).toUpperCase() : "";
      let resolution: any;
      if (!sourceFile) {
        const candidates = await conn.content.resolveMembers({
          library: args.library,
          member: args.member,
          candidateSourceFiles: args.candidateSourceFiles,
          sourceTypes: args.sourceTypes,
          limit: 20
        });
        rankMemberCandidates(candidates, args.candidateSourceFiles);
        resolution = {
          status: candidates.length === 0 ? "not-found" : candidates.length === 1 ? "found" : "ambiguous",
          candidates
        };
        if (candidates.length !== 1) return json(resolution);
        sourceFile = candidates[0].file;
      }
      const snapshot = await conn.content.getMemberSnapshot(args.library, sourceFile, args.member, Boolean(args.forceFresh));
      const conflict = memberVersionConflict(snapshot, args);
      if (conflict) return json(conflict);
      return json({
        status: "found",
        identity: snapshot.identity,
        version: snapshot.version,
        sha256: snapshot.sha256,
        observedAt: snapshot.observedAt,
        complete: snapshot.complete,
        transport: snapshot.transport,
        cacheStatus: snapshot.cacheStatus,
        warnings: snapshot.warnings,
        ...(resolution ? { resolution } : {}),
        results: operations.map((operation: any) => inspectMemberOperation(snapshot, operation))
      });
    }
    case "ibmi.docs.search": {
      let releases = args.releases;
      if ((!releases || releases.length === 0) && args.connectionName) {
        const conn = await ctx.ensureActive(args.connectionName);
        const detected = await readSystemFacts(conn);
        if (detected.release) releases = [detected.release];
      }
      return json(await ibmDocs.search({ ...args, releases }));
    }
    case "ibmi.docs.open": {
      if (!args.ref && !args.url) throw new Error("ref or url is required");
      return json(await ibmDocs.open(args));
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
      return runActionTool(ctx, args);
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
      let activeConfig: any = {};
      try {
        activeConfig = (await ctx.ensureActive(name)).getConfig();
      } catch {
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
      if (!conn) throw new Error(`Connection ${name} not found`);
      const list = conn.settings?.libraryList || [];
      const lib = String(args.library).toUpperCase();
      if (!list.includes(lib)) list.push(lib);
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
      if (!conn) throw new Error(`Connection ${name} not found`);
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
      if (parts.length < 3) throw new Error("Member path should be LIB/FILE/MEMBER(.ext)");
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
      const localPath = await guardLocalPath(ctx, args.localPath, "read");
      await conn.client!.putDirectory(localPath, args.remotePath, { recursive: true, concurrency: 5 });
      return result("OK");
    }
    case "ibmi.deploy.uploadFiles": {
      const conn = await ctx.ensureActive(args?.connectionName);
      enforceWritable(ctx, conn, "deploy.sync", args);
      const remoteDir = String(args.remoteDirectory);
      const localFiles: string[] = [];
      for (const file of args.localFiles || []) {
        localFiles.push(await guardLocalPath(ctx, file, "read"));
      }
      for (const file of localFiles) {
        const base = String(file).split(/[\\/]/).pop();
        const remotePath = `${remoteDir}/${base}`;
        await conn.client!.putFile(String(file), remotePath);
      }
      return result("OK");
    }
    case "ibmi.deploy.setCcsid": {
      const conn = await ctx.ensureActive(args?.connectionName);
      enforceWritable(ctx, conn, "deploy.sync", args);
      const setccsid = conn.remoteFeatures.setccsid;
      if (!setccsid) throw new Error("setccsid not available on remote system");
      const ccsid = args.ccsid || "1208";
      requireCommandSuccess(
        await conn.sendCommand({ command: `${setccsid} -R ${Tools.shellQuote(ccsid)} ${Tools.escapePath(args.remotePath)}` }),
        "setccsid"
      );
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
      const conn = await ctx.ensureActive(args?.connectionName);
      const port = clampNumber(conn.getConfig().debugPort, 8005, 1, 65535);
      const rows = await conn.runSQL(`select job_name, local_port from qsys2.netstat_job_info where local_port = ${port} and remote_address = '0.0.0.0' fetch first 1 row only`);
      if (rows.length === 0) return json({ running: false, port });
      return json({ running: true, port, job: rows[0].JOB_NAME });
    }
    case "ibmi.debug.startService": {
      const conn = await ctx.ensureActive(args?.connectionName);
      enforceWritable(ctx, conn, "qsys.write", args);
      const submitOptions = `JOBQ(QSYS/QUSRNOMAX) JOBD(QSYS/QSYSJOBD) OUTQ(QUSRSYS/QDBGSRV) USER(QDBGSRV)`;
      const cmd = `QSYS/SBMJOB JOB(QDBGSRV) SYSLIBL(*SYSVAL) CURLIB(*USRPRF) INLLIBL(*JOBD) ${submitOptions} CMD(QSH CMD('/QIBM/ProdData/IBMiDebugService/bin/startDebugService.sh'))`;
      const res = await conn.sendQsh({ command: `system \"${cmd}\"` });
      return commandOutcome({ ok: res.code === 0, ...res });
    }
    case "ibmi.debug.stopService": {
      const conn = await ctx.ensureActive(args?.connectionName);
      enforceWritable(ctx, conn, "qsys.write", args);
      const res = await conn.sendCommand({ command: `/QIBM/ProdData/IBMiDebugService/bin/stopDebugService.sh` });
      return commandOutcome({ ok: res.code === 0, ...res });
    }
    case "ibmi.deploy.compare": {
      const conn = await ctx.ensureActive(args?.connectionName);
      const localPath = await guardLocalPath(ctx, args.localPath, "read");
      const remotePath = String(args.remotePath);
      const comparison = await compareDeployTrees(conn, localPath, remotePath);
      return json(comparison);
    }
    case "ibmi.deploy.sync": {
      const conn = await ctx.ensureActive(args?.connectionName);
      enforceWritable(ctx, conn, "deploy.sync", args);
      const localPath = await guardLocalPath(ctx, args.localPath, "read");
      const remotePath = String(args.remotePath);
      const overwrite = Boolean(args.overwrite);
      const dryRun = Boolean(args.dryRun);
      const deleteExtraRemote = Boolean(args.deleteExtraRemote);
      const comparison = await compareDeployTrees(conn, localPath, remotePath);

      const uploadSet = new Set<string>(comparison.onlyLocal);
      if (overwrite) {
        comparison.changed.forEach(entry => uploadSet.add(entry.path));
        comparison.unresolved.forEach(entry => uploadSet.add(entry.path));
      }
      const uploadPlan = Array.from(uploadSet).sort((a, b) => a.localeCompare(b));
      const skipChanged = overwrite ? [] : comparison.changed.map(entry => entry.path).sort((a, b) => a.localeCompare(b));
      const unresolved = overwrite ? [] : comparison.unresolved.map(entry => entry.path).sort((a, b) => a.localeCompare(b));
      const deletePlan = deleteExtraRemote ? [...comparison.onlyRemote] : [];

      const uploaded: string[] = [];
      const deleted: string[] = [];
      const errors: Array<{ operation: "upload" | "delete"; path: string; message: string }> = [];

      if (!dryRun) {
        const createdDirs = new Set<string>();
        for (const rel of uploadPlan) {
          const localFile = path.join(localPath, rel);
          const remoteFile = joinRemotePath(remotePath, rel);
          const remoteDir = remoteFile.split("/").slice(0, -1).join("/");
          try {
            if (!createdDirs.has(remoteDir)) {
              requireCommandSuccess(await conn.sendCommand({ command: `mkdir -p ${Tools.escapePath(remoteDir)}` }), "mkdir");
              createdDirs.add(remoteDir);
            }
            await conn.client!.putFile(localFile, remoteFile);
            uploaded.push(rel);
          } catch (err: any) {
            errors.push({ operation: "upload", path: rel, message: err?.message || String(err) });
          }
        }

        for (const rel of deletePlan) {
          const remoteFile = joinRemotePath(remotePath, rel);
          try {
            requireCommandSuccess(await conn.sendCommand({ command: `rm -f ${Tools.escapePath(remoteFile)}` }), "rm");
            deleted.push(rel);
          } catch (err: any) {
            errors.push({ operation: "delete", path: rel, message: err?.message || String(err) });
          }
        }
      }

      const syncResult = {
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
      };
      if (errors.length > 0) {
        return jsonError(`deploy.sync finished with ${errors.length} failed operation(s)`, syncResult);
      }
      return json(syncResult);
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

      if (!args?.sql) throw new Error("sql is required when cursor is not provided");
      const sql = String(args.sql);
      const readOnlyCheck = checkReadOnlySql(sql);
      if (!readOnlyCheck.readOnly) throw new Error(`ibmi.sql.query only supports read-only SQL: ${readOnlyCheck.reason}`);
      const startedAt = Date.now();
      // Ask for one row more than maxRows so truncation can be reported without
      // pulling the whole result set over the wire.
      const capped = applySqlRowCap(sql, maxRows + 1);
      const rows = await withTimeout(
        conn.runSQL(capped.sql),
        timeoutMs,
        `SQL query timed out after ${timeoutMs}ms`
      );
      const limited = rows.slice(0, maxRows);
      const firstPage = limited.slice(0, pageSize);
      const cursorInfo = ctx.createSqlCursor(limited, pageSize);
      const executionMs = Date.now() - startedAt;

      return json({
        rows: firstPage,
        cursor: cursorInfo.cursor,
        totalRows: limited.length,
        truncated: rows.length > limited.length,
        ...(rows.length > limited.length
          ? { truncationNote: `Result has more than ${maxRows} rows; only the first ${maxRows} are returned. Raise maxRows (up to 20000) or narrow the query.` }
          : {}),
        ...(includeMetadata
          ? {
            metadata: {
              statementType: getSqlStatementType(sql),
              columns: getRowColumns(firstPage),
              pageSize,
              maxRows,
              rowCapAppliedInSql: capped.applied,
              timeoutMs,
              executionMs
            }
          }
          : {})
      });
    }
    case "ibmi.sql.execute": {
      const conn = await ctx.ensureActive(args?.connectionName);
      enforceWritable(ctx, conn, "sql.write", args);
      const sql = String(args.sql);
      const timeoutMs = clampNumber(args?.timeoutMs, 45000, 1000, 300000);
      const statementType = getSqlStatementType(sql);
      const startedAt = Date.now();
      try {
        const rows = await withTimeout(
          conn.runSQL(sql),
          timeoutMs,
          `SQL execute timed out after ${timeoutMs}ms`
        );
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
      } catch (err: any) {
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
      enforceWritable(ctx, conn, "cl.run", args);
      const command = String(args.command || "");
      if (!command.trim()) throw new Error("command is required");
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
      const rows = await querySpoolEntries(conn, {
        limit,
        userName: args?.userName ? requireIbmObjectName(args.userName, "userName") : undefined,
        outputQueue: args?.outputQueue ? requireIbmObjectName(args.outputQueue, "outputQueue") : undefined,
        outputQueueLibrary: args?.outputQueueLibrary ? requireIbmObjectName(args.outputQueueLibrary, "outputQueueLibrary") : undefined,
        jobName: args?.jobName ? requireSpoolJobFilter(args.jobName) : undefined
      });
      return json(rows.map(normalizeSpoolEntry));
    }
    case "ibmi.spool.read": {
      const conn = await ctx.ensureActive(args?.connectionName);
      const limit = clampNumber(args?.limit, 200, 1, 5000);
      const jobName = Tools.sqlString(String(args.jobName));
      const fileName = Tools.sqlString(String(args.spooledFileName));
      const fileNbr = clampNumber(args.spooledFileNumber, 1, 1, 999999999);
      // DISPLAY_SPOOLED_FILE_DATA returns ORDINAL_POSITION and SPOOLED_DATA.
      const rows = await conn.runSQL(
        `select ordinal_position, spooled_data from table(qsys2.display_spooled_file_data(${jobName}, ${fileName}, ${fileNbr})) ` +
        `order by ordinal_position fetch first ${limit} rows only`
      );
      return json(rows.map(normalizeSpoolLine));
    }
    case "ibmi.spool.hold": {
      const conn = await ctx.ensureActive(args?.connectionName);
      enforceWritable(ctx, conn, "qsys.write", args);
      const command = buildSpoolCommand("HLDSPLF", args);
      const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
      return commandOutcome({ ok: cmdResult.code === 0, command, ...cmdResult });
    }
    case "ibmi.spool.release": {
      const conn = await ctx.ensureActive(args?.connectionName);
      enforceWritable(ctx, conn, "qsys.write", args);
      const command = buildSpoolCommand("RLSSPLF", args);
      const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
      return commandOutcome({ ok: cmdResult.code === 0, command, ...cmdResult });
    }
    case "ibmi.spool.delete": {
      const conn = await ctx.ensureActive(args?.connectionName);
      enforceWritable(ctx, conn, "qsys.write", args);
      const command = buildSpoolCommand("DLTSPLF", args);
      const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
      return commandOutcome({ ok: cmdResult.code === 0, command, ...cmdResult });
    }
    case "ibmi.spool.move": {
      const conn = await ctx.ensureActive(args?.connectionName);
      enforceWritable(ctx, conn, "qsys.write", args);
      const baseCommand = buildSpoolCommand("CHGSPLFA", args);
      const outQueueLibrary = requireIbmObjectName(args.outQueueLibrary, "outQueueLibrary");
      const outQueue = requireIbmObjectName(args.outQueue, "outQueue");
      const command = `${baseCommand} OUTQ(${outQueueLibrary}/${outQueue})`;
      const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
      return commandOutcome({ ok: cmdResult.code === 0, command, ...cmdResult });
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
      return commandOutcome({ ok: cmdResult.code === 0, command, ...cmdResult });
    }
    case "ibmi.jobs.release": {
      const conn = await ctx.ensureActive(args?.connectionName);
      enforceWritable(ctx, conn, "qsys.write", args);
      const jobName = requireJobName(args.jobName);
      const command = `RLSJOB JOB(${jobName})`;
      const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
      return commandOutcome({ ok: cmdResult.code === 0, command, ...cmdResult });
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
      return commandOutcome({ ok: cmdResult.code === 0, command, ...cmdResult });
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
      return commandOutcome({ ok: cmdResult.code === 0, command, ...cmdResult });
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
      return commandOutcome({ ok: cmdResult.code === 0, command, ...cmdResult });
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
      if (!message.trim()) throw new Error("message is required");
      const command = buildSendMessageCommand(message, library, messageQueue, messageType);
      const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
      return commandOutcome({
        ok: cmdResult.code === 0,
        command,
        requestedMessageType: messageType,
        mappedMessageType: messageType,
        ...cmdResult
      });
    }
    case "ibmi.msgq.reply": {
      const conn = await ctx.ensureActive(args?.connectionName);
      enforceWritable(ctx, conn, "qsys.write", args);
      const library = requireIbmObjectName(args?.library || "QSYS", "library");
      const messageQueue = requireIbmObjectName(args?.messageQueue || "QSYSOPR", "messageQueue");
      const messageKey = requireMessageKey(args.messageKey);
      const reply = String(args.reply || "");
      if (!reply.trim()) throw new Error("reply is required");
      const command = `SNDRPY MSGKEY(${messageKey}) MSGQ(${library}/${messageQueue}) RPY(${quoteClString(reply)})`;
      const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
      return commandOutcome({ ok: cmdResult.code === 0, command, ...cmdResult });
    }
    case "ibmi.locks.list": {
      const conn = await ctx.ensureActive(args?.connectionName);
      const limit = clampNumber(args?.limit, 200, 1, 5000);
      const rows = await queryLockEntries(conn, {
        objectLibrary: args?.objectLibrary ? requireIbmObjectName(args.objectLibrary, "objectLibrary") : undefined,
        objectName: args?.objectName ? requireIbmObjectName(args.objectName, "objectName") : undefined,
        objectType: args?.objectType ? requireObjectTypeValue(args.objectType, "objectType") : undefined,
        member: args?.member ? requireIbmObjectName(args.member, "member") : undefined,
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
      if (!message) throw new Error("message is required");
      let primaryError: string;
      try {
        await conn.runSQL(
          `call qsys2.send_data_queue(message_data => ${Tools.sqlString(message)}, ` +
          `data_queue => ${Tools.sqlString(queue)}, data_queue_library => ${Tools.sqlString(library)})`
        );
        return json({
          ok: true,
          method: "qsys2.send_data_queue",
          library,
          queue,
          messageLength: message.length
        });
      } catch (err: any) {
        primaryError = err?.message || String(err);
      }
      // Older releases without QSYS2.SEND_DATA_QUEUE: call the QSNDDTAQ API.
      // There is no SNDDTAQ CL command.
      const command = buildQsnddtaqCall(library, queue, message);
      const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
      return commandOutcome({
        ok: cmdResult.code === 0,
        method: "api.qsnddtaq",
        command,
        primaryError,
        ...cmdResult
      });
    }
    case "ibmi.dataqueue.receive": {
      const conn = await ctx.ensureActive(args?.connectionName);
      const library = requireIbmObjectName(args.library, "library");
      const queue = requireIbmObjectName(args.queue, "queue");
      const waitSeconds = clampNumber(args?.waitSeconds, 0, 0, DATA_QUEUE_MAX_WAIT_SECONDS);
      // Peek by default. Removing an entry changes the queue, so it goes
      // through the same write gate as the other write tools.
      const remove = args?.remove === true;
      if (remove) enforceWritable(ctx, conn, "qsys.write", args);
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
      const value = String(args.value ?? "");
      let info: ReturnType<typeof normalizeDataAreaInfoRow> | undefined;
      try {
        info = (await queryDataAreaInfo(conn, { library, dataArea }))[0];
      } catch {
        info = undefined;
      }
      const command = buildChangeDataAreaCommand(library, dataArea, value, info, args);
      const cmdResult = await runClCommand(conn, command, "ile", undefined, 45000);
      return commandOutcome({ ok: cmdResult.code === 0, command, dataAreaType: info?.type || null, ...cmdResult });
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
        outputPath: await guardLocalPath(ctx, args.outputPath, "write"),
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
      const objectType = args?.objectType ? requireObjectTypeValue(args.objectType, "objectType") : undefined;
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
        objectType,
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
      return commandOutcome({
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
      return commandOutcome({
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
      return commandOutcome({
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
      return commandOutcome({
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
      return commandOutcome({
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
      return commandOutcome({
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
      return commandOutcome({
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
      // The schema documents dryRun as defaulting to true; only an explicit
      // dryRun=false may delete receivers.
      const dryRun = args?.dryRun === undefined || args?.dryRun === null ? true : Boolean(args.dryRun);
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
      const deleted: Array<{ receiverLibrary: string; receiver: string; ok: boolean; error?: string }> = [];
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

      return commandOutcome({
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

      const outputPath = await guardLocalPath(ctx, args.outputPath, "write");
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

      let signaturePath: string | undefined;
      let digestPath: string | undefined;
      let signature: string | undefined;
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
      if (!field) throw new Error(`TN5250 field not found: ${args.fieldId}`);
      if (field.protected) throw new Error(`TN5250 field is protected: ${field.id}`);
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

          enforceWritable(ctx, conn, "cl.run", {
            ...args,
            command,
            environment: "ile",
            connectionName: session.connectionName
          });

          const cmdResult = await runClCommand(conn, command, "ile", undefined, timeoutMs);
          const recent = await readRecentJoblogMessages(conn, 5);
          const messages = recent.map((row: any) => {
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
          if (commandField) commandField.value = "";
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
      if (!name) throw new Error("connectionName is required (no active session)");
      const existed = tn5250Sessions.delete(name);
      return json({ disconnected: existed, connectionName: name });
    }
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function listActions(ctx: McpContext) {
  const builtins = Object.values(LocalLanguageActions).flat();
  const custom = await ctx.store.listActions();
  return [...builtins, ...custom];
}

export async function resolveAction(ctx: McpContext, args: any): Promise<Action | undefined> {
  if (args.action) return args.action as Action;
  if (!args.actionName) return undefined;
  const actions = await listActions(ctx);
  return actions.find(a => a.name === args.actionName);
}

type ClCommandResult = {
  code: number;
  signal?: string | null;
  stdout: string;
  stderr: string;
  command?: string;
  [key: string]: unknown;
};

async function runClCommand(conn: any, command: string, environment: string, cwd: string | undefined, timeoutMs: number): Promise<ClCommandResult> {
  if (environment === "pase") {
    return await withTimeout(
      conn.sendCommand({ command, directory: cwd }),
      timeoutMs,
      `CL command timed out after ${timeoutMs}ms`
    ) as ClCommandResult;
  }
  if (environment === "qsh") {
    return await withTimeout(
      conn.sendQsh({ command, directory: cwd }),
      timeoutMs,
      `CL command timed out after ${timeoutMs}ms`
    ) as ClCommandResult;
  }

  try {
    await withTimeout(
      conn.runSQL(`CALL QSYS2.QCMDEXC(${Tools.sqlString(command)})`),
      timeoutMs,
      `CL command timed out after ${timeoutMs}ms`
    );
    return { code: 0, signal: null, stdout: "", stderr: "", command };
  } catch (err: any) {
    return { code: 1, signal: null, stdout: "", stderr: err?.message || String(err), command };
  }
}

async function readRecentJoblogMessages(conn: any, limit: number) {
  try {
    const capped = clampNumber(limit, 5, 1, 20);
    return await conn.runSQL(
      `select message_id, message_text, severity, message_timestamp from table(qsys2.joblog_info('*')) order by message_timestamp desc fetch first ${capped} rows only`
    );
  } catch {
    return [];
  }
}

type JournalQueryOptions = {
  journalLibrary: string;
  journal: string;
  objectLibrary?: string;
  objectName?: string;
  objectType?: string;
  journalCode?: string;
  entryType?: string;
  userName?: string;
  jobName?: string;
  programName?: string;
  limit: number;
  sinceSequence?: number;
  sinceTimestamp?: string;
};

// Every filter is applied on the IBM i (table function parameters and WHERE
// predicates) before FETCH FIRST, so the row cap never hides matching entries.
// Rows come back newest first.
async function queryJournalEntries(conn: any, options: JournalQueryOptions) {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await queryJournalEntriesViaDisplayJournal(conn, options);
  } catch {
    rows = await queryJournalEntriesViaOutfile(conn, options);
  }

  const normalized = rows.map(normalizeJournalEntry);
  normalized.sort((a, b) => {
    const aSeq = typeof a.sequence === "number" ? a.sequence : -1;
    const bSeq = typeof b.sequence === "number" ? b.sequence : -1;
    if (aSeq !== bSeq) return bSeq - aSeq;
    const aTs = a.timestamp ? Date.parse(a.timestamp) : -1;
    const bTs = b.timestamp ? Date.parse(b.timestamp) : -1;
    return bTs - aTs;
  });

  return normalized.slice(0, options.limit);
}

// Turns an ISO-8601 or IBM i style timestamp into a Db2 for i timestamp
// expression in the system's local time. Values with an explicit zone (Z or
// +hh:mm) are converted from UTC with CURRENT TIMEZONE; values without a zone
// are taken as system local time.
function sqlTimestampExpression(value: string) {
  const raw = String(value || "").trim();
  const local = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T-](\d{2})[:.](\d{2})(?:[:.](\d{2})(?:\.(\d{1,6}))?)?)?$/);
  if (local) {
    const [, y, mo, d, h = "00", mi = "00", s = "00", frac = "0"] = local;
    return `timestamp('${y}-${mo}-${d}-${h}.${mi}.${s}.${frac.padEnd(6, "0")}')`;
  }
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    throw new Error(`Invalid sinceTimestamp: ${value}`);
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid sinceTimestamp: ${value}`);
  const iso = new Date(parsed).toISOString();
  const db2 = `${iso.slice(0, 10)}-${iso.slice(11, 13)}.${iso.slice(14, 16)}.${iso.slice(17, 19)}.${iso.slice(20, 23)}000`;
  return `(timestamp('${db2}') + current timezone)`;
}

type JobQueryOptions = {
  subsystem?: string;
  userName?: string;
  status?: string;
  limit: number;
};

async function queryJobs(conn: any, options: JobQueryOptions) {
  const scanLimit = Math.min(options.limit * 5, 5000);
  const rows: any[] = [];

  const activeWhere = buildJobWhereClause(options, {
    subsystem: "SUBSYSTEM",
    userName: "AUTHORIZATION_NAME",
    status: "JOB_STATUS"
  });
  try {
    const activeRows = await conn.runSQL(
      `select * from table(qsys2.active_job_info())${activeWhere} fetch first ${scanLimit} rows only`
    );
    rows.push(...activeRows.map((row: any) => normalizeActiveJobRow(row)));
  } catch {
    // Continue with job_info fallback.
  }

  const allWhere = buildJobWhereClause(options, {
    subsystem: "JOB_SUBSYSTEM",
    userName: "JOB_USER",
    status: "JOB_STATUS"
  });
  try {
    const allRows = await conn.runSQL(
      `select * from table(qsys2.job_info('*ALL'))${allWhere} fetch first ${scanLimit} rows only`
    );
    const seen = new Set(rows.map((row: any) => String(row.jobName || "")));
    for (const row of allRows.map((raw: any) => normalizeActiveJobRow(raw))) {
      const key = String(row.jobName || "");
      if (!key || seen.has(key)) continue;
      rows.push(row);
      seen.add(key);
    }
  } catch {
    // Some systems may not provide job_info as a table function.
  }

  return rows.slice(0, options.limit);
}

function buildJobWhereClause(
  options: JobQueryOptions,
  columns: { subsystem: string; userName: string; status: string }
) {
  const predicates: string[] = [];
  if (options.subsystem) {
    const subsystem = String(options.subsystem).trim().toUpperCase();
    if (subsystem) predicates.push(`upper(${columns.subsystem})=${Tools.sqlString(subsystem)}`);
  }
  if (options.userName) {
    const userName = String(options.userName).trim().toUpperCase();
    if (userName) predicates.push(`upper(${columns.userName})=${Tools.sqlString(userName)}`);
  }
  if (options.status) {
    const status = String(options.status).trim().toUpperCase().replace(/'/g, "''");
    if (status) predicates.push(`upper(${columns.status}) like '%${status}%'`);
  }
  return predicates.length > 0 ? ` where ${predicates.join(" and ")}` : "";
}

async function querySubsystemSummary(conn: any, limit: number) {
  const jobs = await queryJobs(conn, { limit: 5000 });
  const counts = new Map<string, number>();
  for (const job of jobs) {
    const subsystem = String(job.subsystem || "").trim().toUpperCase() || "UNKNOWN";
    counts.set(subsystem, (counts.get(subsystem) || 0) + 1);
  }
  const rows = Array.from(counts.entries())
    .map(([subsystem, activeJobs]) => ({ subsystem, activeJobs }))
    .sort((a, b) => a.subsystem.localeCompare(b.subsystem));
  return rows.slice(0, limit);
}

function normalizeActiveJobRow(row: Record<string, unknown>) {
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

type MessageQueueOptions = {
  library: string;
  messageQueue: string;
  limit: number;
};

// Newest messages first. The table function form takes QUEUE_LIBRARY and
// QUEUE_NAME; the view form is the fallback for releases without it.
async function queryMessageQueueEntries(conn: any, options: MessageQueueOptions) {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await conn.runSQL(
      `select * from table(qsys2.message_queue_info(queue_library => ${Tools.sqlString(options.library)}, queue_name => ${Tools.sqlString(options.messageQueue)})) ` +
      `order by message_timestamp desc fetch first ${options.limit} rows only`
    );
  } catch {
    rows = await conn.runSQL(
      `select * from qsys2.message_queue_info where message_queue_name=${Tools.sqlString(options.messageQueue)} and message_queue_library=${Tools.sqlString(options.library)} ` +
      `order by message_timestamp desc fetch first ${options.limit} rows only`
    );
  }
  return rows.map(normalizeMessageQueueEntry);
}

type SpoolQueryOptions = {
  limit: number;
  userName?: string;
  outputQueue?: string;
  outputQueueLibrary?: string;
  jobName?: string;
};

// QSYS2.OUTPUT_QUEUE_ENTRIES columns: USER_NAME, OUTPUT_QUEUE_NAME,
// OUTPUT_QUEUE_LIBRARY_NAME, JOB_NAME (qualified), CREATE_TIMESTAMP, ...
function buildSpoolWhereClause(options: SpoolQueryOptions) {
  const predicates: string[] = [];
  if (options.userName) predicates.push(`user_name = ${Tools.sqlString(options.userName)}`);
  if (options.outputQueue) predicates.push(`output_queue_name = ${Tools.sqlString(options.outputQueue)}`);
  if (options.outputQueueLibrary) predicates.push(`output_queue_library_name = ${Tools.sqlString(options.outputQueueLibrary)}`);
  if (options.jobName) {
    predicates.push(options.jobName.includes("/")
      ? `job_name = ${Tools.sqlString(options.jobName)}`
      : `job_name like ${Tools.sqlString(`%/${options.jobName}`)}`);
  }
  return predicates.length > 0 ? ` where ${predicates.join(" and ")}` : "";
}

async function querySpoolEntries(conn: any, options: SpoolQueryOptions) {
  const limit = options.limit;
  const where = buildSpoolWhereClause(options);
  const queries = [
    `select * from qsys2.output_queue_entries${where} order by create_timestamp desc fetch first ${limit} rows only`,
    `select * from qsys2.output_queue_entries${where} fetch first ${limit} rows only`
  ];
  if (!where) {
    queries.push(
      `select * from table(qsys2.output_queue_entries()) fetch first ${limit} rows only`,
      `select * from qsys2.spooled_file_info fetch first ${limit} rows only`,
      `select * from table(qsys2.spooled_file_info()) fetch first ${limit} rows only`
    );
  }

  let lastError: unknown;
  for (const sql of queries) {
    try {
      return await conn.runSQL(sql);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "Unable to read spool entries"));
}

function normalizeMessageQueueEntry(row: Record<string, unknown>) {
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

type LockQueryOptions = {
  objectLibrary?: string;
  objectName?: string;
  objectType?: string;
  member?: string;
  limit: number;
};

// QSYS2.OBJECT_LOCK_INFO is a view; filters go into its WHERE clause so the row
// cap applies to matching locks only.
async function queryLockEntries(conn: any, options: LockQueryOptions) {
  const base: string[] = [];
  if (options.objectLibrary) base.push(`object_schema = ${Tools.sqlString(options.objectLibrary)}`);
  if (options.objectName) base.push(`object_name = ${Tools.sqlString(options.objectName)}`);
  if (options.objectType) base.push(`object_type = ${Tools.sqlString(options.objectType)}`);
  const memberPredicate = options.member ? `system_table_member = ${Tools.sqlString(options.member)}` : undefined;
  const whereOf = (predicates: string[]) => predicates.length > 0 ? ` where ${predicates.join(" and ")}` : "";

  let rows: Array<Record<string, unknown>>;
  let filterMemberLocally = false;
  try {
    rows = await conn.runSQL(
      `select * from qsys2.object_lock_info${whereOf(memberPredicate ? [...base, memberPredicate] : base)} fetch first ${options.limit} rows only`
    );
  } catch (err) {
    if (!memberPredicate) throw err;
    // Fallback when the member column is named differently on this release:
    // keep the object filters in SQL and match the member locally.
    rows = await conn.runSQL(`select * from qsys2.object_lock_info${whereOf(base)} fetch first 5000 rows only`);
    filterMemberLocally = true;
  }
  let normalized = rows.map(normalizeLockEntry);
  if (filterMemberLocally && options.member) {
    normalized = normalized.filter(row => (row.member || "") === options.member);
  }
  return normalized.slice(0, options.limit);
}

function normalizeLockEntry(row: Record<string, unknown>) {
  return {
    source: "lock",
    objectLibrary: toNullableString(pickFirst(row, ["OBJECT_SCHEMA", "OBJECT_LIBRARY", "OBJLIB"])),
    objectName: toNullableString(pickFirst(row, ["OBJECT_NAME", "OBJNAME"])),
    objectType: toNullableString(pickFirst(row, ["OBJECT_TYPE", "OBJTYPE"])),
    member: toNullableString(pickFirst(row, ["SYSTEM_TABLE_MEMBER", "MEMBER_NAME", "MEMBER"])),
    lockState: toNullableString(pickFirst(row, ["LOCK_STATE", "LOCK_STATUS", "STATUS"])),
    lockScope: toNullableString(pickFirst(row, ["LOCK_SCOPE", "SCOPE"])),
    lockHolderJob: toNullableString(pickFirst(row, ["JOB_NAME", "LOCK_JOB_NAME"])),
    lockHolderUser: toNullableString(pickFirst(row, ["USER_NAME", "AUTHORIZATION_NAME"]))
  };
}

type ObjectAuthorityOptions = {
  library: string;
  object: string;
  objectType: string;
  limit: number;
};

async function queryObjectAuthorities(conn: any, options: ObjectAuthorityOptions) {
  const rows = await conn.runSQL(
    `select * from qsys2.object_privileges where upper(object_schema)=${Tools.sqlString(options.library)} and upper(object_name)=${Tools.sqlString(options.object)} fetch first ${options.limit} rows only`
  );
  let normalized = rows.map(normalizeObjectAuthorityRow);
  if (options.objectType) {
    normalized = normalized.filter((row: any) => !row.objectType || row.objectType === options.objectType);
  }
  return normalized;
}

function normalizeObjectAuthorityRow(row: Record<string, unknown>) {
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

type DataQueueReceiveOptions = {
  library: string;
  queue: string;
  waitSeconds: number;
  remove: boolean;
};

const DATA_QUEUE_MAX_WAIT_SECONDS = 60;

// remove=false never falls back to anything that takes the entry off the
// queue: it peeks with RECEIVE_DATA_QUEUE(REMOVE => 'NO') and then with the
// read-only DATA_QUEUE_ENTRIES service.
async function queryDataQueueEntries(conn: any, options: DataQueueReceiveOptions) {
  const queue = Tools.sqlString(options.queue);
  const library = Tools.sqlString(options.library);
  const waitSeconds = Math.max(0, Math.min(DATA_QUEUE_MAX_WAIT_SECONDS, Math.floor(options.waitSeconds)));
  let rows: Array<Record<string, unknown>>;
  if (options.remove) {
    rows = await conn.runSQL(
      `select * from table(qsys2.receive_data_queue(data_queue => ${queue}, data_queue_library => ${library}, ` +
      `wait_time => ${waitSeconds}, remove => 'YES')) fetch first 1 rows only`
    );
    return rows.map(normalizeDataQueueEntry);
  }
  try {
    rows = await conn.runSQL(
      `select * from table(qsys2.receive_data_queue(data_queue => ${queue}, data_queue_library => ${library}, ` +
      `wait_time => ${waitSeconds}, remove => 'NO')) fetch first 1 rows only`
    );
  } catch {
    rows = await conn.runSQL(
      `select * from table(qsys2.data_queue_entries(data_queue => ${queue}, data_queue_library => ${library})) ` +
      `order by ordinal_position fetch first 1 rows only`
    );
  }
  return rows.map(normalizeDataQueueEntry);
}

function normalizeDataQueueEntry(row: Record<string, unknown>) {
  return {
    source: "dataqueue",
    message: toNullableString(pickFirst(row, ["MESSAGE_DATA", "DATA_QUEUE_ENTRY", "DATA"])),
    sender: toNullableString(pickFirst(row, ["SENDER_JOB_NAME", "SENDER_USER_PROFILE"])),
    sentAt: toNullableString(pickFirst(row, ["ENQUEUE_TIMESTAMP", "TIMESTAMP"])),
    key: toNullableString(pickFirst(row, ["KEY_DATA", "KEY"]))
  };
}

type DataAreaReadOptions = {
  library: string;
  dataArea: string;
};

async function queryDataAreaInfo(conn: any, options: DataAreaReadOptions) {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await conn.runSQL(
      `select * from table(qsys2.data_area_info(data_area_name => ${Tools.sqlString(options.dataArea)}, data_area_library => ${Tools.sqlString(options.library)}))`
    );
  } catch {
    rows = await conn.runSQL(
      `select * from qsys2.data_area_info where upper(data_area_name)=${Tools.sqlString(options.dataArea)} and upper(data_area_library)=${Tools.sqlString(options.library)}`
    );
  }
  return rows.map(normalizeDataAreaInfoRow);
}

function normalizeDataAreaInfoRow(row: Record<string, unknown>) {
  return {
    source: "dataarea",
    library: toNullableString(pickFirst(row, ["DATA_AREA_LIBRARY", "OBJECT_SCHEMA"])),
    dataArea: toNullableString(pickFirst(row, ["DATA_AREA_NAME", "OBJECT_NAME"])),
    type: toNullableString(pickFirst(row, ["DATA_AREA_TYPE", "OBJECT_TYPE"])),
    length: toNullableNumber(pickFirst(row, ["LENGTH", "DATA_AREA_LENGTH"])),
    decimalPositions: toNullableNumber(pickFirst(row, ["DECIMAL_POSITIONS"])),
    value: toNullableString(pickFirst(row, ["CHARACTER_VALUE", "VALUE", "DECIMAL_VALUE"])),
    updatedAt: toNullableString(pickFirst(row, ["LAST_CHANGED_TIMESTAMP", "CHANGE_TIMESTAMP"]))
  };
}

function buildSpoolCommand(commandName: string, args: any) {
  const jobName = requireJobName(args.jobName);
  const spooledFileName = requireIbmObjectName(args.spooledFileName, "spooledFileName");
  const rawNumber = Number(args.spooledFileNumber);
  const spooledFileNumber = Number.isFinite(rawNumber) && rawNumber > 0
    ? String(Math.floor(rawNumber))
    : "*LAST";
  return `${commandName} FILE(${spooledFileName}) JOB(${jobName}) SPLNBR(${spooledFileNumber})`;
}

function isQualifiedJobName(value: string) {
  return /^[^/]+\/[^/]+\/[^/]+$/.test(value);
}

async function queryJournalEntriesViaDisplayJournal(conn: any, options: JournalQueryOptions) {
  if (options.objectLibrary && !options.objectName) {
    // A library on its own is not a DISPLAY_JOURNAL filter; the outfile path
    // filters it in SQL.
    throw new Error("objectLibrary without objectName is handled by the DSPJRN outfile query");
  }
  const params = [
    `journal_library => ${Tools.sqlString(options.journalLibrary)}`,
    `journal_name => ${Tools.sqlString(options.journal)}`
  ];
  const where: string[] = [];
  const since = options.sinceTimestamp ? sqlTimestampExpression(options.sinceTimestamp) : undefined;
  if (typeof options.sinceSequence === "number" || since) {
    // Search the whole receiver chain, not only the attached receiver, when a
    // starting point is given.
    params.push(`starting_receiver_name => '*CURCHAIN'`);
  }
  if (typeof options.sinceSequence === "number") {
    params.push(`starting_sequence => ${Math.max(0, Math.floor(options.sinceSequence))}`);
    where.push(`sequence_number >= ${Math.max(0, Math.floor(options.sinceSequence))}`);
    if (since) where.push(`entry_timestamp >= ${since}`);
  } else if (since) {
    params.push(`starting_timestamp => ${since}`);
  }
  if (options.journalCode) params.push(`journal_codes => ${Tools.sqlString(options.journalCode)}`);
  if (options.entryType) params.push(`journal_entry_types => ${Tools.sqlString(options.entryType)}`);
  if (options.objectName) {
    params.push(`object_library => ${Tools.sqlString(options.objectLibrary || "*LIBL")}`);
    params.push(`object_name => ${Tools.sqlString(options.objectName)}`);
    const objectType = options.objectType || "*FILE";
    params.push(`object_objtype => ${Tools.sqlString(objectType)}`);
    if (objectType === "*FILE") params.push(`object_member => '*ALL'`);
  }
  if (options.userName) params.push(`user => ${Tools.sqlString(options.userName)}`);
  if (options.programName) params.push(`program => ${Tools.sqlString(options.programName)}`);
  if (options.jobName) {
    if (isQualifiedJobName(options.jobName)) params.push(`job => ${Tools.sqlString(options.jobName)}`);
    else where.push(`job_name = ${Tools.sqlString(options.jobName)}`);
  }
  const whereClause = where.length > 0 ? ` where ${where.join(" and ")}` : "";
  const rows = await conn.runSQL(
    `select * from table(qsys2.display_journal(${params.join(", ")}))${whereClause} ` +
    `order by sequence_number desc fetch first ${options.limit} rows only`
  );
  return rows as Array<Record<string, unknown>>;
}

// DSPJRN writes to QTEMP, which belongs to one job. The CALL QCMDEXC and the
// SELECT are sent in the same QZDFMDB2 request so they run in the same job.
async function queryJournalEntriesViaOutfile(conn: any, options: JournalQueryOptions) {
  const outfile = `MCPJ${String(Math.floor(Math.random() * 900000) + 100000)}`;
  const rangeOption = typeof options.sinceSequence === "number" || options.sinceTimestamp ? " RCVRNG(*CURCHAIN)" : "";
  const command = `DSPJRN JRN(${options.journalLibrary}/${options.journal})${rangeOption} ` +
    `OUTPUT(*OUTFILE) OUTFILFMT(*TYPE5) OUTFILE(QTEMP/${outfile})`;
  const where: string[] = [];
  if (options.objectLibrary) where.push(`JOLIB = ${Tools.sqlString(options.objectLibrary)}`);
  if (options.objectName) where.push(`JOOBJ = ${Tools.sqlString(options.objectName)}`);
  if (options.journalCode) where.push(`JOCODE = ${Tools.sqlString(options.journalCode)}`);
  if (options.entryType) where.push(`JOENTT = ${Tools.sqlString(options.entryType)}`);
  if (options.userName) where.push(`JOUSPF = ${Tools.sqlString(options.userName)}`);
  if (options.programName) where.push(`JOPGM = ${Tools.sqlString(options.programName)}`);
  if (options.jobName) {
    if (isQualifiedJobName(options.jobName)) {
      const [number, user, name] = options.jobName.split("/");
      where.push(`JONBR = ${Tools.sqlString(number)}`, `JOUSER = ${Tools.sqlString(user)}`, `JOJOB = ${Tools.sqlString(name)}`);
    } else {
      where.push(`JOJOB = ${Tools.sqlString(options.jobName)}`);
    }
  }
  if (typeof options.sinceSequence === "number") where.push(`JOSEQN >= ${Math.max(0, Math.floor(options.sinceSequence))}`);
  if (options.sinceTimestamp) where.push(`JOTSTP >= ${sqlTimestampExpression(options.sinceTimestamp)}`);
  const whereClause = where.length > 0 ? ` where ${where.join(" and ")}` : "";
  const rows = await conn.runSQL([
    `CALL QSYS2.QCMDEXC(${Tools.sqlString(command)});`,
    `select * from QTEMP.${outfile}${whereClause} order by JOSEQN desc fetch first ${options.limit} rows only;`
  ].join("\n"));
  return rows as Array<Record<string, unknown>>;
}

function normalizeJournalEntry(row: Record<string, unknown>) {
  const sequence = toNullableNumber(pickFirst(row, ["SEQUENCE_NUMBER", "JOURNAL_SEQUENCE_NUMBER", "JOSEQN", "JRN_SEQUENCE"]));
  const timestamp = toNullableString(pickFirst(row, ["ENTRY_TIMESTAMP", "TIMESTAMP", "JOTSTP", "JOURNAL_TIMESTAMP"]));
  const journalCode = toNullableString(pickFirst(row, ["JOURNAL_CODE", "JOCODE", "JRN_CODE"]));
  const entryType = toNullableString(pickFirst(row, ["JOURNAL_ENTRY_TYPE", "JOENTT", "ENTRY_TYPE"]));
  const objectLibrary = toNullableString(pickFirst(row, ["OBJECT_LIBRARY", "JOLIB", "OBJLIB"]));
  const objectName = toNullableString(pickFirst(row, ["OBJECT_NAME", "JOOBJ", "OBJNAME"]));
  const objectType = toNullableString(pickFirst(row, ["OBJECT_TYPE", "JOOBJT", "OBJTYPE"]));
  const jobName = toNullableString(pickFirst(row, ["JOB_NAME", "JOJOB", "JOB"]));
  const userName = toNullableString(pickFirst(row, ["USER_NAME", "CURRENT_USER", "JOUSPF", "JOUSER", "USER"]));
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

function pickFirst(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (typeof row[key] !== "undefined" && row[key] !== null) return row[key];
  }
  return undefined;
}

function toNullableNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullableString(value: unknown) {
  if (typeof value === "undefined" || value === null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function ensureTn5250Session(connectionName: string): Tn5250Session {
  const existing = tn5250Sessions.get(connectionName);
  if (existing) {
    touchTn5250Session(existing);
    return existing;
  }

  const now = new Date().toISOString();
  const session: Tn5250Session = {
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

function requireTn5250Session(ctx: McpContext, args: any): Tn5250Session {
  const name = resolveTn5250SessionName(ctx, args);
  if (!name) throw new Error("connectionName is required (no active session)");
  const session = tn5250Sessions.get(name);
  if (!session) {
    throw new Error(`TN5250 session for ${name} not found. Call ibmi.tn5250.connect first.`);
  }
  return session;
}

function resolveTn5250SessionName(ctx: McpContext, args: any) {
  return args?.connectionName || ctx.activeName;
}

function findTn5250Field(session: Tn5250Session, fieldId: string): Tn5250Field | undefined {
  const normalized = String(fieldId || "").trim().toLowerCase();
  if (!normalized) return undefined;
  const aliases = normalized === "1" ? ["command", "1"] : [normalized];
  return session.screen.fields.find(field => {
    const id = field.id.toLowerCase();
    return aliases.includes(id);
  });
}

function parseTn5250Keys(value: string) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("keys is required");
  return raw
    .split(/[,\s+]+/)
    .map(part => part.trim().toUpperCase())
    .filter(Boolean);
}

function touchTn5250Session(session: Tn5250Session) {
  session.screen.updatedAt = new Date().toISOString();
  tn5250Sessions.set(session.connectionName, session);
}

function appendTn5250Message(session: Tn5250Session, message: string) {
  session.screen.textLines.unshift(message);
  if (session.screen.textLines.length > TN5250_MAX_LINES) {
    session.screen.textLines = session.screen.textLines.slice(0, TN5250_MAX_LINES);
  }
  touchTn5250Session(session);
}

function resetTn5250Screen(session: Tn5250Session, message: string) {
  const commandField = findTn5250Field(session, "command");
  if (commandField) commandField.value = "";
  session.screen.textLines = [message, `Connected to ${session.connectionName}.`];
  session.screen.cursorFieldId = "command";
  session.screen.lastKeys = [];
  touchTn5250Session(session);
}

function rotateTn5250Cursor(session: Tn5250Session) {
  const fields = session.screen.fields;
  if (fields.length === 0) return;
  const idx = fields.findIndex(field => field.id === session.screen.cursorFieldId);
  const next = idx >= 0 ? (idx + 1) % fields.length : 0;
  session.screen.cursorFieldId = fields[next].id;
  touchTn5250Session(session);
}

async function waitForTn5250Text(session: Tn5250Session, text: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const needle = String(text).toLowerCase();
  while (Date.now() <= deadline) {
    const haystack = renderTn5250Screen(session.screen).toLowerCase();
    if (haystack.includes(needle)) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

function renderTn5250Screen(screen: Tn5250Screen) {
  const lines: string[] = [];
  lines.push(`${screen.title} (${screen.status})`);
  lines.push(...screen.textLines);
  for (const field of screen.fields) {
    lines.push(`${field.label}[${field.id}]=${field.value}`);
  }
  return lines.join("\n");
}

function hasMemberListExtensions(args: any) {
  return args?.responseFormat === "page" || [
    "member", "memberPrefix", "memberContains", "sourceTypes", "changedSince", "limit", "cursor"
  ].some(key => typeof args?.[key] !== "undefined");
}

function hasStructuredMemberReadOptions(args: any) {
  return args?.responseFormat === "structured" || [
    "startLine", "endLine", "ranges", "before", "after", "metadataOnly",
    "expectedVersion", "expectedSha256", "forceFresh"
  ].some(key => typeof args?.[key] !== "undefined");
}

function memberVersionConflict(snapshot: MemberSnapshot, args: any) {
  const versionMismatch = args?.expectedVersion && args.expectedVersion !== snapshot.version;
  const hashMismatch = args?.expectedSha256 && String(args.expectedSha256).toLowerCase() !== snapshot.sha256.toLowerCase();
  if (!versionMismatch && !hashMismatch) return undefined;
  return {
    status: "version-conflict",
    identity: snapshot.identity,
    expectedVersion: args?.expectedVersion,
    expectedSha256: args?.expectedSha256,
    actualVersion: snapshot.version,
    actualSha256: snapshot.sha256,
    observedAt: snapshot.observedAt,
    modified: false
  };
}

function formatMemberRead(snapshot: MemberSnapshot, args: any) {
  const envelope: Record<string, any> = {
    status: "found",
    identity: snapshot.identity,
    metadata: snapshot.metadata,
    version: snapshot.version,
    sha256: snapshot.sha256,
    observedAt: snapshot.observedAt,
    complete: snapshot.complete,
    transport: snapshot.transport,
    cacheStatus: snapshot.cacheStatus,
    warnings: snapshot.warnings
  };
  if (args?.metadataOnly) return envelope;

  const ranges = normalizeLineRanges(args, snapshot.lines.length);
  if (ranges.length === 0) {
    return { ...envelope, content: snapshot.content, lineCount: snapshot.lines.length };
  }
  return {
    ...envelope,
    ranges: ranges.map(range => ({
      start: range.start,
      end: range.end,
      lines: snapshot.lines.slice(range.start - 1, range.end).map((content, index) => ({
        number: range.start + index,
        content
      }))
    }))
  };
}

function normalizeLineRanges(args: any, lineCount: number) {
  const before = clampInteger(args?.before, 0, 200, 0);
  const after = clampInteger(args?.after, 0, 200, 0);
  const requested: Array<{ start: number; end: number }> = [];
  if (typeof args?.startLine !== "undefined" || typeof args?.endLine !== "undefined") {
    requested.push({ start: Number(args.startLine || 1), end: Number(args.endLine || args.startLine || lineCount) });
  }
  if (Array.isArray(args?.ranges)) {
    for (const range of args.ranges.slice(0, 8)) requested.push({ start: Number(range.start), end: Number(range.end) });
  }
  if (requested.length === 0) return [];

  const normalized = requested.map(range => {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 1 || range.end < range.start) {
      throw new Error(`Invalid line range ${range.start}-${range.end}`);
    }
    return {
      start: Math.max(1, Math.floor(range.start) - before),
      end: Math.min(lineCount, Math.floor(range.end) + after)
    };
  }).sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Array<{ start: number; end: number }> = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  const total = merged.reduce((sum, range) => sum + range.end - range.start + 1, 0);
  if (total > 2_000) throw new Error("Requested ranges exceed the 2,000-line response limit");
  return merged;
}

function normalizeSearchTerms(args: any) {
  const terms = [
    ...(typeof args?.term === "string" ? [args.term] : []),
    ...(Array.isArray(args?.terms) ? args.terms : [])
  ].map(value => String(value)).filter(value => value.length > 0);
  const unique = [...new Set(terms)];
  if (unique.length < 1 || unique.length > 20) throw new Error("Provide term or between 1 and 20 terms");
  return unique;
}

function rankMemberCandidates(candidates: any[], preferredFiles?: string[]) {
  if (!preferredFiles?.length) return;
  const ranks = new Map(preferredFiles.map((value, index) => [String(value).toUpperCase(), index]));
  candidates.sort((a, b) => (ranks.get(String(a.file).toUpperCase()) ?? Number.MAX_SAFE_INTEGER) -
    (ranks.get(String(b.file).toUpperCase()) ?? Number.MAX_SAFE_INTEGER) || String(a.file).localeCompare(String(b.file)));
}

function inspectMemberOperation(snapshot: MemberSnapshot, operation: any) {
  switch (operation.operation) {
    case "metadata":
      return { operation: "metadata", metadata: snapshot.metadata };
    case "read_ranges":
      return { operation: "read_ranges", ...formatMemberRead(snapshot, { ranges: operation.ranges, before: operation.before, after: operation.after }) };
    case "search":
      return { operation: "search", ...searchSnapshot(snapshot, operation) };
    case "outline":
      return { operation: "outline", symbols: outlineSnapshot(snapshot) };
    case "dependencies":
      return { operation: "dependencies", dependencies: dependenciesFromSnapshot(snapshot) };
    default:
      throw new Error(`Unsupported inspection operation: ${operation.operation}`);
  }
}

function searchSnapshot(snapshot: MemberSnapshot, operation: any) {
  const terms = normalizeSearchTerms({ term: operation.query, terms: operation.terms });
  const before = clampInteger(operation.before, 0, 50, 0);
  const after = clampInteger(operation.after, 0, 50, 0);
  const maxMatches = clampInteger(operation.maxMatches, 1, 1_000, 100);
  const lowered = terms.map(term => term.toLowerCase());
  const matches: any[] = [];
  for (let index = 0; index < snapshot.lines.length && matches.length < maxMatches; index++) {
    const line = snapshot.lines[index];
    const matchedTerms = terms.filter((_term, termIndex) => line.toLowerCase().includes(lowered[termIndex]));
    if (matchedTerms.length === 0) continue;
    const start = Math.max(0, index - before);
    const end = Math.min(snapshot.lines.length - 1, index + after);
    matches.push({
      line: index + 1,
      content: line,
      matchedTerms,
      context: snapshot.lines.slice(start, end + 1).map((content, contextIndex) => ({ number: start + contextIndex + 1, content }))
    });
  }
  return { terms, matches, returned: matches.length, truncated: matches.length >= maxMatches };
}

function outlineSnapshot(snapshot: MemberSnapshot) {
  const symbols: any[] = [];
  const patterns = [
    { kind: "procedure", regex: /\bdcl-proc\s+([A-Za-z0-9_#$@]+)/i },
    { kind: "procedure", regex: /^\s*[Pp]\s+([A-Za-z0-9_#$@]+)\s+B\b/ },
    { kind: "subroutine", regex: /\bbegsr\s+([A-Za-z0-9_#$@]+)/i },
    { kind: "program", regex: /\bPROGRAM-ID\.?\s+([A-Za-z0-9_#$@-]+)/i },
    { kind: "paragraph", regex: /^\s{0,8}([A-Za-z0-9][A-Za-z0-9-]+)\.\s*$/ },
    { kind: "label", regex: /^\s*([A-Za-z0-9_#$@]+):\s*(?:\/\/.*)?$/ }
  ];
  snapshot.lines.forEach((line, index) => {
    for (const pattern of patterns) {
      const match = pattern.regex.exec(line);
      if (match) {
        symbols.push({ name: match[1], kind: pattern.kind, line: index + 1 });
        break;
      }
    }
  });
  return symbols.slice(0, 1_000);
}

function dependenciesFromSnapshot(snapshot: MemberSnapshot) {
  const found = new Map<string, any>();
  const patterns = [
    { kind: "copy", regex: /\/(?:COPY|INCLUDE)\s+([^\s;]+)/ig },
    { kind: "include", regex: /\bCOPY\s+['\"]?([^'\".\s]+)['\"]?\.?/ig },
    { kind: "external-call", regex: /\b(?:CALLP?|CALLPRC)\s*\(?\s*['\"]?([A-Za-z0-9_#$@]+)/ig },
    { kind: "file", regex: /^\s*[Ff]\s*([A-Za-z0-9_#$@]+)\s+/g }
  ];
  snapshot.lines.forEach((line, index) => {
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      for (let match = pattern.regex.exec(line); match; match = pattern.regex.exec(line)) {
        const name = match[1].replace(/[),;]+$/, "").toUpperCase();
        const key = `${pattern.kind}:${name}`;
        if (!found.has(key)) found.set(key, { name, kind: pattern.kind, line: index + 1 });
      }
    }
  });
  return [...found.values()].slice(0, 1_000);
}

async function readSystemFacts(conn: any): Promise<{ release?: string; effectiveUser?: string; systemName?: string }> {
  if (conn.__mcpSystemFacts) return conn.__mcpSystemFacts;
  try {
    const rows = await conn.runSQL(
      "select OS_VERSION, OS_RELEASE, HOST_NAME, current_user as EFFECTIVE_USER " +
      "from SYSIBMADM.ENV_SYS_INFO fetch first 1 row only"
    );
    const row = rows[0];
    const version = String(row?.OS_VERSION || "").replace(/\D/g, "");
    const release = String(row?.OS_RELEASE || "").replace(/\D/g, "");
    const facts = {
      ...(version && release ? { release: `${Number(version)}.${Number(release)}` } : {}),
      ...(row?.EFFECTIVE_USER ? { effectiveUser: String(row.EFFECTIVE_USER).trim() } : {}),
      ...(row?.HOST_NAME ? { systemName: String(row.HOST_NAME).trim() } : {})
    };
    conn.__mcpSystemFacts = facts;
    return facts;
  } catch {
    // Older IBM i releases may not expose SYSIBMADM.ENV_SYS_INFO.
  }
  return {};
}

function clampInteger(value: any, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function rejectCredentialArgs(args: any, toolName: string) {
  if (!args || typeof args !== "object") return;
  if (typeof args.password === "string" && args.password.length > 0) {
    throw new Error(`${toolName} does not accept password. Use the local control-plane UI to set credentials securely.`);
  }
  if (typeof args.storePassword !== "undefined") {
    throw new Error(`${toolName} does not accept storePassword. Credentials must be managed via local control-plane UI.`);
  }
}

function result(text: string) {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ok: true, text }
  };
}

export function json(obj: any) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
    structuredContent: { ok: true, data: obj }
  };
}

function toolError(message: string, error?: Record<string, any>) {
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

export function jsonError(message: string, obj: any) {
  return {
    isError: true,
    content: [{ type: "text", text: `${message}\n${JSON.stringify(obj, null, 2)}` }],
    structuredContent: {
      ok: false,
      data: obj,
      error: { message }
    }
  };
}

// Returns the payload as normal JSON when the command worked and as a tool
// error (isError) when it did not, so agents can't mistake a failure for "OK".
export function commandOutcome(payload: { ok: boolean; command?: string; stderr?: unknown; [key: string]: unknown }) {
  if (payload.ok) return json(payload);
  const detail = String(payload.stderr || "").trim().split(/\r?\n/)[0] || "";
  const label = payload.command ? `Command failed: ${payload.command}` : "Command failed";
  return jsonError(detail ? `${label} (${detail})` : label, payload);
}

function requireCommandSuccess(res: any, label: string) {
  if (!res || res.code !== 0) {
    const detail = String(res?.stderr || res?.stdout || "").trim();
    throw new Error(`${label} failed (exit ${res?.code ?? "unknown"})${detail ? `: ${detail}` : ""}`);
  }
  return res;
}

const IFS_READ_DEFAULT_MAX_BYTES = 1024 * 1024;
const IFS_READ_HARD_MAX_BYTES = 16 * 1024 * 1024;

// Size of an IFS stream file from `ls -ldL`, or undefined when it can't be
// determined (the download is then checked after the fact).
async function statIfsFileSize(conn: any, remotePath: string): Promise<number | undefined> {
  try {
    const res = await conn.sendCommand({ command: `ls -ldL ${Tools.escapePath(remotePath)}` });
    if (!res || res.code !== 0) return undefined;
    const parts = String(res.stdout || "").trim().split(/\s+/);
    if (parts.length < 5 || parts[0].startsWith("d")) return undefined;
    const size = Number(parts[4]);
    return Number.isFinite(size) && size >= 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

// Decodes data as UTF-8 text, or returns undefined when it is binary (contains
// NUL bytes or is not valid UTF-8).
function decodeUtf8Text(data: Buffer): string | undefined {
  if (data.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}

const SQL_TRAILING_ROW_CLAUSE = new RegExp(
  "(?:fetch\\s+(?:first|next)\\s+(?:\\S+\\s+)?rows?\\s+only" +
  "|for\\s+(?:read|fetch)\\s+only" +
  "|for\\s+update(?:\\s+of\\s+[\\w\\s,\"]+)?" +
  "|optimize\\s+for\\s+\\S+\\s+rows?" +
  "|with\\s+(?:nc|ur|cs|rs|rr)(?:\\s+keep\\s+(?:update|exclusive|share)\\s+locks)?" +
  "|limit\\s+\\S+(?:\\s+offset\\s+\\S+)?" +
  "|offset\\s+\\S+\\s+rows?" +
  "|skip\\s+locked\\s+data|use\\s+currently\\s+committed|wait\\s+for\\s+outcome)$"
);

// Adds FETCH FIRST n ROWS ONLY to a SELECT/WITH query so the row cap is applied
// on the IBM i. Queries that already end with a row-limiting, locking or
// isolation clause are left unchanged (the client-side slice still applies).
function applySqlRowCap(sql: string, rowLimit: number): { sql: string; applied: boolean } {
  const body = sql.replace(/[\s;]+$/, "");
  const normalized = body
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map(line => line.replace(/--.*$/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!/^(?:select|with)\b/.test(normalized)) return { sql, applied: false };
  if (SQL_TRAILING_ROW_CLAUSE.test(normalized)) return { sql, applied: false };
  return { sql: `${body}\nfetch first ${Math.max(1, Math.floor(rowLimit))} rows only`, applied: true };
}

function requireSpoolJobFilter(value: unknown) {
  const raw = String(value || "").trim().toUpperCase();
  return raw.includes("/") ? requireJobName(raw) : requireIbmObjectName(raw, "jobName");
}

function requireObjectTypeValue(value: unknown, label: string) {
  const objectType = String(value || "").trim().toUpperCase();
  if (!/^\*[A-Z]{2,9}$/.test(objectType)) throw new Error(`Invalid ${label}: ${value}`);
  return objectType;
}

// SNDMSG only sends *INFO and *INQ messages; *COMP and *DIAG need SNDPGMMSG.
function buildSendMessageCommand(message: string, library: string, messageQueue: string, messageType: string) {
  const queue = `${library}/${messageQueue}`;
  switch (messageType) {
    case "*INQ":
      return `SNDMSG MSG(${quoteClString(message)}) TOMSGQ(${queue}) MSGTYPE(*INQ) RPYMSGQ(${queue})`;
    case "*COMP":
    case "*DIAG":
      return `SNDPGMMSG MSG(${quoteClString(message)}) TOMSGQ(${queue}) MSGTYPE(${messageType})`;
    default:
      return `SNDMSG MSG(${quoteClString(message)}) TOMSGQ(${queue}) MSGTYPE(*INFO)`;
  }
}

// CALL to the Send Data Queue (QSNDDTAQ) API with explicitly typed parameters:
// queue name CHAR(10), library CHAR(10), data length DEC(5,0), data.
function buildQsnddtaqCall(library: string, queue: string, message: string) {
  if (/[^\x20-\x7E]/.test(message)) {
    throw new Error("QSYS2.SEND_DATA_QUEUE is not available and the QSNDDTAQ fallback only supports printable single-byte text.");
  }
  if (message.length > 5000) {
    throw new Error("QSYS2.SEND_DATA_QUEUE is not available and the QSNDDTAQ fallback is limited to 5000 characters.");
  }
  const length = message.length;
  return `CALL PGM(QSYS/QSNDDTAQ) PARM((${quoteClString(queue)} (*CHAR 10)) (${quoteClString(library)} (*CHAR 10)) ` +
    `(${length} (*DEC 5 0)) (${quoteClString(message)} (*CHAR ${length})))`;
}

// Formats CHGDTAARA for the data area's type: *DEC takes an unquoted number and
// *LGL takes '0' or '1' (neither allows a substring); *CHAR keeps the
// substring form so only the given positions change.
function buildChangeDataAreaCommand(
  library: string,
  dataArea: string,
  value: string,
  info: { type?: string | null; length?: number | null; decimalPositions?: number | null } | undefined,
  args: any
) {
  const target = `${library}/${dataArea}`;
  const type = String(info?.type || "*CHAR").trim().toUpperCase();
  const substringRequested = args?.startPosition !== undefined || args?.length !== undefined;
  if (type === "*DEC") {
    if (substringRequested) throw new Error("startPosition and length are only valid for *CHAR data areas");
    const text = value.trim();
    const match = text.match(/^([+-]?)(\d*)(?:\.(\d*))?$/);
    if (!match || (match[2] === "" && !match[3])) throw new Error(`Value for *DEC data area must be numeric: ${value}`);
    const intDigits = match[2].replace(/^0+(?=\d)/, "");
    const fraction = match[3] || "";
    const decimals = typeof info?.decimalPositions === "number" ? info.decimalPositions : undefined;
    const totalDigits = typeof info?.length === "number" ? info.length : undefined;
    if (decimals !== undefined && fraction.replace(/0+$/, "").length > decimals) {
      throw new Error(`Value has more than ${decimals} decimal positions`);
    }
    if (totalDigits !== undefined && decimals !== undefined && intDigits.replace(/^0+/, "").length > totalDigits - decimals) {
      throw new Error(`Value does not fit a *DEC ${totalDigits} ${decimals} data area`);
    }
    const formatted = `${match[1] === "-" ? "-" : ""}${intDigits || "0"}${fraction ? `.${fraction}` : ""}`;
    return `CHGDTAARA DTAARA(${target}) VALUE(${formatted})`;
  }
  if (type === "*LGL") {
    if (substringRequested) throw new Error("startPosition and length are only valid for *CHAR data areas");
    const normalized = value.trim().toLowerCase();
    const logical = ["1", "true", "*on", "on", "yes"].includes(normalized)
      ? "1"
      : ["0", "false", "*off", "off", "no"].includes(normalized) ? "0" : undefined;
    if (!logical) throw new Error(`Value for *LGL data area must be 0 or 1: ${value}`);
    return `CHGDTAARA DTAARA(${target}) VALUE('${logical}')`;
  }
  const startPosition = clampNumber(args?.startPosition, 1, 1, 2000);
  const length = clampNumber(args?.length, Math.max(value.length, 1), 1, 2000);
  if (typeof info?.length === "number" && info.length > 0 && startPosition + length - 1 > info.length) {
    throw new Error(`Positions ${startPosition} to ${startPosition + length - 1} are outside the ${info.length}-character data area`);
  }
  return `CHGDTAARA DTAARA(${target} (${startPosition} ${length})) VALUE(${quoteClString(value)})`;
}

function getConnectionName(ctx: McpContext, args: any): string {
  const name = args?.connectionName || ctx.activeName;
  if (!name) throw new Error("connectionName is required (no active connection)");
  return name;
}

export function requireQsysName(conn: any, value: unknown, label: string) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) throw new Error(`${label} is required`);
  if (!conn.validQsysName(raw)) throw new Error(`Invalid ${label}: ${raw}`);
  return raw;
}

function requireJobName(value: unknown) {
  const jobName = String(value || "").trim().toUpperCase();
  if (!jobName) throw new Error("jobName is required");
  if (!/^[A-Z0-9#@$*._-]+\/[A-Z0-9#@$*._-]+\/[A-Z0-9#@$*._-]+$/.test(jobName)) {
    throw new Error(`Invalid jobName: ${value}`);
  }
  return jobName;
}

function requireQualifiedObject(value: unknown, label: string) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) throw new Error(`${label} is required`);
  const parts = raw.split("/");
  if (parts.length !== 2) {
    throw new Error(`Invalid ${label}: expected LIB/OBJECT format`);
  }
  return {
    library: requireIbmObjectName(parts[0], `${label} library`),
    object: requireIbmObjectName(parts[1], `${label} object`)
  };
}

function requireMessageKey(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("messageKey is required");
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

async function updateConnectionSettings(ctx: McpContext, name: string, update: Record<string, any>) {
  const conn = await ctx.store.getConnection(name);
  if (!conn) throw new Error(`Connection ${name} not found`);
  conn.settings = { ...(conn.settings || {}), ...stripUndefined(update) };
  await ctx.store.upsertConnection(conn);
  try {
    const active = await ctx.ensureActive(name);
    active.setConfig({ ...active.getConfig(), ...conn.settings });
  } catch {
    // No active session for this connection.
  }
}

async function applyLibraryList(conn: any, libraryList?: string[], currentLibrary?: string) {
  if (libraryList && libraryList.length > 0) {
    const normalized = libraryList.map((l: string) => String(l).toUpperCase());
    const invalid = normalized.find((l: string) => !conn.validQsysName(l));
    if (invalid) throw new Error(`Invalid library name: ${invalid}`);
    // '$' is escaped so names like $LIB are not expanded by qsh.
    const libs = normalized.join(" ").replace(/\$/g, "\\$");
    requireCommandSuccess(await conn.sendQsh({ command: `system \"CHGLIBL LIBL(${libs})\"` }), "CHGLIBL");
  }
  if (currentLibrary) {
    const lib = String(currentLibrary).toUpperCase();
    if (!conn.validQsysName(lib)) throw new Error(`Invalid current library: ${lib}`);
    requireCommandSuccess(await conn.sendQsh({ command: `system \"CHGCURLIB ${lib.replace(/\$/g, "\\$")}\"` }), "CHGCURLIB");
  }
}

function stripUndefined(obj: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

type DeployFileMeta = {
  path: string;
  size?: number;
};

type DeployDiffEntry = {
  path: string;
  localSize?: number;
  remoteSize?: number;
  reason: "size_mismatch" | "unknown_size";
};

type DeployComparison = {
  localRoot: string;
  remoteRoot: string;
  onlyLocal: string[];
  onlyRemote: string[];
  identical: string[];
  changed: DeployDiffEntry[];
  unresolved: DeployDiffEntry[];
  summary: {
    localFiles: number;
    remoteFiles: number;
    onlyLocal: number;
    onlyRemote: number;
    identical: number;
    changed: number;
    unresolved: number;
  };
};

async function compareDeployTrees(conn: any, localRoot: string, remoteRoot: string): Promise<DeployComparison> {
  const local = await listLocalFiles(localRoot);
  const remote = await listRemoteFiles(conn, remoteRoot);

  const onlyLocal: string[] = [];
  const onlyRemote: string[] = [];
  const identical: string[] = [];
  const changed: DeployDiffEntry[] = [];
  const unresolved: DeployDiffEntry[] = [];

  const localKeys = new Set(local.keys());
  const remoteKeys = new Set(remote.keys());

  for (const rel of localKeys) {
    if (!remoteKeys.has(rel)) {
      onlyLocal.push(rel);
      continue;
    }
    const l = local.get(rel)!;
    const r = remote.get(rel)!;
    if (typeof l.size === "number" && typeof r.size === "number") {
      if (l.size === r.size) {
        identical.push(rel);
      } else {
        changed.push({ path: rel, localSize: l.size, remoteSize: r.size, reason: "size_mismatch" });
      }
    } else {
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

async function listLocalFiles(root: string): Promise<Map<string, DeployFileMeta>> {
  const resolvedRoot = path.resolve(root);
  const results = new Map<string, DeployFileMeta>();
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(resolvedRoot, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const stat = await fs.stat(full);
        results.set(rel, { path: rel, size: stat.size });
      }
    }
  }
  await walk(resolvedRoot);
  return results;
}

async function listRemoteFiles(conn: any, remoteRoot: string): Promise<Map<string, DeployFileMeta>> {
  const normalizedRoot = remoteRoot.replace(/\/$/, "");
  const find = conn.remoteFeatures.find || "/QOpenSys/pkgs/bin/find";
  const stat = conn.remoteFeatures.stat;

  if (stat) {
    const statCmd = `${find} ${Tools.escapePath(normalizedRoot)} -type f -exec ${stat} -c '%n|%s' {} \\;`;
    const statRes = await conn.sendCommand({ command: statCmd });
    if (statRes.code === 0) {
      const mapped = parseRemoteStatLines(statRes.stdout || "", normalizedRoot);
      if (mapped.size > 0) return mapped;
    }
  }

  const res = await conn.sendCommand({ command: `${find} ${Tools.escapePath(normalizedRoot)} -type f -print` });
  if (res.code !== 0) {
    throw new Error(res.stderr || `Failed to list remote files under ${normalizedRoot}`);
  }
  const mapped = new Map<string, DeployFileMeta>();
  const lines = String(res.stdout || "").split("\n").map((l: string) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const rel = toRelativeRemotePath(line, normalizedRoot);
    mapped.set(rel, { path: rel });
  }
  return mapped;
}

function parseRemoteStatLines(output: string, remoteRoot: string) {
  const mapped = new Map<string, DeployFileMeta>();
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    const split = line.lastIndexOf("|");
    if (split < 0) continue;
    const absolute = line.substring(0, split);
    const sizeText = line.substring(split + 1);
    const size = Number(sizeText);
    const rel = toRelativeRemotePath(absolute, remoteRoot);
    mapped.set(rel, { path: rel, size: Number.isFinite(size) ? size : undefined });
  }
  return mapped;
}

function toRelativeRemotePath(absolutePath: string, remoteRoot: string) {
  const trimmedRoot = remoteRoot.replace(/\/$/, "");
  const normalizedPath = absolutePath.replace(/\\/g, "/");
  if (normalizedPath === trimmedRoot) return "";
  if (normalizedPath.startsWith(`${trimmedRoot}/`)) {
    return normalizedPath.substring(trimmedRoot.length + 1);
  }
  return normalizedPath.replace(/^[\\/]/, "");
}

function joinRemotePath(root: string, rel: string) {
  const base = root.replace(/\/$/, "");
  return `${base}/${rel}`.replace(/\\/g, "/");
}

export function mapActionExecution(action: Action, targetType: string, targetPath: string, result: any) {
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

function normalizeCommandDiagnostics(result: any) {
  const stdout = String(result?.stdout || "");
  const stderr = String(result?.stderr || "");
  const diagnostics = [
    ...extractDiagnostics(stdout, "stdout"),
    ...extractDiagnostics(stderr, "stderr")
  ];
  return diagnostics.slice(0, 500);
}

function extractDiagnostics(text: string, stream: "stdout" | "stderr") {
  const diagnostics: Array<{ stream: "stdout" | "stderr"; severity: "INFO" | "WARN" | "ERROR"; code?: string; message: string }> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
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

function inferSeverity(line: string): "INFO" | "WARN" | "ERROR" {
  const text = line.toUpperCase();
  if (/(ERROR|FAILED|EXCEPTION|SEV\s*[4-9]|SEVERITY\s*[4-9])/.test(text)) return "ERROR";
  if (/(WARN|WARNING|SEV\s*[1-3]|SEVERITY\s*[1-3])/.test(text)) return "WARN";
  return "INFO";
}

function normalizeJoblogRow(row: Record<string, unknown>) {
  return {
    ...row,
    source: "joblog",
    id: String(row.MESSAGE_ID || ""),
    text: String(row.MESSAGE_TEXT || ""),
    severity: Number.isFinite(Number(row.SEVERITY)) ? Number(row.SEVERITY) : null,
    timestamp: row.MESSAGE_TIMESTAMP ? String(row.MESSAGE_TIMESTAMP) : undefined
  };
}

export function normalizeSpoolEntry(row: Record<string, unknown>) {
  return {
    ...row,
    source: "spool",
    jobName: toNullableString(pickFirst(row, ["JOB_NAME", "JOB"])) || "",
    spooledFileName: toNullableString(pickFirst(row, ["SPOOLED_FILE_NAME", "SPOOLED_FILE", "SPLF_NAME"])) || "",
    spooledFileNumber: toNullableNumber(pickFirst(row, ["SPOOLED_FILE_NUMBER", "SPLF_NUMBER", "FILE_NUMBER"])),
    outputQueue: toNullableString(pickFirst(row, ["OUTPUT_QUEUE_NAME", "OUTQ_NAME", "OUTPUT_QUEUE"])) || "",
    outputQueueLibrary: toNullableString(pickFirst(row, ["OUTPUT_QUEUE_LIBRARY_NAME", "OUTPUT_QUEUE_LIBRARY"])) || "",
    userName: toNullableString(pickFirst(row, ["USER_NAME", "JOB_USER"])) || "",
    createdAt: toNullableString(pickFirst(row, ["CREATE_TIMESTAMP", "CREATION_TIMESTAMP"])),
    totalPages: toNullableNumber(pickFirst(row, ["TOTAL_PAGES", "PAGES"])),
    status: toNullableString(pickFirst(row, ["FILE_STATUS", "STATUS"])) || ""
  };
}

export function normalizeSpoolLine(row: Record<string, unknown>) {
  const position = pickFirst(row, ["ORDINAL_POSITION", "LINE_NUMBER"]);
  return {
    ...row,
    source: "spool",
    lineNumber: Number.isFinite(Number(position)) && position !== null && position !== "" ? Number(position) : null,
    text: String(row.SPOOLED_DATA ?? "")
  };
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function getSqlStatementType(sql: string) {
  return parseSqlStatementType(sql);
}

function getRowColumns(rows: any[]) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return Object.keys(rows[0] || {});
}

function inferAffectedRows(rows: any[]) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
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
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toSafeSqlError(err: any, sql: string, timeoutMs: number) {
  const message = err?.message || String(err);
  const lower = String(message).toLowerCase();
  let type: "sql_error" | "timeout" | "connection_error" | "policy_error" | "unknown_error" = "unknown_error";
  if (lower.includes("timed out")) type = "timeout";
  else if (lower.includes("blocked by policy")) type = "policy_error";
  else if (lower.includes("transport closed") || lower.includes("not connected") || lower.includes("socket")) type = "connection_error";
  else if (err?.name === "SqlError" || /sql\d{4}/i.test(message) || /sqlstate/i.test(message)) type = "sql_error";

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

function isReadOnlySql(sql: string) {
  return checkReadOnlySql(sql).readOnly;
}

export function enforceWritable(ctx: McpContext, conn: any, operation: string, args: any) {
  if (conn.getConfig().readOnlyMode) throw new Error("Connection is in read-only mode");
  enforcePolicyOperation(ctx, operation, args);
}

function enforcePolicyOperation(ctx: McpContext, operation: string, args: any) {
  const policy = ctx.getPolicy(args?.connectionName);
  if (policy.profile === "read-only") {
    throw new Error(`Blocked by policy (${policy.profile}): ${operation}`);
  }
  const deniedReason = isDeniedByPolicy(policy, operation, args);
  if (deniedReason) {
    throw new Error(`Blocked by policy: ${operation} (${deniedReason})`);
  }
  if (requiresApproval(policy, operation) && !Boolean(args?.approve)) {
    throw new Error(`Operation '${operation}' requires approve=true under '${policy.profile}' policy.`);
  }
}

function isMissingColumnError(err: any, column: string) {
  const message = String(err?.message || err || "").toUpperCase();
  return message.includes("42703") && message.includes(column.toUpperCase());
}

function requireIfsPath(value: unknown, label: string) {
  const pathValue = String(value || "").trim();
  if (!pathValue.startsWith("/")) {
    throw new Error(`Invalid ${label}: must be an absolute IFS path`);
  }
  if (pathValue.includes("\n") || pathValue.includes("\r")) {
    throw new Error(`Invalid ${label}: multiline path is not allowed`);
  }
  return pathValue;
}

function requireIfsJournalObjectType(value: unknown) {
  const objectType = String(value || "*STMF").trim().toUpperCase();
  if (objectType !== "*STMF" && objectType !== "*DIR") {
    throw new Error("objectType must be *STMF or *DIR");
  }
  return objectType;
}

function quoteClString(value: string) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function requireIbmObjectName(value: unknown, label: string) {
  const name = String(value || "").trim().toUpperCase();
  if (!/^[A-Z#@$][A-Z0-9#@$]{0,9}$/.test(name)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return name;
}

function requireJournalCode(value: unknown) {
  const code = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{1,4}$/.test(code)) {
    throw new Error(`Invalid journalCode: ${value}`);
  }
  return code;
}

function requireJournalEntryType(value: unknown) {
  const entryType = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(entryType)) {
    throw new Error(`Invalid entryType: ${value}`);
  }
  return entryType;
}

type JournalRetentionPlanOptions = {
  journalLibrary: string;
  journal: string;
  retentionDays: number;
};

async function planJournalReceiverRetention(conn: any, options: JournalRetentionPlanOptions) {
  const rows = await queryJournalReceiverInfo(conn, options.journalLibrary, options.journal);
  const cutoff = Date.now() - options.retentionDays * 24 * 60 * 60 * 1000;
  const candidates = rows
    .filter((row: {
      receiverLibrary: string | null;
      receiver: string | null;
      attachTimestamp: string | null;
      detachTimestamp: string | null;
    }) => {
      if (!row.receiverLibrary || !row.receiver) return false;
      if (!row.detachTimestamp) return false;
      const detachMs = Date.parse(row.detachTimestamp);
      return Number.isFinite(detachMs) && detachMs <= cutoff;
    })
    .map((row: {
      receiverLibrary: string | null;
      receiver: string | null;
      attachTimestamp: string | null;
      detachTimestamp: string | null;
    }) => ({
      receiverLibrary: row.receiverLibrary!,
      receiver: row.receiver!,
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

async function queryJournalReceiverInfo(conn: any, journalLibrary: string, journal: string) {
  try {
    const rows = await conn.runSQL(
      `select * from table(qsys2.journal_receiver_info(journal_name => ${Tools.sqlString(journal)}, journal_library => ${Tools.sqlString(journalLibrary)}))`
    );
    return rows.map(normalizeJournalReceiverInfoRow);
  } catch {
    const rows = await conn.runSQL(
      `select * from qsys2.journal_receiver_info where upper(journal_name)=${Tools.sqlString(journal)} and upper(journal_library)=${Tools.sqlString(journalLibrary)}`
    );
    return rows.map(normalizeJournalReceiverInfoRow);
  }
}

function normalizeJournalReceiverInfoRow(row: Record<string, unknown>) {
  return {
    receiverLibrary: toNullableString(pickFirst(row, ["JOURNAL_RECEIVER_LIBRARY", "RECEIVER_LIBRARY", "JRNRCV_LIBRARY"])),
    receiver: toNullableString(pickFirst(row, ["JOURNAL_RECEIVER", "JOURNAL_RECEIVER_NAME", "RECEIVER_NAME", "JRNRCV_NAME"])),
    attachTimestamp: toNullableString(pickFirst(row, ["ATTACH_TIMESTAMP", "ATTACHED_TIMESTAMP"])),
    detachTimestamp: toNullableString(pickFirst(row, ["DETACH_TIMESTAMP", "DETACHED_TIMESTAMP"]))
  };
}

type ComplianceReportOptions = {
  preset: string;
  sinceTimestamp?: string;
  auditLimit: number;
  qaudLimit: number;
  includeRaw: boolean;
};

async function buildComplianceReport(conn: any, options: ComplianceReportOptions) {
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
  } as Record<string, unknown>;

  if (options.includeRaw) {
    report["raw"] = {
      auditRecords: audit.records,
      qaudjrnEvents: qaudRows
    };
  }
  return report;
}

function normalizeCompliancePreset(value: string) {
  const preset = String(value || "phase6_baseline").trim().toLowerCase();
  if (preset === "phase6_baseline" || preset === "qaudjrn_daily" || preset === "journal_retention") {
    return preset;
  }
  throw new Error(`Unsupported compliance preset: ${value}`);
}

function summarizeByKey(rows: any[], key: string) {
  const summary: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row?.[key] || "UNKNOWN").trim() || "UNKNOWN";
    summary[value] = (summary[value] || 0) + 1;
  }
  return summary;
}

function summarizeQaudjrnEvents(events: Array<Record<string, unknown>>) {
  return {
    total: events.length,
    byCode: summarizeByKey(events, "journalCode"),
    byEntryType: summarizeByKey(events, "entryType"),
    byUser: summarizeByKey(events, "userName")
  };
}

function signEvidencePayload(payload: string, signingKey: string) {
  return crypto.createHmac("sha256", signingKey).update(payload).digest("hex");
}

function sha256Hex(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requiresApproval(policy: ConnectionPolicy, operation: string) {
  if (policy.profile !== "guarded") return false;
  const requires = policy.requireApprovalFor || [];
  return requires.includes(operation);
}

/** Returns the reason an operation is denied by the command policy, if any. */
function isDeniedByPolicy(policy: ConnectionPolicy, operation: string, args: any): string | undefined {
  if (operation === "cl.run" && args?.command) {
    const environment = String(args.environment || "ile");
    return environment === "ile"
      ? checkClCommand(policy, String(args.command))
      : checkShellCommand(policy, String(args.command));
  }
  if (typeof args?.sql === "string") {
    return checkSqlEmbeddedCl(policy, args.sql);
  }
  return undefined;
}

/** Library, IFS path and embedded-CL policy checks that apply to every tool. */
async function enforceResourcePolicy(ctx: McpContext, toolName: string, args: any) {
  const resolver = ctx as Partial<McpContext>;
  const policy = typeof resolver.resolvePolicy === "function"
    ? await resolver.resolvePolicy(args?.connectionName)
    : typeof resolver.getPolicy === "function" ? resolver.getPolicy(args?.connectionName) : undefined;
  if (!policy) return;
  const reason = checkResourcePolicy(policy, toolName, args);
  if (reason) {
    throw new Error(`Blocked by policy: ${toolName} (${reason})`);
  }
}

/** Check the policy against an action's expanded command before it runs. */
export function actionCommandGuard(ctx: McpContext, environment: string | undefined, args: any) {
  return async (expanded: string) => {
    const policy = ctx.getPolicy(args?.connectionName);
    const reason = (environment || "ile") === "ile"
      ? checkClCommands(policy, expanded)
      : checkShellCommand(policy, expanded);
    if (reason) throw new Error(`Blocked by policy: actions.run (${reason})`);
    return expanded;
  };
}

/** Resolve a local path and refuse it outside the allowed local roots. */
export async function guardLocalPath(ctx: McpContext, value: unknown, mode: LocalPathMode) {
  let settingsRoots: unknown;
  try {
    settingsRoots = ((await ctx.store.getSettings()) as any)?.allowedLocalRoots;
  } catch {
    settingsRoots = undefined;
  }
  return resolveAllowedLocalPath(value, mode, configuredLocalRoots(settingsRoots));
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

function withGuardedApprovalHint(tool: any) {
  if (!APPROVAL_HINT_TOOLS.has(tool.name)) return tool;
  const schema = tool.inputSchema || { type: "object", properties: {} };
  if (!schema.properties) schema.properties = {};
  if (!schema.properties.approve) {
    schema.properties.approve = {
      type: "boolean",
      description: "Set true to approve guarded-policy operations."
    };
  }
  return { ...tool, inputSchema: schema };
}

/** Tools outside the qsys/search/source families that also accept connectionName. */
const CONNECTION_NAME_TOOLS = new Set([
  "ibmi.find.ifs",
  "ibmi.actions.run",
  "ibmi.libl.validate",
  "ibmi.resolve.path",
  "ibmi.debug.status",
  "ibmi.journal.objects.list"
]);

function withSourceConnectionName(tool: any) {
  const accepts = /^ibmi\.(?:qsys|search|source|ifs|deploy)\./.test(tool.name) || CONNECTION_NAME_TOOLS.has(tool.name);
  if (!accepts) return tool;
  const schema = tool.inputSchema || { type: "object", properties: {} };
  if (!schema.properties) schema.properties = {};
  if (!schema.properties.connectionName) {
    schema.properties.connectionName = { type: "string", description: "Saved IBM i connection name." };
  }
  return { ...tool, inputSchema: schema };
}

function withStrictInputSchema(tool: any) {
  const schema = strictifySchema(tool.inputSchema || { type: "object", properties: {} });
  return { ...tool, inputSchema: schema };
}

function strictifySchema(schema: JsonSchema): JsonSchema {
  const next: JsonSchema = { ...schema };
  if (isObjectSchema(next) && typeof next.additionalProperties === "undefined") {
    next.additionalProperties = false;
  }
  if (next.properties) {
    const strictProps: Record<string, JsonSchema> = {};
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

function isObjectSchema(schema: JsonSchema) {
  if (!schema.type) return false;
  if (Array.isArray(schema.type)) return schema.type.includes("object");
  return schema.type === "object";
}

function resolveIfsWriteOperation(pathValue: unknown): string {
  const target = String(pathValue || "");
  if (/^\/qsys\.lib\//i.test(target)) {
    return "qsys.write";
  }
  return "ifs.write";
}
