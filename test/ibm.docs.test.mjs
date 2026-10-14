import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IbmDocsService, htmlTableToMarkdown, releaseFromUrl, validateOfficialUrl } from "../dist/ibmi/IbmDocs.js";

async function docsService(options = {}) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-for-i-docs-test-"));
  return new IbmDocsService({ cacheDir, fetch: noNetwork(), ...options });
}

function htmlResponse(body, init = {}) {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" }, ...init });
}

function noNetwork() {
  return async url => {
    throw new Error(`unexpected network access: ${url}`);
  };
}

test("IBM Docs search is release-aware and returns only official canonical URLs", async () => {
  const docs = await docsService();
  const result = await docs.search({ query: "RPG reference", releases: ["7.5"], limit: 10 });
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every(item => item.release === "7.5"));
  assert.ok(result.results.every(item => item.canonicalUrl.startsWith("https://www.ibm.com/docs/")));
  assert.equal(result.webFallback.recommended, true);
});

test("IBM Docs open blocks non-IBM and malformed URLs before network access", async () => {
  const docs = await docsService();
  await assert.rejects(() => docs.open({ url: "https://example.com/docs/en/i" }), /IBM documentation URLs/);
  await assert.rejects(() => docs.open({ url: "http://www.ibm.com/docs/en/i/7.5.0" }), /IBM documentation URLs/);
  await assert.rejects(() => docs.open({ url: "https://www.ibm.com/support/pages/x" }), /IBM documentation URLs/);
  await assert.rejects(() => docs.open({ url: "https://www.ibm.com:8443/docs/en/i/7.5.0" }), /IBM documentation URLs/);
  await assert.rejects(() => docs.open({ url: "https://www.ibm.com:443/docs/en/i/7.5.0" }), /IBM documentation URLs/);
  await assert.rejects(() => docs.open({ url: "https://user:pw@www.ibm.com/docs/en/i/7.5.0" }), /user information/);
  await assert.rejects(() => docs.open({ url: "https://ibm.com/docs/en/i/7.5.0" }), /IBM documentation URLs/);
  await assert.rejects(() => docs.open({ url: "https://www.ibm.com.evil.test/docs/en/i" }), /IBM documentation URLs/);
  await assert.rejects(() => docs.open({ url: "https://www.ibm.com/docs/../support/x" }), /IBM documentation URLs/);
  await assert.rejects(() => docs.open({ url: "https://www.ibm.com\\@evil.test/docs/" }), /IBM documentation URLs|user information/);
  await assert.rejects(() => docs.open({ url: "not a url" }), /IBM documentation URLs/);
});

test("validateOfficialUrl and releaseFromUrl", () => {
  assert.equal(validateOfficialUrl("https://www.ibm.com/docs/en/i/7.5.0?topic=x#frag").toString(), "https://www.ibm.com/docs/en/i/7.5.0?topic=x");
  assert.equal(releaseFromUrl("https://www.ibm.com/docs/en/i/7.5.0?topic=x"), "7.5");
  assert.equal(releaseFromUrl("https://www.ibm.com/docs/en/i/7.3?topic=x"), "7.3");
  assert.equal(releaseFromUrl("https://www.ibm.com/docs/en/db2/11.5"), "unknown");
});

test("IBM Docs open normalizes headings, caches content, and supports section selection", async () => {
  let fetches = 0;
  const docs = await docsService({
    fetch: async () => {
      fetches++;
      return htmlResponse("<html><head><title>IBM i SQL</title></head><body><h1>Database</h1><h2>SQL services</h2><p>Use QSYS2.SYSTEM_STATUS_INFO.</p><pre>SELECT * FROM QSYS2.SYSTEM_STATUS_INFO</pre></body></html>");
    }
  });
  const search = await docs.search({ query: "SQL", releases: ["7.5"] });
  const opened = await docs.open({ ref: search.results[0].ref, section: "SQL services" });
  assert.equal(opened.status, "found");
  assert.deepEqual(opened.headingPath, ["Database", "SQL services"]);
  assert.match(opened.content, /QSYS2\.SYSTEM_STATUS_INFO/);
  const cached = await docs.open({ ref: search.results[0].ref });
  assert.equal(cached.cacheStatus, "hit");
  assert.equal(fetches, 1);
});

test("IBM Docs open accepts any www.ibm.com/docs page and makes it searchable", async () => {
  const requested = [];
  const docs = await docsService({
    fetch: async url => {
      requested.push(String(url));
      return htmlResponse("<title>CRTLIB</title><h1>Create Library (CRTLIB)</h1><p>The CRTLIB command adds a library.</p>");
    }
  });
  const url = new URL("https://www.ibm.com/docs/en/i/7.5.0?topic=ssw_ibm_i_75/cl/crtlib.html").toString();
  const opened = await docs.open({ url });
  assert.equal(opened.status, "found");
  assert.equal(opened.release, "7.5");
  assert.equal(opened.title, "CRTLIB");
  assert.deepEqual(requested, [url]);
  const search = await docs.search({ query: "CRTLIB adds", releases: ["7.5"] });
  const hit = search.results.find(item => item.canonicalUrl === url);
  assert.ok(hit, "opened page should be searchable");
  assert.equal(hit.freshness, "cached");
});

