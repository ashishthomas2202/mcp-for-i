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

  export async function searchMembers(connection: IBMiClient, library: string, sourceFile: string, searchTerm: string, members: string | Array<string | IBMiMember>, readOnly?: boolean): Promise<SearchResults> {
    return searchMembersTerms(connection, library, sourceFile, [searchTerm], members, readOnly);
  }

  export async function searchMembersTerms(
    connection: IBMiClient,
    library: string,
    sourceFile: string,
    searchTerms: string[],
    members: string | Array<string | IBMiMember>,
    readOnly?: boolean,
    options?: { caseSensitive?: boolean; before?: number; after?: number }
  ): Promise<SearchResults & { terms: string[] }> {
    const lib = String(library || "").trim().toUpperCase();
    const src = String(sourceFile || "").trim().toUpperCase();
    if (!connection.validQsysName(lib)) {
      throw new Error(`Invalid library: ${library}`);
    }
    if (!connection.validQsysName(src)) {
      throw new Error(`Invalid source file: ${sourceFile}`);
    }

    const terms = searchTerms.map(term => String(term || "")).filter(term => term.length > 0);
    if (terms.length < 1 || terms.length > 20) throw new Error("Provide between 1 and 20 search terms");
    if (terms.some(term => term.includes("\n") || term.includes("\r"))) throw new Error("Search terms may not contain newlines");

    let detailedMembers: IBMiMember[] | undefined;
    let memberFilter: string | undefined;

    const pfgrep = connection.remoteFeatures.pfgrep;
    if (typeof members === `string`) {
      if (!isSafeMemberToken(members)) {
        throw new Error(`Invalid members filter: ${members}`);
      }
      memberFilter = `${members}.MBR`;
    } else if (Array.isArray(members)) {
      const normalizedMembers = members.map(member => typeof member === "string"
        ? { library: lib, file: src, name: member, extension: "" }
        : member);
      if (members.length > 1000) {
        detailedMembers = normalizedMembers;
        memberFilter = "*.MBR";
      } else {
        normalizedMembers.forEach(member => {
          if (!isSafeMemberToken(member.name)) {
            throw new Error(`Invalid member name in filter: ${member.name}`);
          }
        });
        memberFilter = normalizedMembers.map(member => `${member.name}.MBR`).join(` `);
      }
    }

    const contextFlags = [
      options?.before ? `-B ${Math.max(0, Math.min(50, Math.floor(options.before)))}` : "",
      options?.after ? `-A ${Math.max(0, Math.min(50, Math.floor(options.after)))}` : ""
    ].filter(Boolean).join(" ");
    // Pass patterns over stdin for both single- and multi-term searches. This
    // avoids shell expansion and keeps the command shape constant.
    const flags = "-F -f -";
    const modeFlags = options?.caseSensitive ? "-nHr" : "-inHr";
    const command = pfgrep
      ? `${pfgrep} ${modeFlags} ${contextFlags} ${flags} ${memberFilter}`
      : `/usr/bin/grep ${options?.caseSensitive ? "-nHR" : "-inHR"} ${contextFlags} ${flags} ${memberFilter}`;

    const result: CommandResult = await connection.sendCommand({
      command,
      directory: `/QSYS.LIB/${lib}.LIB/${src}.FILE`,
      stdin: terms.join("\n")
    });

    if (!result.stderr) {
      let hits = parseGrepOutput(result.stdout || '', readOnly);

      if (detailedMembers) {
        hits = hits.filter(hit => {
          const hitMember = parseHitPath(hit);
          return detailedMembers!.some(member => member.name === hitMember.name && member.library === hitMember.library && member.file === hitMember.file);
        });
      }

      return { term: terms[0]!, terms, hits };
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
      if (line && line !== "--" && !line.startsWith(`Binary`)) {
        const parsed = /^(.*?)([:-])(\d+)\2(.*)$/.exec(line);
        if (!parsed) continue;
        const path = pathTransformer?.(parsed[1]) || parsed[1];
        let result = results.find(r => r.path === path);
        if (!result) {
          result = { path, lines: [], readonly };
          results.push(result);
        }
        result.lines.push({ number: Number(parsed[3]), content: parsed[4] });
      }
    }
    return results;
  }

  function isSafeMemberToken(name: string) {
    return /^[A-Za-z0-9_*#]+$/.test(name);
  }

}
