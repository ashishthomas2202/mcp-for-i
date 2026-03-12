export function renderControlPlaneHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MCP-for-i Control Plane</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f7fb;
      --surface: #fff;
      --surface-2: #f8fbff;
      --line: #d9e2ee;
      --line-2: #c1cfdf;
      --text: #102033;
      --muted: #61778f;
      --accent: #0d6efd;
      --accent-2: #0a58ca;
      --ok: #1d9158;
      --warn: #b26a00;
      --danger: #c12c2c;
      --shadow: 0 10px 28px rgba(17, 33, 56, 0.12);
      --ring: 0 0 0 3px rgba(13, 110, 253, 0.2);
    }
    body[data-theme="dark"] {
      color-scheme: dark;
      --bg: #0d1626;
      --surface: #121f33;
      --surface-2: #18283f;
      --line: #2c3f5a;
      --line-2: #3d5475;
      --text: #e6eef8;
      --muted: #9fb4ce;
      --accent: #4b92ff;
      --accent-2: #3579df;
      --ok: #31bf79;
      --warn: #d18c1c;
      --danger: #f16262;
      --shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
      --ring: 0 0 0 3px rgba(75, 146, 255, 0.28);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 "Inter", "Segoe UI", sans-serif;
      color: var(--text);
      background: radial-gradient(circle at 12% 0%, rgba(13, 110, 253, 0.12), transparent 35%), var(--bg);
    }
    .app { max-width: 1140px; margin: 0 auto; padding: 22px; display: grid; gap: 14px; }
    .panel, .tabs, .header {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: var(--shadow);
    }
    .header {
      padding: 14px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .header h1 { margin: 0; font-size: 22px; }
    .sub { color: var(--muted); margin-top: 2px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .status {
      display: inline-flex; gap: 8px; align-items: center;
      border-radius: 999px; border: 1px solid var(--line);
      background: var(--surface-2); color: var(--muted);
      padding: 7px 11px; font-size: 12px; font-weight: 700;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
    .status.online { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
    .status.online .dot { background: var(--ok); }
    .status.reconnecting { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
    .status.reconnecting .dot { background: var(--warn); }
    .status.offline { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); }
    .status.offline .dot { background: var(--danger); }
    .tabs { padding: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
    .tab-btn {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--surface-2);
      color: var(--text);
      padding: 8px 12px;
      font-weight: 700;
      cursor: pointer;
    }
    .tab-btn.active {
      border-color: color-mix(in srgb, var(--accent) 42%, var(--line));
      background: color-mix(in srgb, var(--accent) 16%, var(--surface));
      color: var(--accent-2);
    }
    .panel { display: none; padding: 14px; }
    .panel.active { display: block; }
    .toolbar {
      display: flex; justify-content: space-between; align-items: center;
      gap: 8px; flex-wrap: wrap; margin-bottom: 10px;
    }
    .muted, .hint { color: var(--muted); }
    .hint { font-size: 12px; }
    .grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 10px; }
    .card {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--surface-2);
      padding: 10px;
    }
    .card h3 {
      margin: 0 0 7px;
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .value { font-weight: 700; word-break: break-word; }
    .badge {
      margin-top: 7px; display: inline-block;
      border: 1px solid var(--line); border-radius: 999px;
      padding: 3px 8px; font-size: 11px; font-weight: 700;
      letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted);
    }
    .badge.latest { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); }
    .badge.update { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
    .badge.unknown { color: var(--muted); }
    .fields { display: grid; gap: 9px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .field label {
      display: block; margin-bottom: 5px;
      color: var(--muted); font-size: 11px; font-weight: 700;
      letter-spacing: 0.08em; text-transform: uppercase;
    }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--surface);
      color: var(--text);
      padding: 9px 10px;
      font: inherit;
      outline: none;
    }
    textarea { min-height: 82px; resize: vertical; }
    input:focus, select:focus, textarea:focus { border-color: var(--accent); box-shadow: var(--ring); }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    button {
      border: 1px solid transparent;
      border-radius: 10px;
      padding: 9px 12px;
      font-weight: 700;
      cursor: pointer;
      background: var(--accent);
      color: #fff;
    }
    button:hover { background: var(--accent-2); }
    button:focus-visible { outline: none; box-shadow: var(--ring); }
    button[disabled] { opacity: 0.58; cursor: not-allowed; }
    button.secondary { background: var(--surface-2); color: var(--text); border-color: var(--line); }
    button.secondary:hover { border-color: var(--line-2); background: var(--surface); }
    button.danger { background: var(--danger); color: #fff; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
    tr:last-child td { border-bottom: none; }
    .logs {
      margin-top: 8px;
      max-height: 320px;
      overflow: auto;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: var(--surface-2);
      padding: 10px;
      white-space: pre-wrap;
      font: 12px/1.4 ui-monospace, "Cascadia Code", Consolas, monospace;
    }
    dialog {
      border: none;
      border-radius: 14px;
      background: var(--surface);
      color: var(--text);
      box-shadow: var(--shadow);
      width: min(780px, 94vw);
      padding: 0;
    }
    dialog::backdrop { background: rgba(0, 0, 0, 0.42); }
    .dialog-body { padding: 14px; }
    .dialog-head {
      display: flex; justify-content: space-between; align-items: center; gap: 8px;
      margin-bottom: 10px;
    }
    .dialog-head h2 { margin: 0; font-size: 18px; }
    @media (max-width: 980px) {
      .app { padding: 14px; }
      .fields, .grid3 { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <section class="header">
      <div>
        <h1>MCP-for-i Control Plane</h1>
        <div class="sub">Secure IBM i onboarding, warm sessions, and update lifecycle.</div>
      </div>
      <div class="row">
        <div id="servicePill" class="status offline"><span class="dot"></span><span id="serviceText">Checking service...</span></div>
        <button id="themeBtn" class="secondary" type="button">Dark Theme</button>
      </div>
    </section>

    <section class="tabs">
      <button class="tab-btn active" type="button" data-tab="overview">Overview</button>
      <button class="tab-btn" type="button" data-tab="connections">Connections</button>
      <button class="tab-btn" type="button" data-tab="runtime">Runtime</button>
      <button class="tab-btn" type="button" data-tab="settings">Settings</button>
    </section>

    <section class="panel active" id="panel-overview">
      <div class="toolbar">
        <div id="runtimeSummary" class="muted">No runtime actions yet.</div>
        <button id="refreshOverviewBtn" class="secondary" type="button">Refresh</button>
      </div>
      <div class="grid3">
        <div class="card">
          <h3>MCP Version</h3>
          <div class="value" id="mcpVersionText">Checking...</div>
          <span class="badge unknown" id="mcpVersionBadge">Checking</span>
        </div>
        <div class="card">
          <h3>Skills Version</h3>
          <div class="value" id="skillsVersionText">Checking...</div>
          <span class="badge unknown" id="skillsVersionBadge">Checking</span>
        </div>
        <div class="card">
          <h3>Startup</h3>
          <div class="value" id="startupText">Checking...</div>
          <span class="badge unknown" id="startupBadge">Checking</span>
        </div>
      </div>
      <div id="versionCheckedAt" class="hint"></div>
      <h3 style="margin: 12px 0 8px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted);">Session Snapshot</h3>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>State</th>
            <th>Policy</th>
            <th>Idle Remaining</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody id="sessionsBody"></tbody>
      </table>
    </section>

    <section class="panel" id="panel-connections">
      <div class="toolbar">
        <div>
          <strong>Saved Connections</strong>
          <div class="hint" id="connectionCount">0 connections</div>
        </div>
        <button id="addConnectionBtn" type="button">Add Connection</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Host</th>
            <th>User</th>
            <th>Policy</th>
            <th>Library Context</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="connectionsBody"></tbody>
      </table>
    </section>

    <section class="panel" id="panel-runtime">
      <div class="toolbar"><strong>Runtime Actions</strong></div>
      <div class="fields">
        <div class="field">
          <label>Skills Repository URL</label>
          <input id="skillsRepoUrl" placeholder="https://github.com/org/mcp-for-i-skills.git" />
        </div>
        <div class="field">
          <label>Skills Branch</label>
          <input id="skillsBranch" placeholder="main" />
        </div>
      </div>
      <div class="actions">
        <button id="installBtn" type="button">Install or Repair MCP</button>
        <button id="updateMcpBtn" class="secondary" type="button">Update MCP</button>
        <button id="updateSkillsBtn" class="secondary" type="button">Update Skills</button>
      </div>
      <div class="actions">
        <button id="setupAutostartBtn" class="secondary" type="button">Enable Background Startup</button>
        <button id="removeAutostartBtn" class="secondary" type="button">Disable Background Startup</button>
        <button id="refreshRuntimeBtn" class="secondary" type="button">Refresh Runtime</button>
      </div>
      <div class="hint" id="autostartInfo">Startup status: checking...</div>
      <div class="logs" id="logs">No jobs yet.</div>
    </section>

    <section class="panel" id="panel-settings">
      <div class="toolbar"><strong>Session Defaults</strong></div>
      <div class="fields">
        <div class="field">
          <label>Idle Timeout (minutes)</label>
          <input id="sessionIdleMinutes" type="number" min="1" max="1440" />
        </div>
        <div class="field">
          <label>Health Check Ping (seconds)</label>
          <input id="sessionPingSeconds" type="number" min="5" max="300" />
        </div>
        <div class="field">
          <label>Reconnect Attempts</label>
          <input id="sessionReconnectAttempts" type="number" min="1" max="5" />
        </div>
      </div>
      <div class="actions">
        <button id="saveSettingsBtn" type="button">Save Settings</button>
        <button id="reloadSettingsBtn" class="secondary" type="button">Reload Settings</button>
      </div>
      <div class="hint">Defaults affect idle timeout, health checks, and reconnect behavior for session lifecycle handling.</div>
    </section>

    <dialog id="connectionDialog">
      <form id="connectionForm" method="dialog" class="dialog-body">
        <div class="dialog-head">
          <h2 id="connectionDialogTitle">Add Connection</h2>
          <button id="closeConnectionDialogBtn" class="secondary" type="button">Close</button>
        </div>
        <div class="fields">
          <div class="field">
            <label>Name</label>
            <input id="connName" required />
          </div>
          <div class="field">
            <label>Host</label>
            <input id="connHost" required />
          </div>
          <div class="field">
            <label>Port</label>
            <input id="connPort" type="number" min="1" max="65535" value="22" />
          </div>
          <div class="field">
            <label>Username</label>
            <input id="connUser" required />
          </div>
          <div class="field">
            <label>Private Key Path</label>
            <input id="connKeyPath" placeholder="Optional" />
          </div>
          <div class="field">
            <label>Password (keychain only)</label>
            <input id="connPassword" type="password" placeholder="Leave blank to keep current" />
          </div>
          <div class="field">
            <label>Policy</label>
            <select id="connPolicy">
              <option value="guarded">guarded</option>
              <option value="read-only">read-only</option>
              <option value="power-user">power-user</option>
            </select>
          </div>
          <div class="field">
            <label>Current Library</label>
            <input id="connCurrentLibrary" placeholder="Optional (for example QGPL)" />
          </div>
          <div class="field" style="grid-column: 1 / -1;">
            <label>Library List</label>
            <textarea id="connLibraryList" placeholder="Comma, space, or newline separated"></textarea>
          </div>
          <div class="field">
            <label>Session Idle Override (minutes)</label>
            <input id="connSessionIdleMinutes" type="number" min="1" max="1440" placeholder="Optional" />
          </div>
          <div class="field">
            <label>Session Ping Override (seconds)</label>
            <input id="connSessionPingSeconds" type="number" min="5" max="300" placeholder="Optional" />
          </div>
          <div class="field">
            <label>Reconnect Attempts Override</label>
            <input id="connSessionReconnectAttempts" type="number" min="1" max="5" placeholder="Optional" />
          </div>
        </div>
        <div class="actions">
          <button id="saveConnectionBtn" type="submit">Save Connection</button>
          <button id="cancelConnectionBtn" class="secondary" type="button">Cancel</button>
        </div>
      </form>
    </dialog>
  </div>

  <script>
    const THEME_KEY = "mcp_for_i_theme";
    const SKILLS_REPO_KEY = "mcp_for_i_skills_repo";
    const SKILLS_BRANCH_KEY = "mcp_for_i_skills_branch";
    const DEFAULT_SKILLS_REPO = "https://github.com/ashishthomas2202/mcp-for-i-skills.git";
    const DEFAULT_SKILLS_BRANCH = "main";
    const LEGACY_SKILLS_REPO = "https://github.com/ashishthomas-pcr/mcp-for-i-skills.git";
    const CONTROL_BUTTONS = [
      "installBtn", "updateMcpBtn", "updateSkillsBtn", "setupAutostartBtn", "removeAutostartBtn",
      "refreshOverviewBtn", "refreshRuntimeBtn", "saveSettingsBtn", "reloadSettingsBtn", "addConnectionBtn"
    ];
    const state = { online: false, busy: false, jobs: {}, connections: [], editingName: "" };
    const $ = id => document.getElementById(id);

    function escapeHtml(s) {
      return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    }
    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
    function setButtonsDisabled(disabled) {
      for (const id of CONTROL_BUTTONS) {
        const el = $(id);
        if (el) el.disabled = disabled;
      }
    }
    function setBusy(busy) {
      state.busy = busy;
      setButtonsDisabled(!state.online || state.busy);
    }
    function setServiceState(mode, text) {
      const pill = $("servicePill");
      pill.classList.remove("online", "offline", "reconnecting");
      pill.classList.add(mode);
      $("serviceText").textContent = text;
      state.online = mode === "online";
      setButtonsDisabled(!state.online || state.busy);
    }
    async function api(path, options = {}) {
      const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || ("HTTP " + res.status));
      }
      if (res.status === 204) return null;
      return res.json();
    }
    function readStoredTheme() {
      try {
        const v = localStorage.getItem(THEME_KEY);
        if (v === "light" || v === "dark") return v;
      } catch {}
      return "light";
    }
    function applyTheme(theme) {
      document.body.setAttribute("data-theme", theme);
      $("themeBtn").textContent = theme === "dark" ? "Light Theme" : "Dark Theme";
      try { localStorage.setItem(THEME_KEY, theme); } catch {}
    }
    function toggleTheme() {
      const current = document.body.getAttribute("data-theme") === "dark" ? "dark" : "light";
      applyTheme(current === "dark" ? "light" : "dark");
    }
    function activateTab(name) {
      document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === name));
      document.querySelectorAll(".panel").forEach(panel => panel.classList.toggle("active", panel.id === "panel-" + name));
    }
    function setBadge(id, text, kind) {
      const el = $(id);
      el.textContent = text;
      el.className = "badge " + kind;
    }
    function normalizeLibraries(value) {
      const list = String(value || "").split(/[\\s,]+/).map(v => v.trim().toUpperCase()).filter(Boolean);
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
    function renderRuntimeSummary() {
      const entries = Object.entries(state.jobs || {});
      const running = entries.find(([, job]) => job.status === "running");
      if (running) {
        $("runtimeSummary").textContent = "Running: " + running[0] + " action in progress.";
        return;
      }
      if (entries.length === 0) {
        $("runtimeSummary").textContent = "No runtime actions yet.";
        return;
      }
      const latest = entries.map(([id, job]) => ({ id, at: Date.parse(job.finishedAt || job.startedAt || "") || 0, status: job.status }))
        .sort((a, b) => b.at - a.at)[0];
      $("runtimeSummary").textContent = "Last action: " + latest.id + " (" + latest.status + ").";
    }
    function renderLogs(jobs) {
      state.jobs = jobs || {};
      const lines = [];
      for (const key of Object.keys(state.jobs)) {
        const j = state.jobs[key];
        lines.push("[" + key + "] " + j.status);
        if (j.startedAt) lines.push("  started: " + j.startedAt);
        if (j.finishedAt) lines.push("  finished: " + j.finishedAt);
        if (j.error) lines.push("  error: " + j.error);
        for (const line of j.output || []) lines.push("  " + line);
        lines.push("");
      }
      $("logs").textContent = lines.length ? lines.join("\\n") : "No jobs yet.";
      renderRuntimeSummary();
    }
    function renderConnections(list) {
      state.connections = list || [];
      $("connectionCount").textContent = state.connections.length + (state.connections.length === 1 ? " connection" : " connections");
      const body = $("connectionsBody");
      body.innerHTML = "";
      for (const conn of state.connections) {
        const policy = (conn.policy && conn.policy.profile) || "guarded";
        const current = conn.settings && conn.settings.currentLibrary ? conn.settings.currentLibrary : "";
        const libs = Array.isArray(conn.settings && conn.settings.libraryList) ? conn.settings.libraryList.join(", ") : "";
        const sessionIdle = conn.settings && Number.isFinite(Number(conn.settings.sessionIdleMinutes)) ? ("Idle " + conn.settings.sessionIdleMinutes + "m") : "";
        const sessionPing = conn.settings && Number.isFinite(Number(conn.settings.sessionPingSeconds)) ? ("Ping " + conn.settings.sessionPingSeconds + "s") : "";
        const sessionReconnect = conn.settings && Number.isFinite(Number(conn.settings.sessionReconnectAttempts)) ? ("Reconnect " + conn.settings.sessionReconnectAttempts) : "";
        const ctx = [current ? ("Current: " + current) : "", libs ? ("List: " + libs) : "", sessionIdle, sessionPing, sessionReconnect]
          .filter(Boolean)
          .join(" | ") || "None";
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td><strong>" + escapeHtml(conn.name) + "</strong></td>" +
          "<td>" + escapeHtml(conn.host || "") + ":" + escapeHtml(String(conn.port || 22)) + "</td>" +
          "<td>" + escapeHtml(conn.username || "") + "</td>" +
          "<td>" + escapeHtml(policy) + "</td>" +
          "<td>" + escapeHtml(ctx) + "</td>" +
          "<td><button class='secondary' data-action='edit' data-name='" + encodeURIComponent(conn.name) + "' type='button'>Edit</button> " +
          "<button class='danger' data-action='delete' data-name='" + encodeURIComponent(conn.name) + "' type='button'>Delete</button></td>";
        body.appendChild(tr);
      }
      body.querySelectorAll("button").forEach(btn => btn.addEventListener("click", onConnectionAction));
    }
    function renderVersions(data) {
      const mcp = data?.mcp || {};
      const skills = data?.skills || {};
      $("mcpVersionText").textContent = (mcp.installedVersion || "Unknown") + " (latest: " + (mcp.latestVersion || "Unknown") + ")";
      if (mcp.status === "latest") setBadge("mcpVersionBadge", "Latest", "latest");
      else if (mcp.status === "update-available") setBadge("mcpVersionBadge", "Update Available", "update");
      else setBadge("mcpVersionBadge", "Unknown", "unknown");

      const skillsLocal = skills.localCommit ? ((skills.localBranch || "branch") + " @ " + skills.localCommit) : (skills.status === "not-installed" ? "Not installed" : "Unknown");
      const skillsLatest = skills.latestCommit ? (" (latest: " + skills.latestCommit + ")") : "";
      $("skillsVersionText").textContent = skillsLocal + skillsLatest;
      if (skills.status === "latest") setBadge("skillsVersionBadge", "Latest", "latest");
      else if (skills.status === "update-available") setBadge("skillsVersionBadge", "Update Available", "update");
      else if (skills.status === "not-installed") setBadge("skillsVersionBadge", "Not Installed", "unknown");
      else setBadge("skillsVersionBadge", "Unknown", "unknown");

      if (data?.checkedAt) $("versionCheckedAt").textContent = "Last checked: " + data.checkedAt;
    }
    function renderAutostart(status) {
      if (!status) {
        $("autostartInfo").textContent = "Startup status: unavailable";
        $("startupText").textContent = "Unavailable";
        setBadge("startupBadge", "Unknown", "unknown");
        return;
      }
      if (status.supported === false) {
        $("autostartInfo").textContent = "Startup status: not managed on " + status.platform + ". Running now: " + (status.running ? "yes" : "no") + ".";
        $("startupText").textContent = "Not Managed";
        setBadge("startupBadge", status.running ? "Running" : "Stopped", status.running ? "latest" : "unknown");
        return;
      }
      const installed = status.installed ? "enabled" : "disabled";
      const stateText = status.state ? (" (" + status.state + ")") : "";
      $("autostartInfo").textContent = "Startup status: " + installed + stateText + ". Running now: " + (status.running ? "yes" : "no") + ".";
      $("startupText").textContent = installed + stateText;
      if (status.installed && status.running) setBadge("startupBadge", "Running", "latest");
      else if (status.installed) setBadge("startupBadge", "Enabled", "update");
      else setBadge("startupBadge", "Disabled", "unknown");
    }
    function renderSessions(snapshot) {
      const body = $("sessionsBody");
      body.innerHTML = "";
      const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
      if (sessions.length === 0) {
        const tr = document.createElement("tr");
        tr.innerHTML = "<td colspan='5' class='muted'>No active sessions yet.</td>";
        body.appendChild(tr);
        return;
      }
      for (const s of sessions) {
        const tr = document.createElement("tr");
        const idle = typeof s.idleSecondsRemaining === "number" ? (s.idleSecondsRemaining + "s") : "-";
        tr.innerHTML = "<td>" + escapeHtml(s.name || "") + (s.active ? " (active)" : "") + "</td>" +
          "<td>" + escapeHtml(s.state || "-") + "</td>" +
          "<td>" + escapeHtml(s.policy || "-") + "</td>" +
          "<td>" + escapeHtml(idle) + "</td>" +
          "<td>" + escapeHtml(snapshot.updatedAt || "-") + "</td>";
        body.appendChild(tr);
      }
    }
    function renderSettings(settings) {
      $("sessionIdleMinutes").value = String(settings?.sessionIdleMinutes ?? 30);
      $("sessionPingSeconds").value = String(settings?.sessionPingSeconds ?? 15);
      $("sessionReconnectAttempts").value = String(settings?.sessionReconnectAttempts ?? 2);
    }
    async function pingHealth() {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        if (!res.ok) return false;
        const data = await res.json();
        return Boolean(data?.ok);
      } catch {
        return false;
      }
    }
    async function loadConnections() { renderConnections((await api("/api/connections")).connections || []); }
    async function loadRuntimeStatus() { renderLogs((await api("/api/runtime/status")).jobs || {}); }
    async function loadAutostartStatus() { renderAutostart((await api("/api/runtime/autostart/status")).status || null); }
    async function loadSessions() { renderSessions((await api("/api/sessions")).snapshot || null); }
    async function loadSettings() { renderSettings((await api("/api/settings")).settings || null); }
    async function loadVersions() {
      const s = persistSkillsUpdateSettings();
      const query = new URLSearchParams({ repoUrl: s.repoUrl, branch: s.branch });
      renderVersions(await api("/api/runtime/versions?" + query.toString()));
    }
    function openConnectionDialog(mode, conn) {
      state.editingName = mode === "edit" ? String(conn.name || "") : "";
      $("connectionDialogTitle").textContent = mode === "edit" ? "Edit Connection" : "Add Connection";
      $("connName").disabled = mode === "edit";
      $("connName").value = mode === "edit" ? (conn.name || "") : "";
      $("connHost").value = mode === "edit" ? (conn.host || "") : "";
      $("connPort").value = mode === "edit" ? String(conn.port || 22) : "22";
      $("connUser").value = mode === "edit" ? (conn.username || "") : "";
      $("connKeyPath").value = mode === "edit" ? (conn.privateKeyPath || "") : "";
      $("connPassword").value = "";
      $("connPolicy").value = mode === "edit" ? ((conn.policy && conn.policy.profile) || "guarded") : "guarded";
      $("connCurrentLibrary").value = mode === "edit" ? ((conn.settings && conn.settings.currentLibrary) || "") : "";
      $("connLibraryList").value = mode === "edit" && Array.isArray(conn.settings?.libraryList) ? conn.settings.libraryList.join(", ") : "";
      $("connSessionIdleMinutes").value = mode === "edit" && conn.settings?.sessionIdleMinutes ? String(conn.settings.sessionIdleMinutes) : "";
      $("connSessionPingSeconds").value = mode === "edit" && conn.settings?.sessionPingSeconds ? String(conn.settings.sessionPingSeconds) : "";
      $("connSessionReconnectAttempts").value = mode === "edit" && conn.settings?.sessionReconnectAttempts ? String(conn.settings.sessionReconnectAttempts) : "";
      const dialog = $("connectionDialog");
      if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "open");
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
      if (action === "delete") {
        if (!confirm("Delete connection '" + name + "'?")) return;
        await api("/api/connections/" + encodeURIComponent(name), { method: "DELETE" });
        await loadConnections();
      }
    }
    async function saveConnectionFromDialog(e) {
      e.preventDefault();
      const name = $("connName").value.trim();
      const host = $("connHost").value.trim();
      const username = $("connUser").value.trim();
      if (!name || !host || !username) {
        alert("Name, host, and username are required.");
        return;
      }
      const password = $("connPassword").value || "";
      const payload = {
        name,
        host,
        port: Number($("connPort").value || 22),
        username,
        privateKeyPath: $("connKeyPath").value.trim() || undefined,
        password: password || undefined,
        storePassword: Boolean(password),
        policy: { profile: $("connPolicy").value },
        settings: {
          currentLibrary: $("connCurrentLibrary").value.trim().toUpperCase(),
          libraryList: normalizeLibraries($("connLibraryList").value),
          sessionIdleMinutes: parseOptionalNumber($("connSessionIdleMinutes").value, 1, 1440),
          sessionPingSeconds: parseOptionalNumber($("connSessionPingSeconds").value, 5, 300),
          sessionReconnectAttempts: parseOptionalNumber($("connSessionReconnectAttempts").value, 1, 5)
        }
      };
      if (state.editingName) {
        await api("/api/connections/" + encodeURIComponent(state.editingName), { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await api("/api/connections", { method: "POST", body: JSON.stringify(payload) });
      }
      closeConnectionDialog();
      await loadConnections();
    }
    async function saveSettings() {
      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          sessionIdleMinutes: Number($("sessionIdleMinutes").value || 30),
          sessionPingSeconds: Number($("sessionPingSeconds").value || 15),
          sessionReconnectAttempts: Number($("sessionReconnectAttempts").value || 2)
        })
      });
      await loadSettings();
      alert("Settings saved.");
    }
    async function beginReconnectFlow(label) {
      setServiceState("reconnecting", label + " running. Waiting for service restart...");
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        await sleep(1800);
        if (await pingHealth()) {
          setServiceState("online", "Local control service online");
          await refreshAll();
          return;
        }
      }
      setServiceState("offline", "Service offline. Start with mcp-for-i-control serve.");
    }
    async function triggerJob(path, payload, options = {}) {
      if (!state.online) {
        alert("Control plane is offline. Start it with mcp-for-i-control serve.");
        return;
      }
      setBusy(true);
      try {
        await api(path, { method: "POST", body: payload ? JSON.stringify(payload) : undefined });
        await loadRuntimeStatus();
        if (options.expectRestart) await beginReconnectFlow(options.label || "Update");
        else {
          await Promise.allSettled([loadAutostartStatus(), loadVersions(), loadSessions()]);
          startJobPolling();
        }
      } catch (err) {
        setServiceState("offline", "Request failed. Waiting for reconnect...");
        $("runtimeSummary").textContent = "Action failed: " + (err?.message || String(err));
      } finally {
        setBusy(false);
      }
    }
    let pollId = 0;
    function startJobPolling() {
      if (pollId) return;
      pollId = setInterval(async () => {
        if (!await pingHealth()) return;
        try {
          await loadRuntimeStatus();
          const running = Object.values(state.jobs || {}).some(j => j.status === "running");
          if (!running) {
            clearInterval(pollId);
            pollId = 0;
            await Promise.allSettled([loadAutostartStatus(), loadVersions(), loadSessions()]);
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
          setServiceState("online", "Local control service online");
          await refreshAll();
        } else if (!ok && state.online && !state.busy) {
          setServiceState("offline", "Service offline. Waiting for reconnect...");
        }
      }, 2500);
    }
    async function refreshAll() {
      const healthy = await pingHealth();
      if (!healthy) {
        setServiceState("offline", "Service offline. Start with mcp-for-i-control serve.");
        return;
      }
      setServiceState("online", "Local control service online");
      await Promise.allSettled([loadConnections(), loadRuntimeStatus(), loadAutostartStatus(), loadVersions(), loadSessions(), loadSettings()]);
    }

    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => activateTab(btn.dataset.tab || "overview"));
    });
    $("themeBtn").addEventListener("click", toggleTheme);
    $("addConnectionBtn").addEventListener("click", () => openConnectionDialog("add", {}));
    $("connectionForm").addEventListener("submit", saveConnectionFromDialog);
    $("cancelConnectionBtn").addEventListener("click", closeConnectionDialog);
    $("closeConnectionDialogBtn").addEventListener("click", closeConnectionDialog);
    $("refreshOverviewBtn").addEventListener("click", refreshAll);
    $("refreshRuntimeBtn").addEventListener("click", () => Promise.allSettled([loadRuntimeStatus(), loadAutostartStatus(), loadVersions(), loadSessions()]));
    $("saveSettingsBtn").addEventListener("click", saveSettings);
    $("reloadSettingsBtn").addEventListener("click", () => loadSettings().catch(() => {}));
    $("installBtn").addEventListener("click", () => triggerJob("/api/runtime/install", null, { expectRestart: true, label: "Install or repair" }));
    $("updateMcpBtn").addEventListener("click", () => triggerJob("/api/runtime/update/mcp", null, { expectRestart: true, label: "MCP update" }));
    $("updateSkillsBtn").addEventListener("click", () => triggerJob("/api/runtime/update/skills", persistSkillsUpdateSettings()));
    $("setupAutostartBtn").addEventListener("click", () => triggerJob("/api/runtime/autostart/setup"));
    $("removeAutostartBtn").addEventListener("click", () => triggerJob("/api/runtime/autostart/remove"));
    $("skillsRepoUrl").addEventListener("change", () => { persistSkillsUpdateSettings(); loadVersions().catch(() => {}); });
    $("skillsBranch").addEventListener("change", () => { persistSkillsUpdateSettings(); loadVersions().catch(() => {}); });

    applyTheme(readStoredTheme());
    loadSkillsUpdateSettings();
    activateTab("overview");
    setServiceState("offline", "Checking service...");
    refreshAll().catch(err => { $("logs").textContent = "Startup error: " + err.message; });
    startHeartbeat();
  </script>
</body>
</html>`;
}
