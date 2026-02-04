import path from "path";
export var Tools;
(function (Tools) {
    class SqlError extends Error {
        sqlstate = "0";
        constructor(message) {
            super(message);
        }
    }
    Tools.SqlError = SqlError;
    function db2Parse(output, input) {
        let gotHeaders = false;
        let figuredLengths = false;
        let iiErrorMessage = false;
        const data = output.split(`\n`).filter(line => {
            const trimmed = line.trim();
            return trimmed !== `DB2>` &&
                !trimmed.startsWith(`DB20`) &&
                !/COMMAND .+ COMPLETED WITH EXIT STATUS \d+/.test(trimmed) &&
                trimmed !== `?>`;
        });
        if (!data[data.length - 1]) {
            data.pop();
        }
        let headers = [];
        let SQLSTATE = "";
        const rows = [];
        data.forEach((line, index) => {
            const trimmed = line.trim();
            if (trimmed.length === 0 && iiErrorMessage)
                iiErrorMessage = false;
            if (trimmed.length === 0 || index === data.length - 1)
                return;
            if (trimmed === `**** CLI ERROR *****`) {
                iiErrorMessage = true;
                if (data.length > index + 3) {
                    SQLSTATE = data[index + 1].trim();
                    if (SQLSTATE.includes(`:`)) {
                        SQLSTATE = SQLSTATE.split(`:`)[1].trim();
                    }
                    if (!SQLSTATE.startsWith(`01`)) {
                        const errorMessage = data[index + 3] ? data[index + 3].trim() : `Unknown error`;
                        let sqlError = new SqlError(`${errorMessage} (${SQLSTATE})`);
                        sqlError.sqlstate = SQLSTATE;
                        sqlError.cause = input;
                        throw sqlError;
                    }
                }
                return;
            }
            if (iiErrorMessage)
                return;
            if (!gotHeaders) {
                headers = line.split(` `)
                    .filter(header => header.length > 0)
                    .map(header => ({ name: header, from: 0, length: 0 }));
                gotHeaders = true;
            }
            else if (!figuredLengths) {
                let base = 0;
                line.split(` `).forEach((header, idx) => {
                    headers[idx].from = base;
                    headers[idx].length = header.length;
                    base += header.length + 1;
                });
                figuredLengths = true;
            }
            else {
                let row = {};
                let slideBytesBy = 0;
                headers.forEach(header => {
                    const fromPos = header.from - slideBytesBy;
                    let strValue = line.substring(fromPos, fromPos + header.length);
                    const extendedBytes = strValue
                        .split(``)
                        .map(c => (Buffer.byteLength(c) < 3 || c.charCodeAt(0) === 65533) ? 0 : 1)
                        .reduce((a, b) => a + b, 0);
                    slideBytesBy += extendedBytes;
                    if (extendedBytes > 0) {
                        strValue = strValue.substring(0, strValue.length - extendedBytes);
                    }
                    let realValue = strValue.trimEnd();
                    if (realValue.startsWith(` `)) {
                        const asNumber = Number(strValue.trim());
                        if (!isNaN(asNumber))
                            realValue = asNumber;
                    }
                    else if (realValue === `-`) {
                        realValue = null;
                    }
                    row[header.name] = realValue;
                });
                rows.push(row);
            }
        });
        return rows;
    }
    Tools.db2Parse = db2Parse;
    function bufferToUx(input) {
        const hexString = Array.from(input)
            .map(char => char.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase())
            .join('');
        return `UX'${hexString}'`;
    }
    Tools.bufferToUx = bufferToUx;
    function makeid(length = 8) {
        let text = `O_`;
        const possible = `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789`;
        for (let i = 0; i < length; i++)
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        return text;
    }
    Tools.makeid = makeid;
    function qualifyPath(library, object, member, iasp, noEscape) {
        [library, object] = Tools.sanitizeObjNamesForPase([library, object]);
        member = member ? Tools.sanitizeObjNamesForPase([member])[0] : undefined;
        iasp = iasp ? Tools.sanitizeObjNamesForPase([iasp])[0] : undefined;
        const libraryPath = library === `QSYS` ? `QSYS.LIB` : `QSYS.LIB/${library}.LIB`;
        const filePath = object ? `${object}.FILE` : '';
        const memberPath = member ? `/${member}.MBR` : '';
        const fullPath = `${libraryPath}/${filePath}${memberPath}`;
        const result = (iasp && iasp.length > 0 ? `/${iasp}` : ``) + `/${noEscape ? fullPath : Tools.escapePath(fullPath)}`;
        return result;
    }
    Tools.qualifyPath = qualifyPath;
    function escapePath(Path, alreadyQuoted = false) {
        if (alreadyQuoted) {
            return Path.replace(/"|\$|\\/g, matched => `\\`.concat(matched));
        }
        else {
            return Path.replace(/'|"|\$|&|\\| /g, matched => `\\`.concat(matched));
        }
    }
    Tools.escapePath = escapePath;
    function sanitizeObjNamesForPase(libraries) {
        return libraries.map(library => library.startsWith(`#`) ? `"${library}"` : library);
    }
    Tools.sanitizeObjNamesForPase = sanitizeObjNamesForPase;
    function distinct(value, index, array) {
        return array.indexOf(value) === index;
    }
    Tools.distinct = distinct;
    function parseQSysPath(pathStr) {
        const parts = pathStr.split('/').filter(Boolean);
        if (parts.length > 3) {
            return { asp: parts[0], library: parts[1], name: parts[2] };
        }
        return { library: parts[0], name: parts[1] };
    }
    Tools.parseQSysPath = parseQSysPath;
    function fixSQL(statement, removeComments = false) {
        let statements = statement.split("\n").map(line => {
            if (line.startsWith('@')) {
                line = `Call QSYS2.QCMDEXC('${line.substring(1, line.endsWith(";") ? line.length - 1 : undefined).replaceAll("'", "''")}');`;
            }
            return line.replaceAll("--", "\n--");
        }).join(`\n`);
        if (removeComments) {
            statements = statements.split(`\n`).filter(l => !l.trim().startsWith(`--`)).join(`\n`);
        }
        return statements;
    }
    Tools.fixSQL = fixSQL;
    function upperCaseName(value) {
        return value ? value.toUpperCase() : value;
    }
    Tools.upperCaseName = upperCaseName;
    function pathJoinPosix(...parts) {
        return path.posix.join(...parts);
    }
    Tools.pathJoinPosix = pathJoinPosix;
})(Tools || (Tools = {}));
