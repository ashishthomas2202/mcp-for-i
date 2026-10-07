export function renderControlPlaneHtml(token = "") {
  // The token is hex, but escape it anyway since it lands inside an attribute.
  const tokenAttr = escapeAttribute(token);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="mcp-for-i-token" content="${tokenAttr}" />
  <title>MCP for i · Control Plane</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%232563eb'/%3E%3Cpath d='M16 9.5v1.2M16 14v8.5' stroke='white' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E" />
  <script>
    (function () {
      var t = null;
      try { t = localStorage.getItem("mcp_for_i_theme"); } catch (e) {}
      if (t !== "light" && t !== "dark") t = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", t);
    })();
  </script>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f6f8;
      --surface: #ffffff;
      --surface-2: #f9fafb;
      --hover: #f1f3f6;
      --line: rgba(15, 23, 42, 0.09);
      --line-strong: rgba(15, 23, 42, 0.16);
      --text: #0f172a;
      --text-2: #475569;
      --text-3: #64748b;
      --accent: #2563eb;
      --accent-hover: #1d4ed8;
      --accent-soft: rgba(37, 99, 235, 0.09);
      --on-accent: #ffffff;
      --ok: #15803d;
      --ok-soft: rgba(22, 163, 74, 0.1);
      --warn: #b45309;
      --warn-soft: rgba(217, 119, 6, 0.11);
      --danger: #dc2626;
      --danger-hover: #b91c1c;
      --danger-soft: rgba(220, 38, 38, 0.09);
      --shadow-float: 0 1px 2px rgba(15, 23, 42, 0.06), 0 8px 24px rgba(15, 23, 42, 0.1), 0 24px 48px rgba(15, 23, 42, 0.08);
      --shadow-card: 0 1px 2px rgba(15, 23, 42, 0.04);
      --ring: 0 0 0 3px rgba(37, 99, 235, 0.22);
      --backdrop: rgba(15, 23, 42, 0.38);
      --r-sm: 6px;
      --r-md: 8px;
      --r-lg: 10px;
      --r-xl: 13px;
      --font: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      --mono: ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace;
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --bg: #0b0d12;
      --surface: #12151c;
      --surface-2: #161a22;
      --hover: #1c212b;
      --line: rgba(255, 255, 255, 0.08);
      --line-strong: rgba(255, 255, 255, 0.15);
      --text: #e7eaf0;
      --text-2: #a6afbd;
      --text-3: #7c8696;
      --accent: #4f8cff;
      --accent-hover: #6b9fff;
      --accent-soft: rgba(79, 140, 255, 0.13);
      --on-accent: #ffffff;
      --ok: #3fb950;
      --ok-soft: rgba(63, 185, 80, 0.13);
      --warn: #d29922;
      --warn-soft: rgba(210, 153, 34, 0.14);
      --danger: #f85149;
      --danger-hover: #ff6a62;
      --danger-soft: rgba(248, 81, 73, 0.13);
      --shadow-float: 0 1px 2px rgba(0, 0, 0, 0.4), 0 12px 32px rgba(0, 0, 0, 0.45);
      --shadow-card: none;
      --ring: 0 0 0 3px rgba(79, 140, 255, 0.3);
      --backdrop: rgba(0, 0, 0, 0.6);
    }

    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    html, body { height: 100%; }
    body {
      margin: 0;
      font: 400 13.5px/1.5 var(--font);
      color: var(--text);
      background: var(--bg);
      -webkit-font-smoothing: antialiased;
    }
    svg { flex: none; }
    .icon { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
    .mono { font-family: var(--mono); }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

    /* Shell */
    .shell { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100%; }
    .sidebar {
      position: sticky; top: 0; height: 100vh;
      display: flex; flex-direction: column; gap: 24px;
      padding: 16px 12px;
      border-right: 1px solid var(--line);
      background: var(--surface);
    }
    .brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px; }
    .brand-mark {
      width: 28px; height: 28px; border-radius: var(--r-md);
      display: grid; place-items: center;
      background: var(--accent); color: var(--on-accent);
    }
    .brand-name { font-weight: 600; letter-spacing: -0.01em; }
    .brand-sub { font: 500 10.5px/1.2 var(--mono); color: var(--text-3); letter-spacing: 0.08em; text-transform: uppercase; }
    .nav { display: flex; flex-direction: column; gap: 2px; }
    .nav-label { font: 500 10.5px/1 var(--mono); color: var(--text-3); letter-spacing: 0.1em; text-transform: uppercase; padding: 0 8px 8px; }
    .nav-item {
      display: flex; align-items: center; gap: 10px;
      width: 100%; padding: 7px 8px;
      border: 0; border-radius: var(--r-md);
      background: transparent; color: var(--text-2);
      font: 500 13.5px/1.4 var(--font); text-align: left;
      cursor: pointer;
    }
    .nav-item:hover { background: var(--hover); color: var(--text); }
    .nav-item:focus-visible { outline: none; box-shadow: var(--ring); }
    .nav-item[aria-current="page"] { background: var(--accent-soft); color: var(--accent); }
    .nav-item .count {
      margin-left: auto; min-width: 20px; padding: 0 6px;
      border-radius: 999px; background: var(--hover); color: var(--text-3);
      font: 500 11px/18px var(--mono); text-align: center;
    }
    .nav-item[aria-current="page"] .count { background: transparent; color: inherit; }
    .sidebar-foot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; }
    .service {
      display: flex; align-items: center; gap: 10px;
      padding: 10px; border: 1px solid var(--line); border-radius: var(--r-lg);
      background: var(--surface-2);
    }
    .service-text { min-width: 0; }
    .service-title { font-weight: 500; font-size: 12.5px; }
    .service-detail { color: var(--text-3); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); flex: none; }
    .service[data-state="online"] .pulse { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
    .service[data-state="reconnecting"] .pulse { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); animation: blink 1.2s ease-in-out infinite; }
    .service[data-state="offline"] .pulse { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }
    @keyframes blink { 50% { opacity: 0.35; } }

    /* Main */
    .main { min-width: 0; padding: 32px 40px 64px; }
    .page { display: none; max-width: 1080px; margin: 0 auto; }
    .page.active { display: block; animation: fade 0.18s ease-out; }
    @keyframes fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    .page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
    .page-head h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.25; }
    .page-head p { margin: 4px 0 0; color: var(--text-2); max-width: 64ch; }
    .head-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .stack { display: grid; gap: 16px; }

    /* Cards */
    .card {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--r-xl);
      box-shadow: var(--shadow-card);
    }
    .card-head {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 14px 16px; border-bottom: 1px solid var(--line);
    }
    .card-head h2 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
    .card-head .sub { color: var(--text-3); font-size: 12px; margin-top: 2px; }
    .card-body { padding: 16px; }
    .eyebrow { font: 500 10.5px/1.2 var(--mono); color: var(--text-3); letter-spacing: 0.1em; text-transform: uppercase; }

    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
    .stat { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .stat-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .stat-value { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.2; word-break: break-word; }
    .stat-meta { color: var(--text-3); font-size: 12px; min-height: 18px; word-break: break-word; }

    /* Chips */
    .chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 2px 8px; border-radius: 999px;
      font: 500 11.5px/18px var(--font); white-space: nowrap;
      background: var(--hover); color: var(--text-2);
    }
    .chip::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: 0.85; }
    .chip.plain::before { display: none; }
    .chip.ok { background: var(--ok-soft); color: var(--ok); }
    .chip.warn { background: var(--warn-soft); color: var(--warn); }
    .chip.danger { background: var(--danger-soft); color: var(--danger); }
    .chip.info { background: var(--accent-soft); color: var(--accent); }
    .chip.running::before { animation: blink 1s ease-in-out infinite; }
    .tag {
      display: inline-block; padding: 1px 6px; margin: 1px 4px 1px 0;
      border: 1px solid var(--line); border-radius: var(--r-sm);
      font: 500 11.5px/18px var(--mono); color: var(--text-2); background: var(--surface-2);
    }
    .tag.strong { color: var(--text); border-color: var(--line-strong); }

    /* Banner */
    .banner {
      display: flex; gap: 12px; align-items: flex-start;
      padding: 12px 16px; border-radius: var(--r-xl);
      border: 1px solid var(--line); background: var(--surface);
    }
    .banner .b-icon { width: 28px; height: 28px; border-radius: var(--r-md); display: grid; place-items: center; background: var(--hover); color: var(--text-3); flex: none; }
    .banner.ok .b-icon { background: var(--ok-soft); color: var(--ok); }
    .banner.warn .b-icon { background: var(--warn-soft); color: var(--warn); }
    .banner.danger .b-icon { background: var(--danger-soft); color: var(--danger); }
    .banner-title { font-weight: 500; }
    .banner-text { color: var(--text-2); font-size: 12.5px; }

    /* Buttons */
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      height: 32px; padding: 0 12px;
      border: 1px solid transparent; border-radius: var(--r-md);
      font: 500 13px/1 var(--font); white-space: nowrap;
      cursor: pointer; transition: background 0.12s, border-color 0.12s, color 0.12s;
    }
    .btn:focus-visible { outline: none; box-shadow: var(--ring); }
    .btn[disabled] { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: var(--accent); color: var(--on-accent); }
    .btn-primary:not([disabled]):hover { background: var(--accent-hover); }
    .btn-secondary { background: var(--surface); color: var(--text); border-color: var(--line-strong); box-shadow: var(--shadow-card); }
    .btn-secondary:not([disabled]):hover { background: var(--hover); }
    .btn-ghost { background: transparent; color: var(--text-2); }
    .btn-ghost:not([disabled]):hover { background: var(--hover); color: var(--text); }
    .btn-danger { background: var(--danger); color: #fff; }
    .btn-danger:not([disabled]):hover { background: var(--danger-hover); }
    .btn-icon { width: 30px; height: 30px; padding: 0; }
    .btn-icon.danger-hover:not([disabled]):hover { color: var(--danger); background: var(--danger-soft); }
    .btn.loading { position: relative; color: transparent !important; pointer-events: none; }
    .btn.loading::after {
      content: ""; position: absolute; width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid currentColor; border-right-color: transparent;
      animation: spin 0.7s linear infinite;
    }
    .btn-primary.loading::after, .btn-danger.loading::after { border-color: #fff; border-right-color: transparent; }
    .btn-secondary.loading::after, .btn-ghost.loading::after { border-color: var(--text-2); border-right-color: transparent; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Tables */
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th {
      padding: 8px 16px; text-align: left; white-space: nowrap;
      font: 500 10.5px/1.4 var(--mono); color: var(--text-3); letter-spacing: 0.08em; text-transform: uppercase;
      border-bottom: 1px solid var(--line); background: var(--surface-2);
    }
    td { padding: 12px 16px; border-bottom: 1px solid var(--line); vertical-align: middle; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover td { background: var(--surface-2); }
    .cell-primary { font-weight: 500; }
    .cell-sub { color: var(--text-3); font-size: 12px; }
    .row-actions { display: flex; justify-content: flex-end; gap: 2px; }
    th:last-child.right, td.right { text-align: right; }

    /* Empty states */
    .empty { padding: 48px 24px; text-align: center; color: var(--text-2); }
    .empty-icon { width: 40px; height: 40px; margin: 0 auto 12px; border-radius: var(--r-lg); display: grid; place-items: center; background: var(--hover); color: var(--text-3); }
    .empty h3 { margin: 0 0 4px; font-size: 14px; font-weight: 600; color: var(--text); }
    .empty p { margin: 0 auto 16px; max-width: 44ch; font-size: 12.5px; }
    .empty.compact { padding: 32px 24px; }
    .empty.compact p { margin-bottom: 0; }

    /* Lists */
    .list-row { display: flex; align-items: center; gap: 16px; padding: 16px; border-bottom: 1px solid var(--line); }
    .list-row:last-child { border-bottom: 0; }
    .list-main { flex: 1; min-width: 0; }
    .list-title { font-weight: 500; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .list-sub { color: var(--text-3); font-size: 12.5px; margin-top: 2px; word-break: break-word; }
    .list-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

    /* Forms */
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .form-grid .full { grid-column: 1 / -1; }
    .field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .field label { font-weight: 500; font-size: 12.5px; color: var(--text); }
    .field label .opt { color: var(--text-3); font-weight: 400; }
    .help { color: var(--text-3); font-size: 12px; }
    .err { color: var(--danger); font-size: 12px; display: none; }
    .field.invalid .err { display: block; }
    .field.invalid input { border-color: var(--danger); }
    input, select, textarea {
      width: 100%; height: 34px; padding: 0 10px;
      border: 1px solid var(--line-strong); border-radius: var(--r-md);
      background: var(--surface); color: var(--text);
      font: inherit; outline: none;
      transition: border-color 0.12s, box-shadow 0.12s;
    }
    textarea { height: auto; min-height: 72px; padding: 8px 10px; resize: vertical; font-family: var(--mono); font-size: 12.5px; }
    input::placeholder, textarea::placeholder { color: var(--text-3); opacity: 0.8; }
    input:hover, select:hover, textarea:hover { border-color: var(--text-3); }
    input:focus, select:focus, textarea:focus { border-color: var(--accent); box-shadow: var(--ring); }
    input:disabled { background: var(--surface-2); color: var(--text-3); cursor: not-allowed; }
    .input-suffix { position: relative; }
    .input-suffix input { padding-right: 56px; }
    .input-suffix span { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); color: var(--text-3); font-size: 12px; pointer-events: none; }
    .section-title { margin: 0 0 12px; display: flex; align-items: center; gap: 8px; }
    .form-section + .form-section { margin-top: 24px; padding-top: 24px; border-top: 1px solid var(--line); }
    .segmented { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .segmented label { position: relative; display: block; }
    .segmented input { position: absolute; top: 0; left: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
    .seg-opt {
      display: block; padding: 10px 12px; cursor: pointer;
      border: 1px solid var(--line-strong); border-radius: var(--r-lg); background: var(--surface);
      transition: border-color 0.12s, background 0.12s;
    }
    .seg-opt:hover { background: var(--hover); }
    .seg-opt .t { font-weight: 500; display: flex; align-items: center; gap: 6px; }
    .seg-opt .d { color: var(--text-3); font-size: 12px; margin-top: 2px; }
    .segmented input:checked + .seg-opt { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
    .segmented input:focus-visible + .seg-opt { box-shadow: var(--ring); }
    details.disclosure > summary {
      list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
      color: var(--text-2); font-weight: 500; font-size: 12.5px; padding: 4px 0;
    }
    details.disclosure > summary::-webkit-details-marker { display: none; }
    details.disclosure > summary:hover { color: var(--text); }
    details.disclosure > summary .chev { transition: transform 0.15s; }
    details.disclosure[open] > summary .chev { transform: rotate(90deg); }
    details.disclosure > .disclosure-body { margin-top: 12px; }
    .form-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--surface-2); border-radius: 0 0 var(--r-xl) var(--r-xl); }
    .dirty-hint { color: var(--text-3); font-size: 12px; }

    /* Logs */
    .log-list { display: flex; flex-direction: column; }
    .log-item { padding: 12px 16px; border-bottom: 1px solid var(--line); }
    .log-item:last-child { border-bottom: 0; }
    .log-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .log-name { font-weight: 500; }
    .log-time { color: var(--text-3); font-size: 12px; margin-left: auto; }
    pre.console {
      margin: 8px 0 0; padding: 10px 12px; max-height: 260px; overflow: auto;
      border-radius: var(--r-md); border: 1px solid var(--line); background: var(--surface-2);
      font: 12px/1.55 var(--mono); color: var(--text-2); white-space: pre-wrap; word-break: break-word;
    }
    pre.console .e { color: var(--danger); }

    /* Clients */
    .client-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
    .client { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .client-top { display: flex; align-items: flex-start; gap: 12px; }
    .client-logo { width: 32px; height: 32px; border-radius: var(--r-md); display: grid; place-items: center; background: var(--hover); color: var(--text-2); font: 600 12px/1 var(--mono); flex: none; }
    .client-name { font-weight: 600; letter-spacing: -0.01em; }
    .client-desc { color: var(--text-2); font-size: 12.5px; flex: 1; }
    .client-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }

    /* Dialog */
    dialog {
      width: min(720px, calc(100vw - 32px)); max-height: calc(100vh - 48px);
      padding: 0; border: 1px solid var(--line); border-radius: var(--r-xl);
      background: var(--surface); color: var(--text); box-shadow: var(--shadow-float);
    }
    dialog[open] { display: flex; overflow: hidden; flex-direction: column; animation: pop 0.16s ease-out; }
    dialog::backdrop { background: var(--backdrop); backdrop-filter: blur(2px); }
    @keyframes pop { from { opacity: 0; transform: translateY(6px) scale(0.985); } to { opacity: 1; transform: none; } }
    dialog form { display: flex; flex-direction: column; min-height: 0; margin: 0; }
    .dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--line); }
    .dialog-head h2 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
    .dialog-head p { margin: 2px 0 0; color: var(--text-3); font-size: 12.5px; }
    .dialog-body { padding: 20px; overflow-y: auto; }
    .dialog-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--line); background: var(--surface-2); }
    .dialog-error { display: none; margin-bottom: 16px; padding: 10px 12px; border-radius: var(--r-md); background: var(--danger-soft); color: var(--danger); font-size: 12.5px; word-break: break-word; }
    .dialog-error.show { display: block; }
    .test-result { display: none; margin-bottom: 16px; padding: 10px 12px; border-radius: var(--r-md); border: 1px solid var(--line); background: var(--surface-2); font-size: 12.5px; }
    .test-result.show { display: block; }
    .test-result .tr-title { display: flex; align-items: center; gap: 8px; font-weight: 600; }
    .test-result.ok .tr-title { color: var(--ok); }
    .test-result.warn .tr-title { color: var(--warn); }
    .test-result.danger .tr-title { color: var(--danger); }
    .test-result .tr-msg { margin-top: 4px; color: var(--text-2); word-break: break-word; }
    .test-result ul { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 3px; }
    .test-result li { display: flex; gap: 8px; color: var(--text-3); }
    .test-result li .mark { flex: none; width: 14px; text-align: center; }
    .test-result li.ok .mark { color: var(--ok); }
    .test-result li.fail .mark { color: var(--danger); }
    .test-result li .detail { word-break: break-all; }
    .dialog-foot .spacer { flex: 1; }
    #confirmDialog { width: min(420px, calc(100vw - 32px)); }
    #confirmDialog .dialog-body { display: flex; gap: 12px; }
    .confirm-icon { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; background: var(--danger-soft); color: var(--danger); flex: none; }

    /* Toasts */
    .toasts { position: fixed; right: 24px; bottom: 24px; z-index: 50; display: flex; flex-direction: column; gap: 8px; width: min(360px, calc(100vw - 32px)); }
    .toast {
      display: flex; gap: 10px; align-items: flex-start;
      padding: 12px 14px; border-radius: var(--r-lg);
      background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow-float);
      animation: slide 0.2s ease-out;
    }
    .toast.leaving { opacity: 0; transform: translateY(6px); transition: opacity 0.2s, transform 0.2s; }
    .toast .t-icon { color: var(--text-3); margin-top: 1px; }
    .toast.ok .t-icon { color: var(--ok); }
    .toast.error .t-icon { color: var(--danger); }
    .toast-title { font-weight: 500; }
    .toast-text { color: var(--text-2); font-size: 12.5px; word-break: break-word; }
    @keyframes slide { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

    .skeleton { display: inline-block; height: 1em; width: 8em; border-radius: var(--r-sm); background: linear-gradient(90deg, var(--hover), var(--surface-2), var(--hover)); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; vertical-align: middle; }
    @keyframes shimmer { to { background-position: -200% 0; } }
    .offline-overlay .requires-online { pointer-events: none; }

    @media (max-width: 1000px) {
      .stats { grid-template-columns: 1fr; }
    }
    @media (max-width: 860px) {
      .shell { grid-template-columns: minmax(0, 1fr); }
      .sidebar {
        position: sticky; top: 0; z-index: 10; height: auto; min-width: 0;
        flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 16px 0;
        border-right: 0; border-bottom: 1px solid var(--line);
      }
      .brand { padding: 0; }
      .brand-name { white-space: nowrap; }
      .brand-sub, .nav-label, .service-detail, #themeLabel { display: none; }
      .sidebar-foot { order: 2; margin: 0 0 0 auto; flex-direction: row; align-items: center; gap: 4px; }
      .service { padding: 4px 10px; border-radius: 999px; }
      #themeBtn { width: 32px; padding: 0; }
      .nav { order: 3; flex: 1 0 100%; flex-direction: row; gap: 4px; overflow-x: auto; margin: 0 -16px; padding: 0 16px 8px; scrollbar-width: none; }
      .nav-item { width: auto; white-space: nowrap; }
      .nav-item .count { display: none; }
      .main { padding: 24px 16px 48px; }
      .form-grid, .segmented { grid-template-columns: 1fr; }
      .list-row { flex-direction: column; align-items: stretch; }
      .list-actions { justify-content: flex-start; }
      .toasts { right: 16px; bottom: 16px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
    }
  </style>
</head>
<body>
  <svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <defs>
      <symbol id="i-overview" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></symbol>
      <symbol id="i-server" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></symbol>
      <symbol id="i-runtime" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/></symbol>
      <symbol id="i-plug" viewBox="0 0 24 24"><path d="M9 2v6M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/></symbol>
      <symbol id="i-settings" viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></symbol>
      <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
      <symbol id="i-edit" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></symbol>
      <symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/></symbol>
      <symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>
      <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></symbol>
      <symbol id="i-moon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></symbol>
      <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></symbol>
      <symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5h.01"/></symbol>
      <symbol id="i-check" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></symbol>
      <symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></symbol>
      <symbol id="i-chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></symbol>
      <symbol id="i-pulse" viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4"/></symbol>
      <symbol id="i-terminal" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/></symbol>
    </defs>
  </svg>

  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><path d="M12 4v.5M12 10v10"/></svg>
        </div>
        <div>
          <div class="brand-name">MCP for i</div>
          <div class="brand-sub">Control plane</div>
        </div>
      </div>

      <nav class="nav" aria-label="Sections">
        <div class="nav-label">Workspace</div>
        <button class="nav-item" type="button" data-tab="overview"><svg class="icon"><use href="#i-overview"/></svg>Overview</button>
        <button class="nav-item" type="button" data-tab="connections"><svg class="icon"><use href="#i-server"/></svg>Connections<span class="count" id="navConnCount">0</span></button>
        <button class="nav-item" type="button" data-tab="runtime"><svg class="icon"><use href="#i-runtime"/></svg>Runtime</button>
        <button class="nav-item" type="button" data-tab="clients"><svg class="icon"><use href="#i-plug"/></svg>Clients</button>
        <button class="nav-item" type="button" data-tab="settings"><svg class="icon"><use href="#i-settings"/></svg>Settings</button>
      </nav>

      <div class="sidebar-foot">
        <div class="service" id="servicePill" data-state="offline" role="status" aria-live="polite">
          <span class="pulse"></span>
          <div class="service-text">
            <div class="service-title" id="serviceTitle">Connecting</div>
            <div class="service-detail" id="serviceText">Checking local service...</div>
          </div>
        </div>
        <button id="themeBtn" class="btn btn-ghost" type="button" aria-label="Toggle theme">
          <svg class="icon" id="themeIcon"><use href="#i-moon"/></svg><span id="themeLabel">Dark mode</span>
        </button>
      </div>
    </aside>

    <main class="main">
      <!-- Overview -->
      <section class="page" id="panel-overview" aria-labelledby="h-overview">
        <header class="page-head">
          <div>
            <h1 id="h-overview">Overview</h1>
            <p id="runtimeSummary">Health of your local MCP server, skills and IBM i sessions.</p>
          </div>
          <div class="head-actions">
            <button id="refreshOverviewBtn" class="btn btn-secondary requires-online" type="button"><svg class="icon"><use href="#i-runtime"/></svg>Refresh</button>
          </div>
        </header>

        <div class="stack">
          <div class="stats">
            <div class="card stat">
              <div class="stat-top"><span class="eyebrow">MCP server</span><span class="chip" id="mcpVersionBadge">Checking</span></div>
              <div class="stat-value mono" id="mcpVersionText"><span class="skeleton"></span></div>
              <div class="stat-meta" id="mcpVersionMeta">&nbsp;</div>
            </div>
            <div class="card stat">
              <div class="stat-top"><span class="eyebrow">Skills</span><span class="chip" id="skillsVersionBadge">Checking</span></div>
              <div class="stat-value mono" id="skillsVersionText"><span class="skeleton"></span></div>
              <div class="stat-meta" id="skillsVersionMeta">&nbsp;</div>
            </div>
            <div class="card stat">
              <div class="stat-top"><span class="eyebrow">Background service</span><span class="chip" id="startupBadge">Checking</span></div>
              <div class="stat-value" id="startupText"><span class="skeleton"></span></div>
              <div class="stat-meta" id="startupMeta">&nbsp;</div>
            </div>
          </div>

          <div class="banner" id="credentialNotice">
            <div class="b-icon"><svg class="icon"><use href="#i-shield"/></svg></div>
            <div>
              <div class="banner-title" id="credentialTitle">Credential store</div>
              <div class="banner-text" id="credentialText">Checking...</div>
            </div>
          </div>

          <div class="card">
            <div class="card-head">
              <div>
                <h2>Active sessions</h2>
                <div class="sub" id="sessionsUpdated">Warm IBM i sessions held by the MCP server.</div>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Connection</th><th>State</th><th>Policy</th><th>Idle remaining</th></tr></thead>
                <tbody id="sessionsBody"></tbody>
              </table>
            </div>
          </div>
          <div class="help" id="versionCheckedAt"></div>
        </div>
      </section>

      <!-- Connections -->
      <section class="page" id="panel-connections" aria-labelledby="h-connections">
        <header class="page-head">
          <div>
            <h1 id="h-connections">Connections</h1>
            <p>IBM i systems the MCP server can reach. Passwords are stored in your OS keychain, never in config files.</p>
          </div>
          <div class="head-actions">
            <button id="addConnectionBtn" class="btn btn-primary requires-online" type="button"><svg class="icon"><use href="#i-plus"/></svg>Add connection</button>
          </div>
        </header>
        <div class="card">
          <div class="card-head">
            <div><h2>Saved connections</h2><div class="sub" id="connectionCount">0 connections</div></div>
          </div>
          <div class="table-wrap" id="connectionsTableWrap">
            <table>
              <thead><tr><th>Name</th><th>Host</th><th>User</th><th>Status</th><th>Policy</th><th>Library context</th><th class="right"><span class="sr-only">Actions</span></th></tr></thead>
              <tbody id="connectionsBody"></tbody>
            </table>
          </div>
          <div class="empty" id="connectionsEmpty" hidden>
            <div class="empty-icon"><svg class="icon"><use href="#i-server"/></svg></div>
            <h3>No connections yet</h3>
            <p>Add an IBM i system to let your coding assistant query libraries, run SQL and manage source.</p>
            <button class="btn btn-primary requires-online" type="button" id="emptyAddConnectionBtn"><svg class="icon"><use href="#i-plus"/></svg>Add connection</button>
          </div>
        </div>
      </section>

      <!-- Runtime -->
      <section class="page" id="panel-runtime" aria-labelledby="h-runtime">
        <header class="page-head">
          <div>
            <h1 id="h-runtime">Runtime</h1>
            <p>Keep the MCP server and skills current, and control whether the control plane starts with your machine.</p>
          </div>
          <div class="head-actions">
            <button id="refreshRuntimeBtn" class="btn btn-secondary requires-online" type="button"><svg class="icon"><use href="#i-runtime"/></svg>Refresh</button>
          </div>
        </header>
        <div class="stack">
          <div class="card">
            <div class="card-head"><div><h2>Updates</h2><div class="sub">Updating the MCP server restarts the control plane. This page reconnects on its own.</div></div></div>
            <div class="list-row">
              <div class="list-main">
                <div class="list-title">MCP server <span class="chip" id="rtMcpBadge">Checking</span></div>
                <div class="list-sub mono" id="rtMcpText">Checking...</div>
              </div>
              <div class="list-actions">
                <button id="updateMcpBtn" class="btn btn-primary requires-online" type="button">Update MCP</button>
              </div>
            </div>
            <div class="list-row" style="align-items: flex-start;">
              <div class="list-main">
                <div class="list-title">Skills <span class="chip" id="rtSkillsBadge">Checking</span></div>
                <div class="list-sub mono" id="rtSkillsText">Checking...</div>
                <details class="disclosure" style="margin-top: 8px;">
                  <summary><svg class="icon chev" style="width:14px;height:14px"><use href="#i-chev"/></svg>Skills source</summary>
                  <div class="disclosure-body form-grid">
                    <div class="field">
                      <label for="skillsRepoUrl">Repository URL</label>
                      <input id="skillsRepoUrl" class="mono" placeholder="https://github.com/org/mcp-for-i-skills.git" spellcheck="false" />
                    </div>
                    <div class="field">
                      <label for="skillsBranch">Branch</label>
                      <input id="skillsBranch" class="mono" placeholder="main" spellcheck="false" />
                    </div>
                  </div>
                </details>
              </div>
              <div class="list-actions">
                <button id="updateSkillsBtn" class="btn btn-secondary requires-online" type="button">Update skills</button>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h2>Background service</h2><div class="sub">Start the control plane automatically when you sign in.</div></div><span class="chip" id="rtServiceBadge">Checking</span></div>
            <div class="list-row">
              <div class="list-main">
                <div class="list-title" id="rtServiceTitle">Checking...</div>
                <div class="list-sub" id="autostartInfo">Background service: checking...</div>
              </div>
              <div class="list-actions">
                <button id="enableServiceBtn" class="btn btn-secondary requires-online" type="button">Enable</button>
                <button id="disableServiceBtn" class="btn btn-secondary requires-online" type="button">Disable</button>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h2>Activity</h2><div class="sub">Output from update and service jobs.</div></div></div>
            <div class="log-list" id="logs"></div>
          </div>
        </div>
      </section>

      <!-- Clients -->
      <section class="page" id="panel-clients" aria-labelledby="h-clients">
        <header class="page-head">
          <div>
            <h1 id="h-clients">Clients</h1>
            <p id="clientSummary">Register MCP for i with the coding assistants installed on this machine.</p>
          </div>
          <div class="head-actions">
            <button id="refreshClientsBtn" class="btn btn-secondary requires-online" type="button"><svg class="icon"><use href="#i-runtime"/></svg>Refresh</button>
          </div>
        </header>
        <div class="stack">
          <div class="client-grid" id="clientButtons"></div>
          <div class="card" id="clientLogsCard" hidden>
            <div class="card-head"><div><h2 id="clientLogsTitle">Result</h2></div><button class="btn btn-ghost btn-icon" type="button" id="clientLogsClose" aria-label="Dismiss"><svg class="icon"><use href="#i-x"/></svg></button></div>
            <div class="card-body"><pre class="console" id="clientLogs" style="margin:0"></pre></div>
          </div>
        </div>
      </section>

      <!-- Settings -->
      <section class="page" id="panel-settings" aria-labelledby="h-settings">
        <header class="page-head">
          <div>
            <h1 id="h-settings">Settings</h1>
            <p>Session defaults apply to every connection unless a connection sets its own override.</p>
          </div>
        </header>
        <form class="card" id="settingsForm" novalidate>
          <div class="card-head"><div><h2>Session lifecycle</h2><div class="sub">How long sessions stay warm and how they recover from drops.</div></div></div>
          <div class="card-body">
            <div class="form-grid">
              <div class="field">
                <label for="sessionIdleMinutes">Idle timeout</label>
                <div class="input-suffix"><input id="sessionIdleMinutes" type="number" min="1" max="1440" required /><span>minutes</span></div>
                <div class="help">Close a session after this long without activity. 1 to 1440.</div>
                <div class="err">Enter a whole number from 1 to 1440.</div>
              </div>
              <div class="field">
                <label for="sessionPingSeconds">Health check interval</label>
                <div class="input-suffix"><input id="sessionPingSeconds" type="number" min="5" max="300" required /><span>seconds</span></div>
                <div class="help">How often an open session is pinged. 5 to 300.</div>
                <div class="err">Enter a whole number from 5 to 300.</div>
              </div>
              <div class="field">
                <label for="sessionReconnectAttempts">Reconnect attempts</label>
                <div class="input-suffix"><input id="sessionReconnectAttempts" type="number" min="1" max="5" required /><span>tries</span></div>
                <div class="help">Retries before a dropped session is reported as failed. 1 to 5.</div>
                <div class="err">Enter a whole number from 1 to 5.</div>
              </div>
            </div>
          </div>
          <div class="form-foot">
            <span class="dirty-hint" id="settingsDirty">No unsaved changes</span>
            <div class="head-actions">
              <button id="reloadSettingsBtn" class="btn btn-ghost requires-online" type="button">Discard</button>
              <button id="saveSettingsBtn" class="btn btn-primary requires-online" type="submit">Save changes</button>
            </div>
          </div>
        </form>
      </section>
    </main>
  </div>

  <!-- Connection dialog -->
  <dialog id="connectionDialog" aria-labelledby="connectionDialogTitle">
    <form id="connectionForm" method="dialog" novalidate>
      <div class="dialog-head">
        <div>
          <h2 id="connectionDialogTitle">Add connection</h2>
          <p id="connectionDialogSub">Connect over SSH to an IBM i system.</p>
        </div>
        <button id="closeConnectionDialogBtn" class="btn btn-ghost btn-icon" type="button" aria-label="Close"><svg class="icon"><use href="#i-x"/></svg></button>
      </div>
      <div class="dialog-body">
        <div class="dialog-error" id="connectionError" role="alert"></div>
        <div class="test-result" id="connectionTestResult" role="status" aria-live="polite"></div>

        <div class="form-section">
          <div class="section-title eyebrow">Server</div>
          <div class="form-grid">
            <div class="field">
              <label for="connName">Name</label>
              <input id="connName" required autocomplete="off" placeholder="DEV400" />
              <div class="err">A name is required.</div>
            </div>
            <div class="field">
              <label for="connUser">Username</label>
              <input id="connUser" required autocomplete="off" spellcheck="false" />
              <div class="err">A username is required.</div>
            </div>
            <div class="field">
              <label for="connHost">Host</label>
              <input id="connHost" required autocomplete="off" spellcheck="false" placeholder="ibmi.example.com" />
              <div class="err">A host is required.</div>
            </div>
            <div class="field">
              <label for="connPort">SSH port</label>
              <input id="connPort" type="number" min="1" max="65535" value="22" />
              <div class="err">Port must be between 1 and 65535.</div>
            </div>
          </div>
        </div>

        <div class="form-section">
          <div class="section-title eyebrow">Authentication</div>
          <div class="form-grid">
            <div class="field">
              <label for="connPassword">Password <span class="opt">(optional)</span></label>
              <input id="connPassword" type="password" autocomplete="new-password" placeholder="Stored in OS keychain" />
              <div class="help" id="connPasswordHelp">Saved to the OS keychain only.</div>
            </div>
            <div class="field">
              <label for="connKeyPath">Private key path <span class="opt">(optional)</span></label>
              <input id="connKeyPath" class="mono" spellcheck="false" placeholder="~/.ssh/id_ed25519" />
              <div class="help">Used instead of a password when set.</div>
            </div>
          </div>
        </div>

        <div class="form-section">
          <div class="section-title eyebrow">Access policy</div>
          <div class="segmented" role="radiogroup" aria-label="Policy">
            <label><input type="radio" name="connPolicy" value="read-only" /><span class="seg-opt"><span class="t">Read-only</span><span class="d">Blocks every change to the system.</span></span></label>
            <label><input type="radio" name="connPolicy" value="guarded" /><span class="seg-opt"><span class="t">Guarded</span><span class="d">Risky operations need explicit approval.</span></span></label>
            <label><input type="radio" name="connPolicy" value="power-user" /><span class="seg-opt"><span class="t">Power user</span><span class="d">No approval prompts. Use with care.</span></span></label>
          </div>
        </div>

        <div class="form-section">
          <div class="section-title eyebrow">Library context</div>
          <div class="form-grid">
            <div class="field">
              <label for="connCurrentLibrary">Current library <span class="opt">(optional)</span></label>
              <input id="connCurrentLibrary" class="mono" spellcheck="false" placeholder="QGPL" style="text-transform: uppercase;" />
            </div>
            <div class="field full">
              <label for="connLibraryList">Library list <span class="opt">(optional)</span></label>
              <textarea id="connLibraryList" spellcheck="false" placeholder="MYLIB, QGPL, QTEMP"></textarea>
              <div class="help">Separate with commas, spaces or new lines.</div>
            </div>
          </div>
        </div>

        <div class="form-section">
          <details class="disclosure" id="overridesDisclosure">
            <summary><svg class="icon chev" style="width:14px;height:14px"><use href="#i-chev"/></svg>Session overrides</summary>
            <div class="disclosure-body">
              <div class="help" style="margin-bottom: 12px;">Leave blank to use the defaults from Settings.</div>
              <div class="form-grid">
                <div class="field">
                  <label for="connSessionIdleMinutes">Idle timeout</label>
                  <div class="input-suffix"><input id="connSessionIdleMinutes" type="number" min="1" max="1440" /><span>minutes</span></div>
                </div>
                <div class="field">
                  <label for="connSessionPingSeconds">Health check interval</label>
                  <div class="input-suffix"><input id="connSessionPingSeconds" type="number" min="5" max="300" /><span>seconds</span></div>
                </div>
                <div class="field">
                  <label for="connSessionReconnectAttempts">Reconnect attempts</label>
                  <div class="input-suffix"><input id="connSessionReconnectAttempts" type="number" min="1" max="5" /><span>tries</span></div>
                </div>
              </div>
            </div>
          </details>
        </div>
      </div>
      <div class="dialog-foot">
        <button id="testConnectionBtn" class="btn btn-secondary" type="button" title="Sign on once and sign off, without saving">Test connection</button>
        <span class="spacer"></span>
        <button id="cancelConnectionBtn" class="btn btn-secondary" type="button">Cancel</button>
        <button id="saveConnectionBtn" class="btn btn-primary" type="submit">Save connection</button>
      </div>
    </form>
  </dialog>

  <!-- Confirm dialog -->
  <dialog id="confirmDialog" aria-labelledby="confirmTitle">
    <div class="dialog-body">
      <div class="confirm-icon"><svg class="icon"><use href="#i-alert"/></svg></div>
      <div>
        <h2 id="confirmTitle" style="margin:0 0 4px;font-size:15px;font-weight:600">Are you sure?</h2>
        <div id="confirmText" style="color:var(--text-2);font-size:13px"></div>
      </div>
    </div>
    <div class="dialog-foot">
      <button class="btn btn-secondary" type="button" id="confirmCancel">Cancel</button>
      <button class="btn btn-danger" type="button" id="confirmOk">Delete</button>
    </div>
  </dialog>

  <div class="toasts" id="toasts" aria-live="polite" aria-atomic="false"></div>

  <script>
    const THEME_KEY = "mcp_for_i_theme";
    const TAB_KEY = "mcp_for_i_tab";
    const SKILLS_REPO_KEY = "mcp_for_i_skills_repo";
    const SKILLS_BRANCH_KEY = "mcp_for_i_skills_branch";
    const DEFAULT_SKILLS_REPO = "https://github.com/ashishthomas2202/mcp-for-i-skills.git";
    const DEFAULT_SKILLS_BRANCH = "main";
    const LEGACY_SKILLS_REPO = "https://github.com/ashishthomas-pcr/mcp-for-i-skills.git";
    const TABS = ["overview", "connections", "runtime", "clients", "settings"];
    const JOB_LABELS = {
      updateMcp: "MCP update",
      updateSkills: "Skills update",
      enableService: "Enable background service",
      disableService: "Disable background service"
    };
    const POLICY_CHIP = { "read-only": ["ok", "Read-only"], "guarded": ["info", "Guarded"], "power-user": ["warn", "Power user"] };
    const state = { online: false, busy: false, jobs: {}, connections: [], editingName: "", service: null, settings: null, testing: {} };
    const $ = id => document.getElementById(id);
    const TOKEN_HEADER = "X-MCP-For-I-Token";
    const API_TOKEN = (document.querySelector("meta[name='mcp-for-i-token']") || {}).content || "";
    const NL = String.fromCharCode(10);

    function escapeHtml(s) {
      return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    }
    function icon(name, size) {
      const s = size ? (" style='width:" + size + "px;height:" + size + "px'") : "";
      return "<svg class='icon'" + s + "><use href='#i-" + name + "'/></svg>";
    }
    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
    function errorMessage(err) {
      const raw = err && err.message ? err.message : String(err);
      try { const parsed = JSON.parse(raw); if (parsed && parsed.error) return parsed.error; } catch {}
      return raw;
    }
    function formatTime(value) {
      if (!value) return "";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return String(value);
      return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
    function relativeTime(value) {
      const t = Date.parse(value || "");
      if (!t) return "";
      const diff = Math.round((Date.now() - t) / 1000);
      if (diff < 5) return "just now";
      if (diff < 60) return diff + "s ago";
      if (diff < 3600) return Math.floor(diff / 60) + "m ago";
      if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
      return formatTime(value);
    }
    function formatDuration(seconds) {
      if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "-";
      if (seconds < 60) return seconds + "s";
      const m = Math.floor(seconds / 60), s = seconds % 60;
      return m + "m " + String(s).padStart(2, "0") + "s";
    }

    /* Toasts */
    function toast(kind, title, text) {
      const host = $("toasts");
      const el = document.createElement("div");
      el.className = "toast " + kind;
      el.setAttribute("role", kind === "error" ? "alert" : "status");
      const ic = kind === "ok" ? "check" : kind === "error" ? "alert" : "info";
      el.innerHTML = "<span class='t-icon'>" + icon(ic) + "</span><div><div class='toast-title'>" + escapeHtml(title) + "</div>" +
        (text ? "<div class='toast-text'>" + escapeHtml(text) + "</div>" : "") + "</div>";
      host.appendChild(el);
      const ttl = kind === "error" ? 7000 : 3500;
      setTimeout(() => { el.classList.add("leaving"); setTimeout(() => el.remove(), 220); }, ttl);
    }

    /* Confirm */
    function confirmAction(title, text, okLabel) {
      return new Promise(resolve => {
        const dlg = $("confirmDialog");
        $("confirmTitle").textContent = title;
        $("confirmText").textContent = text;
        $("confirmOk").textContent = okLabel || "Confirm";
        const done = value => { cleanup(); if (dlg.open) dlg.close(); resolve(value); };
        const onOk = () => done(true);
        const onCancel = () => done(false);
        const onClose = () => { cleanup(); resolve(false); };
        function cleanup() {
          $("confirmOk").removeEventListener("click", onOk);
          $("confirmCancel").removeEventListener("click", onCancel);
          dlg.removeEventListener("close", onClose);
        }
        $("confirmOk").addEventListener("click", onOk);
        $("confirmCancel").addEventListener("click", onCancel);
        dlg.addEventListener("close", onClose);
        dlg.showModal();
        $("confirmCancel").focus();
      });
    }

    /* Busy / online */
    function syncControls() {
      const disabled = !state.online || state.busy;
      document.querySelectorAll(".requires-online").forEach(el => { el.disabled = disabled; });
      document.querySelectorAll("#clientButtons button, #connectionsBody button").forEach(el => { el.disabled = disabled; });
      syncServiceButtons();
    }
    function setBusy(busy) { state.busy = busy; syncControls(); }
    async function withLoading(btn, fn) {
      if (btn) btn.classList.add("loading");
      try { return await fn(); }
      finally { if (btn) btn.classList.remove("loading"); }
    }
    function setServiceState(mode, title, text) {
      const pill = $("servicePill");
      pill.dataset.state = mode;
      $("serviceTitle").textContent = title;
      $("serviceText").textContent = text;
      $("serviceText").title = text;
      state.online = mode === "online";
      syncControls();
    }
    async function api(path, options = {}) {
      const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
      headers[TOKEN_HEADER] = API_TOKEN;
      const res = await fetch(path, { ...options, headers });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || ("HTTP " + res.status));
      }
      if (res.status === 204) return null;
      return res.json();
    }

    /* Theme */
    function currentTheme() { return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"; }
    function applyTheme(theme, persist) {
      document.documentElement.setAttribute("data-theme", theme);
      $("themeIcon").innerHTML = "<use href='#i-" + (theme === "dark" ? "sun" : "moon") + "'/>";
      $("themeLabel").textContent = theme === "dark" ? "Light mode" : "Dark mode";
      if (persist) { try { localStorage.setItem(THEME_KEY, theme); } catch {} }
    }

    /* Tabs */
    function activateTab(name, focus) {
      if (!TABS.includes(name)) name = "overview";
      document.querySelectorAll(".nav-item").forEach(btn => {
        if (btn.dataset.tab === name) btn.setAttribute("aria-current", "page"); else btn.removeAttribute("aria-current");
      });
      document.querySelectorAll(".page").forEach(panel => panel.classList.toggle("active", panel.id === "panel-" + name));
      try { localStorage.setItem(TAB_KEY, name); } catch {}
      if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
      if (focus) { const h = document.querySelector("#panel-" + name + " h1"); if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); } }
    }
    function initialTab() {
      const fromHash = location.hash.replace("#", "");
      if (TABS.includes(fromHash)) return fromHash;
      try { const t = localStorage.getItem(TAB_KEY); if (t && TABS.includes(t)) return t; } catch {}
      return "overview";
    }

    function setChip(id, text, kind) {
      const el = $(id);
      if (!el) return;
      el.textContent = text;
      el.className = "chip" + (kind ? " " + kind : "");
    }
    function normalizeLibraries(value) {
      const list = String(value || "").split(/[,;]|\\s+/).map(v => v.trim().toUpperCase()).filter(Boolean);
      return Array.from(new Set(list));
    }
    function parseOptionalNumber(value, min, max) {
      const raw = String(value || "").trim();
      if (!raw) return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n)) return undefined;
      const normalized = Math.floor(n);
      if (normalized < min || normalized > max) return undefined;
      return normalized;
    }

    /* Skills source */
    function loadSkillsUpdateSettings() {
      let repo = DEFAULT_SKILLS_REPO;
      let branch = DEFAULT_SKILLS_BRANCH;
      try {
        const r = localStorage.getItem(SKILLS_REPO_KEY);
        const b = localStorage.getItem(SKILLS_BRANCH_KEY);
        if (r && r.trim()) repo = r.trim();
        if (b && b.trim()) branch = b.trim();
      } catch {}
      if (repo === LEGACY_SKILLS_REPO) repo = DEFAULT_SKILLS_REPO;
      $("skillsRepoUrl").value = repo;
      $("skillsBranch").value = branch;
      persistSkillsUpdateSettings();
    }
    function persistSkillsUpdateSettings() {
      const repo = ($("skillsRepoUrl").value || "").trim() || DEFAULT_SKILLS_REPO;
      const branch = ($("skillsBranch").value || "").trim() || DEFAULT_SKILLS_BRANCH;
      const normalizedRepo = repo === LEGACY_SKILLS_REPO ? DEFAULT_SKILLS_REPO : repo;
      $("skillsRepoUrl").value = normalizedRepo;
      $("skillsBranch").value = branch;
      try {
        localStorage.setItem(SKILLS_REPO_KEY, normalizedRepo);
        localStorage.setItem(SKILLS_BRANCH_KEY, branch);
      } catch {}
      return { repoUrl: normalizedRepo, branch };
    }

    /* Renderers */
    function jobLabel(id) { return JOB_LABELS[id] || id; }
    function renderRuntimeSummary() {
      const entries = Object.entries(state.jobs || {}).filter(([, job]) => job.status !== "idle");
      const running = entries.find(([, job]) => job.status === "running");
      const el = $("runtimeSummary");
      if (running) { el.textContent = jobLabel(running[0]) + " in progress..."; return; }
      if (entries.length === 0) { el.textContent = "Health of your local MCP server, skills and IBM i sessions."; return; }
      const latest = entries.map(([id, job]) => ({ id, at: job.finishedAt || job.startedAt || "", status: job.status }))
        .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))[0];
      el.textContent = "Last action: " + jobLabel(latest.id) + " " + (latest.status === "success" ? "succeeded" : latest.status) + (latest.at ? " " + relativeTime(latest.at) : "") + ".";
    }
    function renderLogs(jobs) {
      state.jobs = jobs || {};
      const host = $("logs");
      const entries = Object.entries(state.jobs).filter(([, j]) => j.status !== "idle")
        .sort((a, b) => (Date.parse(b[1].startedAt || "") || 0) - (Date.parse(a[1].startedAt || "") || 0));
      if (entries.length === 0) {
        host.innerHTML = "<div class='empty compact'><div class='empty-icon'>" + icon("terminal") + "</div><h3>No activity yet</h3><p>Job output appears here when you run an update or change the background service.</p></div>";
      } else {
        host.innerHTML = entries.map(([id, j]) => {
          const chip = j.status === "running" ? "<span class='chip info running'>Running</span>"
            : j.status === "success" ? "<span class='chip ok'>Succeeded</span>"
            : j.status === "failed" ? "<span class='chip danger'>Failed</span>"
            : "<span class='chip'>" + escapeHtml(j.status) + "</span>";
          const lines = (j.output || []).map(escapeHtml);
          if (j.error) lines.push("<span class='e'>" + escapeHtml(j.error) + "</span>");
          const when = j.finishedAt ? ("Finished " + formatTime(j.finishedAt)) : (j.startedAt ? ("Started " + formatTime(j.startedAt)) : "");
          return "<div class='log-item'><div class='log-head'><span class='log-name'>" + escapeHtml(jobLabel(id)) + "</span>" + chip +
            "<span class='log-time'>" + escapeHtml(when) + "</span></div>" +
            (lines.length ? "<pre class='console'>" + lines.join(NL) + "</pre>" : "") + "</div>";
        }).join("");
      }
      renderRuntimeSummary();
    }
    function renderConnections(list) {
      state.connections = list || [];
      const n = state.connections.length;
      $("connectionCount").textContent = n + (n === 1 ? " connection" : " connections");
      $("navConnCount").textContent = String(n);
      $("connectionsTableWrap").hidden = n === 0;
      $("connectionsEmpty").hidden = n !== 0;
      const body = $("connectionsBody");
      body.innerHTML = "";
      for (const conn of state.connections) {
        const policy = (conn.policy && conn.policy.profile) || "guarded";
        const pc = POLICY_CHIP[policy] || ["", policy];
        const s = conn.settings || {};
        const current = s.currentLibrary || "";
        const libs = Array.isArray(s.libraryList) ? s.libraryList : [];
        const overrides = [
          Number.isFinite(Number(s.sessionIdleMinutes)) && s.sessionIdleMinutes ? ("idle " + s.sessionIdleMinutes + "m") : "",
          Number.isFinite(Number(s.sessionPingSeconds)) && s.sessionPingSeconds ? ("ping " + s.sessionPingSeconds + "s") : "",
          Number.isFinite(Number(s.sessionReconnectAttempts)) && s.sessionReconnectAttempts ? ("retry " + s.sessionReconnectAttempts) : ""
        ].filter(Boolean);
        let ctx = "";
        if (current) ctx += "<span class='tag strong' title='Current library'>" + escapeHtml(current) + "</span>";
        const rest = libs.filter(l => l !== current);
        const shown = rest.slice(0, 4);
        ctx += shown.map(l => "<span class='tag'>" + escapeHtml(l) + "</span>").join("");
        if (rest.length > shown.length) ctx += "<span class='cell-sub' title='" + escapeHtml(rest.join(", ")) + "'>+" + (rest.length - shown.length) + " more</span>";
        if (!ctx) ctx = "<span class='cell-sub'>Default</span>";
        if (overrides.length) ctx += "<div class='cell-sub' style='margin-top:4px'>Overrides: " + escapeHtml(overrides.join(", ")) + "</div>";
        const enc = encodeURIComponent(conn.name);
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td><div class='cell-primary'>" + escapeHtml(conn.name) + "</div>" + (conn.privateKeyPath ? "<div class='cell-sub'>SSH key</div>" : "") + "</td>" +
          "<td class='mono' style='font-size:12.5px'>" + escapeHtml(conn.host || "") + "<span class='cell-sub'>:" + escapeHtml(String(conn.port || 22)) + "</span></td>" +
          "<td class='mono' style='font-size:12.5px'>" + escapeHtml(conn.username || "") + "</td>" +
          "<td>" + testStatusChip(conn.name, conn.lastTest) + "</td>" +
          "<td><span class='chip " + pc[0] + "'>" + escapeHtml(pc[1]) + "</span></td>" +
          "<td>" + ctx + "</td>" +
          "<td class='right'><div class='row-actions'>" +
          "<button class='btn btn-ghost btn-icon' data-action='test' data-name='" + enc + "' type='button' title='Test connection' aria-label='Test " + escapeHtml(conn.name) + "'>" + icon("pulse") + "</button>" +
          "<button class='btn btn-ghost btn-icon' data-action='edit' data-name='" + enc + "' type='button' title='Edit' aria-label='Edit " + escapeHtml(conn.name) + "'>" + icon("edit") + "</button>" +
          "<button class='btn btn-ghost btn-icon danger-hover' data-action='delete' data-name='" + enc + "' type='button' title='Delete' aria-label='Delete " + escapeHtml(conn.name) + "'>" + icon("trash") + "</button>" +
          "</div></td>";
        body.appendChild(tr);
      }
      body.querySelectorAll("button").forEach(btn => btn.addEventListener("click", onConnectionAction));
      syncControls();
    }
    const TEST_LABELS = {
      "ok": "Connected", "invalid-input": "Incomplete", "host-not-found": "Host not found",
      "host-unreachable": "Unreachable", "port-closed": "SSH port closed", "port-timeout": "No answer",
      "not-ssh": "Not SSH", "host-key-changed": "Host key changed", "no-credentials": "No password",
      "key-unreadable": "Key problem", "auth-failed": "Sign-on rejected", "password-expired": "Password expired",
      "password-already-rejected": "Password rejected", "timeout": "Timed out", "error": "Failed"
    };
    function testTone(result) {
      if (result.ok) return result.warnings && result.warnings.length ? "warn" : "ok";
      return result.code === "no-credentials" ? "warn" : "danger";
    }
    function testSummary(result) {
      return [result.message].concat(result.warnings || []).join(" ");
    }
    function testStatusChip(name, result) {
      if (state.testing[name]) return "<span class='chip info running'>Testing</span>";
      if (!result) return "<span class='chip plain'>Not tested</span>";
      const when = result.testedAt ? (" Tested " + formatTime(result.testedAt) + ".") : "";
      return "<span class='chip " + testTone(result) + "' title='" + escapeHtml(testSummary(result) + when) + "'>" +
        escapeHtml(TEST_LABELS[result.code] || result.code) + "</span>";
    }
    function renderTestResult(result) {
      const box = $("connectionTestResult");
      if (!result) { box.className = "test-result"; box.innerHTML = ""; return; }
      const tone = testTone(result);
      const steps = (result.steps || []).map(s =>
        "<li class='" + (s.ok ? "ok" : "fail") + "'><span class='mark'>" + (s.ok ? "&#10003;" : "&#10007;") + "</span>" +
        "<span><strong>" + escapeHtml(s.name) + "</strong> <span class='detail'>" + escapeHtml(s.detail || "") + "</span></span></li>").join("");
      const warnings = (result.warnings || []).map(w => "<li class='fail'><span class='mark'>!</span><span>" + escapeHtml(w) + "</span></li>").join("");
      box.className = "test-result show " + tone;
      box.innerHTML = "<div class='tr-title'>" + icon(tone === "ok" ? "check" : "alert", 14) + escapeHtml(TEST_LABELS[result.code] || result.code) + "</div>" +
        "<div class='tr-msg'>" + escapeHtml(result.message) + "</div>" +
        (steps || warnings ? "<ul>" + steps + warnings + "</ul>" : "");
    }
    async function testSavedConnection(name, btn) {
      if (state.testing[name]) return;
      state.testing[name] = true;
      renderConnections(state.connections);
      let result = null;
      try {
        result = (await api("/api/connections/" + encodeURIComponent(name) + "/test", { method: "POST", body: "{}" })).result;
      } catch (err) {
        toast("error", "Could not test " + name, errorMessage(err));
      } finally {
        delete state.testing[name];
      }
      try { await loadConnections(); } catch { renderConnections(state.connections); }
      if (result) {
        if (result.ok && !(result.warnings || []).length) toast("ok", name + ": connected", result.message);
        else toast(result.ok ? "info" : "error", name + ": " + (TEST_LABELS[result.code] || result.code), testSummary(result));
      }
      return result;
    }
    function versionChip(status) {
      if (status === "latest") return ["Up to date", "ok"];
      if (status === "update-available") return ["Update available", "warn"];
      if (status === "not-installed") return ["Not installed", ""];
      return ["Unknown", ""];
    }
    function renderVersions(data) {
      const mcp = data?.mcp || {};
      const skills = data?.skills || {};
      const mc = versionChip(mcp.status);
      $("mcpVersionText").textContent = mcp.installedVersion ? ("v" + String(mcp.installedVersion).replace(/^v/, "")) : "Unknown";
      $("mcpVersionMeta").textContent = mcp.latestVersion ? ("Latest release v" + String(mcp.latestVersion).replace(/^v/, "")) : "Latest release unknown";
      setChip("mcpVersionBadge", mc[0], mc[1]);
      setChip("rtMcpBadge", mc[0], mc[1]);
      $("rtMcpText").textContent = "Installed " + (mcp.installedVersion || "unknown") + "  ·  Latest " + (mcp.latestVersion || "unknown");
      $("updateMcpBtn").className = "btn requires-online " + (mcp.status === "update-available" ? "btn-primary" : "btn-secondary");

      const sc = versionChip(skills.status);
      const short = c => String(c || "").slice(0, 7);
      if (skills.localCommit) {
        $("skillsVersionText").textContent = short(skills.localCommit);
        $("skillsVersionMeta").textContent = (skills.localBranch || "branch") + (skills.latestCommit ? (" · latest " + short(skills.latestCommit)) : "");
      } else {
        $("skillsVersionText").textContent = skills.status === "not-installed" ? "Not installed" : "Unknown";
        $("skillsVersionMeta").textContent = skills.latestCommit ? ("Latest " + short(skills.latestCommit)) : "";
      }
      setChip("skillsVersionBadge", sc[0], sc[1]);
      setChip("rtSkillsBadge", sc[0], sc[1]);
      $("rtSkillsText").textContent = skills.localCommit
        ? ((skills.localBranch || "branch") + " @ " + short(skills.localCommit) + (skills.latestCommit ? ("  ·  Latest " + short(skills.latestCommit)) : ""))
        : (skills.status === "not-installed" ? "Not installed yet. Run an update to install." : "Unknown");
      $("updateSkillsBtn").textContent = skills.status === "not-installed" ? "Install skills" : "Update skills";
      $("updateSkillsBtn").className = "btn requires-online " + (skills.status === "update-available" || skills.status === "not-installed" ? "btn-primary" : "btn-secondary");

      if (data?.checkedAt) $("versionCheckedAt").textContent = "Versions checked " + formatTime(data.checkedAt) + ".";
      syncControls();
    }
    function syncServiceButtons() {
      const s = state.service;
      const disabled = !state.online || state.busy;
      $("enableServiceBtn").hidden = Boolean(s && s.enabled);
      $("disableServiceBtn").hidden = Boolean(s && !s.enabled);
      $("enableServiceBtn").disabled = disabled;
      $("disableServiceBtn").disabled = disabled;
    }
    function renderService(status) {
      state.service = status || null;
      if (!status) {
        $("autostartInfo").textContent = "Background service status is unavailable.";
        $("rtServiceTitle").textContent = "Unavailable";
        $("startupText").textContent = "Unavailable";
        $("startupMeta").textContent = "";
        setChip("startupBadge", "Unknown", "");
        setChip("rtServiceBadge", "Unknown", "");
        syncServiceButtons();
        return;
      }
      let chip;
      if (status.enabled && status.running) chip = ["Running", "ok"];
      else if (status.enabled) chip = ["Enabled, stopped", "warn"];
      else chip = ["Disabled", ""];
      setChip("startupBadge", chip[0], chip[1]);
      setChip("rtServiceBadge", chip[0], chip[1]);
      $("startupText").textContent = status.enabled ? "Starts at sign-in" : "Manual start";
      $("startupMeta").textContent = (status.label || "") + (status.arch ? (" · " + status.arch) : "") + (status.managedBy ? (" · " + status.managedBy) : "");
      $("rtServiceTitle").textContent = status.enabled ? ("Enabled via " + (status.managedBy || "OS service manager")) : "Not enabled";
      const detail = [status.detail || "", status.target ? ("Target: " + status.target) : ""].filter(Boolean).join(" ");
      $("autostartInfo").textContent = detail || ((status.label || "This platform") + " (" + (status.arch || "") + ")");
      syncServiceButtons();
    }
    function renderCredentialStore(status) {
      const el = $("credentialNotice");
      if (!status) {
        el.className = "banner warn";
        $("credentialTitle").textContent = "Credential store unavailable";
        $("credentialText").textContent = "Passwords cannot be saved until a credential store is reachable.";
        return;
      }
      el.className = "banner " + (status.persistent ? "ok" : "warn");
      el.querySelector(".b-icon").innerHTML = icon(status.persistent ? "shield" : "alert");
      $("credentialTitle").textContent = status.persistent ? "Credentials are stored securely" : "Credentials are not persisted";
      $("credentialText").textContent = status.message || "";
    }
    function clientInitials(label) {
      return String(label || "?").split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
    }
    function renderClients(targets) {
      const list = Array.isArray(targets) ? targets : [];
      const ready = list.filter(t => t.autoInstall && t.available).length;
      const configured = list.filter(t => t.configured).length;
      $("clientSummary").textContent = list.length
        ? ("Register MCP for i with the coding assistants on this machine. " + ready + " detected, " + configured + " configured.")
        : "No client integrations detected.";
      const host = $("clientButtons");
      host.innerHTML = "";
      for (const target of list) {
        let chip;
        if (target.configured) chip = "<span class='chip ok'>Configured</span>";
        else if (!target.autoInstall) chip = "<span class='chip plain'>Manual setup</span>";
        else if (target.available) chip = "<span class='chip info'>Detected</span>";
        else chip = "<span class='chip plain'>Not detected</span>";
        const card = document.createElement("div");
        card.className = "card client";
        card.innerHTML =
          "<div class='client-top'><div class='client-logo'>" + escapeHtml(clientInitials(target.label)) + "</div>" +
          "<div style='min-width:0;flex:1'><div class='client-name'>" + escapeHtml(target.label) + "</div></div>" + chip + "</div>" +
          "<div class='client-desc'>" + escapeHtml(target.description || "") + (target.details ? ("<div class='help' style='margin-top:4px'>" + escapeHtml(target.details) + "</div>") : "") + "</div>" +
          "<div class='client-foot'><span></span></div>";
        const btn = document.createElement("button");
        btn.type = "button";
        const primary = target.autoInstall && target.available && !target.configured;
        btn.className = "btn " + (primary ? "btn-primary" : "btn-secondary");
        btn.textContent = target.autoInstall ? (target.configured ? "Re-apply" : "Add to " + target.label.split(" /")[0]) : "Show instructions";
        btn.dataset.clientId = target.id;
        btn.disabled = !state.online || state.busy;
        btn.addEventListener("click", () => installClient(target.id, btn));
        card.querySelector(".client-foot").appendChild(btn);
        host.appendChild(card);
      }
    }
    function renderSessions(snapshot) {
      const body = $("sessionsBody");
      body.innerHTML = "";
      const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
      $("sessionsUpdated").textContent = snapshot && snapshot.updatedAt
        ? ("Warm IBM i sessions held by the MCP server. Updated " + relativeTime(snapshot.updatedAt) + ".")
        : "Warm IBM i sessions held by the MCP server.";
      if (sessions.length === 0) {
        const tr = document.createElement("tr");
        tr.innerHTML = "<td colspan='4' style='padding:0'><div class='empty compact'><div class='empty-icon'>" + icon("pulse") + "</div><h3>No active sessions</h3><p>Sessions open when your coding assistant first uses a connection.</p></div></td>";
        body.appendChild(tr);
        return;
      }
      for (const s of sessions) {
        const st = String(s.state || "-");
        const kind = /connected|ready|active|open/i.test(st) ? "ok" : /reconnect|connecting|idle/i.test(st) ? "warn" : /fail|error|closed|disconnect/i.test(st) ? "danger" : "";
        const pc = POLICY_CHIP[s.policy] || ["", s.policy || "-"];
        const tr = document.createElement("tr");
        tr.innerHTML = "<td><span class='cell-primary'>" + escapeHtml(s.name || "") + "</span>" + (s.active ? " <span class='chip info plain' style='margin-left:6px'>Active</span>" : "") + "</td>" +
          "<td><span class='chip " + kind + "'>" + escapeHtml(st) + "</span></td>" +
          "<td><span class='chip plain " + pc[0] + "'>" + escapeHtml(pc[1]) + "</span></td>" +
          "<td class='mono' style='font-size:12.5px'>" + escapeHtml(formatDuration(s.idleSecondsRemaining)) + "</td>";
        body.appendChild(tr);
      }
    }
    const SETTINGS_FIELDS = [
      ["sessionIdleMinutes", 1, 1440, 30],
      ["sessionPingSeconds", 5, 300, 15],
      ["sessionReconnectAttempts", 1, 5, 2]
    ];
    function renderSettings(settings) {
      state.settings = {};
      for (const [key, , , def] of SETTINGS_FIELDS) {
        const v = settings?.[key] ?? def;
        state.settings[key] = String(v);
        $(key).value = String(v);
        $(key).closest(".field").classList.remove("invalid");
      }
      updateSettingsDirty();
    }
    function settingsDirty() {
      if (!state.settings) return false;
      return SETTINGS_FIELDS.some(([key]) => String($(key).value) !== state.settings[key]);
    }
    function updateSettingsDirty() {
      const dirty = settingsDirty();
      $("settingsDirty").textContent = dirty ? "You have unsaved changes" : "No unsaved changes";
      $("settingsDirty").style.color = dirty ? "var(--warn)" : "";
    }
    function validateSettings() {
      let ok = true;
      for (const [key, min, max] of SETTINGS_FIELDS) {
        const raw = $(key).value.trim();
        const n = Number(raw);
        const valid = raw !== "" && Number.isInteger(n) && n >= min && n <= max;
        $(key).closest(".field").classList.toggle("invalid", !valid);
        if (!valid) ok = false;
      }
      return ok;
    }

    /* Loaders */
    async function pingHealth() {
      try {
        const res = await fetch("/api/health", { cache: "no-store", headers: { [TOKEN_HEADER]: API_TOKEN } });
        if (!res.ok) return false;
        const data = await res.json();
        renderCredentialStore(data?.credentialStore || null);
        return Boolean(data?.ok);
      } catch {
        return false;
      }
    }
    async function loadConnections() { renderConnections((await api("/api/connections")).connections || []); }
    async function loadRuntimeStatus() { renderLogs((await api("/api/runtime/status")).jobs || {}); }
    async function loadServiceStatus() { renderService((await api("/api/service/status")).status || null); }
    async function loadClients() { renderClients((await api("/api/clients")).targets || []); }
    async function loadSessions() { renderSessions((await api("/api/sessions")).snapshot || null); }
    async function loadSettings() { renderSettings((await api("/api/settings")).settings || null); }
    async function loadVersions() {
      const s = persistSkillsUpdateSettings();
      const query = new URLSearchParams({ repoUrl: s.repoUrl, branch: s.branch });
      renderVersions(await api("/api/runtime/versions?" + query.toString()));
    }

    /* Connection dialog */
    function setPolicy(value) {
      document.querySelectorAll("input[name='connPolicy']").forEach(r => { r.checked = r.value === value; });
    }
    function getPolicy() {
      const r = document.querySelector("input[name='connPolicy']:checked");
      return r ? r.value : "guarded";
    }
    function openConnectionDialog(mode, conn) {
      const edit = mode === "edit";
      const s = (edit && conn.settings) || {};
      state.editingName = edit ? String(conn.name || "") : "";
      $("connectionDialogTitle").textContent = edit ? "Edit connection" : "Add connection";
      $("connectionDialogSub").textContent = edit ? ("Update settings for " + conn.name + ".") : "Connect over SSH to an IBM i system.";
      $("connName").disabled = edit;
      $("connName").value = edit ? (conn.name || "") : "";
      $("connHost").value = edit ? (conn.host || "") : "";
      $("connPort").value = edit ? String(conn.port || 22) : "22";
      $("connUser").value = edit ? (conn.username || "") : "";
      $("connKeyPath").value = edit ? (conn.privateKeyPath || "") : "";
      $("connPassword").value = "";
      $("connPassword").placeholder = edit ? "Leave blank to keep current" : "Stored in OS keychain";
      setPolicy(edit ? ((conn.policy && conn.policy.profile) || "guarded") : "guarded");
      $("connCurrentLibrary").value = s.currentLibrary || "";
      $("connLibraryList").value = Array.isArray(s.libraryList) ? s.libraryList.join(", ") : "";
      $("connSessionIdleMinutes").value = s.sessionIdleMinutes ? String(s.sessionIdleMinutes) : "";
      $("connSessionPingSeconds").value = s.sessionPingSeconds ? String(s.sessionPingSeconds) : "";
      $("connSessionReconnectAttempts").value = s.sessionReconnectAttempts ? String(s.sessionReconnectAttempts) : "";
      $("overridesDisclosure").open = Boolean(s.sessionIdleMinutes || s.sessionPingSeconds || s.sessionReconnectAttempts);
      $("connectionError").classList.remove("show");
      renderTestResult(null);
      document.querySelectorAll("#connectionForm .field").forEach(f => f.classList.remove("invalid"));
      const dialog = $("connectionDialog");
      if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "open");
      (edit ? $("connHost") : $("connName")).focus();
    }
    function closeConnectionDialog() {
      const dialog = $("connectionDialog");
      if (typeof dialog.close === "function") dialog.close(); else dialog.removeAttribute("open");
      state.editingName = "";
    }
    async function onConnectionAction(e) {
      const btn = e.currentTarget;
      const action = btn.dataset.action;
      const name = decodeURIComponent(btn.dataset.name || "");
      const conn = state.connections.find(c => c.name === name);
      if (!conn) return;
      if (action === "edit") {
        openConnectionDialog("edit", conn);
        return;
      }
      if (action === "test") {
        await testSavedConnection(name, btn);
        return;
      }
      if (action === "delete") {
        const ok = await confirmAction("Delete " + name + "?", "This removes the saved connection and its stored password. Active sessions for it will close.", "Delete connection");
        if (!ok) return;
        await withLoading(btn, async () => {
          try {
            await api("/api/connections/" + encodeURIComponent(name), { method: "DELETE" });
            toast("ok", "Connection deleted", name);
            await loadConnections();
          } catch (err) {
            toast("error", "Could not delete connection", errorMessage(err));
          }
        });
      }
    }
    function validateConnectionForm() {
      let first = null;
      const check = (id, valid) => {
        $(id).closest(".field").classList.toggle("invalid", !valid);
        if (!valid && !first) first = $(id);
      };
      check("connName", Boolean($("connName").value.trim()));
      check("connUser", Boolean($("connUser").value.trim()));
      check("connHost", Boolean($("connHost").value.trim()));
      const port = Number($("connPort").value || 22);
      check("connPort", Number.isInteger(port) && port >= 1 && port <= 65535);
      if (first) first.focus();
      return !first;
    }
    async function saveConnectionFromDialog(e) {
      e.preventDefault();
      $("connectionError").classList.remove("show");
      if (!validateConnectionForm()) return;
      const name = $("connName").value.trim();
      const password = $("connPassword").value || "";
      const payload = {
        name,
        host: $("connHost").value.trim(),
        port: Number($("connPort").value || 22),
        username: $("connUser").value.trim(),
        privateKeyPath: $("connKeyPath").value.trim() || undefined,
        password: password || undefined,
        storePassword: Boolean(password),
        policy: { profile: getPolicy() },
        settings: {
          currentLibrary: $("connCurrentLibrary").value.trim().toUpperCase(),
          libraryList: normalizeLibraries($("connLibraryList").value),
          sessionIdleMinutes: parseOptionalNumber($("connSessionIdleMinutes").value, 1, 1440),
          sessionPingSeconds: parseOptionalNumber($("connSessionPingSeconds").value, 5, 300),
          sessionReconnectAttempts: parseOptionalNumber($("connSessionReconnectAttempts").value, 1, 5)
        }
      };
      const editing = state.editingName;
      await withLoading($("saveConnectionBtn"), async () => {
        try {
          if (editing) {
            await api("/api/connections/" + encodeURIComponent(editing), { method: "PUT", body: JSON.stringify(payload) });
          } else {
            await api("/api/connections", { method: "POST", body: JSON.stringify(payload) });
          }
          closeConnectionDialog();
          toast("ok", editing ? "Connection updated" : "Connection added", name);
          await loadConnections();
        } catch (err) {
          $("connectionError").textContent = errorMessage(err);
          $("connectionError").classList.add("show");
          return;
        }
        // One check after saving, so the list shows whether the details work.
        testSavedConnection(name);
      });
    }
    async function testConnectionFromDialog() {
      $("connectionError").classList.remove("show");
      let first = null;
      const check = (id, valid) => {
        $(id).closest(".field").classList.toggle("invalid", !valid);
        if (!valid && !first) first = $(id);
      };
      check("connUser", Boolean($("connUser").value.trim()));
      check("connHost", Boolean($("connHost").value.trim()));
      const port = Number($("connPort").value || 22);
      check("connPort", Number.isInteger(port) && port >= 1 && port <= 65535);
      if (first) { first.focus(); return; }
      const payload = {
        name: state.editingName || undefined,
        host: $("connHost").value.trim(),
        port,
        username: $("connUser").value.trim(),
        privateKeyPath: $("connKeyPath").value.trim() || undefined,
        password: $("connPassword").value || undefined
      };
      renderTestResult(null);
      await withLoading($("testConnectionBtn"), async () => {
        try {
          const result = (await api("/api/connections/test", { method: "POST", body: JSON.stringify(payload) })).result;
          renderTestResult(result);
        } catch (err) {
          $("connectionError").textContent = errorMessage(err);
          $("connectionError").classList.add("show");
        }
      });
      $("connectionTestResult").scrollIntoView({ block: "nearest" });
    }

    /* Settings */
    async function saveSettings(e) {
      if (e) e.preventDefault();
      if (!validateSettings()) return;
      await withLoading($("saveSettingsBtn"), async () => {
        try {
          await api("/api/settings", {
            method: "PUT",
            body: JSON.stringify({
              sessionIdleMinutes: Number($("sessionIdleMinutes").value),
              sessionPingSeconds: Number($("sessionPingSeconds").value),
              sessionReconnectAttempts: Number($("sessionReconnectAttempts").value)
            })
          });
          await loadSettings();
          toast("ok", "Settings saved");
        } catch (err) {
          toast("error", "Could not save settings", errorMessage(err));
        }
      });
    }

    /* Jobs */
    async function beginReconnectFlow(label, jobKey) {
      setServiceState("reconnecting", "Restarting", label + " running. Waiting for restart...");
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline) {
        await sleep(1800);
        if (await pingHealth()) {
          // Jobs run in the background: wait until this one is no longer running.
          // After a restart the new process reports it as idle.
          let job = null;
          if (jobKey) {
            try { job = ((await api("/api/runtime/status")).jobs || {})[jobKey] || null; } catch { continue; }
            if (job && job.status === "running") continue;
          }
          setServiceState("online", "Online", "Local control service");
          await refreshAll();
          if (job && job.status === "failed") toast("error", label + " failed", job.error || "");
          else toast("ok", label + " finished", "The control plane is back online.");
          return;
        }
      }
      setServiceState("offline", "Offline", "Run mcp-for-i control to start it");
      toast("error", "Service did not come back", "Start it again with mcp-for-i control.");
    }
    async function triggerJob(path, payload, options = {}, btn) {
      if (!state.online) {
        toast("error", "Control plane is offline", "Start it with mcp-for-i control.");
        return;
      }
      if (options.confirm) {
        const ok = await confirmAction(options.confirm.title, options.confirm.text, options.confirm.ok);
        if (!ok) return;
      }
      setBusy(true);
      if (btn) btn.classList.add("loading");
      try {
        const started = await api(path, { method: "POST", body: payload ? JSON.stringify(payload) : undefined });
        await loadRuntimeStatus();
        if (options.expectRestart) await beginReconnectFlow(options.label || "Update", started && started.job ? started.job.id : "");
        else {
          await Promise.allSettled([loadServiceStatus(), loadVersions(), loadSessions()]);
          startJobPolling();
        }
      } catch (err) {
        toast("error", (options.label || "Action") + " failed", errorMessage(err));
        if (!await pingHealth()) setServiceState("offline", "Offline", "Waiting for reconnect...");
      } finally {
        if (btn) btn.classList.remove("loading");
        setBusy(false);
      }
    }
    async function installClient(id, btn) {
      if (!state.online) {
        toast("error", "Control plane is offline", "Start it with mcp-for-i control.");
        return;
      }
      setBusy(true);
      if (btn) btn.classList.add("loading");
      try {
        const response = await api("/api/clients/install", { method: "POST", body: JSON.stringify({ id }) });
        const result = response?.result || {};
        const lines = [result.message || ""].concat(result.output || []);
        $("clientLogsTitle").textContent = result.label || id;
        $("clientLogs").textContent = lines.filter(Boolean).join(NL) || "Done.";
        $("clientLogsCard").hidden = false;
        if (result.ok === false) toast("error", "Could not configure " + (result.label || id), result.message || "");
        else toast("ok", result.label || id, result.message || "Done");
        await loadClients();
      } catch (err) {
        $("clientLogsTitle").textContent = "Client setup failed";
        $("clientLogs").textContent = errorMessage(err);
        $("clientLogsCard").hidden = false;
        toast("error", "Client setup failed", errorMessage(err));
      } finally {
        if (btn) btn.classList.remove("loading");
        setBusy(false);
      }
    }
    let pollId = 0;
    function startJobPolling() {
      if (pollId) return;
      pollId = setInterval(async () => {
        if (!await pingHealth()) return;
        try {
          const before = JSON.stringify(Object.fromEntries(Object.entries(state.jobs).map(([k, j]) => [k, j.status])));
          await loadRuntimeStatus();
          const running = Object.values(state.jobs || {}).some(j => j.status === "running");
          if (!running) {
            clearInterval(pollId);
            pollId = 0;
            const prev = JSON.parse(before);
            for (const [k, j] of Object.entries(state.jobs)) {
              if (prev[k] === "running" && j.status === "success") toast("ok", jobLabel(k) + " succeeded");
              if (prev[k] === "running" && j.status === "failed") toast("error", jobLabel(k) + " failed", j.error || "");
            }
            await Promise.allSettled([loadServiceStatus(), loadVersions(), loadSessions()]);
          }
        } catch {}
      }, 1800);
    }
    let heartbeatId = 0;
    function startHeartbeat() {
      if (heartbeatId) clearInterval(heartbeatId);
      heartbeatId = setInterval(async () => {
        const ok = await pingHealth();
        if (ok && !state.online) {
          setServiceState("online", "Online", "Local control service");
          await refreshAll();
        } else if (!ok && state.online && !state.busy) {
          setServiceState("offline", "Offline", "Waiting for reconnect...");
        }
      }, 2500);
    }
    async function refreshAll(btn) {
      return withLoading(btn, async () => {
        const healthy = await pingHealth();
        if (!healthy) {
          setServiceState("offline", "Offline", "Run mcp-for-i control to start it");
          return;
        }
        setServiceState("online", "Online", "Local control service");
        await Promise.allSettled([loadConnections(), loadRuntimeStatus(), loadServiceStatus(), loadVersions(), loadSessions(), loadSettings(), loadClients()]);
      });
    }

    /* Wiring */
    document.querySelectorAll(".nav-item").forEach(btn => {
      btn.addEventListener("click", () => activateTab(btn.dataset.tab || "overview", true));
    });
    window.addEventListener("hashchange", () => activateTab(location.hash.replace("#", "")));
    $("themeBtn").addEventListener("click", () => applyTheme(currentTheme() === "dark" ? "light" : "dark", true));
    $("addConnectionBtn").addEventListener("click", () => openConnectionDialog("add", {}));
    $("emptyAddConnectionBtn").addEventListener("click", () => openConnectionDialog("add", {}));
    $("connectionForm").addEventListener("submit", saveConnectionFromDialog);
    $("cancelConnectionBtn").addEventListener("click", closeConnectionDialog);
    $("testConnectionBtn").addEventListener("click", testConnectionFromDialog);
    $("closeConnectionDialogBtn").addEventListener("click", closeConnectionDialog);
    ["connName", "connUser", "connHost", "connPort"].forEach(id => $(id).addEventListener("input", () => $(id).closest(".field").classList.remove("invalid")));
    $("connectionDialog").addEventListener("click", e => { if (e.target === e.currentTarget) closeConnectionDialog(); });
    $("refreshOverviewBtn").addEventListener("click", e => refreshAll(e.currentTarget));
    $("refreshRuntimeBtn").addEventListener("click", e => withLoading(e.currentTarget, () => Promise.allSettled([loadRuntimeStatus(), loadServiceStatus(), loadVersions(), loadSessions()])));
    $("refreshClientsBtn").addEventListener("click", e => withLoading(e.currentTarget, () => loadClients().catch(err => toast("error", "Could not load clients", errorMessage(err)))));
    $("settingsForm").addEventListener("submit", saveSettings);
    $("settingsForm").addEventListener("input", () => { updateSettingsDirty(); });
    $("reloadSettingsBtn").addEventListener("click", () => loadSettings().catch(err => toast("error", "Could not load settings", errorMessage(err))));
    $("updateMcpBtn").addEventListener("click", e => triggerJob("/api/runtime/update/mcp", null, {
      expectRestart: true, label: "MCP update",
      confirm: { title: "Update the MCP server?", text: "The control plane restarts during the update. Coding assistants using MCP for i may need to reconnect.", ok: "Update and restart" }
    }, e.currentTarget));
    $("updateSkillsBtn").addEventListener("click", e => triggerJob("/api/runtime/update/skills", persistSkillsUpdateSettings(), { label: "Skills update" }, e.currentTarget));
    $("enableServiceBtn").addEventListener("click", e => triggerJob("/api/service/enable", null, { label: "Enable service" }, e.currentTarget));
    $("disableServiceBtn").addEventListener("click", e => triggerJob("/api/service/disable", null, { label: "Disable service" }, e.currentTarget));
    $("clientLogsClose").addEventListener("click", () => { $("clientLogsCard").hidden = true; });
    $("skillsRepoUrl").addEventListener("change", () => { persistSkillsUpdateSettings(); loadVersions().catch(() => {}); });
    $("skillsBranch").addEventListener("change", () => { persistSkillsUpdateSettings(); loadVersions().catch(() => {}); });
    window.addEventListener("beforeunload", e => { if (settingsDirty()) { e.preventDefault(); e.returnValue = ""; } });

    applyTheme(currentTheme(), false);
    loadSkillsUpdateSettings();
    activateTab(initialTab());
    renderLogs({});
    setServiceState("offline", "Connecting", "Checking local service...");
    refreshAll().catch(err => toast("error", "Startup error", errorMessage(err)));
    startHeartbeat();
  </script>
</body>
</html>`;
}

function escapeAttribute(value: string) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
