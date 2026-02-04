import { Tools } from "./Tools.js";
export var Search;
(function (Search) {
    function parseHitPath(hit) {
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
    async function searchMembers(connection, library, sourceFile, searchTerm, members, readOnly) {
        let detailedMembers;
        let memberFilter;
        const pfgrep = connection.remoteFeatures.pfgrep;
        if (typeof members === `string`) {
            memberFilter = `${members}.MBR`;
        }
        else if (Array.isArray(members)) {
            if (members.length > 1000) {
                detailedMembers = members;
                memberFilter = "*.MBR";
            }
            else {
                memberFilter = members.map(member => `${member.name}.MBR`).join(` `);
            }
        }
        const command = pfgrep
            ? `${pfgrep} -inHr -F "${sanitizeSearchTerm(searchTerm)}" ${memberFilter}`
            : `/usr/bin/grep -inHR -F "${sanitizeSearchTerm(searchTerm)}" ${memberFilter}`;
        const result = await connection.sendCommand({
            command,
            directory: `/QSYS.LIB/${library}.LIB/${sourceFile}.FILE`
        });
        if (!result.stderr) {
            let hits = parseGrepOutput(result.stdout || '', readOnly);
            if (detailedMembers) {
                hits = hits.filter(hit => {
                    const hitMember = parseHitPath(hit);
                    return detailedMembers.some(member => member.name === hitMember.name && member.library === hitMember.library && member.file === hitMember.file);
                });
            }
            return { term: searchTerm, hits };
        }
        throw new Error(result.stderr || "Search failed");
    }
    Search.searchMembers = searchMembers;
    async function searchIFS(connection, path, searchTerm) {
        const grep = connection.remoteFeatures.grep;
        if (!grep)
            throw new Error("Grep must be installed on the remote system.");
        const grepRes = await connection.sendCommand({
            command: `${grep} -inr -F -f - ${Tools.escapePath(path)}`,
            stdin: searchTerm
        });
        if (grepRes.code === 0) {
            return { term: searchTerm, hits: parseGrepOutput(grepRes.stdout) };
        }
    }
    Search.searchIFS = searchIFS;
    async function findIFS(connection, path, findTerm) {
        const find = connection.remoteFeatures.find;
        if (!find)
            throw new Error("Find must be installed on the remote system.");
        const findRes = await connection.sendCommand({
            command: `${find} ${Tools.escapePath(path)} -type f -iname '*${findTerm}*' -print`
        });
        if (findRes.code === 0 && findRes.stdout) {
            return { term: findTerm, hits: parseFindOutput(findRes.stdout) };
        }
    }
    Search.findIFS = findIFS;
    function parseFindOutput(output, readonly, pathTransformer) {
        const results = [];
        for (const line of output.split('\n')) {
            const path = pathTransformer?.(line) || line;
            results.push(results.find(r => r.path === path) || { path, readonly, lines: [] });
        }
        return results;
    }
    function parseGrepOutput(output, readonly, pathTransformer) {
        const results = [];
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
    function sanitizeSearchTerm(searchTerm) {
        return searchTerm.replace(/\\/g, `\\\\`).replace(/"/g, `\\"`);
    }
    function nthIndex(aString, pattern, n) {
        let index = -1;
        while (n-- && index++ < aString.length) {
            index = aString.indexOf(pattern, index);
            if (index < 0)
                break;
        }
        return index;
    }
})(Search || (Search = {}));
