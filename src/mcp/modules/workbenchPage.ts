/**
 * The workbench page: jobs, job logs with their diagnosis, and debug readiness,
 * for a person working with any agent. It shows exactly what the tools return
 * (it calls them through the local server), so the page and the agent never
 * disagree.
 *
 * How it is laid out: a narrow list of jobs at the left (tight, it is chrome),
 * and one calm reading column at the right that answers in order: what
 * happened, where in whose code, what led to it, and only then the whole log.
 * One accent colour, kept for the one action and for what is selected; the
 * colours of failed / waiting / fine are a separate set.
 *
 * Everything from the system is put on the page as text, never as markup.
 * The client script must not contain backticks or "${" (it sits in a template literal).
 *
 * A host application that frames or embeds the page can listen for
 * window messages of type "mcp-for-i.openSource" ({ library, file, member,
 * streamFile, line }) to open the source in its own editor.
 */
export function renderWorkbenchPage(version: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>IBM i workbench</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --raised: #f7f8fa; --hover: #f0f2f5; --line: rgba(15, 23, 42, .09); --line-2: rgba(15, 23, 42, .16);
    --tx: #111827; --tx-2: #4b5565; --tx-3: #7b8494; --tx-4: #a3abb8;
    --accent: #3b5bdb; --accent-soft: rgba(59, 91, 219, .09); --on-accent: #ffffff;
    --bad: #c9372c; --bad-soft: rgba(201, 55, 44, .08); --warn: #a15c07; --warn-soft: rgba(161, 92, 7, .09);
    --good: #1a7f4b; --good-soft: rgba(26, 127, 75, .09); --wait: #6d3fc0; --wait-soft: rgba(109, 63, 192, .09);
    --shadow: 0 1px 2px rgba(15, 23, 42, .05), 0 8px 24px rgba(15, 23, 42, .08);
    --sans: "Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
    --mono: "Cascadia Mono", "JetBrains Mono", "SF Mono", Consolas, Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --raised: #151820; --hover: #1b1f29; --line: rgba(255, 255, 255, .08); --line-2: rgba(255, 255, 255, .15);
      --tx: #eceef2; --tx-2: #a9b1c0; --tx-3: #7a8394; --tx-4: #565e6d;
      --accent: #8aa2ff; --accent-soft: rgba(138, 162, 255, .13); --on-accent: #0f1115;
      --bad: #ff8478; --bad-soft: rgba(255, 132, 120, .1); --warn: #e6ac4d; --warn-soft: rgba(230, 172, 77, .1);
      --good: #5fcf8e; --good-soft: rgba(95, 207, 142, .1); --wait: #b99bff; --wait-soft: rgba(185, 155, 255, .11);
      --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 12px 32px rgba(0, 0, 0, .45);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font: 13px/1.5 var(--sans); color: var(--tx); background: var(--bg); display: flex; flex-direction: column; -webkit-font-smoothing: antialiased; }
  button, input, select, textarea { font: inherit; color: inherit; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  /* top bar */
  header { height: 48px; flex: none; display: flex; align-items: center; gap: 16px; padding: 0 16px; border-bottom: 1px solid var(--line); }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 600; letter-spacing: -.01em; }
  .brand i { width: 18px; height: 18px; border-radius: 6px; background: var(--accent); display: block; position: relative; }
  .brand i::after { content: ""; position: absolute; inset: 5px 4px; border-top: 2px solid var(--on-accent); border-bottom: 2px solid var(--on-accent); }
  .seg { display: inline-flex; background: var(--raised); border: 1px solid var(--line); border-radius: 8px; padding: 2px; }
  .seg button { border: 0; background: transparent; padding: 3px 12px; border-radius: 6px; color: var(--tx-2); cursor: pointer; }
  .seg button:hover { color: var(--tx); }
  .seg button.on { background: var(--bg); color: var(--tx); font-weight: 550; box-shadow: 0 0 0 1px var(--line), 0 1px 2px rgba(0, 0, 0, .06); }
  .grow { flex: 1; }
  select.quiet { border: 1px solid transparent; background: transparent; border-radius: 6px; padding: 4px 8px; color: var(--tx-2); cursor: pointer; max-width: 260px; }
  select.quiet:hover { background: var(--hover); color: var(--tx); }
  .btn { border: 1px solid var(--line-2); background: var(--bg); border-radius: 8px; padding: 5px 12px; cursor: pointer; }
  .btn:hover { background: var(--hover); }
  .btn.ghost { border-color: transparent; color: var(--tx-2); }
  .btn.ghost:hover { color: var(--tx); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 550; }
  .btn.primary:hover { filter: brightness(1.08); background: var(--accent); }

  main { flex: 1; min-height: 0; display: flex; }

  /* job list: chrome, kept tight */
  #side { width: 300px; flex: none; border-right: 1px solid var(--line); display: flex; flex-direction: column; background: var(--raised); }
  .search { padding: 12px 12px 8px; display: flex; flex-direction: column; gap: 8px; }
  .field { width: 100%; border: 1px solid var(--line); background: var(--bg); border-radius: 8px; padding: 6px 10px; }
  .field::placeholder { color: var(--tx-4); }
  .field:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .search .row { display: flex; gap: 8px; }
  .search .seg { flex: 1; }
  .search .seg button { flex: 1; padding: 3px 4px; font-size: 12px; }
  #jobs { flex: 1; overflow: auto; padding: 0 8px 12px; }
  .day { font: 500 11px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--tx-4); padding: 16px 8px 8px; }
  .job { display: grid; grid-template-columns: 8px 1fr auto; gap: 0 10px; align-items: center; padding: 8px; border-radius: 8px; cursor: pointer; }
  .job:hover { background: var(--hover); }
  .job.on { background: var(--accent-soft); }
  .job .dot { grid-row: span 2; }
  .job .n { font-weight: 550; letter-spacing: -.005em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .job .t { font: 11px/1 var(--mono); color: var(--tx-3); }
  .job .s { grid-column: 2 / span 2; font-size: 12px; color: var(--tx-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tx-4); display: inline-block; flex: none; }
  .dot.bad { background: var(--bad); } .dot.good { background: var(--good); } .dot.wait { background: var(--wait); box-shadow: 0 0 0 3px var(--wait-soft); } .dot.warn { background: var(--warn); }

  /* reading column: content, given room */
  #detail { flex: 1; min-width: 0; overflow: auto; }
  .col { max-width: 920px; margin: 0 auto; padding: 32px 32px 64px; }
  .title { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 24px; line-height: 1.2; font-weight: 620; letter-spacing: -.02em; margin: 0; }
  .qual { font: 12px/1 var(--mono); color: var(--tx-3); }
  .facts { margin-top: 8px; color: var(--tx-2); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .facts .sep { color: var(--tx-4); }
  .pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 550; }
  .pill.bad { color: var(--bad); background: var(--bad-soft); } .pill.good { color: var(--good); background: var(--good-soft); }
  .pill.wait { color: var(--wait); background: var(--wait-soft); } .pill.warn { color: var(--warn); background: var(--warn-soft); } .pill.dim { color: var(--tx-2); background: var(--hover); }
  .eyebrow { font: 500 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--tx-3); margin: 32px 0 12px; }

  .finding { margin-top: 24px; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--bg); }
  .finding .top { padding: 20px 24px; border-left: 3px solid var(--tx-4); }
  .finding.bad .top { border-left-color: var(--bad); } .finding.wait .top { border-left-color: var(--wait); } .finding.warn .top { border-left-color: var(--warn); } .finding.good .top { border-left-color: var(--good); }
  .finding .label { font: 500 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--tx-3); display: flex; gap: 8px; align-items: center; }
  .finding .say { font-size: 16px; line-height: 1.45; font-weight: 550; letter-spacing: -.01em; margin: 12px 0 0; max-width: 70ch; }
  .finding .began { margin-top: 8px; color: var(--tx-2); max-width: 75ch; }
  .chip { font: 11px/1 var(--mono); border: 1px solid var(--line-2); border-radius: 6px; padding: 3px 6px; color: var(--tx-2); white-space: nowrap; }
  .where { border-top: 1px solid var(--line); padding: 16px 24px 20px; background: var(--raised); }
  .where .path { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font: 12px/1.5 var(--mono); color: var(--tx-2); }
  .where .path b { color: var(--tx); font-weight: 600; }
  .code { margin-top: 12px; display: grid; grid-template-columns: auto 1fr; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); font: 12px/1.7 var(--mono); overflow-x: auto; }
  .code .ln { padding: 8px 12px; color: var(--tx-4); border-right: 1px solid var(--line); text-align: right; user-select: none; }
  .code .tx { padding: 8px 12px; white-space: pre; }
  .act { margin-top: 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .hint { color: var(--tx-3); font-size: 12px; }
  details.more { margin-top: 12px; color: var(--tx-3); font-size: 12px; }
  details.more summary { cursor: pointer; width: fit-content; }
  details.more summary:hover { color: var(--tx-2); }
  details.more p { margin: 8px 0 0; max-width: 80ch; }

  /* what led to it: a timeline */
  .trail { position: relative; margin: 0; padding: 0; list-style: none; }
  .trail li { position: relative; display: grid; grid-template-columns: 76px auto 1fr; gap: 0 12px; padding: 8px 0 8px 24px; align-items: baseline; }
  .trail li::before { content: ""; position: absolute; left: 3px; top: 0; bottom: 0; width: 1px; background: var(--line-2); }
  .trail li:first-child::before { top: 14px; } .trail li:last-child::before { bottom: calc(100% - 14px); }
  .trail li::after { content: ""; position: absolute; left: 0; top: 13px; width: 7px; height: 7px; border-radius: 50%; background: var(--bg); border: 1px solid var(--tx-3); }
  .trail li.end::after { background: var(--bad); border-color: var(--bad); }
  .trail .tm { font: 11px/1.6 var(--mono); color: var(--tx-3); }
  .trail .tx { min-width: 0; }
  .trail .pg { display: block; font: 11px/1.6 var(--mono); color: var(--tx-3); }

  /* the whole log */
  .tools { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
  .tools .field { width: 220px; }
  .tools label { color: var(--tx-2); display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
  .log { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .m { display: grid; grid-template-columns: 8px 84px 76px 1fr; gap: 0 12px; align-items: baseline; padding: 7px 16px; border-top: 1px solid var(--line); cursor: pointer; }
  .m:first-child { border-top: 0; }
  .m:hover { background: var(--raised); }
  .m.led { background: var(--bad-soft); }
  .m .dot { align-self: center; width: 6px; height: 6px; }
  .m .tm, .m .id { font: 11px/1.6 var(--mono); color: var(--tx-3); }
  .m .id { color: var(--tx-2); }
  .m .tx { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .m.open .tx { white-space: normal; font-weight: 550; }
  .mx { padding: 4px 16px 16px 196px; border-top: 0; color: var(--tx-2); white-space: pre-wrap; max-width: 100%; }
  .mx .kv { display: grid; grid-template-columns: 44px 1fr; gap: 2px 12px; margin-top: 12px; font: 11px/1.6 var(--mono); color: var(--tx-3); white-space: normal; }
  .count { color: var(--tx-3); font-size: 12px; margin-top: 8px; }

  /* readiness */
  .checks { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; margin-top: 24px; }
  .check { display: grid; grid-template-columns: 20px 1fr; gap: 2px 12px; padding: 14px 20px; border-top: 1px solid var(--line); }
  .check:first-child { border-top: 0; }
  .check .ic { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; margin-top: 1px; }
  .check .ic.good { color: var(--good); background: var(--good-soft); } .check .ic.bad { color: var(--bad); background: var(--bad-soft); } .check .ic.warn { color: var(--warn); background: var(--warn-soft); }
  .check b { font-weight: 550; }
  .check .d { grid-column: 2; color: var(--tx-2); }
  .check .f { grid-column: 2; margin-top: 4px; }
  .form { display: flex; gap: 8px; margin-top: 24px; flex-wrap: wrap; }
  .form .field { width: 180px; }

  .empty { height: 100%; display: grid; place-items: center; text-align: center; color: var(--tx-3); padding: 48px; }
  .empty b { display: block; color: var(--tx); font-size: 16px; font-weight: 600; letter-spacing: -.01em; margin-bottom: 4px; }
  .quiet-note { color: var(--tx-3); padding: 24px 8px; text-align: center; font-size: 12px; }
  .err { color: var(--bad); background: var(--bad-soft); border-radius: 8px; padding: 10px 12px; margin-top: 16px; }
  .skel { height: 12px; border-radius: 6px; background: var(--hover); margin: 12px 0; animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .45; } }

  dialog { border: 1px solid var(--line-2); border-radius: 12px; background: var(--bg); color: var(--tx); width: min(860px, 92vw); padding: 24px; box-shadow: var(--shadow); }
  dialog::backdrop { background: rgba(8, 10, 14, .45); }
  dialog h2 { margin: 0 0 4px; font-size: 16px; font-weight: 600; letter-spacing: -.01em; }
  dialog p { margin: 0 0 16px; color: var(--tx-2); }
  dialog textarea { width: 100%; height: 46vh; resize: vertical; border: 1px solid var(--line); border-radius: 8px; background: var(--raised); padding: 12px; font: 12px/1.5 var(--mono); }
  dialog .act { justify-content: flex-end; }
  footer { flex: none; padding: 6px 16px; border-top: 1px solid var(--line); color: var(--tx-4); font: 11px/1.4 var(--mono); }
  header, header * { white-space: nowrap; }
  #back { display: none; }
  /* A narrow window (docked beside something else): the list or the job, one at a time. */
  @media (max-width: 820px) {
    header { gap: 8px; padding: 0 12px; }
    .brand span { display: none; }
    #side { width: auto; flex: 1; border-right: 0; }
    body.reading #side { display: none; }
    body:not(.reading) #detail { display: none; }
    body.reading #back { display: inline-flex; }
    .col { padding: 20px 16px 48px; }
    h1 { font-size: 20px; }
    .finding .top, .where { padding-left: 16px; padding-right: 16px; }
    .trail li { grid-template-columns: 60px 1fr; }
    .trail .tx { grid-column: 1 / -1; }
    .mx { padding-left: 16px; }
    .m { grid-template-columns: 8px 60px 1fr; }
    .m .tx { grid-column: 2 / -1; white-space: normal; }
    .tools .field { width: 100%; }
  }
</style>
</head>
<body>
<header>
  <button id="back" class="btn ghost" title="Back to the list of jobs">‹ Jobs</button>
  <span class="brand"><i></i><span>IBM i workbench</span></span>
  <span class="seg" role="tablist"><button id="tab-jobs" class="on">Jobs</button><button id="tab-debug">Debug readiness</button></span>
  <span class="grow"></span>
  <select id="conn" class="quiet" title="Connection"></select>
  <button id="paste" class="btn ghost" title="Read a job log you paste in">Paste log</button>
</header>
<main>
  <section id="side">
    <div class="search">
      <input id="f-name" class="field" placeholder="Job name  (NIGHT* finds all that start so)" />
      <div class="row">
        <input id="f-user" class="field" placeholder="User: you" title="Whose jobs; empty for the connection's user" style="width:110px" />
        <span class="seg" id="f-state"><button data-v="*ALL" class="on">All</button><button data-v="*ACTIVE">Active</button><button data-v="*OUTQ">Ended</button></span>
      </div>
    </div>
    <div id="jobs"></div>
  </section>
  <section id="detail"></section>
</main>
<footer>mcp-for-i ${version} · reads only · shows what the ibmi.jobs tools return</footer>
<dialog id="paste-box">
  <h2>Read a job log</h2>
  <p>Paste the text of a QPJOBLOG spooled file, or what DSPJOBLOG printed.</p>
  <textarea id="paste-text" spellcheck="false"></textarea>
  <div class="act"><button id="paste-cancel" class="btn ghost">Cancel</button><button id="paste-read" class="btn primary">Read it</button></div>
</dialog>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var token = params.get("t") || "";
  var state = { conn: params.get("c") || "", view: params.get("view") === "debug" ? "debug" : "jobs", job: params.get("job") || "", jobState: "*ALL", log: null, marks: {}, filter: "serious", search: "", follow: false, timer: null, open: {} };
  var $ = function (id) { return document.getElementById(id); };

  function h(tag, props) {
    var node = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (key) {
      var value = props[key];
      if (value === undefined || value === null || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    });
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === undefined || child === null || child === false) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function reading(on) { document.body.className = on ? "reading" : ""; }
  function column() { var col = h("div", { class: "col" }); clear($("detail")).appendChild(col); $("detail").scrollTop = 0; reading(true); return col; }
  function emptyState(title, text) { clear($("detail")).appendChild(h("div", { class: "empty" }, h("div", {}, h("b", { text: title }), text))); reading(false); }
  function skeleton(node) { [70, 92, 55].forEach(function (w) { node.appendChild(h("div", { class: "skel", style: "width:" + w + "%" })); }); return node; }

  function call(tool, args) {
    return fetch("/api/call?t=" + encodeURIComponent(token), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: tool, args: Object.assign({ connectionName: state.conn }, args || {}) })
    }).then(function (res) { return res.json(); }).then(function (body) {
      if (!body.ok) throw new Error(body.error || "The request failed.");
      return body.data;
    });
  }

  // ---- words ----
  function shortName(job) { return String(job).split("/").pop(); }
  function place(p) {
    if (!p || !p.program) return "";
    var s = (p.library ? p.library + "/" : "") + p.program;
    if (p.procedure && p.procedure !== p.program) s += " · " + p.procedure;
    if (p.statement) s += " · statement " + p.statement;
    return s;
  }
  function ownSide(m) { return m.to && m.to.program && m.to.library && !/^Q/.test(m.to.library) ? m.to : m.from; }
  function clockOf(t) { return t ? String(t).replace("T", " ").slice(11, 19) : ""; }
  function sentence(m) { return m ? String(m.text || "").replace(/[.\\s]+$/, "") + "." : ""; }
  function tone(v) { return v === "failed" ? "bad" : v === "waiting" ? "wait" : v === "warnings" ? "warn" : "good"; }
  function verdictWords(v) { return v === "failed" ? "Failed" : v === "waiting" ? "Waiting for a reply" : v === "warnings" ? "Ended with warnings" : "Nothing wrong found"; }
  function messageTone(m) { return m.type === "ESCAPE" || m.type === "INQUIRY" ? "bad" : m.type === "DIAGNOSTIC" || (m.severity || 0) >= 30 ? "warn" : m.type === "COMPLETION" ? "good" : ""; }
  function parseStamp(s) { if (!s) return null; var d = new Date(String(s).replace(" ", "T").slice(0, 19)); return isNaN(d.getTime()) ? null : d; }
  function duration(a, b) {
    var from = parseStamp(a), to = parseStamp(b);
    if (!from || !to) return "";
    var s = Math.max(0, Math.round((to - from) / 1000));
    if (s < 60) return s + " s";
    if (s < 3600) return Math.floor(s / 60) + " min " + (s % 60) + " s";
    return Math.floor(s / 3600) + " h " + Math.floor((s % 3600) / 60) + " min";
  }
  function dayLabel(stamp) {
    var d = parseStamp(stamp);
    if (!d) return "Earlier";
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var that = new Date(d); that.setHours(0, 0, 0, 0);
    var days = Math.round((today - that) / 86400000);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }
  function typeWords(t) { return t ? t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, " ") : ""; }

  function openSource(loc) {
    var src = loc.source || {};
    var msg = { type: "mcp-for-i.openSource", connectionName: state.conn, library: src.library, file: src.file, member: src.member, streamFile: src.streamFile, line: loc.line };
    try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, "*"); } catch (e) {}
    try { if (window.opener) window.opener.postMessage(msg, "*"); } catch (e) {}
    var where = src.streamFile ? src.streamFile : src.library + "/" + src.file + "(" + src.member + ")";
    var text = where + (loc.line ? " line " + loc.line : "");
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {});
    return text;
  }

  // ---- connections ----
  function loadConnections() {
    return fetch("/api/connections?t=" + encodeURIComponent(token)).then(function (r) { return r.json(); }).then(function (body) {
      var select = clear($("conn"));
      (body.connections || []).forEach(function (c) { select.appendChild(h("option", { value: c.name, text: c.name })); });
      if (!state.conn && body.connections && body.connections.length) state.conn = (body.active || body.connections[0].name);
      select.value = state.conn;
    });
  }

  // ---- the job list ----
  function jobTone(job) {
    if (job.activeStatus === "MSGW") return "wait";
    if (job.state === "ACTIVE") return "good";
    if (job.completion === "ABNORMAL") return "bad";
    return "";
  }
  function jobWords(job) {
    if (job.activeStatus === "MSGW") return "Waiting on a message";
    if (job.state === "ACTIVE") return "Running" + (job.function ? " · " + job.function : "");
    if (job.state === "JOBQ") return "On job queue" + (job.jobQueue ? " " + job.jobQueue : "");
    if (job.completion === "ABNORMAL") return "Ended abnormally";
    return "Ended";
  }
  function markSelected() {
    Array.prototype.forEach.call(document.querySelectorAll(".job"), function (n) { n.className = "job" + (n.getAttribute("data-job") === state.job ? " on" : ""); });
  }
  function findJobs() {
    var box = clear($("jobs"));
    if (!state.conn) { box.appendChild(h("div", { class: "quiet-note", text: "Choose a connection." })); return; }
    skeleton(box);
    call("ibmi.jobs.find", { userName: $("f-user").value.trim() || undefined, name: $("f-name").value.trim() || undefined, state: state.jobState, limit: 150 }).then(function (got) {
      clear(box);
      if (!got.jobs.length) { box.appendChild(h("div", { class: "quiet-note", text: "No jobs of " + got.user + " match." })); return; }
      var day = "";
      got.jobs.forEach(function (job) {
        var stamp = job.ended || job.started || job.entered || "";
        var label = dayLabel(stamp);
        if (label !== day) { day = label; box.appendChild(h("div", { class: "day", text: label })); }
        var parts = job.jobName.split("/");
        box.appendChild(h("div", { class: "job", "data-job": job.jobName, title: job.jobName + (job.endReason ? "\\n" + job.endReason : ""), onclick: function () { showJob(job.jobName); } },
          h("span", { class: "dot " + jobTone(job) }),
          h("span", { class: "n", text: parts[2] || job.jobName }),
          h("span", { class: "t", text: stamp.slice(11, 16) }),
          h("span", { class: "s", text: jobWords(job) + " · " + parts[0] })));
      });
      if (got.truncated) box.appendChild(h("div", { class: "quiet-note", text: "More jobs match. Narrow the search." }));
      markSelected();
    }).catch(function (err) { clear(box).appendChild(h("div", { class: "err", text: err.message })); });
  }

  // ---- what happened ----
  function finding(d) {
    var t = tone(d.verdict);
    var main = d.waitingOn || d.failure;
    var box = h("div", { class: "finding " + t });
    var top = h("div", { class: "top" });
    top.appendChild(h("div", { class: "label" }, d.verdict === "failed" ? "Why it failed" : d.verdict === "waiting" ? "What it is waiting for" : d.verdict === "warnings" ? "Worth a look" : "Result", main && main.id ? h("span", { class: "chip", text: main.id }) : null));
    top.appendChild(h("p", { class: "say", text: main ? sentence(main) : (d.summary || "Nothing in the log says the job failed.") }));
    if (d.rootCause && d.rootCause !== main) top.appendChild(h("div", { class: "began" }, "It began with ", h("span", { class: "chip", text: d.rootCause.id || "a message" }), " " + sentence(d.rootCause)));
    else if (d.ended && d.verdict !== "failed" && main) top.appendChild(h("div", { class: "began", text: d.ended.meaning }));
    box.appendChild(top);

    var loc = d.location;
    if (d.suspect) {
      var where = h("div", { class: "where" });
      var path = h("div", { class: "path" }, h("b", { text: (d.suspect.library ? d.suspect.library + "/" : "") + d.suspect.program }));
      if (d.suspect.procedure && d.suspect.procedure !== d.suspect.program) path.appendChild(h("span", { text: d.suspect.procedure }));
      if (d.suspect.statement) path.appendChild(h("span", { text: "statement " + d.suspect.statement }));
      if (loc && loc.source) path.appendChild(h("span", { text: "→  " + (loc.source.streamFile || (loc.source.library + "/" + loc.source.file + "(" + loc.source.member + ")")) + (loc.line ? "  line " + loc.line : "") }));
      where.appendChild(path);
      if (loc && loc.lineText) where.appendChild(h("div", { class: "code" }, h("div", { class: "ln", text: String(loc.line) }), h("div", { class: "tx", text: loc.lineText })));
      if (loc && loc.source) {
        var said = h("span", { class: "hint", text: loc.line ? (loc.confidence === "exact" ? "The line is exact." : "The line is probable, not certain.") : "The line could not be worked out." });
        where.appendChild(h("div", { class: "act" }, h("button", { class: "btn primary", text: "Open source", onclick: function () { said.textContent = "Copied  " + openSource(loc); } }), said));
      }
      var notes = (loc && loc.notes || []).concat(d.notes || []);
      if (notes.length) {
        var more = h("details", { class: "more" }, h("summary", { text: "How sure is this" }));
        notes.forEach(function (n) { more.appendChild(h("p", { text: n })); });
        where.appendChild(more);
      }
      box.appendChild(where);
    } else if (d.notes && d.notes.length) {
      var only = h("div", { class: "where" });
      d.notes.forEach(function (n) { only.appendChild(h("div", { class: "hint", text: n })); });
      box.appendChild(only);
    }
    return box;
  }

  function trail(chain, endPosition) {
    var list = h("ol", { class: "trail" });
    chain.forEach(function (m) {
      list.appendChild(h("li", { class: m.position === endPosition ? "end" : "" },
        h("span", { class: "tm", text: clockOf(m.time) }),
        h("span", { class: "chip", text: m.id || typeWords(m.type) }),
        h("span", { class: "tx" }, m.text, h("span", { class: "pg", text: place(ownSide(m)) }))));
    });
    return list;
  }

  // ---- the whole log ----
  function shown() {
    if (!state.log) return [];
    var needle = state.search.toUpperCase();
    return state.log.messages.filter(function (m) {
      if (state.filter === "serious" && !((m.severity || 0) >= 30 || m.type === "ESCAPE" || m.type === "INQUIRY" || m.type === "DIAGNOSTIC" || state.marks[m.position])) return false;
      if (needle && ((m.id || "") + " " + m.text + " " + (m.help || "")).toUpperCase().indexOf(needle) < 0) return false;
      return true;
    });
  }
  function renderMessages() {
    var holder = $("messages");
    if (!holder || !state.log) return;
    clear(holder);
    var list = shown();
    if (!list.length) holder.appendChild(h("div", { class: "quiet-note", text: state.filter === "serious" && !state.search ? "No serious messages. Show all to read the whole log." : "No messages match." }));
    else {
      var log = h("div", { class: "log" });
      list.forEach(function (m) {
        var open = state.open[m.position];
        log.appendChild(h("div", { class: "m" + (state.marks[m.position] ? " led" : "") + (open ? " open" : ""), onclick: function () { state.open[m.position] = !open; renderMessages(); } },
          h("span", { class: "dot " + messageTone(m), title: typeWords(m.type) + (m.severity !== null && m.severity !== undefined ? ", severity " + m.severity : "") }),
          h("span", { class: "tm", text: clockOf(m.time) }),
          h("span", { class: "id", text: m.id || typeWords(m.type) }),
          h("span", { class: "tx", text: m.text })));
        if (open) {
          var kv = h("div", { class: "kv" }, h("span", { text: "Type" }), h("span", { text: typeWords(m.type) + (m.severity !== null && m.severity !== undefined ? " · severity " + m.severity : "") }), h("span", { text: "From" }), h("span", { text: place(m.from) || "-" }), h("span", { text: "To" }), h("span", { text: place(m.to) || "-" }));
          log.appendChild(h("div", { class: "mx" }, m.help || "", kv));
        }
      });
      holder.appendChild(log);
    }
    var count = $("count");
    if (count) count.textContent = list.length + " of " + state.log.messages.length + " messages" + (state.log.truncated ? " · the log is longer, this is its end" : "") + (state.log.source === "spooled" ? " · read from the printed job log" : "");
  }
  function logSection(parent) {
    parent.appendChild(h("div", { class: "eyebrow", text: "Job log" }));
    var seg = h("span", { class: "seg" });
    [["serious", "Serious"], ["all", "All"]].forEach(function (c) {
      seg.appendChild(h("button", { class: state.filter === c[0] ? "on" : "", text: c[1], onclick: function () { state.filter = c[0]; Array.prototype.forEach.call(seg.children, function (b) { b.className = ""; }); this.className = "on"; renderMessages(); } }));
    });
    var tools = h("div", { class: "tools" }, seg, h("input", { class: "field", placeholder: "Find in messages", value: state.search, oninput: function () { state.search = this.value; renderMessages(); } }));
    if (state.job && state.log && state.log.source === "live") {
      var box = h("input", { type: "checkbox", onchange: function () { state.follow = this.checked; follow(); } });
      tools.appendChild(h("label", {}, box, "Follow new messages"));
    }
    parent.appendChild(tools);
    parent.appendChild(h("div", { id: "messages" }));
    parent.appendChild(h("div", { id: "count", class: "count" }));
  }
  function follow() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (!state.follow || !state.job || !state.log) return;
    state.timer = setInterval(function () {
      var job = state.job;
      call("ibmi.jobs.log", { jobName: job, after: state.log.lastPosition || 0, limit: 500 }).then(function (more) {
        if (job !== state.job || !more.messages.length) return;
        state.log.messages = state.log.messages.concat(more.messages);
        state.log.lastPosition = more.lastPosition;
        renderMessages();
      }).catch(function () {});
    }, 3000);
  }

  // ---- one job ----
  function showJob(jobName) {
    state.job = jobName; state.log = null; state.open = {}; state.marks = {}; state.follow = false; state.search = ""; state.filter = "serious"; follow();
    markSelected();
    var col = column();
    var facts = h("div", { class: "facts" });
    col.appendChild(h("div", { class: "title" }, h("h1", { text: shortName(jobName) }), h("span", { class: "qual", text: jobName })));
    col.appendChild(facts);
    var diag = skeleton(h("div"));
    var after = h("div");
    var log = h("div");
    col.appendChild(diag); col.appendChild(after); col.appendChild(log);

    call("ibmi.jobs.diagnose", { jobName: jobName }).then(function (d) {
      if (state.job !== jobName) return;
      facts.appendChild(h("span", { class: "pill " + tone(d.verdict) }, h("span", { class: "dot " + tone(d.verdict) }), verdictWords(d.verdict)));
      var bits = [];
      if (d.job) {
        if (d.job.type) bits.push(typeWords(d.job.type));
        if (d.job.ended) bits.push("ended " + d.job.ended.slice(0, 16));
        else if (d.job.started) bits.push("started " + d.job.started.slice(0, 16));
        var took = duration(d.job.started, d.job.ended);
        if (took) bits.push("ran " + took);
        if (d.job.submittedBy) bits.push("submitted by " + shortName(d.job.submittedBy));
      }
      if (d.ended) bits.push("end code " + d.ended.endCode);
      bits.forEach(function (b) { facts.appendChild(h("span", { class: "sep", text: "·" })); facts.appendChild(h("span", { text: b })); });
      clear(diag).appendChild(finding(d));
      (d.chain || []).forEach(function (m) { state.marks[m.position] = true; });
      var end = (d.waitingOn || d.failure || {}).position;
      if (d.chain && d.chain.length > 1) { after.appendChild(h("div", { class: "eyebrow", text: "What led to it" })); after.appendChild(trail(d.chain, end)); }
      if (d.stack && d.stack.length) {
        after.appendChild(h("div", { class: "eyebrow", text: "Where it stands now" }));
        after.appendChild(trail(d.stack.map(function (e, i) { return { position: i, time: "", id: e.program, type: "", text: (e.procedure || e.module || "") + (e.statement ? "  statement " + e.statement : ""), from: { library: e.library, program: e.program } }; }), -1));
      }
      renderMessages();
    }).catch(function (err) { if (state.job === jobName) clear(diag).appendChild(h("div", { class: "err", text: err.message })); });

    call("ibmi.jobs.log", { jobName: jobName, order: "newest", limit: 2000 }).then(function (got) {
      if (state.job !== jobName) return;
      got.messages.reverse();
      state.log = got;
      logSection(log);
      renderMessages();
    }).catch(function (err) { if (state.job === jobName) log.appendChild(h("div", { class: "err", text: err.message })); });
  }

  // ---- pasted text ----
  function readPasted(text) {
    state.job = ""; state.follow = false; follow(); state.open = {}; state.marks = {}; state.search = ""; state.filter = "serious"; markSelected();
    var col = column();
    skeleton(col);
    call("ibmi.joblog.parse", { text: text, limit: 5000 }).then(function (d) {
      clear(col);
      var name = (d.job && d.job.qualified) || "";
      col.appendChild(h("div", { class: "title" }, h("h1", { text: name ? shortName(name) : "Pasted job log" }), name ? h("span", { class: "qual", text: name }) : null));
      var facts = h("div", { class: "facts" }, h("span", { class: "pill " + tone(d.verdict) }, h("span", { class: "dot " + tone(d.verdict) }), verdictWords(d.verdict)));
      if (d.ended) { facts.appendChild(h("span", { class: "sep", text: "·" })); facts.appendChild(h("span", { text: "end code " + d.ended.endCode })); }
      col.appendChild(facts);
      col.appendChild(finding(d));
      (d.chain || []).forEach(function (m) { state.marks[m.position] = true; });
      if (d.chain && d.chain.length > 1) { col.appendChild(h("div", { class: "eyebrow", text: "What led to it" })); col.appendChild(trail(d.chain, (d.waitingOn || d.failure || {}).position)); }
      state.log = { messages: d.messages || [], truncated: d.truncated, source: "pasted" };
      logSection(col);
      renderMessages();
    }).catch(function (err) { clear(col).appendChild(h("div", { class: "err", text: err.message })); });
  }

  // ---- debug readiness ----
  function showDebug() {
    var col = column();
    col.appendChild(h("div", { class: "title" }, h("h1", { text: "Debug readiness" })));
    var facts = h("div", { class: "facts", text: "Whether programs on this system can be debugged from this computer, and what is in the way." });
    col.appendChild(facts);
    var lib = h("input", { class: "field", placeholder: "Library" });
    var pgm = h("input", { class: "field", placeholder: "Program (optional)" });
    var out = h("div");
    var run = function () {
      skeleton(clear(out));
      call("ibmi.debug.ready", { library: lib.value.trim() || undefined, program: pgm.value.trim() || undefined }).then(function (r) {
        clear(out);
        var box = h("div", { class: "finding " + (r.ready ? "good" : "bad") });
        box.appendChild(h("div", { class: "top" }, h("div", { class: "label", text: r.host + (r.serviceVersion ? "  ·  Debug Service " + r.serviceVersion : "") }), h("p", { class: "say", text: r.ready ? "Ready. Nothing was found that would stop a debug session." : r.summary })));
        out.appendChild(box);
        var list = h("div", { class: "checks" });
        r.checks.forEach(function (c) {
          var kind = c.ok === true ? "good" : c.ok === false ? "bad" : "warn";
          var row = h("div", { class: "check" }, h("span", { class: "ic " + kind, text: c.ok === true ? "✓" : c.ok === false ? "!" : "?" }), h("b", { text: c.title }), h("div", { class: "d", text: c.detail }));
          if (c.fix) row.appendChild(h("div", { class: "f" }, h("span", { class: "chip", text: c.who === "administrator" ? "Administrator" : "You" }), "  " + c.fix));
          list.appendChild(row);
        });
        out.appendChild(list);
        var more = h("details", { class: "more" }, h("summary", { text: "What this does not check" }));
        (r.notes || []).forEach(function (n) { more.appendChild(h("p", { text: n })); });
        out.appendChild(more);
      }).catch(function (err) { clear(out).appendChild(h("div", { class: "err", text: err.message })); });
    };
    col.appendChild(h("div", { class: "form" }, lib, pgm, h("button", { class: "btn", text: "Check again", onclick: run })));
    col.appendChild(out);
    if (state.conn) run();
  }

  function setView(view) {
    state.view = view; state.follow = false; follow();
    $("tab-jobs").className = view === "jobs" ? "on" : "";
    $("tab-debug").className = view === "debug" ? "on" : "";
    $("side").style.display = view === "jobs" ? "" : "none";
    if (view === "debug") showDebug();
    else if (state.job) showJob(state.job);
    else emptyState("Pick a job", "You will see why it ended the way it did, and where in the code.");
  }

  $("back").onclick = function () { state.job = ""; markSelected(); setView("jobs"); };
  $("tab-jobs").onclick = function () { setView("jobs"); };
  $("tab-debug").onclick = function () { setView("debug"); };
  ["f-user", "f-name"].forEach(function (id) { $(id).addEventListener("keydown", function (e) { if (e.key === "Enter") findJobs(); }); });
  Array.prototype.forEach.call($("f-state").children, function (b) {
    b.onclick = function () { state.jobState = b.getAttribute("data-v"); Array.prototype.forEach.call($("f-state").children, function (o) { o.className = ""; }); b.className = "on"; findJobs(); };
  });
  $("conn").onchange = function () { state.conn = this.value; state.job = ""; findJobs(); setView(state.view); };
  $("paste").onclick = function () { $("paste-box").showModal(); $("paste-text").focus(); };
  $("paste-cancel").onclick = function () { $("paste-box").close(); };
  $("paste-read").onclick = function () { var text = $("paste-text").value; $("paste-box").close(); if (text.trim()) { setView("jobs"); readPasted(text); } };

  loadConnections().then(function () { findJobs(); setView(state.view); }).catch(function (err) { clear($("jobs")).appendChild(h("div", { class: "err", text: err.message })); });
})();
</script>
</body>
</html>`;
}
