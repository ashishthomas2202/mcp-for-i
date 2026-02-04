import fs from "fs/promises";
import path from "path";
import os from "os";
import { Tools } from "./Tools.js";
import { IBMiClient } from "./client.js";
export class IBMiContent {
    ibmi;
    constructor(ibmi) {
        this.ibmi = ibmi;
    }
    get config() {
        return this.ibmi.getConfig();
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
        const rows = await this.ibmi.runSQL(`select OBJNAME, OBJTEXT from table(QSYS2.OBJECT_STATISTICS('${libFilter}', 'LIB', '*ALLSIMPLE'))`);
        return rows.map(r => ({
            library: String(r.OBJNAME),
            name: String(r.OBJNAME),
            type: "*LIB",
            text: String(r.OBJTEXT || "")
        }));
    }
    async getObjectList(library, types = ["*ALL"]) {
        const lib = this.ibmi.upperCaseName(library);
        const typesList = types.join(" ");
        const rows = await this.ibmi.runSQL(`select OBJNAME, OBJTYPE, OBJTEXT, OBJATTRIBUTE from table(QSYS2.OBJECT_STATISTICS('${lib}', '${typesList}', '*ALLSIMPLE'))`);
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
        const rows = await this.ibmi.runSQL(`select SYSTEM_TABLE_MEMBER, SOURCE_TYPE, PARTITION_TEXT from QSYS2.SYSPARTITIONSTAT where SYSTEM_TABLE_SCHEMA='${lib}' and SYSTEM_TABLE_NAME='${file}'`);
        return rows.map(r => ({
            library: lib,
            file,
            name: String(r.SYSTEM_TABLE_MEMBER),
            extension: String(r.SOURCE_TYPE || ""),
            text: String(r.PARTITION_TEXT || "")
        }));
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
