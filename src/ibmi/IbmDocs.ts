import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { getConfigDir } from "../config/store.js";

export type IbmDocsSeed = {
  title: string;
  url: string;
  release: string;
  categories: string[];
  keywords: string[];
};

type CachedDocument = {
  title: string;
  url: string;
  release: string;
  content: string;
  version: string;
  fetchedAt: string;
};

type MarkdownSection = {
  headingPath: string[];
  startLine: number;
  endLine: number;
};

const DEFAULT_SEEDS: IbmDocsSeed[] = [
  ...["7.4", "7.5", "7.6"].map(release => ({
    title: `IBM i ${release} documentation overview`,
    url: `https://www.ibm.com/docs/en/i/${release}.0?topic=documentation-overview-whats-new`,
    release,
    categories: ["overview", "programming", "database", "systems-management"],
    keywords: ["IBM i", "RPG", "CL", "SQL", "QSYS2", "IFS", "API", "security", "database", "performance", "system administration"]
  })),
  ...["7.4", "7.5", "7.6"].map(release => ({
    title: `IBM i ${release} PDF files and manuals`,
    url: `https://www.ibm.com/docs/en/i/${release}.0?topic=documentation-pdf-files-manuals`,
    release,
    categories: ["manuals", "programming", "database", "systems-management"],
    keywords: ["manual", "reference", "RPG", "COBOL", "CL", "SQL", "API", "ILE", "DDS", "backup", "security"]
  })),
  ...["7.4", "7.5", "7.6"].flatMap(release => [
    {
      title: `IBM i ${release} documentation site map`,
      topic: "documentation-site-map",
      categories: ["catalog", "programming", "database", "security", "systems-management"],
      keywords: ["site map", "RPG", "COBOL", "CL", "SQL", "database", "IFS", "security", "backup", "work management"]
    },
    {
      title: `IBM i ${release} ILE RPG Reference`,
      topic: "rpg-ile-reference",
      categories: ["programming", "rpg", "ile"],
      keywords: ["RPGLE", "RPG IV", "free form", "operation codes", "built-in functions", "subprocedure", "prototype"]
    },
    {
      title: `IBM i ${release} CL command finder`,
      topic: "language-cl-command-finder",
      categories: ["programming", "cl", "commands"],
      keywords: ["CL", "command", "CRTLIB", "CRTPGM", "DSPJOB", "WRKACTJOB", "QCMDEXC"]
    },
    {
      title: `IBM i ${release} APIs overview`,
      topic: "interfaces-apis-overview",
      categories: ["programming", "apis"],
      keywords: ["API", "QUSRMBRD", "QUSLJOB", "QUSLOBJ", "QUSRSPLA", "user space", "service program"]
    },
    {
      title: `IBM i ${release} IBM i Services catalog`,
      topic: "services-info-table",
      categories: ["database", "sql", "services"],
      keywords: ["QSYS2", "SYSTOOLS", "SQL services", "SERVICES_INFO", "table function", "view", "PTF"]
    },
    {
      title: `IBM i ${release} security reference`,
      topic: "security-reference",
      categories: ["security", "systems-management"],
      keywords: ["authority", "user profile", "authorization list", "audit journal", "QSECURITY", "object security"]
    },
    {
      title: `IBM i ${release} database query optimizer`,
      topic: "performance-optimizer",
      categories: ["database", "sql", "performance"],
      keywords: ["optimizer", "access plan", "index", "SQL performance", "query engine", "Visual Explain"]
    },
    {
      title: `IBM i ${release} integrated file system CL commands`,
      topic: "system-accessing-using-cl-commands",
      categories: ["ifs", "commands", "systems-management"],
      keywords: ["IFS", "integrated file system", "ADDLNK", "ADDMFS", "WRKLNK", "CPYTOSTMF", "CPYFRMSTMF"]
    }
  ].map(seed => ({
    title: seed.title,
    url: `https://www.ibm.com/docs/en/i/${release}.0?topic=${seed.topic}`,
    release,
    categories: seed.categories,
    keywords: seed.keywords
  })))
];