test("IBM Docs follows redirects only within www.ibm.com/docs and caps them", async () => {
  const offsite = await docsService({
    fetch: async () => new Response(null, { status: 302, headers: { location: "https://evil.test/docs/x" } })
  });
  await assert.rejects(() => offsite.open({ url: "https://www.ibm.com/docs/en/i/7.5.0?topic=a" }), /IBM documentation URLs/);

  const leavesDocs = await docsService({
    fetch: async () => new Response(null, { status: 301, headers: { location: "/support/pages/x" } })
  });
  await assert.rejects(() => leavesDocs.open({ url: "https://www.ibm.com/docs/en/i/7.5.0?topic=a" }), /IBM documentation URLs/);

  let hops = 0;
  const loop = await docsService({
    fetch: async () => {
      hops++;
      return new Response(null, { status: 302, headers: { location: `/docs/en/i/7.5.0?topic=hop${hops}` } });
    }
  });
  await assert.rejects(() => loop.open({ url: "https://www.ibm.com/docs/en/i/7.5.0?topic=a" }), /redirect limit/);
  assert.equal(hops, 4);

  const fetched = [];
  const ok = await docsService({
    fetch: async url => {
      fetched.push(String(url));
      if (fetched.length === 1) return new Response(null, { status: 301, headers: { location: "/docs/en/i/7.5.0?topic=b" } });
      return htmlResponse("<h1>B</h1>");
    }
  });
  const opened = await ok.open({ url: "https://www.ibm.com/docs/en/i/7.5.0?topic=a" });
  assert.equal(opened.status, "found");
  assert.deepEqual(fetched, ["https://www.ibm.com/docs/en/i/7.5.0?topic=a", "https://www.ibm.com/docs/en/i/7.5.0?topic=b"]);
});

test("IBM Docs caps the body size even without content-length", async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(65);
  let sent = 0;
  const docs = await docsService({
    fetch: async () => {
      const stream = new ReadableStream({
        pull(controller) {
          sent++;
          if (sent > 40) controller.close();
          else controller.enqueue(chunk);
        }
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/html" } });
    }
  });
  await assert.rejects(() => docs.open({ url: "https://www.ibm.com/docs/en/i/7.5.0?topic=big" }), /exceeds 12 MiB/);
  assert.ok(sent <= 16, `stopped reading early (read ${sent} chunks)`);
});

test("IBM Docs converts HTML tables to Markdown tables", async () => {
  const docs = await docsService({
    fetch: async () => htmlResponse(
      "<h1>Parameters</h1><table><caption>Keywords</caption><thead><tr><th>Keyword</th><th>Description</th></tr></thead>" +
      "<tbody><tr><td>LIB</td><td>Library &amp; name</td></tr><tr><td>TEXT</td><td>Text a|b</td></tr></tbody></table><p>After</p>"
    )
  });
  const opened = await docs.open({ url: "https://www.ibm.com/docs/en/i/7.5.0?topic=table" });
  assert.ok(opened.content.includes(
    "**Keywords**\n| Keyword | Description |\n| --- | --- |\n| LIB | Library & name |\n| TEXT | Text a\\|b |"
  ), opened.content);
  assert.match(opened.content, /After/);
  assert.equal(
    htmlTableToMarkdown("<tr><th colspan=2>A</th></tr><tr><td>1</td><td>2</td><td>3</td></tr>"),
    "| A |  |  |\n| --- | --- | --- |\n| 1 | 2 | 3 |"
  );
});

test("IBM Docs cache expires and refreshes, serving the stale copy if refresh fails", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  let fail = false;
  let fetches = 0;
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-for-i-docs-test-"));
  const options = {
    cacheDir,
    cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
    now: () => now,
    fetch: async () => {
      fetches++;
      if (fail) throw new Error("offline");
      return htmlResponse(`<h1>Version ${fetches}</h1>`);
    }
  };
  const url = "https://www.ibm.com/docs/en/i/7.5.0?topic=expiry";
  const docs = new IbmDocsService(options);
  assert.equal((await docs.open({ url })).cacheStatus, "miss");
  now += 24 * 60 * 60 * 1000;
  assert.equal((await docs.open({ url })).cacheStatus, "hit");
  now += 7 * 24 * 60 * 60 * 1000;
  const refreshed = await docs.open({ url });
  assert.equal(refreshed.cacheStatus, "refreshed");
  assert.match(refreshed.content, /Version 2/);

  // A new service instance reads the on-disk cache; an expired copy is served when offline.
  now += 8 * 24 * 60 * 60 * 1000;
  fail = true;
  const reloaded = new IbmDocsService(options);
  const stale = await reloaded.open({ url });
  assert.equal(stale.cacheStatus, "stale");
  assert.match(stale.content, /Version 2/);
  assert.ok(stale.warnings.some(item => /could not be refreshed/.test(item)));
});

test("IBM Docs covers 7.2 and 7.3 and says when a release is unsupported", async () => {
  const docs = await docsService();
  const older = await docs.search({ query: "CL command", releases: ["7.3"] });
  assert.ok(older.results.length > 0);
  assert.ok(older.results.every(item => item.release === "7.3"));
  const v72 = await docs.search({ query: "API", releases: ["7.2"] });
  assert.ok(v72.results.length > 0);
  const unsupported = await docs.search({ query: "CL command", releases: ["7.1"] });
  assert.equal(unsupported.results.length, 0);
  assert.ok(unsupported.warnings.some(item => /no collection for IBM i 7\.1/.test(item)));
});

test("IBM Docs search does not create the cache directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-for-i-docs-test-"));
  const cacheDir = path.join(root, "not-created");
  const docs = new IbmDocsService({ cacheDir, fetch: noNetwork() });
  await docs.search({ query: "RPG" });
  await assert.rejects(() => fs.stat(cacheDir));
});
