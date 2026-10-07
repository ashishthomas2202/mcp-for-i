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

/** Releases with an IBM Docs collection. 7.1 and earlier were retired from IBM Docs. */
export const SUPPORTED_DOC_RELEASES = ["7.2", "7.3", "7.4", "7.5", "7.6"];
const CURRENT_RELEASES = ["7.4", "7.5", "7.6"];
const OLDER_RELEASES = ["7.2", "7.3"];

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_SEEDS: IbmDocsSeed[] = [
  ...OLDER_RELEASES.flatMap(release => [
    {
      title: `IBM i ${release} documentation overview`,
      topic: "documentation-overview-whats-new",
      categories: ["overview", "programming", "database", "systems-management"],
      keywords: ["IBM i", "RPG", "CL", "SQL", "QSYS2", "IFS", "API", "security", "database", "system administration"]
    },
    {
      title: `IBM i ${release} PDF files and manuals`,
      topic: "documentation-pdf-files-manuals",
      categories: ["manuals", "programming", "database", "systems-management"],
      keywords: ["manual", "reference", "RPG", "COBOL", "CL", "SQL", "API", "ILE", "DDS", "backup", "security"]
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
      title: `IBM i ${release} ILE RPG Reference`,
      topic: "rpg-ile-reference",
      categories: ["programming", "rpg", "ile"],
      keywords: ["RPGLE", "RPG IV", "free form", "operation codes", "built-in functions", "subprocedure", "prototype"]
    }
  ].map(seed => ({
    title: seed.title,
    url: `https://www.ibm.com/docs/en/i/${release}.0?topic=${seed.topic}`,
    release,
    categories: seed.categories,
    keywords: seed.keywords
  }))),
  ...CURRENT_RELEASES.map(release => ({
    title: `IBM i ${release} documentation overview`,
    url: `https://www.ibm.com/docs/en/i/${release}.0?topic=documentation-overview-whats-new`,
    release,
    categories: ["overview", "programming", "database", "systems-management"],
    keywords: ["IBM i", "RPG", "CL", "SQL", "QSYS2", "IFS", "API", "security", "database", "performance", "system administration"]
  })),
  ...CURRENT_RELEASES.map(release => ({
    title: `IBM i ${release} PDF files and manuals`,
    url: `https://www.ibm.com/docs/en/i/${release}.0?topic=documentation-pdf-files-manuals`,
    release,
    categories: ["manuals", "programming", "database", "systems-management"],
    keywords: ["manual", "reference", "RPG", "COBOL", "CL", "SQL", "API", "ILE", "DDS", "backup", "security"]
  })),
  ...CURRENT_RELEASES.flatMap(release => [
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
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cacheDirReady?: Promise<void>;
  private cacheLoaded = false;

  constructor(options: { seeds?: IbmDocsSeed[]; cacheDir?: string; fetch?: typeof fetch; cacheTtlMs?: number; now?: () => number } = {}) {
    this.cacheDir = options.cacheDir || process.env.MCP_FOR_I_IBM_DOCS_CACHE_DIR || path.join(getConfigDir(), "ibm-docs");
    this.httpFetch = options.fetch || fetch;
    this.cacheTtlMs = resolveCacheTtl(options.cacheTtlMs);
    this.now = options.now || Date.now;
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
    const unsupportedReleases = [...releaseSet].filter(release => !SUPPORTED_DOC_RELEASES.includes(release));
    if (unsupportedReleases.length) {
      refreshWarnings.push(
        `IBM Docs has no collection for IBM i ${unsupportedReleases.join(", ")}; supported releases are ${SUPPORTED_DOC_RELEASES.join(", ")}. ` +
        "Older manuals may only exist as PDFs or Redbooks."
      );
    }
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
    const matches = this.searchableEntries().flatMap(seed => {
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
        matchReasons: cached
          ? ["official-doc-content", seed.opened ? "previously-opened-page" : "curated-official-catalog"]
          : ["curated-official-catalog"],
        freshness: cached ? (this.isExpired(cached) ? "stale" : "cached") : "catalog",
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
    // Any https://www.ibm.com/docs/ page may be opened; the seeds only drive search.
    const url = options.url ? validateOfficialUrl(options.url).toString() : decodeRef(String(options.ref || ""));
    const requireLive = options.requireLive || options.freshness === "require-live";
    const cached = requireLive ? undefined : await this.cachedDocument(url);
    const warnings: string[] = [];
    let document: CachedDocument;
    let cacheStatus: "hit" | "miss" | "refreshed" | "stale";
    if (cached && !this.isExpired(cached)) {
      document = cached;
      cacheStatus = "hit";
    } else if (cached) {
      try {
        document = await this.fetchDocument(url);
        cacheStatus = "refreshed";
      } catch (error: any) {
        // Serve the expired copy rather than nothing, and say so.
        document = cached;
        cacheStatus = "stale";
        warnings.push(`Cached copy is older than the cache expiry and could not be refreshed: ${error?.message || String(error)}`);
      }
    } else {
      document = await this.fetchDocument(url);
      cacheStatus = "miss";
    }
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
      ...(complete ? {} : { truncatedReason: `Document exceeds maxCharacters=${maximum}` }),
      ...(document.release === "unknown" || SUPPORTED_DOC_RELEASES.includes(document.release) ? {} : {
        releaseNote: `IBM i ${document.release} is not a release this catalog covers (${SUPPORTED_DOC_RELEASES.join(", ")}).`
      }),
      ...(warnings.length ? { warnings } : {})
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
      for (let redirects = 0; ; redirects += 1) {
        response = await this.httpFetch(current, { redirect: "manual", signal: controller.signal, headers: { accept: "text/html" } });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (!location) throw new Error("IBM documentation redirect had no location");
        if (redirects >= MAX_REDIRECTS) throw new Error("IBM documentation redirect limit exceeded");
        // Redirects may only stay on https://www.ibm.com/docs/.
        current = validateOfficialUrl(new URL(location, current).toString());
      }
      if (!response?.ok) throw new Error(`IBM documentation request failed (${response?.status || "unknown"})`);
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("text/html")) throw new Error("IBM documentation response was not HTML");
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > MAX_BODY_BYTES) throw new Error("IBM documentation response exceeds 12 MiB");
      const html = await readBodyWithLimit(response, MAX_BODY_BYTES);
      const seed = this.seeds.find(item => item.url === url);
      const parsed = htmlToMarkdown(html);
      const document: CachedDocument = {
        title: parsed.title || seed?.title || url,
        url,
        release: seed?.release || releaseFromUrl(url),
        content: parsed.content,
        version: crypto.createHash("sha256").update(parsed.content, "utf8").digest("hex"),
        fetchedAt: new Date(this.now()).toISOString()
      };
      await this.ensureCacheDir();
      await fs.writeFile(this.cachePath(url), JSON.stringify(document), "utf8");
      this.cache.set(url, document);
      return document;
    } finally {
      clearTimeout(timer);
    }
  }

  private isExpired(document: CachedDocument) {
    const fetched = Date.parse(document.fetchedAt);
    if (!Number.isFinite(fetched)) return true;
    return this.now() - fetched > this.cacheTtlMs;
  }

  /** Seeds plus any non-seed pages that were opened before, so they are searchable too. */
  private searchableEntries(): Array<IbmDocsSeed & { opened?: boolean }> {
    const seedUrls = new Set(this.seeds.map(seed => seed.url));
    const opened = [...this.cache.values()]
      .filter(document => !seedUrls.has(document.url))
      .map(document => ({
        title: document.title,
        url: document.url,
        release: document.release,
        categories: [] as string[],
        keywords: [] as string[],
        opened: true
      }));
    return [...this.seeds, ...opened];
  }

  private ensureCacheDir() {
    this.cacheDirReady ||= fs.mkdir(this.cacheDir, { recursive: true }).then(() => undefined, error => {
      this.cacheDirReady = undefined;
      throw error;
    });
    return this.cacheDirReady;
  }

  private async cachedDocument(url: string) {
    await this.loadCachedDocuments();
    return this.cache.get(url);
  }

  private async loadCachedDocuments() {
    if (this.cacheLoaded) return;
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.cacheDir);
    } catch {
      // No cache directory yet; it is created on the first fetch.
    }
    await Promise.all(entries.filter(name => /^[0-9a-f]{64}\.json$/.test(name)).map(async name => {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.cacheDir, name), "utf8")) as CachedDocument;
        if (typeof parsed?.url !== "string" || typeof parsed.content !== "string") return;
        const url = validateOfficialUrl(parsed.url).toString();
        if (this.cachePath(url) !== path.join(this.cacheDir, name)) return;
        if (!this.cache.has(url)) this.cache.set(url, { ...parsed, url });
      } catch {}
    }));
    this.cacheLoaded = true;
  }

  private cachePath(url: string) {
    return path.join(this.cacheDir, `${crypto.createHash("sha256").update(url).digest("hex")}.json`);
  }
}