export class IbmDocsService {
  private readonly cache = new Map<string, CachedDocument>();
  private readonly inflight = new Map<string, Promise<CachedDocument>>();
  private readonly seeds: IbmDocsSeed[];
  private readonly cacheDir: string;
  private readonly httpFetch: typeof fetch;

  constructor(options: { seeds?: IbmDocsSeed[]; cacheDir?: string; fetch?: typeof fetch } = {}) {
    this.cacheDir = options.cacheDir || process.env.MCP_FOR_I_IBM_DOCS_CACHE_DIR || path.join(getConfigDir(), "ibm-docs");
    this.httpFetch = options.fetch || fetch;
    this.seeds = [...DEFAULT_SEEDS, ...loadExtraSeeds(), ...(options.seeds || [])]
      .map(seed => ({ ...seed, url: validateOfficialUrl(seed.url).toString() }))
      .filter((seed, index, all) => all.findIndex(item => item.url === seed.url) === index);
  }

  async search(options: {
    query: string;
    releases?: string[];
    categories?: string[];
    limit?: number;
    cursor?: string;
    freshness?: "indexed" | "prefer-live";
  }) {
    const query = String(options.query || "").trim();
    if (!query) throw new Error("query is required");
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit || 10)));
    const offset = options.cursor ? decodeCursor(options.cursor) : 0;
    await this.loadCachedDocuments();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const releaseSet = new Set((options.releases || []).map(normalizeRelease));
    const categorySet = new Set((options.categories || []).map(value => value.toLowerCase()));
    const refreshWarnings: string[] = [];
    if (options.freshness === "prefer-live") {
      const refreshCandidates = this.seeds.flatMap(seed => {
        if (releaseSet.size && !releaseSet.has(normalizeRelease(seed.release))) return [];
        if (categorySet.size && !seed.categories.some(category => categorySet.has(category.toLowerCase()))) return [];
        const catalog = `${seed.title} ${seed.keywords.join(" ")} ${seed.categories.join(" ")}`.toLowerCase();
        const score = terms.reduce((total, term) => total + (catalog.includes(term) ? (/[._#$@*\d]/.test(term) ? 12 : 1) : 0), 0);
        return score > 0 ? [{ seed, score }] : [];
      }).sort((a, b) => b.score - a.score).slice(0, Math.min(limit, 5)).map(item => item.seed);
      const refreshed = await Promise.allSettled(refreshCandidates.map(seed => this.fetchDocument(seed.url)));
      refreshed.forEach((outcome, index) => {
        if (outcome.status === "rejected") refreshWarnings.push(`Could not refresh ${refreshCandidates[index].title}: ${outcome.reason?.message || String(outcome.reason)}`);
      });
    }
    const matches = this.seeds.flatMap(seed => {
      if (releaseSet.size && !releaseSet.has(normalizeRelease(seed.release))) return [];
      if (categorySet.size && !seed.categories.some(category => categorySet.has(category.toLowerCase()))) return [];
      const cached = this.cache.get(seed.url);
      const title = cached?.title || seed.title;
      const haystack = `${title} ${seed.keywords.join(" ")} ${seed.categories.join(" ")} ${cached?.content || ""}`.toLowerCase();
      const titleText = title.toLowerCase();
      const identifierTerms = terms.filter(term => /[._#$@*\d]/.test(term));
      const score = terms.reduce((total, term) => {
        if (titleText.includes(term)) return total + 8;
        if (seed.keywords.some(keyword => keyword.toLowerCase().includes(term))) return total + 4;
        if (haystack.includes(term)) return total + 1;
        return total;
      }, 0) + identifierTerms.reduce((total, term) => total + (haystack.includes(term) ? 12 : 0), 0);
      if (score === 0) return [];
      return [{ seed, cached, title, score }];
    }).sort((a, b) => b.score - a.score || b.seed.release.localeCompare(a.seed.release) || a.title.localeCompare(b.title));
    const selected = matches.slice(offset, offset + limit);
    const hasMore = offset + selected.length < matches.length;
    return {
      query,
      results: selected.map(({ seed, cached, title, score }) => {
        const match = cached ? locateBestMatch(cached.content, terms) : undefined;
        return ({
        ref: encodeRef(seed.url),
        title,
        product: "IBM i",
        release: seed.release,
        topicId: new URL(seed.url).searchParams.get("topic") || undefined,
        categories: seed.categories,
        canonicalUrl: seed.url,
        headingPath: match?.headingPath || [],
        excerpt: cached ? excerptFor(cached.content, terms, match?.index) : seed.keywords.join(", "),
        score,
        matchReasons: cached ? ["official-doc-content", "curated-official-catalog"] : ["curated-official-catalog"],
        freshness: cached ? "cached" : "catalog",
        version: cached?.version,
        observedAt: cached?.fetchedAt
      }); }),
      returned: selected.length,
      hasMore,
      ...(hasMore ? { nextCursor: encodeCursor(offset + selected.length) } : {}),
      coverage: {
        sufficient: selected.length > 0 && selected.some(item => item.cached),
        searchedSeeds: this.seeds.length,
        cachedDocuments: matches.filter(item => item.cached).length
      },
      warnings: [
        ...refreshWarnings,
        ...(selected.some(item => item.cached) ? [] : ["Search used the curated official catalog; open a result to cache and search its full content."])
      ],
      ...(selected.some(item => item.cached) ? {} : {
        webFallback: {
          recommended: true,
          query: `${query} IBM i ${options.releases?.[0] || ""}`.trim(),
          preferredDomains: ["www.ibm.com/docs", "www.ibm.com/support", "www.redbooks.ibm.com", "developer.ibm.com"],
          reason: selected.length ? "Catalog matches exist but their content has not been cached yet; open a result or use web search." : "No configured official documentation seed matched the query."
        }
      })
    };
  }

  async open(options: {
    ref?: string;
    url?: string;
    expectedVersion?: string;
    requireLive?: boolean;
    freshness?: "allow-cached" | "require-live";
    maxCharacters?: number;
    section?: string;
    startLine?: number;
    endLine?: number;
  }) {
    const url = options.url ? validateOfficialUrl(options.url).toString() : decodeRef(String(options.ref || ""));
    if (!this.seeds.some(seed => seed.url === url)) throw new Error("IBM documentation URL is not in the approved catalog");
    let document = options.requireLive || options.freshness === "require-live" ? undefined : await this.cachedDocument(url);
    const cacheStatus = document ? "hit" : "miss";
    document ||= await this.fetchDocument(url);
    if (options.expectedVersion && options.expectedVersion !== document.version) {
      return {
        status: "version-conflict" as const,
        expectedVersion: options.expectedVersion,
        actualVersion: document.version,
        canonicalUrl: url,
        observedAt: document.fetchedAt
      };
    }
    const selected = selectDocumentContent(document.content, options);
    const maximum = Math.max(1_000, Math.min(200_000, Math.floor(options.maxCharacters || 50_000)));
    const complete = selected.content.length <= maximum;
    return {
      status: "found" as const,
      ref: encodeRef(url),
      title: document.title,
      product: "IBM i",
      release: document.release,
      topicId: new URL(document.url).searchParams.get("topic") || undefined,
      canonicalUrl: document.url,
      headingPath: selected.headingPath,
      startLine: selected.startLine,
      endLine: selected.endLine,
      content: selected.content.slice(0, maximum),
      version: document.version,
      checksum: document.version,
      observedAt: document.fetchedAt,
      cacheStatus,
      complete,
      ...(complete ? {} : { truncatedReason: `Document exceeds maxCharacters=${maximum}` })
    };
  }

  listResources() {
    return this.seeds.map(seed => ({
      uri: `ibmi-docs://topic/${encodeURIComponent(encodeRef(seed.url))}`,
      name: seed.title,
      description: `Official IBM i ${seed.release} documentation`,
      mimeType: "text/markdown"
    }));
  }

  async readResource(uri: string) {
    if (uri === "ibmi-docs://catalog") {
      return JSON.stringify(this.seeds, null, 2);
    }
    const prefix = "ibmi-docs://topic/";
    if (!uri.startsWith(prefix)) throw new Error("Unknown IBM documentation resource URI");
    const ref = decodeURIComponent(uri.slice(prefix.length));
    const opened = await this.open({ ref });
    if (opened.status !== "found") throw new Error("IBM documentation resource changed; read it again");
    return opened.content;
  }

  private async fetchDocument(url: string): Promise<CachedDocument> {
    const existing = this.inflight.get(url);
    if (existing) return existing;
    const loading = this.fetchDocumentUncoalesced(url);
    this.inflight.set(url, loading);
    try {
      return await loading;
    } finally {
      this.inflight.delete(url);
    }
  }

  private async fetchDocumentUncoalesced(url: string): Promise<CachedDocument> {
    let current = validateOfficialUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    timer.unref?.();
    try {
      let response: Response | undefined;
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        response = await this.httpFetch(current, { redirect: "manual", signal: controller.signal, headers: { accept: "text/html" } });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        if (!location || redirects === 3) throw new Error("IBM documentation redirect limit exceeded");
        current = validateOfficialUrl(new URL(location, current).toString());
      }
      if (!response?.ok) throw new Error(`IBM documentation request failed (${response?.status || "unknown"})`);
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("text/html")) throw new Error("IBM documentation response was not HTML");
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > 12 * 1024 * 1024) throw new Error("IBM documentation response exceeds 12 MiB");
      const html = await response.text();
      if (Buffer.byteLength(html, "utf8") > 12 * 1024 * 1024) throw new Error("IBM documentation response exceeds 12 MiB");
      const seed = this.seeds.find(item => item.url === url)!;
      const parsed = htmlToMarkdown(html);
      const document: CachedDocument = {
        title: parsed.title || seed.title,
        url,
        release: seed.release,
        content: parsed.content,
        version: crypto.createHash("sha256").update(parsed.content, "utf8").digest("hex"),
        fetchedAt: new Date().toISOString()
      };
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(this.cachePath(url), JSON.stringify(document), "utf8");
      this.cache.set(url, document);
      return document;
    } finally {
      clearTimeout(timer);
    }
  }

  private async cachedDocument(url: string) {
    await this.loadCachedDocuments();
    return this.cache.get(url);
  }

  private async loadCachedDocuments() {
    await fs.mkdir(this.cacheDir, { recursive: true });
    await Promise.all(this.seeds.map(async seed => {
      if (this.cache.has(seed.url)) return;
      try {
        const parsed = JSON.parse(await fs.readFile(this.cachePath(seed.url), "utf8")) as CachedDocument;
        if (parsed.url === seed.url && typeof parsed.content === "string") this.cache.set(seed.url, parsed);
      } catch {}
    }));
  }

  private cachePath(url: string) {
    return path.join(this.cacheDir, `${crypto.createHash("sha256").update(url).digest("hex")}.json`);
  }
}

export const ibmDocs = new IbmDocsService();

function validateOfficialUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "www.ibm.com" || url.port || !url.pathname.startsWith("/docs/")) {
    throw new Error("IBM documentation URLs must use https://www.ibm.com/docs/");
  }
  if (url.username || url.password) throw new Error("IBM documentation URLs may not include user information");
  url.hash = "";
  return url;
}

