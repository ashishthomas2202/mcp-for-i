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
      --bg-grad-1: rgba(11, 101, 216, 0.11);
      --bg-grad-2: rgba(6, 182, 212, 0.08);
      --surface: rgba(255, 255, 255, 0.96);
      --surface-2: #f7faff;
      --line: #d8e1ed;
      --line-strong: #b8c8dd;
      --text: #0f1d2d;
      --muted: #5f738b;
      --accent: #0b65d8;
      --accent-2: #0b65d8;
      --danger-1: #dc2626;
      --danger-2: #dc2626;
      --ok: #1f9d58;
      --warn: #c27c00;
      --shadow: 0 14px 34px rgba(13, 35, 66, 0.14);
      --ring: 0 0 0 3px rgba(11, 101, 216, 0.18);
    }

    body[data-theme="dark"] {
      color-scheme: dark;
      --bg: #0a1220;
      --bg-grad-1: rgba(59, 130, 246, 0.2);
      --bg-grad-2: rgba(14, 165, 233, 0.14);
      --surface: rgba(16, 25, 38, 0.94);
      --surface-2: #152133;
      --line: #26374e;
      --line-strong: #39506f;
      --text: #e5edf7;
      --muted: #9cb0c8;
      --accent: #3b82f6;
      --accent-2: #3b82f6;
      --danger-1: #ef4444;
      --danger-2: #ef4444;
      --ok: #34d399;
      --warn: #f59e0b;
      --shadow: 0 18px 42px rgba(0, 0, 0, 0.34);
      --ring: 0 0 0 3px rgba(59, 130, 246, 0.26);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background:
        radial-gradient(circle at 12% 10%, var(--bg-grad-1), transparent 34%),
        radial-gradient(circle at 88% 8%, var(--bg-grad-2), transparent 35%),
        linear-gradient(180deg, var(--bg), var(--bg));
      font: 14px/1.55 "Inter", "Segoe UI", "SF Pro Text", "Helvetica Neue", sans-serif;
      letter-spacing: 0.01em;
    }

    .page {
      max-width: 1220px;
      margin: 0 auto;
      padding: 24px;
      display: grid;
      gap: 18px;
      grid-template-columns: 1.1fr 1fr;
    }

    .shell,
    .card {
      border-radius: 14px;
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0)), var(--surface);
      box-shadow: var(--shadow);
      backdrop-filter: blur(8px);
    }

    .shell {
      grid-column: 1 / -1;
      padding: 18px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 14px;
      flex-wrap: wrap;
    }

    .title-wrap h1 {
      margin: 0;
      font-size: 24px;
      letter-spacing: 0.2px;
      font-weight: 700;
    }

    .title-wrap p {
      margin: 5px 0 0;
      color: var(--muted);
      max-width: 850px;
    }

    .top-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 12px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: var(--surface-2);
      color: var(--muted);
      font-weight: 600;
      font-size: 12px;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--muted);
    }

    .status.online {
      border-color: color-mix(in srgb, var(--ok) 38%, var(--line));
      color: var(--ok);
    }
    .status.online .dot { background: var(--ok); }

    .status.reconnecting {
      border-color: color-mix(in srgb, var(--warn) 40%, var(--line));
      color: var(--warn);
    }
    .status.reconnecting .dot { background: var(--warn); }

    .status.offline {
      border-color: color-mix(in srgb, var(--danger-1) 38%, var(--line));
      color: var(--danger-1);
    }
    .status.offline .dot { background: var(--danger-1); }

    .card { padding: 16px; }

    .card h2 {
      margin: 0 0 12px;
      font-size: 15px;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .status-card {
      background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 6%, var(--surface)) 0%, var(--surface) 100%);
    }

    .version-grid {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .version-item {
      border: 1px solid var(--line);
      border-radius: 11px;
      background: var(--surface-2);
      padding: 10px 11px;
    }

    .version-label {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 700;
      margin-bottom: 5px;
    }

    .version-value {
      font-weight: 700;
      font-size: 13px;
      margin-bottom: 6px;
      word-break: break-word;
    }

    .badge-latest {
      color: var(--ok);
      border-color: color-mix(in srgb, var(--ok) 40%, var(--line));
      background: color-mix(in srgb, var(--ok) 12%, transparent);
    }

    .badge-update {
      color: var(--warn);
      border-color: color-mix(in srgb, var(--warn) 40%, var(--line));
      background: color-mix(in srgb, var(--warn) 12%, transparent);
    }

    .badge-unknown {
      color: var(--muted);
    }

    .grid-2 {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .field label {
      display: block;
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.09em;
      text-transform: uppercase;
    }

    input,
    select,
    textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--surface-2);
      color: var(--text);
      padding: 10px 11px;
      outline: none;
      transition: border-color .15s ease, box-shadow .15s ease, transform .1s ease;
    }

    input:focus,
    select:focus,
    textarea:focus {
      border-color: var(--accent);
      box-shadow: var(--ring);
      transform: translateY(-1px);
    }

    .actions {
      margin-top: 12px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    button {
      border-radius: 10px;
      border: 1px solid transparent;
      padding: 9px 13px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: transform 0.12s ease, filter 0.15s ease, box-shadow 0.15s ease;
      background: var(--accent);
      color: #ffffff;
      box-shadow: 0 7px 16px color-mix(in srgb, var(--accent) 34%, transparent);
    }

    button:hover {
      transform: translateY(-1px);
      background: color-mix(in srgb, var(--accent) 82%, #000 18%);
      filter: none;
    }

    button:focus-visible {
      outline: none;
      box-shadow: var(--ring);
    }

    button.secondary,
    button.theme,
    button.table-action {
      background: var(--surface-2);
      color: var(--text);
      border-color: var(--line);
      box-shadow: none;
    }

    button.secondary:hover,
    button.theme:hover,
    button.table-action:hover {
      border-color: var(--line-strong);
      filter: none;
    }

    button.danger {
      background: var(--danger-1);
      color: #fff;
      box-shadow: 0 8px 18px rgba(239, 68, 68, 0.28);
    }

    button[disabled] {
      opacity: 0.58;
      cursor: not-allowed;
      transform: none !important;
      box-shadow: none !important;
    }

    button.table-action {
      padding: 6px 9px;
      font-size: 12px;
      font-weight: 600;
    }

    .hint {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
    }

    .logs {
      margin-top: 10px;
      max-height: 320px;
      overflow: auto;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--surface-2) 95%, #000 5%);
      padding: 10px;
      white-space: pre-wrap;
      font: 12px/1.45 ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, monospace;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    th,
    td {
      text-align: left;
      padding: 10px 8px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }

    th {
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.09em;
      text-transform: uppercase;
    }

    tbody tr {
      transition: background-color 0.12s ease;
    }

    tbody tr:hover {
      background: color-mix(in srgb, var(--accent) 9%, transparent);
    }

    tbody tr.selected {
      background: color-mix(in srgb, var(--accent) 13%, transparent);
    }

    tr:last-child td { border-bottom: none; }

    .pill {
      display: inline-block;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--surface-2) 95%, transparent);
      padding: 3px 8px;
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .footer-note {
      grid-column: 1 / -1;
      color: var(--muted);
      font-size: 12px;
      padding: 2px 2px 6px;
    }

    @media (max-width: 1080px) {
      .page { grid-template-columns: 1fr; }
      .grid-2 { grid-template-columns: 1fr; }
      .version-grid { grid-template-columns: 1fr; }
      .shell { align-items: flex-start; }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="shell">
      <div class="title-wrap">
        <h1>MCP-for-i Control Plane</h1>
        <p>Secure onboarding, profile management, and runtime updates for agent-driven IBM i workflows.</p>
      </div>
      <div class="top-actions">
        <div id="servicePill" class="status offline"><span class="dot"></span><span id="healthText">Checking local service...</span></div>
        <button id="themeBtn" class="theme" type="button">Dark Theme</button>
      </div>
    </section>

    <section class="card status-card" style="grid-column: 1 / -1;">
      <h2>Runtime Status</h2>
      <div class="version-grid">
        <div class="version-item">
          <div class="version-label">MCP</div>
          <div class="version-value" id="mcpVersionText">Checking...</div>
          <span class="pill badge-unknown" id="mcpVersionBadge">Checking</span>
        </div>
        <div class="version-item">
          <div class="version-label">Skills</div>
          <div class="version-value" id="skillsVersionText">Checking...</div>
          <span class="pill badge-unknown" id="skillsVersionBadge">Checking</span>
        </div>
        <div class="version-item">
          <div class="version-label">Startup</div>
          <div class="version-value" id="startupVersionText">Checking...</div>
          <span class="pill badge-unknown" id="startupVersionBadge">Checking</span>
        </div>
      </div>
      <div class="hint" id="runtimeSummary">No runtime actions yet.</div>
      <div class="hint" id="versionCheckedAt"></div>
    </section>

    <section class="card">
      <h2>Connection Profile</h2>
      <div class="grid-2">
        <div class="field">
          <label>Name</label>
          <input id="name" placeholder="DEV400" />
        </div>
        <div class="field">
          <label>Host</label>
          <input id="host" placeholder="dev400.company.com" />
        </div>
        <div class="field">
          <label>Port</label>
          <input id="port" type="number" value="22" />
        </div>
        <div class="field">
          <label>Username</label>
          <input id="username" placeholder="DEVUSER" />
        </div>
        <div class="field">
          <label>Private Key Path</label>
          <input id="privateKeyPath" placeholder="C:/keys/id_rsa" />
        </div>
        <div class="field">
          <label>Password (stored in keychain)</label>
          <input id="password" type="password" placeholder="Optional" />
        </div>
        <div class="field">
          <label>Policy</label>
          <select id="policyProfile">
            <option value="guarded">guarded</option>
            <option value="read-only">read-only</option>
            <option value="power-user">power-user</option>
          </select>
        </div>
        <div class="field">
          <label>Current Library (optional)</label>
          <input id="currentLibrary" placeholder="QGPL" />
        </div>
      </div>
      <div class="actions">
        <button id="saveBtn" type="button">Save Connection</button>
        <button id="renameBtn" class="secondary" type="button">Rename Selected</button>
        <button id="clearBtn" class="secondary" type="button">Clear Form</button>
      </div>
      <div class="hint">Credentials never persist in plain config. Passwords go only to the local control service and OS keychain.</div>
    </section>

    <section class="card">
      <h2>Runtime Actions</h2>
      <div class="grid-2">
        <div class="field">
          <label>Skills Repo URL</label>
          <input id="skillsRepoUrl" placeholder="https://github.com/ashishthomas2202/mcp-for-i-skills.git" />
        </div>
        <div class="field">
          <label>Skills Branch</label>
          <input id="skillsBranch" placeholder="main" />
        </div>
      </div>
      <div class="actions">
        <button id="installBtn" type="button">Install/Repair MCP</button>
        <button id="updateMcpBtn" class="secondary" type="button">Update MCP</button>
        <button id="updateSkillsBtn" class="secondary" type="button">Update Skills</button>
      </div>
      <div class="actions">
        <button id="setupAutostartBtn" class="secondary" type="button">Enable Background Startup</button>
        <button id="removeAutostartBtn" class="secondary" type="button">Disable Background Startup</button>
        <button id="refreshStatusBtn" class="secondary" type="button">Refresh Status</button>
      </div>
      <div id="autostartInfo" class="hint">Startup status: checking...</div>
      <div id="logs" class="logs">No jobs yet.</div>
      <div class="hint">Install/Repair uses local git checkout when available, otherwise global npm install. Update MCP follows the same mode.</div>
      <div class="hint">Windows global updates may briefly restart the local control-plane service.</div>
      <div class="hint">Skills update can clone or pull from the repo and branch shown above.</div>
    </section>

    <section class="card" style="grid-column: 1 / -1;">
      <h2>Saved Connections</h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Host</th>
            <th>User</th>
            <th>Policy</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="connectionsBody"></tbody>
      </table>
    </section>

    <div class="footer-note">Run <code>mcp-for-i-control serve</code> to start this page. Use <code>setup</code> only to enable startup at login.</div>
  </div>

  <script>
    const THEME_KEY = "mcp_for_i_theme";
    const SKILLS_REPO_KEY = "mcp_for_i_skills_repo";
    const SKILLS_BRANCH_KEY = "mcp_for_i_skills_branch";
    const DEFAULT_SKILLS_REPO = "https://github.com/ashishthomas2202/mcp-for-i-skills.git";
    const LEGACY_SKILLS_REPO = "https://github.com/ashishthomas-pcr/mcp-for-i-skills.git";
    const DEFAULT_SKILLS_BRANCH = "main";
    const CONTROL_BUTTONS = [
      "saveBtn",
      "renameBtn",
      "clearBtn",
      "installBtn",
      "updateMcpBtn",
      "updateSkillsBtn",
      "setupAutostartBtn",
      "removeAutostartBtn",
      "refreshStatusBtn"
    ];

    const state = {
      selectedName: "",
      jobs: {},
      autostart: null,
      online: false,
      busy: false
    };

    const $ = id => document.getElementById(id);

    function readStoredTheme() {
      try {
        const stored = localStorage.getItem(THEME_KEY);
        if (stored === "light" || stored === "dark") return stored;
      } catch {}
      return "light";
    }

    function applyTheme(theme) {
      document.body.setAttribute("data-theme", theme);
      const btn = $("themeBtn");
      if (btn) {
        btn.textContent = theme === "dark" ? "Light Theme" : "Dark Theme";
      }
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch {}
    }

    function toggleTheme() {
      const current = document.body.getAttribute("data-theme") === "light" ? "light" : "dark";
      applyTheme(current === "dark" ? "light" : "dark");
    }

    function loadSkillsUpdateSettings() {
      let repoUrl = DEFAULT_SKILLS_REPO;
      let branch = DEFAULT_SKILLS_BRANCH;
      try {
        const storedRepo = localStorage.getItem(SKILLS_REPO_KEY);
        const storedBranch = localStorage.getItem(SKILLS_BRANCH_KEY);
        if (storedRepo && storedRepo.trim()) repoUrl = storedRepo.trim();
        if (storedBranch && storedBranch.trim()) branch = storedBranch.trim();
      } catch {}
      if (repoUrl === LEGACY_SKILLS_REPO) {
        repoUrl = DEFAULT_SKILLS_REPO;
      }
      $("skillsRepoUrl").value = repoUrl;
      $("skillsBranch").value = branch;
      persistSkillsUpdateSettings();
    }

    function persistSkillsUpdateSettings() {
      const repoUrl = $("skillsRepoUrl").value.trim();
      const branch = $("skillsBranch").value.trim();
      const normalizedRepo = repoUrl === LEGACY_SKILLS_REPO ? DEFAULT_SKILLS_REPO : (repoUrl || DEFAULT_SKILLS_REPO);
      const normalizedBranch = branch || DEFAULT_SKILLS_BRANCH;
      $("skillsRepoUrl").value = normalizedRepo;
      $("skillsBranch").value = normalizedBranch;
      try {
        localStorage.setItem(SKILLS_REPO_KEY, normalizedRepo);
        localStorage.setItem(SKILLS_BRANCH_KEY, normalizedBranch);
      } catch {}
      return {
        repoUrl: normalizedRepo,
        branch: normalizedBranch
      };
    }

    async function api(path, options = {}) {
      const res = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...options
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || ("HTTP " + res.status));
      }
      if (res.status === 204) return null;
      return res.json();
    }

    function setButtonsDisabled(disabled) {
      for (const id of CONTROL_BUTTONS) {
        const btn = $(id);
        if (!btn) continue;
        btn.disabled = disabled || state.busy;
      }
    }

    function setBusy(busy) {
      state.busy = busy;
      setButtonsDisabled(!state.online);
    }

    function setServiceState(mode, text) {
      const pill = $("servicePill");
      pill.classList.remove("online", "offline", "reconnecting");
      pill.classList.add(mode);
      $("healthText").textContent = text;
      state.online = mode === "online";
      setButtonsDisabled(mode !== "online");
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

    function formToPayload() {
      const name = $("name").value.trim();
      const payload = {
        name,
        host: $("host").value.trim(),
        port: Number($("port").value || 22),
        username: $("username").value.trim(),
        privateKeyPath: $("privateKeyPath").value.trim() || undefined,
        password: $("password").value || undefined,
        storePassword: true,
        policy: { profile: $("policyProfile").value },
        settings: {}
      };
      const currentLibrary = $("currentLibrary").value.trim();
      if (currentLibrary) payload.settings.currentLibrary = currentLibrary;
      return payload;
    }

    function resetForm() {
      state.selectedName = "";
      $("name").value = "";
      $("host").value = "";
      $("port").value = "22";
      $("username").value = "";
      $("privateKeyPath").value = "";
      $("password").value = "";
      $("policyProfile").value = "guarded";
      $("currentLibrary").value = "";
      renderConnections(window.__connectionsCache || []);
    }

    function renderConnections(list) {
      window.__connectionsCache = list;
      const body = $("connectionsBody");
      body.innerHTML = "";
      for (const conn of list) {
        const tr = document.createElement("tr");
        if (conn.name === state.selectedName) tr.className = "selected";
        const policy = (conn.policy && conn.policy.profile) || "guarded";
        tr.innerHTML = \`
          <td><strong>\${escapeHtml(conn.name)}</strong></td>
          <td>\${escapeHtml(conn.host || "")}:\${escapeHtml(String(conn.port || 22))}</td>
          <td>\${escapeHtml(conn.username || "")}</td>
          <td><span class="pill">\${escapeHtml(policy)}</span></td>
          <td>
            <button class="table-action" data-action="select" data-name="\${encodeURIComponent(conn.name)}" type="button">Select</button>
            <button class="table-action" data-action="password" data-name="\${encodeURIComponent(conn.name)}" type="button">Set Password</button>
            <button class="table-action danger" data-action="delete" data-name="\${encodeURIComponent(conn.name)}" type="button">Delete</button>
          </td>\`;
        body.appendChild(tr);
      }
      body.querySelectorAll("button").forEach(btn => {
        btn.addEventListener("click", onTableAction);
      });
    }

    async function loadConnections() {
      const data = await api("/api/connections");
      renderConnections(data.connections || []);
    }

    function renderLogs(jobs) {
      state.jobs = jobs || {};
      const lines = [];
      for (const key of Object.keys(jobs || {})) {
        const j = jobs[key];
        lines.push(\`[\${key}] \${j.status}\`);
        if (j.startedAt) lines.push(\`  started: \${j.startedAt}\`);
        if (j.finishedAt) lines.push(\`  finished: \${j.finishedAt}\`);
        if (j.error) lines.push(\`  error: \${j.error}\`);
        for (const line of j.output || []) lines.push(\`  \${line}\`);
        lines.push("");
      }
      $("logs").textContent = lines.length ? lines.join("\\n") : "No jobs yet.";
      renderRuntimeSummary();
    }

    function renderRuntimeSummary() {
      const entries = Object.entries(state.jobs || {});
      const running = entries.find(([, job]) => job.status === "running");
      const summary = $("runtimeSummary");
      if (running) {
        summary.textContent = \`Running: \${running[0]} action in progress.\`;
        return;
      }
      if (entries.length === 0) {
        summary.textContent = "No runtime actions yet.";
        return;
      }
      const latest = entries
        .map(([id, job]) => ({ id, job, at: Date.parse(job.finishedAt || job.startedAt || "") || 0 }))
        .sort((a, b) => b.at - a.at)[0];
      if (latest.job.status === "failed") {
        summary.textContent = \`Last action failed: \${latest.id}. See activity log for details.\`;
      } else if (latest.job.status === "success") {
        summary.textContent = \`Last action succeeded: \${latest.id}.\`;
      } else {
        summary.textContent = \`Status: \${latest.id} is \${latest.job.status}.\`;
      }
    }

    function setBadge(id, text, kind) {
      const el = $(id);
      el.textContent = text;
      el.className = \`pill badge-\${kind}\`;
    }

    function renderVersions(payload) {
      const mcp = payload?.mcp || {};
      const skills = payload?.skills || {};
      const mcpInstalled = mcp.installedVersion || "Unknown";
      const mcpLatest = mcp.latestVersion || "Unknown";
      $("mcpVersionText").textContent = \`\${mcpInstalled} (latest: \${mcpLatest})\`;
      if (mcp.status === "latest") setBadge("mcpVersionBadge", "Latest", "latest");
      else if (mcp.status === "update-available") setBadge("mcpVersionBadge", "Update Available", "update");
      else setBadge("mcpVersionBadge", "Unknown", "unknown");

      const skillsLocal = skills.localCommit
        ? \`\${skills.localBranch || "branch"} @ \${skills.localCommit}\`
        : (skills.status === "not-installed" ? "Not installed" : "Unknown");
      const skillsLatest = skills.latestCommit ? \` (latest: \${skills.latestCommit})\` : "";
      $("skillsVersionText").textContent = \`\${skillsLocal}\${skillsLatest}\`;
      if (skills.status === "latest") setBadge("skillsVersionBadge", "Latest", "latest");
      else if (skills.status === "update-available") setBadge("skillsVersionBadge", "Update Available", "update");
      else if (skills.status === "not-installed") setBadge("skillsVersionBadge", "Not Installed", "unknown");
      else setBadge("skillsVersionBadge", "Unknown", "unknown");

      if (payload?.checkedAt) {
        $("versionCheckedAt").textContent = "Last checked: " + payload.checkedAt;
      }
    }

    async function loadRuntimeStatus() {
      const status = await api("/api/runtime/status");
      renderLogs(status.jobs || {});
    }

    function renderAutostart(status) {
      state.autostart = status || null;
      const el = $("autostartInfo");
      if (!status) {
        el.textContent = "Startup status: unavailable";
        $("startupVersionText").textContent = "Unavailable";
        setBadge("startupVersionBadge", "Unknown", "unknown");
        return;
      }
      if (status.supported === false) {
        el.textContent = \`Startup status: not managed on platform '\${status.platform}'. Running now: \${status.running ? "yes" : "no"}.\`;
        $("startupVersionText").textContent = "Not managed";
        setBadge("startupVersionBadge", status.running ? "Running" : "Stopped", status.running ? "latest" : "unknown");
        return;
      }
      const installed = status.installed ? "enabled" : "disabled";
      const stateText = status.state ? \` (\${status.state})\` : "";
      el.textContent = \`Startup status: \${installed}\${stateText}. Running now: \${status.running ? "yes" : "no"}.\`;
      $("startupVersionText").textContent = installed + stateText;
      if (status.installed && status.running) setBadge("startupVersionBadge", "Running", "latest");
      else if (status.installed) setBadge("startupVersionBadge", "Enabled", "update");
      else setBadge("startupVersionBadge", "Disabled", "unknown");
    }

    async function loadAutostartStatus() {
      const data = await api("/api/runtime/autostart/status");
      renderAutostart(data.status || null);
    }

    async function loadVersions() {
      const settings = persistSkillsUpdateSettings();
      const query = new URLSearchParams({
        repoUrl: settings.repoUrl,
        branch: settings.branch
      });
      const versions = await api("/api/runtime/versions?" + query.toString());
      renderVersions(versions);
    }

    async function onSave() {
      const payload = formToPayload();
      if (!payload.name || !payload.host || !payload.username) {
        alert("Name, host, and username are required.");
        return;
      }
      if (state.selectedName && state.selectedName === payload.name) {
        await api("/api/connections/" + encodeURIComponent(state.selectedName), {
          method: "PUT",
          body: JSON.stringify(payload)
        });
      } else {
        await api("/api/connections", {
          method: "POST",
          body: JSON.stringify(payload)
        });
      }
      state.selectedName = payload.name;
      await loadConnections();
      $("password").value = "";
    }

    async function onRename() {
      if (!state.selectedName) {
        alert("Select a connection first.");
        return;
      }
      const newName = prompt("Rename connection to:", state.selectedName);
      if (!newName || !newName.trim() || newName === state.selectedName) return;
      await api("/api/connections/" + encodeURIComponent(state.selectedName) + "/rename", {
        method: "POST",
        body: JSON.stringify({ newName: newName.trim() })
      });
      state.selectedName = newName.trim();
      await loadConnections();
    }

    async function deleteConnection(name) {
      if (!name) return;
      if (!confirm("Delete connection '" + name + "'?")) return;
      await api("/api/connections/" + encodeURIComponent(name), { method: "DELETE" });
      if (state.selectedName === name) {
        resetForm();
      }
      await loadConnections();
    }

    async function onTableAction(e) {
      const btn = e.currentTarget;
      const action = btn.dataset.action;
      const name = decodeURIComponent(btn.dataset.name || "");
      if (!name) return;
      if (action === "select") {
        const res = await api("/api/connections/" + encodeURIComponent(name));
        const conn = res.connection;
        state.selectedName = conn.name;
        $("name").value = conn.name;
        $("host").value = conn.host || "";
        $("port").value = String(conn.port || 22);
        $("username").value = conn.username || "";
        $("privateKeyPath").value = conn.privateKeyPath || "";
        $("policyProfile").value = (conn.policy && conn.policy.profile) || "guarded";
        $("currentLibrary").value = (conn.settings && conn.settings.currentLibrary) || "";
        $("password").value = "";
        renderConnections(window.__connectionsCache || []);
      }
      if (action === "password") {
        const pwd = prompt("Set new password for " + name + ":");
        if (!pwd) return;
        await api("/api/connections/" + encodeURIComponent(name) + "/password", {
          method: "POST",
          body: JSON.stringify({ password: pwd })
        });
        alert("Password updated in keychain.");
      }
      if (action === "delete") {
        await deleteConnection(name);
      }
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
        await api(path, {
          method: "POST",
          body: payload ? JSON.stringify(payload) : undefined
        });
        await loadRuntimeStatus();
        if (options.expectRestart) {
          await beginReconnectFlow(options.label || "Update");
        } else {
          await Promise.allSettled([loadAutostartStatus(), loadVersions()]);
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
          const jobs = Object.values(state.jobs || {});
          const running = jobs.some(j => j.status === "running");
          if (!running) {
            clearInterval(pollId);
            pollId = 0;
            await Promise.allSettled([loadAutostartStatus(), loadVersions()]);
          }
        } catch {
          // best effort polling during reconnects
        }
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

    function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    function escapeHtml(str) {
      return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    async function refreshAll() {
      const healthy = await pingHealth();
      if (!healthy) {
        setServiceState("offline", "Service offline. Start with mcp-for-i-control serve.");
        return;
      }
      setServiceState("online", "Local control service online");
      await Promise.allSettled([
        loadConnections(),
        loadRuntimeStatus(),
        loadAutostartStatus(),
        loadVersions()
      ]);
    }

    $("themeBtn").addEventListener("click", toggleTheme);
    $("saveBtn").addEventListener("click", onSave);
    $("renameBtn").addEventListener("click", onRename);
    $("clearBtn").addEventListener("click", resetForm);
    $("installBtn").addEventListener("click", () => triggerJob("/api/runtime/install", null, { expectRestart: true, label: "Install/Repair" }));
    $("updateMcpBtn").addEventListener("click", () => triggerJob("/api/runtime/update/mcp", null, { expectRestart: true, label: "MCP Update" }));
    $("updateSkillsBtn").addEventListener("click", () => triggerJob("/api/runtime/update/skills", persistSkillsUpdateSettings()));
    $("refreshStatusBtn").addEventListener("click", refreshAll);
    $("setupAutostartBtn").addEventListener("click", () => triggerJob("/api/runtime/autostart/setup"));
    $("removeAutostartBtn").addEventListener("click", () => triggerJob("/api/runtime/autostart/remove"));
    $("skillsRepoUrl").addEventListener("change", () => {
      persistSkillsUpdateSettings();
      loadVersions().catch(() => {});
    });
    $("skillsBranch").addEventListener("change", () => {
      persistSkillsUpdateSettings();
      loadVersions().catch(() => {});
    });

    applyTheme(readStoredTheme());
    loadSkillsUpdateSettings();
    setServiceState("offline", "Checking local service...");
    refreshAll().catch(err => {
      $("logs").textContent = "Startup error: " + err.message;
    });
    startHeartbeat();
  </script>
</body>
</html>`;
}
