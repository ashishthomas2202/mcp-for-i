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

  export const MEMBER_SEARCH_DEFAULT_MAX_MATCHES = 100;
  export const MEMBER_SEARCH_MAX_MATCHES = 1_000;

  export type MemberSearchResults = SearchResults & {
    terms: string[];
    matchCount: number;
    maxMatches: number;
    truncated: boolean;
    truncatedReason?: "max-matches" | "output-limit";
    warnings?: string[];
  };

  export async function searchMembersTerms(
    connection: IBMiClient,
    library: string,
    sourceFile: string,
    searchTerms: string[],
    members: string | Array<string | IBMiMember>,
    readOnly?: boolean,
    options?: { caseSensitive?: boolean; before?: number; after?: number; maxMatches?: number }
  ): Promise<MemberSearchResults> {
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
      memberFilter = memberGlobToken(members);
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
        memberFilter = normalizedMembers.map(member => memberGlobToken(member.name)).join(` `);
      }
    }

    const before = clampCount(options?.before, 0, 50, 0);
    const after = clampCount(options?.after, 0, 50, 0);
    const maxMatches = clampCount(options?.maxMatches, 1, MEMBER_SEARCH_MAX_MATCHES, MEMBER_SEARCH_DEFAULT_MAX_MATCHES);
    const contextFlags = [
      before ? `-B ${before}` : "",
      after ? `-A ${after}` : ""
    ].filter(Boolean).join(" ");
    // pfgrep documents -F (literal), -f - (patterns from stdin, one per line),
    // -m (matches per member), -A/-B (context), -n, -H, -i and -r, all with
    // grep semantics. Patterns go over stdin so terms never reach the shell.
    // -m stops each member early; one extra match per member reveals whether
    // the cap cut anything off. The total across members is bounded by head,
    // which ends the grep as soon as enough lines have been produced.
    const flags = `-F -m ${maxMatches + 1} -f -`;
    const modeFlags = options?.caseSensitive ? "-nHr" : "-inHr";
    const outputLineLimit = (maxMatches + 1) * (before + after + 2);
    const grep = connection.remoteFeatures.grep || "/usr/bin/grep";
    const searchCommand = pfgrep
      ? `${pfgrep} ${modeFlags} ${contextFlags} ${flags} ${memberFilter}`
      : `${grep} ${options?.caseSensitive ? "-nHR" : "-inHR"} ${contextFlags} ${flags} ${memberFilter}`;
    const command = `${searchCommand.replace(/\s+/g, " ")} | /QOpenSys/usr/bin/head -n ${outputLineLimit}`;

    const result: CommandResult = await connection.sendCommand({
      command,
      directory: `/QSYS.LIB/${lib}.LIB/${src}.FILE`,
      stdin: terms.join("\n")
    });

    const stdout = result.stdout || "";
    if (result.stderr && !stdout.trim()) {
      throw new Error(result.stderr || "Search failed");
    }

    const outputLines = stdout.split("\n").filter(line => line.length > 0);
    const parsed = parseMemberGrepOutput(stdout, maxMatches, readOnly);
    let hits = parsed.hits;

    if (detailedMembers) {
      hits = hits.filter(hit => {
        const hitMember = parseHitPath(hit);
        return detailedMembers!.some(member => member.name === hitMember.name && member.library === hitMember.library && member.file === hitMember.file);
      });
    }

    const outputLimited = outputLines.length >= outputLineLimit;
    const truncated = parsed.truncated || outputLimited;
    return {
      term: terms[0]!,
      terms,
      hits,
      matchCount: parsed.matchCount,
      maxMatches,
      truncated,
      ...(truncated ? { truncatedReason: parsed.truncated ? "max-matches" as const : "output-limit" as const } : {}),
      ...(result.stderr ? { warnings: [String(result.stderr).trim()] } : {})
    };
  }

  // Parses grep-style output where matching lines use "path:line:text" and
  // context lines use "path-line-text". Keeps at most maxMatches matches and
  // the context that belongs to them.
  function parseMemberGrepOutput(output: string, maxMatches: number, readonly?: boolean) {
    const hits: SearchHit[] = [];
    let matchCount = 0;
    let truncated = false;
    for (const line of output.split("\n")) {
      if (!line || line === "--" || line.startsWith("Binary")) continue;
      const parsed = /^(.*?)([:-])(\d+)\2(.*)$/.exec(line);
      if (!parsed) continue;
      const kind = parsed[2] === ":" ? "match" : "context";
      if (kind === "match") {
        if (matchCount >= maxMatches) {
          truncated = true;
          break;
        }
        matchCount++;
      }
      const path = parsed[1];
      let hit = hits.find(entry => entry.path === path);
      if (!hit) {
        hit = { path, lines: [], readonly };
        hits.push(hit);
      }
      hit.lines.push({ number: Number(parsed[3]), content: parsed[4], kind });
    }
    return { hits, matchCount, truncated };
  }

  function clampCount(value: unknown, minimum: number, maximum: number, fallback: number) {
    const parsed = Number(value);
    if (value === undefined || value === null || !Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
  }

  export type IfsSearchResults = SearchResults & { exitCode: number; warnings?: string[] };

  export async function searchIFS(connection: IBMiClient, path: string, searchTerm: string): Promise<IfsSearchResults> {
    const grep = connection.remoteFeatures.grep;
    if (!grep) throw new Error("Grep must be installed on the remote system.");

    const grepRes = await connection.sendCommand({
      command: `${grep} -inr -F -f - ${Tools.escapePath(path)}`,
      stdin: searchTerm
    });

    // grep exits 1 when nothing matched and 2 when any file or directory could
    // not be read, even if other files matched. Keep whatever was printed and
    // report the problems as warnings instead of discarding every hit.
    return withIfsWarnings(
      { term: searchTerm, hits: parseGrepOutput(grepRes.stdout || ""), exitCode: grepRes.code ?? 0 },
      grepRes.stderr
    );
  }

  export async function findIFS(connection: IBMiClient, path: string, findTerm: string): Promise<IfsSearchResults> {
    const find = connection.remoteFeatures.find;
    if (!find) throw new Error("Find must be installed on the remote system.");

    const findRes = await connection.sendCommand({
      command: `${find} ${Tools.escapePath(path)} -type f -iname ${Tools.shellQuote(`*${findTerm}*`)} -print`
    });

    // find exits 1 when a single directory is unreadable; the paths it did
    // print are still valid results.
    return withIfsWarnings(
      { term: findTerm, hits: parseFindOutput(findRes.stdout || ""), exitCode: findRes.code ?? 0 },
      findRes.stderr
    );
  }

  const MAX_IFS_WARNINGS = 50;

  function withIfsWarnings(results: IfsSearchResults, stderr?: string): IfsSearchResults {
    const lines = String(stderr || "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0);
    if (lines.length > 0) {
      const warnings = lines.slice(0, MAX_IFS_WARNINGS);
      if (lines.length > MAX_IFS_WARNINGS) {
        warnings.push(`${lines.length - MAX_IFS_WARNINGS} more warning line(s) omitted`);
      }
      results.warnings = warnings;
    }
    return results;
  }

  function parseFindOutput(output: string, readonly?: boolean, pathTransformer?: (path: string) => string): SearchHit[] {
    const results: SearchHit[] = [];
    const seen = new Set<string>();
    for (const rawLine of output.split('\n')) {
      const line = rawLine.replace(/\r$/, "");
      if (!line.trim()) continue;
      const path = pathTransformer?.(line) || line;
      if (seen.has(path)) continue;
      seen.add(path);
      results.push({ path, readonly, lines: [] });
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
    // IBM i names may contain $, # and @ (and . or _ after the first
    // character); '*' is kept for generic filters such as ABC*.
    return /^[A-Za-z0-9_.*#@$]{1,11}$/.test(name);
  }

  // Builds the shell word for a member glob. A leading '#' would start a shell
  // comment and '$' would expand a variable, so both are escaped; '*' stays
  // unescaped so generic names still expand.
  function memberGlobToken(name: string) {
    return `${name.replace(/[#$]/g, c => `\\${c}`)}.MBR`;
  }

}