function loadExtraSeeds(): IbmDocsSeed[] {
  const raw = process.env.MCP_FOR_I_IBM_DOCS_SEEDS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(item => {
      if (!item || typeof item !== "object" || typeof item.title !== "string" || typeof item.url !== "string" || typeof item.release !== "string") return [];
      return [{
        title: item.title,
        url: item.url,
        release: normalizeRelease(item.release),
        categories: Array.isArray(item.categories) ? item.categories.map(String) : [],
        keywords: Array.isArray(item.keywords) ? item.keywords.map(String) : []
      }];
    });
  } catch {
    return [];
  }
}

function htmlToMarkdown(html: string) {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").replace(/<[^>]+>/g, " ")).trim();
  const content = decodeEntities(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_all, level, text) => `\n${"#".repeat(Number(level))} ${stripTags(text)}\n`)
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_all, text) => `\n\`\`\`\n${stripTags(text).trim()}\n\`\`\`\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_all, text) => `\`${stripTags(text).trim()}\``)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_all, text) => `\n- ${stripTags(text).trim()}`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, content };
}

function stripTags(value: string) {
  return decodeEntities(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
}

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function excerptFor(content: string, terms: string[], preferredIndex?: number) {
  const lower = content.toLowerCase();
  const indexes = terms.map(term => lower.indexOf(term)).filter(index => index >= 0);
  const index = typeof preferredIndex === "number" ? preferredIndex : indexes.length ? Math.min(...indexes) : 0;
  const start = Math.max(0, index - 180);
  const end = Math.min(content.length, index + 420);
  return `${start > 0 ? "…" : ""}${content.slice(start, end).replace(/\s+/g, " ")}${end < content.length ? "…" : ""}`;
}

function markdownSections(content: string): MarkdownSection[] {
  const lines = content.split("\n");
  const headings: Array<{ level: number; title: string; line: number; path: string[] }> = [];
  const stack: string[] = [];
  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) return;
    const level = match[1].length;
    stack.length = level - 1;
    stack[level - 1] = match[2];
    headings.push({ level, title: match[2], line: index + 1, path: stack.filter(Boolean) });
  });
  return headings.map((heading, index) => ({
    headingPath: heading.path,
    startLine: heading.line,
    endLine: (headings[index + 1]?.line || lines.length + 1) - 1
  }));
}

