import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { Tools } from "./Tools.js";
import { IBMiClient } from "./client.js";
import { IBMiMember, IBMiObject, IFSFile } from "./types.js";
import { SourceDateStore, makeAliasName } from "./sourceDates.js";

export type MemberMetadata = IBMiMember & {
  rowCount?: number;
  lastChanged?: string;
  recordLength?: number;
};

export type MemberSnapshot = {
  identity: { library: string; sourceFile: string; member: string };
  content: string;
  lines: string[];
  metadata: MemberMetadata;
  sha256: string;
  version: string;
  observedAt: string;
  complete: true;
  transport: "sql-member" | "cpytostmf";
  warnings: string[];
  cacheStatus: "hit" | "miss" | "coalesced";
};

export type MemberListPage = {
  items: MemberMetadata[];
  returned: number;
  hasMore: boolean;
  nextCursor?: string;
  observedAt: string;
};

export class IBMiContent {
  private readonly sourceDates = new SourceDateStore();
  private readonly snapshotCache = new Map<string, { snapshot: MemberSnapshot; expiresAt: number }>();
  private readonly snapshotInflight = new Map<string, Promise<MemberSnapshot>>();
  private readonly snapshotLatestKey = new Map<string, string>();
  private readonly snapshotCacheTtlMs = 120_000;
  private readonly snapshotCacheMax = 32;

  constructor(private readonly ibmi: IBMiClient) {}

  private get config() {
    return this.ibmi.getConfig();
  }

  async downloadStreamfileRaw(remotePath: string): Promise<Uint8Array> {
    const tmpFile = await this.createTempFile();
    await this.ibmi.client!.getFile(tmpFile, remotePath);
    return fs.readFile(tmpFile);
  }

  async writeStreamfileRaw(remotePath: string, content: Uint8Array | string) {
    this.assertWritable();
    const tmpFile = await this.createTempFile();
    await fs.writeFile(tmpFile, content);
    return this.ibmi.client!.putFile(tmpFile, remotePath);
  }

  async createStreamFile(remotePath: string) {
    this.assertWritable();
    return this.ibmi.sendCommand({ command: `touch ${Tools.escapePath(remotePath)}` });
  }

  async testStreamFile(remotePath: string, mode: "e" | "w" | "d") {
    const flag = mode === "d" ? "-d" : mode === "w" ? "-w" : "-e";
    const res = await this.ibmi.sendCommand({ command: `test ${flag} ${Tools.escapePath(remotePath)} && echo 1 || echo 0` });
    return res.stdout.trim() === "1";
  }

  async getFileList(remotePath: string): Promise<IFSFile[]> {
    const ls = this.ibmi.remoteFeatures.ls || "ls";
    const res = await this.ibmi.sendCommand({ command: `${ls} -la ${Tools.escapePath(remotePath)}` });
    const lines = res.stdout.split("\n").filter(l => l.trim().length > 0);
    const files: IFSFile[] = [];
    for (const line of lines) {
      if (line.startsWith("total")) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;
      const typeChar = parts[0][0];
      const name = parts.slice(8).join(" ");
      if (name === "." || name === "..") continue;
      files.push({
        type: typeChar === "d" ? "directory" : "streamfile",
        name,
        path: path.posix.join(remotePath, name),
        size: Number(parts[4])
      });
    }
    return files;
  }

  async downloadMemberContent(library: string, sourceFile: string, member: string): Promise<string> {
    return (await this.downloadMemberContentDetailed(library, sourceFile, member)).content;
  }

  async downloadMemberContentDetailed(library: string, sourceFile: string, member: string): Promise<{
    content: string;
    transport: "sql-member" | "cpytostmf";
    warnings: string[];
  }> {
    if (this.config.enableSourceDates) {
      try {
        const lib = this.requireQsysName(library, "library");
        const file = this.requireQsysName(sourceFile, "sourceFile");
        const mbr = this.requireQsysName(member, "member");
        const snapshot = await this.loadMemberSnapshotViaSql(lib, file, mbr);
        return { content: snapshot.content, transport: "sql-member", warnings: [] };
      } catch (error: any) {
        const fallback = await this.downloadMemberContentViaStreamFile(library, sourceFile, member);
        return {
          content: fallback,
          transport: "cpytostmf",
          warnings: [`Source-date SQL read failed; used complete CPYTOSTMF fallback: ${error?.message || String(error)}`]
        };
      }
    }
    return {
      content: await this.downloadMemberContentViaStreamFile(library, sourceFile, member),
      transport: "cpytostmf",
      warnings: []
    };
  }

