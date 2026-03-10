export type ActionType = "member" | "streamfile" | "object" | "file";
export type ActionEnvironment = "ile" | "qsh" | "pase";

export interface StandardIO {
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
  stdin?: string;
}

export interface RemoteCommand {
  title?: string;
  command: string;
  environment?: ActionEnvironment;
  cwd?: string;
  env?: Record<string, string>;
  noLibList?: boolean;
}

export interface CommandData extends StandardIO {
  command: string;
  directory?: string;
  env?: Record<string, string>;
}

export interface CommandResult {
  code: number;
  signal?: string | null;
  stdout: string;
  stderr: string;
  command?: string;
}

export interface Action {
  name: string;
  command: string;
  type?: ActionType;
  environment: ActionEnvironment;
  extensions?: string[];
  deployFirst?: boolean;
  postDownload?: string[];
  runOnProtected?: boolean;
  outputToFile?: string;
}

export interface ConnectionData {
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  keepaliveInterval?: number;
  readyTimeout?: number;
  sshDebug?: boolean;
}

export interface ConnectionConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  readOnlyMode?: boolean;
  tempLibrary?: string;
  tempDir?: string;
  autoClearTempData?: boolean;
  sourceFileCCSID?: string;
  sqlJobCcsid?: string | number;
  enableSourceDates?: boolean;
  homeDirectory?: string;
  libraryList?: string[];
  currentLibrary?: string;
  customVariables?: { name: string; value: string }[];
  objectFilters?: ObjectFilter[];
  ifsShortcuts?: string[];
  debugPort?: number;
  debugSepPort?: number;
}

export interface ObjectFilter {
  name: string;
  library: string;
  object: string;
  types: string[];
  member: string;
  memberType?: string;
  protected?: boolean;
  filterType?: "simple" | "regex";
}

export interface QsysPath {
  asp?: string;
  library: string;
  name: string;
}

export interface IBMiObject extends QsysPath {
  type: string;
  text: string;
  sourceFile?: boolean;
  attribute?: string;
  sourceLength?: number;
  size?: number;
  created?: Date;
  changed?: Date;
}

export interface IBMiMember {
  library: string;
  file: string;
  name: string;
  extension: string;
  recordLength?: number;
  text?: string;
  asp?: string;
  lines?: number;
  created?: Date;
  changed?: Date;
}

export interface IFSFile {
  type: "directory" | "streamfile";
  name: string;
  path: string;
  size?: number;
  modified?: Date;
  owner?: string;
}

export type SearchResults = {
  term: string;
  hits: SearchHit[];
};

export type SearchHit = {
  path: string;
  lines: SearchHitLine[];
  readonly?: boolean;
  label?: string;
};

export type SearchHitLine = {
  number: number;
  content: string;
};