export const ibmDocs = new IbmDocsService();

export function validateOfficialUrl(value: string) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 2048 || /[\s\\]/.test(raw)) throw new Error("IBM documentation URLs must use https://www.ibm.com/docs/");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("IBM documentation URLs must use https://www.ibm.com/docs/");
  }
  if (url.username || url.password || /^https:\/\/[^/]*@/i.test(raw)) {
    throw new Error("IBM documentation URLs may not include user information");
  }
  // An explicit port (even :443) is rejected by looking at the raw authority.
  const authority = /^https:\/\/([^/?#]*)/i.exec(raw)?.[1] || "";
  if (url.protocol !== "https:" || url.hostname !== "www.ibm.com" || url.port || authority.toLowerCase() !== "www.ibm.com" || !url.pathname.startsWith("/docs/")) {
    throw new Error("IBM documentation URLs must use https://www.ibm.com/docs/");
  }
  url.hash = "";
  return url;
}

/** IBM Docs paths look like /docs/en/i/7.5.0 or /docs/en/i/7.5; returns "7.5" or "unknown". */
export function releaseFromUrl(value: string) {
  const match = /^\/docs\/[a-z]{2}(?:-[a-z]{2})?\/i\/(\d+)\.(\d+)(?:\.\d+)?(?:\/|$)/i.exec(new URL(value).pathname);
  return match ? `${Number(match[1])}.${Number(match[2])}` : "unknown";
}

function resolveCacheTtl(option?: number) {
  if (typeof option === "number" && Number.isFinite(option) && option >= 0) return option;
  const days = Number(process.env.MCP_FOR_I_IBM_DOCS_CACHE_TTL_DAYS);
  if (process.env.MCP_FOR_I_IBM_DOCS_CACHE_TTL_DAYS && Number.isFinite(days) && days >= 0) return days * 24 * 60 * 60 * 1000;
  return DEFAULT_CACHE_TTL_MS;
}

/** Reads the body as text, failing as soon as more than `limit` bytes arrive. */
async function readBodyWithLimit(response: Response, limit: number) {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > limit) throw new Error("IBM documentation response exceeds 12 MiB");
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("IBM documentation response exceeds 12 MiB");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
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
  const tables: string[] = [];
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  // Tables become Markdown tables. They are swapped for placeholders so the
  // generic tag stripping below does not flatten them; innermost tables first.
  let tableSource = withoutScripts;
  for (let pass = 0; pass < 5 && /<table\b/i.test(tableSource); pass += 1) {
    tableSource = tableSource.replace(/<table\b[^>]*>((?:(?!<table\b)[\s\S])*?)<\/table>/gi, (_all, body) => {
      tables.push(htmlTableToMarkdown(body, tables));
      return `\n\u0000TABLE${tables.length - 1}\u0000\n`;
    });
  }
  const content = decodeEntities(tableSource
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
    .replace(/\u0000TABLE(\d+)\u0000/g, (_all, index) => tables[Number(index)] || "")
    .trim();
  return { title, content };
}

/** Converts the inside of a <table> element into a Markdown table. */
export function htmlTableToMarkdown(body: string, nested: string[] = []) {
  const caption = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i.exec(body)?.[1];
  const rows: string[][] = [];
  for (const rowMatch of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/(?:th|td)>/gi)) {
      const text = stripTags(cellMatch[3].replace(/<br\s*\/?>/gi, " "))
        .replace(/\u0000TABLE(\d+)\u0000/g, (_all, index) => (nested[Number(index)] || "").replace(/\s*\n\s*/g, " "))
        .replace(/\|/g, "\\|")
        .trim();
      cells.push(text);
      const span = Number(/colspan\s*=\s*["']?(\d+)/i.exec(cellMatch[2])?.[1] || 1);
      for (let extra = 1; extra < Math.min(span, 20); extra += 1) cells.push("");
    }
    if (cells.length) rows.push(cells);
  }
  const captionText = caption ? stripTags(caption).trim() : "";
  if (!rows.length) return captionText;
  const width = Math.max(...rows.map(row => row.length));
  const pad = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill("")].join(" | ")} |`;
  // The first row is used as the header (IBM Docs tables start with <th> cells).
  const [first, ...rest] = rows;
  const lines = [pad(first), `| ${Array(width).fill("---").join(" | ")} |`, ...rest.map(pad)];
  return [captionText ? `**${captionText}**` : "", ...lines].filter(Boolean).join("\n");
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
