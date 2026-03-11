import { IBMiClient } from "./client.js";
import { Tools } from "./Tools.js";
import { IBMiMember, SearchHit, SearchResults, CommandResult } from "./types.js";

export namespace Search {
  function parseHitPath(hit: SearchHit): IBMiMember {
    const parts = hit.path.split('/');
    if (parts.length === 4) {
      parts.shift();
    }
    return {
      library: parts[0],
      file: parts[1],
      name: parts[2],
      extension: ''
    };
  }

  export async function searchMembers(connection: IBMiClient, library: string, sourceFile: string, searchTerm: string, members: string | IBMiMember[], readOnly?: boolean): Promise<SearchResults> {
    let detailedMembers: IBMiMember[] | undefined;
    let memberFilter: string | undefined;

    const pfgrep = connection.remoteFeatures.pfgrep;
    if (typeof members === `string`) {
      if (!isSafeMemberToken(members)) {
        throw new Error(`Invalid members filter: ${members}`);
      }
      memberFilter = `${members}.MBR`;
    } else if (Array.isArray(members)) {
      if (members.length > 1000) {
        detailedMembers = members;
        memberFilter = "*.MBR";
      } else {
        members.forEach(member => {
          if (!isSafeMemberToken(member.name)) {
            throw new Error(`Invalid member name in filter: ${member.name}`);
          }
        });
        memberFilter = members.map(member => `${member.name}.MBR`).join(` `);
      }
    }

    const command = pfgrep
      ? `${pfgrep} -inHr -F "${sanitizeSearchTerm(searchTerm)}" ${memberFilter}`
      : `/usr/bin/grep -inHR -F "${sanitizeSearchTerm(searchTerm)}" ${memberFilter}`;

    const result: CommandResult = await connection.sendCommand({
      command,
      directory: `/QSYS.LIB/${library}.LIB/${sourceFile}.FILE`
    });

    if (!result.stderr) {
      let hits = parseGrepOutput(result.stdout || '', readOnly);

      if (detailedMembers) {
        hits = hits.filter(hit => {
          const hitMember = parseHitPath(hit);
          return detailedMembers!.some(member => member.name === hitMember.name && member.library === hitMember.library && member.file === hitMember.file);
        });
      }

      return { term: searchTerm, hits };
    }

    throw new Error(result.stderr || "Search failed");
  }

  export async function searchIFS(connection: IBMiClient, path: string, searchTerm: string): Promise<SearchResults | undefined> {
    const grep = connection.remoteFeatures.grep;
    if (!grep) throw new Error("Grep must be installed on the remote system.");

    const grepRes = await connection.sendCommand({
      command: `${grep} -inr -F -f - ${Tools.escapePath(path)}`,
      stdin: searchTerm
    });

    if (grepRes.code === 0) {
      return { term: searchTerm, hits: parseGrepOutput(grepRes.stdout) };
    }
    // grep returns exit code 1 when no matches are found
    if (grepRes.code === 1 && !grepRes.stderr) {
      return { term: searchTerm, hits: [] };
    }
  }

  export async function findIFS(connection: IBMiClient, path: string, findTerm: string): Promise<SearchResults | undefined> {
    const find = connection.remoteFeatures.find;
    if (!find) throw new Error("Find must be installed on the remote system.");

    const findRes = await connection.sendCommand({
      command: `${find} ${Tools.escapePath(path)} -type f -iname ${Tools.shellQuote(`*${findTerm}*`)} -print`
    });

    if (findRes.code === 0) {
      if (findRes.stdout) {
        return { term: findTerm, hits: parseFindOutput(findRes.stdout) };
      }
      return { term: findTerm, hits: [] };
    }
  }

  function parseFindOutput(output: string, readonly?: boolean, pathTransformer?: (path: string) => string): SearchHit[] {
    const results: SearchHit[] = [];
    for (const line of output.split('\n')) {
      const path = pathTransformer?.(line) || line;
      results.push(results.find(r => r.path === path) || { path, readonly, lines: [] });
    }
    return results;
  }

  function parseGrepOutput(output: string, readonly?: boolean, pathTransformer?: (path: string) => string): SearchHit[] {
    const results: SearchHit[] = [];
    for (const line of output.split('\n')) {
      if (line && !line.startsWith(`Binary`)) {
        const parts = line.split(`:`);
        const path = pathTransformer?.(parts[0]) || parts[0];
        let result = results.find(r => r.path === path);
        if (!result) {
          result = { path, lines: [], readonly };
          results.push(result);
        }
        const contentIndex = nthIndex(line, `:`, 2);
        if (contentIndex >= 0) {
          const curContent = line.substring(contentIndex + 1);
          result.lines.push({ number: Number(parts[1]), content: curContent });
        }
      }
    }
    return results;
  }

  function sanitizeSearchTerm(searchTerm: string): string {
    return searchTerm.replace(/\\/g, `\\\\`).replace(/"/g, `\\"`);
  }

  function isSafeMemberToken(name: string) {
    return /^[A-Za-z0-9_*#]+$/.test(name);
  }

  function nthIndex(aString: string, pattern: string, n: number) {
    let index = -1;
    while (n-- && index++ < aString.length) {
      index = aString.indexOf(pattern, index);
      if (index < 0) break;
    }
    return index;
  }
}