  private async downloadMemberContentViaStreamFile(library: string, sourceFile: string, member: string): Promise<string> {
    const lib = this.requireQsysName(library, "library");
    const file = this.requireQsysName(sourceFile, "sourceFile");
    const mbr = this.requireQsysName(member, "member");

    const tempRemote = this.ibmi.getTempRemote("mbr");
    const ccsid = this.normalizeSourceFileCcsid(this.config.sourceFileCCSID);
    const cmd = `QSYS/CPYTOSTMF FROMMBR('${Tools.qualifyPath(lib, file, mbr, undefined, true)}') ` +
      `TOSTMF('${tempRemote}') STMFOPT(*REPLACE) STMFCCSID(1208) DBFCCSID(${ccsid})`;

    try {
      const result = await this.ibmi.sendQsh({ command: `system \"${IBMiClient.escapeForShell(cmd)}\"` });
      if (result.code !== 0) throw new Error(result.stderr || "CPYTOSTMF failed");

      const buffer = await this.downloadStreamfileRaw(tempRemote);
      return Buffer.from(buffer).toString("utf8");
    } finally {
      await this.ibmi.sendCommand({ command: `rm -f ${Tools.escapePath(tempRemote)}` }).catch(() => {});
    }
  }

  async uploadMemberContent(library: string, sourceFile: string, member: string, content: Uint8Array | string) {
    if (this.config.enableSourceDates) {
      try {
        await this.uploadMemberContentWithDates(library, sourceFile, member, content.toString());
        this.invalidateMemberSnapshot(library, sourceFile, member);
        return;
      } catch {
        // Fall back to normal upload without source dates
      }
    }
    await this.uploadMemberContentRaw(library, sourceFile, member, content);
    this.invalidateMemberSnapshot(library, sourceFile, member);
  }

  private async uploadMemberContentRaw(library: string, sourceFile: string, member: string, content: Uint8Array | string) {
    this.assertWritable();
    const lib = this.requireQsysName(library, "library");
    const file = this.requireQsysName(sourceFile, "sourceFile");
    const mbr = this.requireQsysName(member, "member");

    const tempRemote = this.ibmi.getTempRemote("mbr");
    await this.writeStreamfileRaw(tempRemote, content);

    const ccsid = this.normalizeSourceFileCcsid(this.config.sourceFileCCSID);
    const cmd = `QSYS/CPYFRMSTMF FROMSTMF('${tempRemote}') ` +
      `TOMBR('${Tools.qualifyPath(lib, file, mbr, undefined, true)}') MBROPT(*REPLACE) ` +
      `STMFCCSID(1208) DBFCCSID(${ccsid})`;

    const result = await this.ibmi.sendQsh({ command: `system \"${IBMiClient.escapeForShell(cmd)}\"` });
    if (result.code !== 0) throw new Error(result.stderr || "CPYFRMSTMF failed");

    await this.ibmi.sendCommand({ command: `rm -f ${Tools.escapePath(tempRemote)}` });
  }

