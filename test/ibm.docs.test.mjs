import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IbmDocsService } from "../dist/ibmi/IbmDocs.js";

async function docsService(options = {}) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-for-i-docs-test-"));
  return new IbmDocsService({ cacheDir, ...options });
}

test("IBM Docs search is release-aware and returns only official canonical URLs", async () => {
  const docs = await docsService();
  const result = await docs.search({ query: "RPG reference", releases: ["7.5"], limit: 10 });
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every(item => item.release === "7.5"));
  assert.ok(result.results.every(item => item.canonicalUrl.startsWith("https://www.ibm.com/docs/")));
  assert.equal(result.webFallback.recommended, true);
});

test("IBM Docs open blocks arbitrary and non-IBM URLs before network access", async () => {
  const docs = await docsService();
  await assert.rejects(() => docs.open({ url: "https://example.com/docs/en/i" }), /IBM documentation URLs/);
  await assert.rejects(() => docs.open({ url: "https://www.ibm.com/docs/unlisted" }), /approved catalog/);
});

test("IBM Docs open normalizes headings, caches content, and supports section selection", async () => {
  let fetches = 0;
  const docs = await docsService({
    fetch: async () => {
      fetches++;
      return new Response("<html><head><title>IBM i SQL</title></head><body><h1>Database</h1><h2>SQL services</h2><p>Use QSYS2.SYSTEM_STATUS_INFO.</p><pre>SELECT * FROM QSYS2.SYSTEM_STATUS_INFO</pre></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
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
