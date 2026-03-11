import fs from "fs/promises";
import path from "path";
import os from "os";
import { Tools } from "./Tools.js";
import { IBMiClient } from "./client.js";
import { SourceDateStore, makeAliasName } from "./sourceDates.js";
export class IBMiContent {
    ibmi;
    sourceDates = new SourceDateStore();
    constructor(ibmi) {
        this.ibmi = ibmi;
    }
    get config() {
        return this.ibmi.getConfig();
    }
    async getTempLibrary() {
        const desired = this.ibmi.upperCaseName(this.config.tempLibrary || "ILEDITOR");
        if (desired === "QTEMP")
            return "QTEMP";
        try {
            const rows = await this.ibmi.runSQL(`select SYSTEM_SCHEMA_NAME from QSYS2.SYSSCHEMAS where SYSTEM_SCHEMA_NAME=${Tools.sqlString(desired)}`);
            if (rows.length > 0)
                return desired;
        }
        catch {
            // ignore and fall back to QTEMP
        }
        if (!this.config.readOnlyMode) {
            try {
                await this.createLibrary(desired);
                return desired;
            }
            catch {
                // ignore
            }
        }
        return undefined;
    }
    async downloadStreamfileRaw(remotePath) {
        const tmpFile = await this.createTempFile();
        await this.ibmi.client.getFile(tmpFile, remotePath);
        return fs.readFile(tmpFile);
    }
    async writeStreamfileRaw(remotePath, content) {
        this.assertWritable();
        const tmpFile = await this.createTempFile();
        await fs.writeFile(tmpFile, content);
        return this.ibmi.client.putFile(tmpFile, remotePath);
    }
    async createStreamFile(remotePath) {
        this.assertWritable();
        return this.ibmi.sendCommand({ command: `touch ${Tools.escapePath(remotePath)}` });
    }
    async testStreamFile(remotePath, mode) {
        const flag = mode === "d" ? "-d" : mode === "w" ? "-w" : "-e";
        const res = await this.ibmi.sendCommand({ command: `test ${flag} ${Tools.escapePath(remotePath)} && echo 1 || echo 0` });
        return res.stdout.trim() === "1";
    }
    async getFileList(remotePath) {
        const ls = this.ibmi.remoteFeatures.ls || "ls";
        const res = await this.ibmi.sendCommand({ command: `${ls} -la ${Tools.escapePath(remotePath)}` });
        const lines = res.stdout.split("\n").filter(l => l.trim().length > 0);
        const files = [];
        for (const line of lines) {
            if (line.startsWith("total"))
                continue;
            const parts = line.split(/\s+/);
            if (parts.length < 9)
                continue;
            const typeChar = parts[0][0];
            const name = parts.slice(8).join(" ");
            if (name === "." || name === "..")
                continue;
            files.push({
                type: typeChar === "d" ? "directory" : "streamfile",
                name,
                path: path.posix.join(remotePath, name),
                size: Number(parts[4])
            });
        }
        return files;
    }
    async downloadMemberContent(library, sourceFile, member) {
        if (this.config.enableSourceDates) {
            const withDates = await this.downloadMemberContentWithDates(library, sourceFile, member);
            if (withDates !== undefined)
                return withDates;
        }
        const lib = this.ibmi.upperCaseName(library);
        const file = this.ibmi.upperCaseName(sourceFile);
        const mbr = this.ibmi.upperCaseName(member);
        const tempRemote = this.ibmi.getTempRemote("mbr");
        const ccsid = this.config.sourceFileCCSID || "*FILE";
        const cmd = `QSYS/CPYTOSTMF FROMMBR('${Tools.qualifyPath(lib, file, mbr, undefined, true)}') ` +
            `TOSTMF('${tempRemote}') STMFOPT(*REPLACE) STMFCCSID(1208) DBFCCSID(${ccsid})`;
        const result = await this.ibmi.sendQsh({ command: `system \"${IBMiClient.escapeForShell(cmd)}\"` });
        if (result.code !== 0)
            throw new Error(result.stderr || "CPYTOSTMF failed");
        const buffer = await this.downloadStreamfileRaw(tempRemote);
        await this.ibmi.sendCommand({ command: `rm -f ${Tools.escapePath(tempRemote)}` });
        return Buffer.from(buffer).toString("utf8");
    }
    async uploadMemberContent(library, sourceFile, member, content) {
        if (this.config.enableSourceDates) {
            try {
                await this.uploadMemberContentWithDates(library, sourceFile, member, content.toString());
                return;
            }
            catch {
                // Fall back to normal upload without source dates
            }
        }
        await this.uploadMemberContentRaw(library, sourceFile, member, content);
    }
    async uploadMemberContentRaw(library, sourceFile, member, content) {
        this.assertWritable();
        const lib = this.ibmi.upperCaseName(library);
        const file = this.ibmi.upperCaseName(sourceFile);
        const mbr = this.ibmi.upperCaseName(member);
        const tempRemote = this.ibmi.getTempRemote("mbr");
        await this.writeStreamfileRaw(tempRemote, content);
        const ccsid = this.config.sourceFileCCSID || "*FILE";
        const cmd = `QSYS/CPYFRMSTMF FROMSTMF('${tempRemote}') ` +
            `TOMBR('${Tools.qualifyPath(lib, file, mbr, undefined, true)}') MBROPT(*REPLACE) ` +
            `STMFCCSID(1208) DBFCCSID(${ccsid})`;
        const result = await this.ibmi.sendQsh({ command: `system \"${IBMiClient.escapeForShell(cmd)}\"` });
        if (result.code !== 0)
            throw new Error(result.stderr || "CPYFRMSTMF failed");
        await this.ibmi.sendCommand({ command: `rm -f ${Tools.escapePath(tempRemote)}` });
    }
    async getLibraries(filter = "*") {
        const libFilter = filter === "*" ? "*ALL" : filter;
        const rows = await this.ibmi.runSQL(`select OBJNAME, OBJTEXT from table(QSYS2.OBJECT_STATISTICS(${Tools.sqlString(libFilter)}, 'LIB', '*ALLSIMPLE'))`);
        return rows.map(r => ({
            library: String(r.OBJNAME),
            name: String(r.OBJNAME),
            type: "*LIB",
            text: String(r.OBJTEXT || "")
        }));
    }
    async getLibraryList(libraries) {
        const libs = libraries.map(l => this.ibmi.upperCaseName(l));
        if (libs.length === 0)
            return [];
        const inClause = libs.map(l => Tools.sqlString(l)).join(", ");
        const rows = await this.ibmi.runSQL(`select SYSTEM_SCHEMA_NAME, SCHEMA_TEXT from QSYS2.SYSSCHEMAS where SYSTEM_SCHEMA_NAME in (${inClause})`);
        const found = rows.map(r => ({
            library: "QSYS",
            name: String(r.SYSTEM_SCHEMA_NAME),
            type: "*LIB",
            text: String(r.SCHEMA_TEXT || "")
        }));
        return libs.map(library => {
            return found.find(f => f.name === library) || {
                library: "QSYS",
                name: library,
                type: "*LIB",
                text: "*** NOT FOUND ***"
            };
        });
    }
    async validateLibraryList(newLibl) {
        let badLibs = [];
        const libs = newLibl
            .map(l => this.ibmi.upperCaseName(l))
            .filter(l => {
            const ok = this.ibmi.validQsysName(l);
            if (!ok)
                badLibs.push(l);
            return ok;
        });
        if (libs.length === 0)
            return badLibs;
        const inClause = libs.map(l => Tools.sqlString(l)).join(", ");
        const rows = await this.ibmi.runSQL(`select SYSTEM_SCHEMA_NAME from QSYS2.SYSSCHEMAS where SYSTEM_SCHEMA_NAME in (${inClause})`);
        const existing = rows.map(r => String(r.SYSTEM_SCHEMA_NAME));
        libs.forEach(l => {
            if (!existing.includes(l))
                badLibs.push(l);
        });
        return badLibs;
    }
    async getObjectList(library, types = ["*ALL"]) {
        const lib = this.ibmi.upperCaseName(library);
        const safeTypes = types.map(t => this.ibmi.upperCaseName(t));
        const hasInvalidType = safeTypes.some(t => !/^[*A-Z0-9]+$/.test(t));
        if (hasInvalidType)
            throw new Error("Invalid object type filter");
        const typesList = safeTypes.join(" ");
        const rows = await this.ibmi.runSQL(`select OBJNAME, OBJTYPE, OBJTEXT, OBJATTRIBUTE from table(QSYS2.OBJECT_STATISTICS(${Tools.sqlString(lib)}, ${Tools.sqlString(typesList)}, '*ALLSIMPLE'))`);
        return rows.map(r => ({
            library: lib,
            name: String(r.OBJNAME),
            type: String(r.OBJTYPE),
            text: String(r.OBJTEXT || ""),
            attribute: String(r.OBJATTRIBUTE || "")
        }));
    }
    async getMemberList(options) {
        const lib = this.ibmi.upperCaseName(options.library);
        const file = this.ibmi.upperCaseName(options.sourceFile);
        const rows = await this.ibmi.runSQL(`select SYSTEM_TABLE_MEMBER, SOURCE_TYPE, PARTITION_TEXT from QSYS2.SYSPARTITIONSTAT where SYSTEM_TABLE_SCHEMA=${Tools.sqlString(lib)} and SYSTEM_TABLE_NAME=${Tools.sqlString(file)}`);
        return rows.map(r => ({
            library: lib,
            file,
            name: String(r.SYSTEM_TABLE_MEMBER),
            extension: String(r.SOURCE_TYPE || ""),
            text: String(r.PARTITION_TEXT || "")
        }));
    }
    async getMemberInfo(library, sourceFile, member) {
        const lib = this.ibmi.upperCaseName(library);
        const file = this.ibmi.upperCaseName(sourceFile);
        const mbr = this.ibmi.upperCaseName(member);
        const rows = await this.ibmi.runSQL(`select SYSTEM_TABLE_MEMBER, SOURCE_TYPE, PARTITION_TEXT from QSYS2.SYSPARTITIONSTAT where SYSTEM_TABLE_SCHEMA=${Tools.sqlString(lib)} and SYSTEM_TABLE_NAME=${Tools.sqlString(file)} and SYSTEM_TABLE_MEMBER=${Tools.sqlString(mbr)}`);
        const row = rows[0];
        if (!row)
            return undefined;
        return {
            library: lib,
            file,
            name: String(row.SYSTEM_TABLE_MEMBER),
            extension: String(row.SOURCE_TYPE || ""),
            text: String(row.PARTITION_TEXT || "")
        };
    }
    async downloadMemberContentWithDates(library, sourceFile, member) {
        const lib = this.ibmi.upperCaseName(library);
        const file = this.ibmi.upperCaseName(sourceFile);
        const mbr = this.ibmi.upperCaseName(member);
        const tempLib = await this.getTempLibrary();
        if (!tempLib)
            return undefined;
        const alias = makeAliasName(`${lib}/${file}/${mbr}`);
        const aliasPath = `${tempLib}.${alias}`;
        try {
            await this.ibmi.runSQL(`CREATE OR REPLACE ALIAS ${aliasPath} for \"${lib}\".\"${file}\"(\"${mbr}\")`);
        }
        catch {
            // ignore, alias might already exist
        }
        const recordLength = await this.getRecordLength(aliasPath, lib, file);
        const rows = await this.ibmi.runSQL(`select case when locate('40',hex(srcdat)) > 0 then 0 else srcdat end as SRCDAT, srcseq, srcdta from ${aliasPath}`);
        if (!rows || rows.length === 0) {
            return "";
        }
        const sourceDates = rows.map(row => String(row.SRCDAT).padStart(6, `0`));
        const body = rows.map(row => String(row.SRCDTA ?? "")).join(`\n`);
        this.sourceDates.setBase(`${lib}/${file}/${mbr}`, body, sourceDates, recordLength);
        return body;
    }
    async uploadMemberContentWithDates(library, sourceFile, member, body) {
        this.assertWritable();
        const lib = this.ibmi.upperCaseName(library);
        const file = this.ibmi.upperCaseName(sourceFile);
        const mbr = this.ibmi.upperCaseName(member);
        const tempLib = await this.getTempLibrary();
        if (!tempLib) {
            throw new Error(`Temp library is not available for source-date updates.`);
        }
        const alias = makeAliasName(`${lib}/${file}/${mbr}`);
        const aliasPath = `${tempLib}.${alias}`;
        const baseKey = `${lib}/${file}/${mbr}`;
        if (!this.sourceDates.getBaseSource(baseKey)) {
            await this.downloadMemberContentWithDates(lib, file, mbr);
        }
        const sourceDates = this.sourceDates.calcNewSourceDates(baseKey, body);
        const recordLength = this.sourceDates.getRecordLength(baseKey) || await this.getRecordLength(aliasPath, lib, file);
        const sourceData = body.split(`\n`);
        const decimalSequence = sourceData.length >= 10000;
        const rows = [];
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
        const statements = [
            `CREATE TABLE ${tempTable} LIKE \"${lib}\".\"${file}\";`
        ];
        const rowLength = recordLength + 55;
        const perInsert = Math.max(1, Math.floor(400000 / rowLength));
        for (let i = 0; i < rows.length; i += perInsert) {
            statements.push(`insert into ${tempTable} values ${rows.slice(i, i + perInsert).join(`,`)};`);
        }
        statements.push(`CALL QSYS2.QCMDEXC('CLRPFM FILE(${lib}/${file}) MBR(${mbr})');`, `insert into ${aliasPath} (select * from ${tempTable});`);
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
    async getRecordLength(aliasPath, lib, file) {
        let recordLength = 80;
        try {
            const res = await this.ibmi.runSQL(`select length(SRCDTA) as LENGTH from ${aliasPath} fetch first 1 rows only`);
            if (res.length > 0 && res[0].LENGTH) {
                recordLength = Number(res[0].LENGTH);
                return recordLength;
            }
        }
        catch { }
        try {
            const res = await this.ibmi.runSQL(`select row_length-12 as LENGTH from QSYS2.SYSTABLES where SYSTEM_TABLE_SCHEMA = ${Tools.sqlString(lib)} and SYSTEM_TABLE_NAME = ${Tools.sqlString(file)} fetch first 1 rows only`);
            if (res.length > 0 && res[0].LENGTH) {
                recordLength = Number(res[0].LENGTH);
            }
        }
        catch { }
        return recordLength;
    }
    async createLibrary(library) {
        this.assertWritable();
        const lib = this.ibmi.upperCaseName(library);
        return this.ibmi.sendQsh({ command: `system \"CRTLIB LIB(${lib})\"` });
    }
    async createSourceFile(library, file, rcdlen = 112) {
        this.assertWritable();
        const lib = this.ibmi.upperCaseName(library);
        const src = this.ibmi.upperCaseName(file);
        return this.ibmi.sendQsh({ command: `system \"CRTSRCPF FILE(${lib}/${src}) RCDLEN(${rcdlen})\"` });
    }
    async createMember(library, file, member, srctype) {
        this.assertWritable();
        const lib = this.ibmi.upperCaseName(library);
        const src = this.ibmi.upperCaseName(file);
        const mbr = this.ibmi.upperCaseName(member);
        const type = srctype ? this.ibmi.upperCaseName(srctype) : "*NONE";
        return this.ibmi.sendQsh({ command: `system \"ADDPFM FILE(${lib}/${src}) MBR(${mbr}) SRCTYPE(${type})\"` });
    }
    async renameMember(library, file, member, newMember) {
        this.assertWritable();
        const lib = this.ibmi.upperCaseName(library);
        const src = this.ibmi.upperCaseName(file);
        const mbr = this.ibmi.upperCaseName(member);
        const newMbr = this.ibmi.upperCaseName(newMember);
        return this.ibmi.sendQsh({ command: `system \"RNMM FILE(${lib}/${src}) MBR(${mbr}) NEWMBR(${newMbr})\"` });
    }
    async deleteMember(library, file, member) {
        this.assertWritable();
        const lib = this.ibmi.upperCaseName(library);
        const src = this.ibmi.upperCaseName(file);
        const mbr = this.ibmi.upperCaseName(member);
        return this.ibmi.sendQsh({ command: `system \"RMVM FILE(${lib}/${src}) MBR(${mbr})\"` });
    }
    async createTempFile() {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcpfori-"));
        return path.join(dir, "tmp");
    }
    assertWritable() {
        if (this.config.readOnlyMode) {
            throw new Error("Connection is in read-only mode");
        }
    }
}
function escapeString(val) {
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