  async getLibraries(filter = "*"): Promise<IBMiObject[]> {
    const normalized = String(filter || "*").trim().toUpperCase() || "*";
    let sql: string;
    if (normalized === "*" || normalized === "*ALL") {
      sql = `select OBJNAME, OBJTEXT from table(QSYS2.OBJECT_STATISTICS('*ALL', 'LIB', '*ALLSIMPLE'))`;
    } else if (normalized.includes("*")) {
      // Generic filter such as DEV*: libraries are *LIB objects in QSYS, so list
      // those and match the name with LIKE.
      if (!/^[A-Z0-9#@$_.*]{1,11}$/.test(normalized)) throw new Error(`Invalid library filter: ${filter}`);
      const pattern = normalized.replace(/[!%_]/g, c => `!${c}`).replace(/\*/g, "%");
      sql = `select OBJNAME, OBJTEXT from table(QSYS2.OBJECT_STATISTICS('QSYS', '*LIB', '*ALLSIMPLE')) ` +
        `where OBJNAME like ${Tools.sqlString(pattern)} escape '!' order by OBJNAME`;
    } else {
      sql = `select OBJNAME, OBJTEXT from table(QSYS2.OBJECT_STATISTICS(${Tools.sqlString(normalized)}, 'LIB', '*ALLSIMPLE'))`;
    }
    const rows = await this.ibmi.runSQL(sql);
    return rows.map(r => ({
      library: String(r.OBJNAME),
      name: String(r.OBJNAME),
      type: "*LIB",
      text: String(r.OBJTEXT || "")
    }));
  }

  async getLibraryList(libraries: string[]): Promise<IBMiObject[]> {
    const libs = libraries.map(l => this.ibmi.upperCaseName(l));
    if (libs.length === 0) return [];

    const inClause = libs.map(l => Tools.sqlString(l)).join(", ");
    const rows = await this.ibmi.runSQL(
      `select SYSTEM_SCHEMA_NAME, SCHEMA_TEXT from QSYS2.SYSSCHEMAS where SYSTEM_SCHEMA_NAME in (${inClause})`
    );

    const found = rows.map(r => ({
      library: "QSYS",
      name: String(r.SYSTEM_SCHEMA_NAME),
      type: "*LIB",
      text: String(r.SCHEMA_TEXT || "")
    } as IBMiObject));

    return libs.map(library => {
      return found.find(f => f.name === library) || {
        library: "QSYS",
        name: library,
        type: "*LIB",
        text: "*** NOT FOUND ***"
      };
    });
  }

  async validateLibraryList(newLibl: string[]): Promise<string[]> {
    let badLibs: string[] = [];
    const libs = newLibl
      .map(l => this.ibmi.upperCaseName(l))
      .filter(l => {
        const ok = this.ibmi.validQsysName(l);
        if (!ok) badLibs.push(l);
        return ok;
      });

    if (libs.length === 0) return badLibs;

    const inClause = libs.map(l => Tools.sqlString(l)).join(", ");
    const rows = await this.ibmi.runSQL(
      `select SYSTEM_SCHEMA_NAME from QSYS2.SYSSCHEMAS where SYSTEM_SCHEMA_NAME in (${inClause})`
    );
    const existing = rows.map(r => String(r.SYSTEM_SCHEMA_NAME));

    libs.forEach(l => {
      if (!existing.includes(l)) badLibs.push(l);
    });

    return badLibs;
  }

  async getObjectList(library: string, types: string[] = ["*ALL"]): Promise<IBMiObject[]> {
    const lib = this.requireQsysName(library, "library");
    const safeTypes = types.map(t => this.ibmi.upperCaseName(t));
    const hasInvalidType = safeTypes.some(t => !/^[*A-Z0-9]+$/.test(t));
    if (hasInvalidType) throw new Error("Invalid object type filter");
    const typesList = safeTypes.join(" ");
    const rows = await this.ibmi.runSQL(
      `select OBJNAME, OBJTYPE, OBJTEXT, OBJATTRIBUTE from table(QSYS2.OBJECT_STATISTICS(${Tools.sqlString(lib)}, ${Tools.sqlString(typesList)}, '*ALLSIMPLE'))`
    );
    return rows.map(r => ({
      library: lib,
      name: String(r.OBJNAME),
      type: String(r.OBJTYPE),
      text: String(r.OBJTEXT || ""),
      attribute: String(r.OBJATTRIBUTE || "")
    }));
  }

  async getMemberList(options: { library: string; sourceFile: string }): Promise<IBMiMember[]> {
    const lib = this.requireQsysName(options.library, "library");
    const file = this.requireQsysName(options.sourceFile, "sourceFile");
    const rows = await this.ibmi.runSQL(
      `select SYSTEM_TABLE_MEMBER, SOURCE_TYPE, PARTITION_TEXT from QSYS2.SYSPARTITIONSTAT where SYSTEM_TABLE_SCHEMA=${Tools.sqlString(lib)} and SYSTEM_TABLE_NAME=${Tools.sqlString(file)}`
    );
    return rows.map(r => ({
      library: lib,
      file,
      name: String(r.SYSTEM_TABLE_MEMBER),
      extension: String(r.SOURCE_TYPE || ""),
      text: String(r.PARTITION_TEXT || "")
    }));
  }

  async getMemberListPage(options: {
    library: string;
    sourceFile: string;
    member?: string;
    memberPrefix?: string;
    memberContains?: string;
    sourceTypes?: string[];
    changedSince?: string;
    limit?: number;
    cursor?: string;
  }): Promise<MemberListPage> {
    const lib = this.requireQsysName(options.library, "library");
    const file = this.requireQsysName(options.sourceFile, "sourceFile");
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit || 50)));
    const conditions = [
      `P.SYSTEM_TABLE_SCHEMA=${Tools.sqlString(lib)}`,
      `P.SYSTEM_TABLE_NAME=${Tools.sqlString(file)}`,
      `P.SYSTEM_TABLE_MEMBER <> ''`
    ];
    if (options.member) {
      conditions.push(`P.SYSTEM_TABLE_MEMBER=${Tools.sqlString(this.requireQsysName(options.member, "member"))}`);
    }
    if (options.memberPrefix) {
      conditions.push(`P.SYSTEM_TABLE_MEMBER LIKE ${Tools.sqlString(`${this.normalizeSearchValue(options.memberPrefix)}%`)}`);
    }
    if (options.memberContains) {
      conditions.push(`P.SYSTEM_TABLE_MEMBER LIKE ${Tools.sqlString(`%${this.normalizeSearchValue(options.memberContains)}%`)}`);
    }
    if (options.sourceTypes?.length) {
      const sourceTypes = options.sourceTypes.map(value => this.normalizeSourceType(value));
      conditions.push(`P.SOURCE_TYPE IN (${sourceTypes.map(Tools.sqlString).join(", ")})`);
    }
    if (options.changedSince) {
      const changedSince = new Date(options.changedSince);
      if (Number.isNaN(changedSince.getTime())) throw new Error(`Invalid changedSince timestamp: ${options.changedSince}`);
      const sqlTimestamp = changedSince.toISOString().slice(0, 23).replace("T", " ");
      conditions.push(`P.LAST_SOURCE_UPDATE_TIMESTAMP >= timestamp(${Tools.sqlString(sqlTimestamp)})`);
    }
    if (options.cursor) {
      const cursor = this.decodeMemberCursor(options.cursor);
      conditions.push(`P.SYSTEM_TABLE_MEMBER > ${Tools.sqlString(cursor)}`);
    }