function locateBestMatch(content: string, terms: string[]) {
  const lower = content.toLowerCase();
  const indexes = terms.map(term => lower.indexOf(term)).filter(index => index >= 0);
  const index = indexes.length ? Math.min(...indexes) : 0;
  const line = content.slice(0, index).split("\n").length;
  const section = markdownSections(content).filter(item => item.startLine <= line).at(-1);
  return { index, headingPath: section?.headingPath || [] };
}

function selectDocumentContent(content: string, options: { section?: string; startLine?: number; endLine?: number }) {
  const lines = content.split("\n");
  let baseStart = 1;
  let baseEnd = lines.length;
  let headingPath: string[] = [];
  if (options.section) {
    const query = options.section.trim().toLowerCase();
    const section = markdownSections(content).find(item => item.headingPath.join(" > ").toLowerCase().includes(query));
    if (!section) throw new Error(`IBM documentation section not found: ${options.section}`);
    baseStart = section.startLine;
    baseEnd = section.endLine;
    headingPath = section.headingPath;
  }
  const requestedStart = options.startLine === undefined ? baseStart : Math.floor(Number(options.startLine));
  const requestedEnd = options.endLine === undefined ? baseEnd : Math.floor(Number(options.endLine));
  if (!Number.isFinite(requestedStart) || !Number.isFinite(requestedEnd) || requestedStart < 1 || requestedEnd < requestedStart) {
    throw new Error("Invalid IBM documentation line range");
  }
  const startLine = Math.max(baseStart, requestedStart);
  const endLine = Math.min(baseEnd, requestedEnd);
  if (endLine < startLine) throw new Error("IBM documentation line range does not overlap the selected section");
  return { headingPath, startLine, endLine, content: lines.slice(startLine - 1, endLine).join("\n") };
}

function encodeRef(url: string) {
  return `ibmi-docs:${Buffer.from(url, "utf8").toString("base64url")}`;
}

function decodeRef(ref: string) {
  if (!ref.startsWith("ibmi-docs:")) throw new Error("Invalid IBM documentation ref");
  return validateOfficialUrl(Buffer.from(ref.slice("ibmi-docs:".length), "base64url").toString("utf8")).toString();
}

function encodeCursor(offset: number) {
  return `ibmi-docs:v1:${offset}`;
}

function decodeCursor(cursor: string) {
  const match = /^ibmi-docs:v1:(\d+)$/.exec(cursor);
  const offset = Number(match?.[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid IBM documentation cursor");
  return offset;
}

function normalizeRelease(value: string) {
  return String(value).trim().replace(/\.0$/, "");
}
