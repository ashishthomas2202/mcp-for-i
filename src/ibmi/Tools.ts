import path from "path";

export namespace Tools {
  export class SqlError extends Error {
    public sqlstate: string = "0";
    constructor(message: string) {
      super(message);
    }
  }

  export interface DB2Headers {
    name: string;
    from: number;
    length: number;
  }

  export interface DB2Row extends Record<string, string | number | null> {}

  export function db2Parse(output: string, input?: string): DB2Row[] {
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

    let headers: DB2Headers[] = [];
    let SQLSTATE = "";

    const rows: DB2Row[] = [];

    data.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 && iiErrorMessage) iiErrorMessage = false;
      if (trimmed.length === 0 || index === data.length - 1) return;

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

      if (iiErrorMessage) return;

      if (!gotHeaders) {
        headers = line.split(` `)
          .filter(header => header.length > 0)
          .map(header => ({ name: header, from: 0, length: 0 }));
        gotHeaders = true;
      } else if (!figuredLengths) {
        let base = 0;
        line.split(` `).forEach((header, idx) => {
          headers[idx].from = base;
          headers[idx].length = header.length;
          base += header.length + 1;
        });
        figuredLengths = true;
      } else {
        let row: DB2Row = {};
        let slideBytesBy = 0;

        headers.forEach(header => {
          const fromPos = header.from - slideBytesBy;
          let strValue = line.substring(fromPos, fromPos + header.length);
          const extendedBytes = strValue
            .split(``)
            .map(c => (Buffer.byteLength(c) < 3 || c.charCodeAt(0) === 65533) ? 0 : 1)
            .reduce<number>((a, b) => a + b, 0);
          slideBytesBy += extendedBytes;
          if (extendedBytes > 0) {
            strValue = strValue.substring(0, strValue.length - extendedBytes);
          }

          let realValue: string | number | null = strValue.trimEnd();
          if (realValue.startsWith(` `)) {
            const asNumber = Number(strValue.trim());
            if (!isNaN(asNumber)) realValue = asNumber;
          } else if (realValue === `-`) {
            realValue = null;
          }
          row[header.name] = realValue;
        });

        rows.push(row);
      }
    });

    return rows;
  }

  export function bufferToUx(input: string) {
    const hexString = Array.from(input)
      .map(char => char.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase())
      .join('');
    return `UX'${hexString}'`;
  }

  export function makeid(length: number = 8) {
    let text = `O_`;
    const possible = `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789`;
    for (let i = 0; i < length; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
    return text;
  }

  export function qualifyPath(library: string, object: string, member?: string, iasp?: string, noEscape?: boolean) {
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

  export function escapePath(Path: string, alreadyQuoted = false): string {
    if (alreadyQuoted) {
      return Path.replace(/"|\$|\\/g, matched => `\\`.concat(matched));
    } else {
      return Path.replace(/'|"|\$|&|\\| /g, matched => `\\`.concat(matched));
    }
  }

  export function shellQuote(value: string) {
    return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
  }

  export function sqlEscapeLiteral(value: string) {
    return String(value).replace(/'/g, "''");
  }

  export function sqlString(value: string) {
    return `'${sqlEscapeLiteral(value)}'`;
  }

  export function isSafeQshToken(value: string) {
    return /^[A-Za-z0-9_./*-]+$/.test(value);
  }

  export function sanitizeObjNamesForPase(libraries: string[]): string[] {
    return libraries.map(library => library.startsWith(`#`) ? `"${library}"` : library);
  }

  export function distinct<T>(value: T, index: number, array: T[]) {
    return array.indexOf(value) === index;
  }

  export function parseQSysPath(pathStr: string) {
    const parts = pathStr.split('/').filter(Boolean);
    if (parts.length > 3) {
      return { asp: parts[0], library: parts[1], name: parts[2] };
    }
    return { library: parts[0], name: parts[1] };
  }

  export function fixSQL(statement: string, removeComments = false): string {
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

  export function upperCaseName(value: string) {
    return value ? value.toUpperCase() : value;
  }

  export function pathJoinPosix(...parts: string[]) {
    return path.posix.join(...parts);
  }
}
