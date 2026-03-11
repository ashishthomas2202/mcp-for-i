export function renderControlPlaneHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MCP-for-i Control Plane</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #060b11;
      --bg-grad-1: rgba(20, 184, 166, 0.17);
      --bg-grad-2: rgba(59, 130, 246, 0.18);
      --surface: rgba(15, 23, 32, 0.9);
      --surface-2: #131d2a;
      --line: #263547;
      --line-strong: #3c5270;
      --text: #e6eef8;
      --muted: #8da4bb;
      --accent: #14b8a6;
      --accent-2: #38bdf8;
      --danger-1: #f97316;
      --danger-2: #ef4444;
      --ok: #34d399;
      --shadow: 0 18px 42px rgba(0, 0, 0, 0.34);
      --ring: 0 0 0 3px rgba(20, 184, 166, 0.22);
    }

    body[data-theme="light"] {
      color-scheme: light;
      --bg: #f4f7fb;
      --bg-grad-1: rgba(20, 184, 166, 0.14);
      --bg-grad-2: rgba(14, 165, 233, 0.12);
      --surface: rgba(255, 255, 255, 0.92);
      --surface-2: #f8fbff;
      --line: #d5e0ec;
      --line-strong: #b8c9dd;
      --text: #0e1b2a;
      --muted: #516377;
      --accent: #0f766e;
      --accent-2: #0284c7;
      --danger-1: #dc2626;
      --danger-2: #b91c1c;
      --ok: #059669;
      --shadow: 0 14px 34px rgba(13, 35, 66, 0.14);
      --ring: 0 0 0 3px rgba(2, 132, 199, 0.2);
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
      background: rgba(0, 0, 0, 0.12);
      color: var(--muted);
      font-weight: 600;
      font-size: 12px;
    }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--ok);
      box-shadow: 0 0 12px color-mix(in srgb, var(--ok) 75%, transparent);
    }

    .card { padding: 16px; }

    .card h2 {
      margin: 0 0 12px;
      font-size: 15px;
      letter-spacing: 0.03em;
      text-transform: uppercase;
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
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      color: #062228;
      box-shadow: 0 8px 18px color-mix(in srgb, var(--accent) 35%, transparent);
    }

    button:hover {
      transform: translateY(-1px);
      filter: brightness(1.05);
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
      background: linear-gradient(135deg, var(--danger-1), var(--danger-2));
      color: #fff;
      box-shadow: 0 8px 18px rgba(239, 68, 68, 0.28);
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
        <div class="status"><span class="dot"></span><span id="healthText">Checking local service...</span></div>
        <button id="themeBtn" class="theme" type="button">Switch Theme</button>
      </div>
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
        <button id="deleteBtn" class="danger" type="button">Delete Selected</button>
        <button id="clearBtn" class="secondary" type="button">Clear Form</button>
      </div>
      <div class="hint">Credentials never persist in plain config. Passwords go only to the local control service and OS keychain.</div>
    </section>

    <section class="card">
      <h2>Runtime Actions</h2>
      <div class="grid-2">
        <div class="field">
          <label>Skills Repo URL</label>
          <input id="skillsRepoUrl" placeholder="https://github.com/ashishthomas-pcr/mcp-for-i-skills.git" />
        </div>
        <div class="field">
          <label>Skills Branch</label>
          <input id="skillsBranch" placeholder="main" />
        </div>
      </div>
      <div class="actions">
        <button id="installBtn" type="button">Install/Repair MCP</button>
        <button id="updateMcpBtn" class="secondary" type="button">Update MCP from GitHub</button>
        <button id="updateSkillsBtn" class="secondary" type="button">Update Skills</button>
        <button id="refreshStatusBtn" class="secondary" type="button">Refresh Status</button>
      </div>
      <div id="logs" class="logs">No jobs yet.</div>
      <div class="hint">Actions stream logs live. Skills update can clone or pull from the repo and branch shown above.</div>
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

    <div class="footer-note">Tip: select a connection from the table to edit, rename, or rotate password.</div>
  </div>

  <script>
    const THEME_KEY = "mcp_for_i_theme";
    const SKILLS_REPO_KEY = "mcp_for_i_skills_repo";
    const SKILLS_BRANCH_KEY = "mcp_for_i_skills_branch";
    const DEFAULT_SKILLS_REPO = "https://github.com/ashishthomas-pcr/mcp-for-i-skills.git";
    const DEFAULT_SKILLS_BRANCH = "main";

    const state = {
      selectedName: "",
      jobs: {}
    };

    const $ = id => document.getElementById(id);

    function readStoredTheme() {
      try {
        const stored = localStorage.getItem(THEME_KEY);
        if (stored === "light" || stored === "dark") return stored;
      } catch {}
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
        return "light";
      }
      return "dark";
    }

    function applyTheme(theme) {
      document.body.setAttribute("data-theme", theme);
      const btn = $("themeBtn");
      if (btn) {
        btn.textContent = theme === "dark" ? "Switch to Light" : "Switch to Dark";
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
      $("skillsRepoUrl").value = repoUrl;
      $("skillsBranch").value = branch;
    }

    function getSkillsUpdatePayload() {
      const repoUrl = $("skillsRepoUrl").value.trim();
      const branch = $("skillsBranch").value.trim();
      try {
        localStorage.setItem(SKILLS_REPO_KEY, repoUrl || DEFAULT_SKILLS_REPO);
        localStorage.setItem(SKILLS_BRANCH_KEY, branch || DEFAULT_SKILLS_BRANCH);
      } catch {}
      return {
        repoUrl: repoUrl || DEFAULT_SKILLS_REPO,
        branch: branch || DEFAULT_SKILLS_BRANCH
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

    async function loadHealth() {
      const health = await api("/api/health");
      $("healthText").textContent = health.ok ? "Local control service online" : "Service unavailable";
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
    }

    async function loadRuntimeStatus() {
      const status = await api("/api/runtime/status");
      renderLogs(status.jobs || {});
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

    async function onDelete() {
      if (!state.selectedName) {
        alert("Select a connection first.");
        return;
      }
      if (!confirm("Delete connection '" + state.selectedName + "'?")) return;
      await api("/api/connections/" + encodeURIComponent(state.selectedName), { method: "DELETE" });
      resetForm();
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
    }

    async function triggerJob(path, payload) {
      await api(path, {
        method: "POST",
        body: payload ? JSON.stringify(payload) : undefined
      });
      await loadRuntimeStatus();
      startJobPolling();
    }

    let pollId = 0;
    function startJobPolling() {
      if (pollId) return;
      pollId = setInterval(async () => {
        await loadRuntimeStatus();
        const jobs = Object.values(state.jobs || {});
        const running = jobs.some(j => j.status === "running");
        if (!running) {
          clearInterval(pollId);
          pollId = 0;
        }
      }, 1500);
    }

    function escapeHtml(str) {
      return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    $("themeBtn").addEventListener("click", toggleTheme);
    $("saveBtn").addEventListener("click", onSave);
    $("renameBtn").addEventListener("click", onRename);
    $("deleteBtn").addEventListener("click", onDelete);
    $("clearBtn").addEventListener("click", resetForm);
    $("installBtn").addEventListener("click", () => triggerJob("/api/runtime/install"));
    $("updateMcpBtn").addEventListener("click", () => triggerJob("/api/runtime/update/mcp"));
    $("updateSkillsBtn").addEventListener("click", () => triggerJob("/api/runtime/update/skills", getSkillsUpdatePayload()));
    $("refreshStatusBtn").addEventListener("click", loadRuntimeStatus);

    applyTheme(readStoredTheme());
    loadSkillsUpdateSettings();
    Promise.all([loadHealth(), loadConnections(), loadRuntimeStatus()]).catch(err => {
      $("logs").textContent = "Startup error: " + err.message;
    });
  </script>
</body>
</html>`;
}