    const rows = await this.ibmi.runSQL(
      `select P.SYSTEM_TABLE_MEMBER, P.SOURCE_TYPE, P.PARTITION_TEXT, P.NUMBER_ROWS, ` +
      `P.LAST_SOURCE_UPDATE_TIMESTAMP, T.ROW_LENGTH from QSYS2.SYSPARTITIONSTAT P ` +
      `left join QSYS2.SYSTABLES T on T.SYSTEM_TABLE_SCHEMA=P.SYSTEM_TABLE_SCHEMA and T.SYSTEM_TABLE_NAME=P.SYSTEM_TABLE_NAME ` +
      `where ${conditions.join(" and ")} order by P.SYSTEM_TABLE_MEMBER fetch first ${limit + 1} rows only`
    );
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = selected.map(row => this.memberMetadataFromRow(lib, file, row));
    const last = items.at(-1);
    return {
      items,
      returned: items.length,
      hasMore,
      ...(hasMore && last ? { nextCursor: this.encodeMemberCursor(last.name) } : {}),
      observedAt: new Date().toISOString()
    };
  }

  async getMemberInfo(library: string, sourceFile: string, member: string): Promise<IBMiMember | undefined> {
    const lib = this.requireQsysName(library, "library");
    const file = this.requireQsysName(sourceFile, "sourceFile");
    const mbr = this.requireQsysName(member, "member");
    const rows = await this.ibmi.runSQL(
      `select SYSTEM_TABLE_MEMBER, SOURCE_TYPE, PARTITION_TEXT from QSYS2.SYSPARTITIONSTAT where SYSTEM_TABLE_SCHEMA=${Tools.sqlString(lib)} and SYSTEM_TABLE_NAME=${Tools.sqlString(file)} and SYSTEM_TABLE_MEMBER=${Tools.sqlString(mbr)}`
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      library: lib,
      file,
      name: String(row.SYSTEM_TABLE_MEMBER),
      extension: String(row.SOURCE_TYPE || ""),
      text: String(row.PARTITION_TEXT || "")
    };
  }

  async getMemberMetadata(library: string, sourceFile: string, member: string): Promise<MemberMetadata | undefined> {
    const lib = this.requireQsysName(library, "library");
    const file = this.requireQsysName(sourceFile, "sourceFile");
    const mbr = this.requireQsysName(member, "member");
    const rows = await this.ibmi.runSQL(
      `select P.SYSTEM_TABLE_MEMBER, P.SOURCE_TYPE, P.PARTITION_TEXT, P.NUMBER_ROWS, ` +
      `P.LAST_SOURCE_UPDATE_TIMESTAMP, T.ROW_LENGTH from QSYS2.SYSPARTITIONSTAT P ` +
      `left join QSYS2.SYSTABLES T on T.SYSTEM_TABLE_SCHEMA=P.SYSTEM_TABLE_SCHEMA and T.SYSTEM_TABLE_NAME=P.SYSTEM_TABLE_NAME ` +
      `where P.SYSTEM_TABLE_SCHEMA=${Tools.sqlString(lib)} and P.SYSTEM_TABLE_NAME=${Tools.sqlString(file)} ` +
      `and P.SYSTEM_TABLE_MEMBER=${Tools.sqlString(mbr)} fetch first 1 row only`
    );
    return rows[0] ? this.memberMetadataFromRow(lib, file, rows[0]) : undefined;
  }

  async resolveMembers(options: {
    library: string;
    member: string;
    candidateSourceFiles?: string[];
    sourceTypes?: string[];
    limit?: number;
  }): Promise<MemberMetadata[]> {
    const lib = this.requireQsysName(options.library, "library");
    const member = this.requireQsysName(options.member, "member");
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit || 20)));
    const conditions = [
      `P.SYSTEM_TABLE_SCHEMA=${Tools.sqlString(lib)}`,
      `P.SYSTEM_TABLE_MEMBER=${Tools.sqlString(member)}`
    ];
    if (options.candidateSourceFiles?.length) {
      const files = options.candidateSourceFiles.map(value => this.requireQsysName(value, "candidateSourceFile"));
      conditions.push(`P.SYSTEM_TABLE_NAME IN (${files.map(Tools.sqlString).join(", ")})`);
    }
    if (options.sourceTypes?.length) {
      const types = options.sourceTypes.map(value => this.normalizeSourceType(value));
      conditions.push(`P.SOURCE_TYPE IN (${types.map(Tools.sqlString).join(", ")})`);
    }
    const rows = await this.ibmi.runSQL(
      `select P.SYSTEM_TABLE_NAME, P.SYSTEM_TABLE_MEMBER, P.SOURCE_TYPE, P.PARTITION_TEXT, P.NUMBER_ROWS, ` +
      `P.LAST_SOURCE_UPDATE_TIMESTAMP, T.ROW_LENGTH from QSYS2.SYSPARTITIONSTAT P ` +
      `left join QSYS2.SYSTABLES T on T.SYSTEM_TABLE_SCHEMA=P.SYSTEM_TABLE_SCHEMA and T.SYSTEM_TABLE_NAME=P.SYSTEM_TABLE_NAME ` +
      `where ${conditions.join(" and ")} order by P.SYSTEM_TABLE_NAME fetch first ${limit + 1} rows only`
    );
    return rows.slice(0, limit).map(row => this.memberMetadataFromRow(lib, String(row.SYSTEM_TABLE_NAME || ""), row));
  }

  async getMemberSnapshot(library: string, sourceFile: string, member: string, forceFresh = false): Promise<MemberSnapshot> {
    const lib = this.requireQsysName(library, "library");
    const file = this.requireQsysName(sourceFile, "sourceFile");
    const mbr = this.requireQsysName(member, "member");
    const identityKey = `${lib}/${file}/${mbr}`;
    if (!forceFresh) {
      const latestKey = this.snapshotLatestKey.get(identityKey);
      const cached = latestKey ? this.snapshotCache.get(latestKey) : undefined;
      if (cached && cached.expiresAt > Date.now()) {
        this.snapshotCache.delete(latestKey!);
        this.snapshotCache.set(latestKey!, cached);
        return { ...cached.snapshot, cacheStatus: "hit" };
      }
      const inflight = this.snapshotInflight.get(identityKey);
      if (inflight) return { ...(await inflight), cacheStatus: "coalesced" };
    }
    const loading = this.loadMemberSnapshot(lib, file, mbr);
    this.snapshotInflight.set(identityKey, loading);
    try {
      const snapshot = await loading;
      const key = `${identityKey}/${snapshot.metadata.lastChanged || snapshot.version}`;
      this.snapshotCache.set(key, { snapshot, expiresAt: Date.now() + this.snapshotCacheTtlMs });
      this.snapshotLatestKey.set(identityKey, key);
      while (this.snapshotCache.size > this.snapshotCacheMax) {
        const oldest = this.snapshotCache.keys().next().value;
        if (!oldest) break;
        this.snapshotCache.delete(oldest);
      }
      return snapshot;
    } finally {
      this.snapshotInflight.delete(identityKey);
    }
  }

  invalidateMemberSnapshot(library: string, sourceFile: string, member: string) {
    const identityKey = `${String(library).toUpperCase()}/${String(sourceFile).toUpperCase()}/${String(member).toUpperCase()}`;
    const prefix = `${identityKey}/`;
    for (const key of this.snapshotCache.keys()) {
      if (key.startsWith(prefix)) this.snapshotCache.delete(key);
    }
    this.snapshotLatestKey.delete(identityKey);
  }

  async downloadMemberContentWithDates(library: string, sourceFile: string, member: string): Promise<string | undefined> {
    const lib = this.requireQsysName(library, "library");
    const file = this.requireQsysName(sourceFile, "sourceFile");
    const mbr = this.requireQsysName(member, "member");

    // Db2 for i requires an alias to address a non-default member. Keep the
    // alias in QTEMP and create/read it in the same QZDFMDB2 job so no
    // persistent ILEDITOR object or cross-job alias lookup is involved.
    const alias = makeAliasName(`${lib}/${file}/${mbr}`);
    const aliasPath = `QTEMP.\"${alias}\"`;
    const recordLength = await this.getRecordLength(undefined, lib, file);
    const rows = await this.ibmi.runSQL(
      `create alias ${aliasPath} for \"${lib}\".\"${file}\"(\"${mbr}\");\n` +
      `select case when locate('40',hex(srcdat)) > 0 then 0 else srcdat end as SRCDAT, srcseq, srcdta ` +
      `from ${aliasPath} as M order by rrn(M)`
    );

    if (!rows || rows.length === 0) {
      return "";
    }

    const sourceDates = rows.map(row => String(row.SRCDAT).padStart(6, `0`));
    const body = rows.map(row => String(row.SRCDTA ?? "")).join(`\n`);

    this.sourceDates.setBase(`${lib}/${file}/${mbr}`, body, sourceDates, recordLength);
    return body;
  }

  async uploadMemberContentWithDates(library: string, sourceFile: string, member: string, body: string) {
    this.assertWritable();
    const lib = this.requireQsysName(library, "library");
    const file = this.requireQsysName(sourceFile, "sourceFile");
    const mbr = this.requireQsysName(member, "member");

    const alias = makeAliasName(`${lib}/${file}/${mbr}`);
    const aliasPath = `QTEMP.\"${alias}\"`;

    const baseKey = `${lib}/${file}/${mbr}`;
    if (!this.sourceDates.getBaseSource(baseKey)) {
      await this.loadMemberSnapshotViaSql(lib, file, mbr);
    }

    const sourceDates = this.sourceDates.calcNewSourceDates(baseKey, body);
    const recordLength = this.sourceDates.getRecordLength(baseKey) || await this.getRecordLength(undefined, lib, file);

    const sourceData = body.split(`\n`);
    const decimalSequence = sourceData.length >= 10000;

    const rows: string[] = [];
    for (let i = 0; i < sourceData.length; i++) {
      const seq = decimalSequence ? ((i + 1) / 100) : (i + 1);
      let line = sourceData[i].trimEnd();
      if (line.length > recordLength) {
        line = line.substring(0, recordLength);
      }
      const date = sourceDates[i] ? sourceDates[i].padEnd(6, `0`) : `0`;
      rows.push(`(${seq}, ${date}, '${escapeString(line)}')`);
    }

    const tempTable = `QTEMP.NEWMEMBER`;
    const statements: string[] = [
      `CREATE ALIAS ${aliasPath} FOR \"${lib}\".\"${file}\"(\"${mbr}\");`,
      `CREATE TABLE ${tempTable} LIKE \"${lib}\".\"${file}\";`
    ];

    const rowLength = recordLength + 55;
    const perInsert = Math.max(1, Math.floor(400000 / rowLength));
    for (let i = 0; i < rows.length; i += perInsert) {
      statements.push(`insert into ${tempTable} values ${rows.slice(i, i + perInsert).join(`,`)};`);
    }

    statements.push(
      `CALL QSYS2.QCMDEXC('CLRPFM FILE(${lib}/${file}) MBR(${mbr})');`,
      `insert into ${aliasPath} (select * from ${tempTable});`
    );

    const tempRmt = this.ibmi.getTempRemote(`${lib}${file}${mbr}`);
    await this.writeStreamfileRaw(tempRmt, statements.join(`\n`));

    const setccsid = this.ibmi.remoteFeatures.setccsid;
    if (setccsid) {
      await this.ibmi.sendCommand({ command: `${setccsid} 1208 ${tempRmt}` });
    }

    const result = await this.ibmi.sendQsh({
      command: `system \"RUNSQLSTM SRCSTMF('${tempRmt}') COMMIT(*NONE) NAMING(*SQL)\"`
    });

    if (result.code !== 0) {
      throw new Error(`Failed to save member with source dates: ${result.stderr || result.stdout}`);
    }
  }

  private async getRecordLength(aliasPath: string | undefined, lib: string, file: string): Promise<number> {
    let recordLength = 80;
    if (aliasPath) {
      try {
        const res = await this.ibmi.runSQL(`select length(SRCDTA) as LENGTH from ${aliasPath} fetch first 1 rows only`);
        if (res.length > 0 && res[0].LENGTH) {
          recordLength = Number(res[0].LENGTH);
          return recordLength;
        }
      } catch {}
    }

    try {
      const res = await this.ibmi.runSQL(`select row_length-12 as LENGTH from QSYS2.SYSTABLES where SYSTEM_TABLE_SCHEMA = ${Tools.sqlString(lib)} and SYSTEM_TABLE_NAME = ${Tools.sqlString(file)} fetch first 1 rows only`);
      if (res.length > 0 && res[0].LENGTH) {
        recordLength = Number(res[0].LENGTH);
      }
    } catch {}
    return recordLength;
  }

  private async loadMemberSnapshot(lib: string, file: string, mbr: string): Promise<MemberSnapshot> {
    if (this.config.enableSourceDates) {
      try {
        return await this.loadMemberSnapshotViaSql(lib, file, mbr);
      } catch (error: any) {
        return this.loadMemberSnapshotViaStreamFile(lib, file, mbr, error);
      }
    }
    return this.loadMemberSnapshotViaStreamFile(lib, file, mbr);
  }

  private async loadMemberSnapshotViaSql(lib: string, file: string, mbr: string): Promise<MemberSnapshot> {
    const alias = makeAliasName(`${lib}/${file}/${mbr}`);
    const aliasPath = `QTEMP.\"${alias}\"`;
    const rows = await this.ibmi.runSQL(
      `create alias ${aliasPath} for \"${lib}\".\"${file}\"(\"${mbr}\");\n` +
      `select case when locate('40',hex(M.srcdat)) > 0 then 0 else M.srcdat end as SRCDAT, M.srcseq, M.srcdta, ` +
      `P.SYSTEM_TABLE_MEMBER, P.SOURCE_TYPE, P.PARTITION_TEXT, P.NUMBER_ROWS, P.LAST_SOURCE_UPDATE_TIMESTAMP, T.ROW_LENGTH ` +
      `from ${aliasPath} as M cross join QSYS2.SYSPARTITIONSTAT P ` +
      `left join QSYS2.SYSTABLES T on T.SYSTEM_TABLE_SCHEMA=P.SYSTEM_TABLE_SCHEMA and T.SYSTEM_TABLE_NAME=P.SYSTEM_TABLE_NAME ` +
      `where P.SYSTEM_TABLE_SCHEMA=${Tools.sqlString(lib)} and P.SYSTEM_TABLE_NAME=${Tools.sqlString(file)} ` +
      `and P.SYSTEM_TABLE_MEMBER=${Tools.sqlString(mbr)} order by rrn(M)`
    );
    let metadata: MemberMetadata;
    if (rows.length === 0) {
      const emptyMetadata = await this.getMemberMetadata(lib, file, mbr);
      if (!emptyMetadata) throw new Error(`${mbr} in ${lib}/${file} not found`);
      metadata = emptyMetadata;
    } else {
      metadata = this.memberMetadataFromRow(lib, file, rows[0]);
    }
    const sourceDates = rows.map(row => String(row.SRCDAT).padStart(6, "0"));
    const content = rows.map(row => String(row.SRCDTA ?? "")).join("\n");
    this.sourceDates.setBase(`${lib}/${file}/${mbr}`, content, sourceDates, metadata.recordLength || 80);
    return this.makeMemberSnapshot(lib, file, mbr, content, metadata, "sql-member", []);
  }

  private async loadMemberSnapshotViaStreamFile(lib: string, file: string, mbr: string, sqlError?: any): Promise<MemberSnapshot> {
    const metadataBefore = await this.getMemberMetadata(lib, file, mbr);
    if (!metadataBefore) throw new Error(`${mbr} in ${lib}/${file} not found`);
    const content = await this.downloadMemberContentViaStreamFile(lib, file, mbr);
    const metadataAfter = await this.getMemberMetadata(lib, file, mbr);
    if (!metadataAfter) throw new Error(`${mbr} in ${lib}/${file} was removed during read`);
    if (metadataBefore.lastChanged && metadataAfter.lastChanged && metadataBefore.lastChanged !== metadataAfter.lastChanged) {
      throw new Error(`Source changed during read: ${lib}/${file}(${mbr})`);
    }
    return this.makeMemberSnapshot(
      lib,
      file,
      mbr,
      content,
      metadataAfter,
      "cpytostmf",
      sqlError ? [`Source-date SQL read failed; used complete CPYTOSTMF fallback: ${sqlError?.message || String(sqlError)}`] : []
    );
  }

  private makeMemberSnapshot(
    lib: string,
    file: string,
    mbr: string,
    rawContent: string,
    metadata: MemberMetadata,
    transport: "sql-member" | "cpytostmf",
    warnings: string[]
  ): MemberSnapshot {
    const content = rawContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = content.split("\n");
    const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");
    const marker = metadata.lastChanged || "unknown";
    return {
      identity: { library: lib, sourceFile: file, member: mbr },
      content,
      lines,
      metadata,
      sha256,
      version: `${marker}:${sha256.slice(0, 16)}`,
      observedAt: new Date().toISOString(),
      complete: true,
      transport,
      warnings,
      cacheStatus: "miss"
    };
  }

  private memberMetadataFromRow(lib: string, file: string, row: Tools.DB2Row): MemberMetadata {
    const rowLength = Number(row.ROW_LENGTH || 0);
    return {
      library: lib,
      file: this.ibmi.upperCaseName(file),
      name: String(row.SYSTEM_TABLE_MEMBER || ""),
      extension: String(row.SOURCE_TYPE || ""),
      text: String(row.PARTITION_TEXT || ""),
      lines: Number(row.NUMBER_ROWS || 0),
      rowCount: Number(row.NUMBER_ROWS || 0),
      ...(row.LAST_SOURCE_UPDATE_TIMESTAMP ? { lastChanged: String(row.LAST_SOURCE_UPDATE_TIMESTAMP) } : {}),
      ...(rowLength > 0 ? { recordLength: Math.max(0, rowLength - 12) } : {})
    };
  }

  private normalizeSearchValue(value: string) {
    return String(value || "").trim().toUpperCase().replace(/[%_]/g, "");
  }

  private encodeMemberCursor(member: string) {
    return Buffer.from(JSON.stringify({ v: 1, member }), "utf8").toString("base64url");
  }

  private decodeMemberCursor(cursor: string) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (parsed?.v !== 1 || typeof parsed.member !== "string") throw new Error("bad cursor");
      return this.requireQsysName(parsed.member, "cursor member");
    } catch {
      throw new Error("Invalid member-list cursor");
    }
  }

  async createLibrary(library: string) {
    this.assertWritable();
    const lib = this.requireQsysName(library, "library");
    return this.runClViaQsh(`CRTLIB LIB(${lib})`, "CRTLIB");
  }

  async createSourceFile(library: string, file: string, rcdlen = 112) {
    this.assertWritable();
    const lib = this.requireQsysName(library, "library");
    const src = this.requireQsysName(file, "sourceFile");
    const length = Number(rcdlen);
    if (!Number.isInteger(length) || length < 13 || length > 32766) {
      throw new Error(`Invalid rcdlen: ${rcdlen}`);
    }
    return this.runClViaQsh(`CRTSRCPF FILE(${lib}/${src}) RCDLEN(${length})`, "CRTSRCPF");
  }

  async createMember(library: string, file: string, member: string, srctype?: string) {
    this.assertWritable();
    const lib = this.requireQsysName(library, "library");
    const src = this.requireQsysName(file, "sourceFile");
    const mbr = this.requireQsysName(member, "member");
    const type = this.normalizeSourceType(srctype);
    try {
      return await this.runClViaQsh(`ADDPFM FILE(${lib}/${src}) MBR(${mbr}) SRCTYPE(${type})`, "ADDPFM");
    } finally {
      this.invalidateMemberSnapshot(lib, src, mbr);
    }
  }

  async renameMember(library: string, file: string, member: string, newMember: string) {
    this.assertWritable();
    const lib = this.requireQsysName(library, "library");
    const src = this.requireQsysName(file, "sourceFile");
    const mbr = this.requireQsysName(member, "member");
    const newMbr = this.requireQsysName(newMember, "newMember");
    try {
      return await this.runClViaQsh(`RNMM FILE(${lib}/${src}) MBR(${mbr}) NEWMBR(${newMbr})`, "RNMM");
    } finally {
      this.invalidateMemberSnapshot(lib, src, mbr);
      this.invalidateMemberSnapshot(lib, src, newMbr);
    }
  }

  async deleteMember(library: string, file: string, member: string) {
    this.assertWritable();
    const lib = this.requireQsysName(library, "library");
    const src = this.requireQsysName(file, "sourceFile");
    const mbr = this.requireQsysName(member, "member");
    try {
      return await this.runClViaQsh(`RMVM FILE(${lib}/${src}) MBR(${mbr})`, "RMVM");
    } finally {
      this.invalidateMemberSnapshot(lib, src, mbr);
    }
  }

  // Runs a CL command through qsh's `system` utility and throws when it fails.
  // `system` exits non-zero when the command ends with an escape message.
  // '$' is escaped because names such as $ABC would otherwise be expanded by
  // the shell inside the double-quoted argument.
  private async runClViaQsh(command: string, label: string) {
    const result = await this.ibmi.sendQsh({ command: `system \"${IBMiClient.escapeForShell(command)}\"` });
    if (!result || result.code !== 0) {
      const detail = String(result?.stderr || result?.stdout || "").trim();
      throw new Error(`${label} failed (exit ${result?.code ?? "unknown"})${detail ? `: ${detail}` : ""}`);
    }
    return result;
  }

  private async createTempFile(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcpfori-"));
    return path.join(dir, "tmp");
  }

  private requireQsysName(value: string, label: string) {
    const normalized = this.ibmi.upperCaseName(String(value || "").trim());
    if (!normalized || !this.ibmi.validQsysName(normalized)) {
      throw new Error(`Invalid ${label}: ${value}`);
    }
    return normalized;
  }

  private normalizeSourceType(value?: string) {
    const normalized = this.ibmi.upperCaseName(String(value || "*NONE").trim());
    if (!/^\*?[A-Z0-9#@$._]{1,10}$/.test(normalized)) {
      throw new Error(`Invalid source type: ${value}`);
    }
    return normalized;
  }

  private normalizeSourceFileCcsid(value: unknown) {
    const normalized = String(value || "*FILE").trim().toUpperCase();
    if (/^\d{1,5}$/.test(normalized)) return normalized;
    if (/^\*[A-Z0-9]{2,10}$/.test(normalized)) return normalized;
    throw new Error(`Invalid sourceFileCCSID setting: ${value}`);
  }

  private assertWritable() {
    if (this.config.readOnlyMode) {
      throw new Error("Connection is in read-only mode");
    }
  }
}

function escapeString(val: string): string {
  return val.replace(/[\0\n\r\b\t'\x1a]/g, function (s) {
    switch (s) {
      case `\0`:
        return `\\0`;
      case `\n`:
        return `\\n`;
      case `\r`:
        return ``;
      case `\b`:
        return `\\b`;
      case `\x1a`:
        return `\\Z`;
      case `'`:
        return `''`;
      default:
        return `\\` + s;
    }
  });
}
