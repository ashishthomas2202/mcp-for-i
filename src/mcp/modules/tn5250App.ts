/**
 * MCP Apps view for the 5250 tools: clients that support MCP Apps draw the
 * screen inside the chat. The view talks to the host over postMessage
 * (JSON-RPC, ui/* methods); it refreshes with ibmi.tn5250.readScreen and sends
 * input with ibmi.tn5250.sendKeys / ibmi.tn5250.click, so the usual checks and
 * confirmations apply. "Open live view" opens the localhost page.
 *
 * The client script must not contain backticks or "${" (it sits in a template literal).
 */

export const TN5250_APP_URI = "ui://mcp-for-i/tn5250-screen.html";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** Tools whose results the view can draw. */
export const TN5250_APP_TOOLS = new Set([
  "ibmi.tn5250.connect",
  "ibmi.tn5250.readScreen",
  "ibmi.tn5250.sendKeys",
  "ibmi.tn5250.click",
  "ibmi.tn5250.setField",
  "ibmi.tn5250.waitFor",
  "ibmi.tn5250.snapshot"
]);

export function renderTn5250App(version: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>5250 screen</title>
<style>
  :root { color-scheme: light dark; --fg: #33ff66; --bg: #050805; --muted: #8aa094; --line: #24312a; --accent: #33ff66; --err: #ff6b6b; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--muted); background: transparent; }
  .bar { display: flex; gap: 8px; align-items: center; padding: 6px 2px; flex-wrap: wrap; }
  .bar b { color: inherit; font-weight: 600; }
  button { font: inherit; border: 1px solid var(--line); border-radius: 6px; padding: 2px 8px; background: transparent; color: inherit; cursor: pointer; }
  #term { background: var(--bg); color: var(--fg); border-radius: 8px; padding: 8px 10px; outline: none; overflow-x: auto; border: 1px solid var(--line); }
  #term:focus { border-color: var(--accent); }
  #screen { position: relative; font: 13px/1.25 "Cascadia Mono", Consolas, Menlo, monospace; white-space: pre; user-select: none; }
  .row { height: 1.25em; }
  .fld { text-decoration: underline; }
  #cursor { position: absolute; width: 1ch; height: 1.25em; background: var(--accent); opacity: .5; pointer-events: none; }
  #msg { min-height: 1.2em; color: var(--err); padding-top: 4px; }
</style>
</head>
<body>
<div class="bar"><b id="title">5250</b><span id="state"></span><span style="flex:1"></span><button id="live" hidden>Open live view</button><button id="refresh">Refresh</button></div>
<div id="term" tabindex="0"><div id="screen"><div id="cursor"></div></div></div>
<div id="msg"></div>
<script>
(function () {
  var nextId = 1, pending = {}, view = null, connectionName = null, ready = false, typed = '', typeTimer = null, busy = false;
  var screenEl = document.getElementById('screen'), cursorEl = document.getElementById('cursor'), term = document.getElementById('term');
  var msg = document.getElementById('msg'), stateEl = document.getElementById('state'), titleEl = document.getElementById('title'), liveBtn = document.getElementById('live');

  function post(obj) { window.parent.postMessage(obj, '*'); }
  function request(method, params) {
    var id = nextId++;
    post({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params || {} }); }

  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id !== undefined && pending[m.id]) {
      var p = pending[m.id]; delete pending[m.id];
      if (m.error) p.reject(new Error(m.error.message || 'request failed')); else p.resolve(m.result);
      return;
    }
    if (m.method === 'ui/notifications/tool-result') showResult(m.params);
    if (m.method === 'ui/notifications/tool-input' && m.params && m.params.arguments && m.params.arguments.connectionName) connectionName = m.params.arguments.connectionName;
    if (m.method === 'ui/notifications/host-context-changed' && m.params) applyTheme(m.params.theme);
    if (m.method === 'ui/resource-teardown' && m.id !== undefined) post({ jsonrpc: '2.0', id: m.id, result: {} });
  });

  function applyTheme(theme) {
    if (theme === 'light') { document.documentElement.style.setProperty('--muted', '#4b5a52'); document.documentElement.style.setProperty('--line', '#c9d4ce'); }
  }

  function screenOf(result) {
    var data = result && result.structuredContent && result.structuredContent.data;
    if (!data) return null;
    if (Array.isArray(data.text)) return data;
    if (data.screen && Array.isArray(data.screen.text)) return data.screen;
    return null;
  }
  function showResult(result) {
    if (result && result.isError) { msg.textContent = textOf(result); return; }
    var s = screenOf(result);
    if (s) { msg.textContent = (result.structuredContent.data.note || ''); render(s); }
  }
  function textOf(result) { return (result && result.content && result.content[0] && result.content[0].text) || 'Error'; }

  function render(s) {
    view = s; connectionName = s.connectionName || connectionName;
    titleEl.textContent = (s.connectionName || '5250') + ' ' + s.rows + 'x' + s.cols;
    var st = [];
    if (!s.connected && s.connected !== undefined) st.push('disconnected');
    if (s.keyboardLocked && !s.inputInhibited) st.push('X System');
    if (s.inputInhibited) st.push('input inhibited');
    if (s.lastActor === 'person') st.push('you acted last');
    stateEl.textContent = st.join(' · ');
    liveBtn.hidden = !s.liveViewUrl;
    var fieldsByRow = {};
    (s.fields || []).forEach(function (f) { if (!f.protected) (fieldsByRow[f.row] = fieldsByRow[f.row] || []).push(f); });
    var frag = document.createDocumentFragment();
    s.text.forEach(function (line, i) {
      var row = document.createElement('div'); row.className = 'row'; row.dataset.row = String(i + 1);
      var fl = (fieldsByRow[i + 1] || []).sort(function (a, b) { return a.col - b.col; });
      var pos = 0;
      fl.forEach(function (f) {
        var start = f.col - 1, end = Math.min(line.length, start + f.length);
        if (start > pos) row.appendChild(document.createTextNode(line.substring(pos, start)));
        var span = document.createElement('span'); span.className = 'fld'; span.textContent = line.substring(start, end); row.appendChild(span);
        pos = end;
      });
      row.appendChild(document.createTextNode(line.substring(pos)));
      frag.appendChild(row);
    });
    screenEl.querySelectorAll('.row').forEach(function (n) { n.remove(); });
    screenEl.appendChild(frag);
    cursorEl.style.left = (s.cursor.col - 1) + 'ch';
    cursorEl.style.top = ((s.cursor.row - 1) * 1.25) + 'em';
  }

  function call(name, args) {
    if (!connectionName) return Promise.resolve();
    busy = true;
    var a = Object.assign({ connectionName: connectionName }, args);
    return request('tools/call', { name: name, arguments: a })
      .then(function (r) { showResult(r); })
      .catch(function (e) { msg.textContent = e.message; })
      .then(function () { busy = false; });
  }
  function flush(keys) {
    if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
    var args = {};
    if (typed) { args.text = typed; typed = ''; }
    if (keys) args.keys = keys;
    if (args.text || args.keys) return call('ibmi.tn5250.sendKeys', args);
  }

  term.addEventListener('keydown', function (ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    var k = ev.key, name = null;
    if (/^F([1-9]|1[0-2])$/.test(k)) name = 'F' + (Number(k.substring(1)) + (ev.shiftKey ? 12 : 0));
    else if (k === 'Enter') name = 'Enter';
    else if (k === 'Escape') name = ev.shiftKey ? 'SysReq' : 'Attn';
    else if (k === 'Tab') name = ev.shiftKey ? 'BackTab' : 'Tab';
    else if (k === 'ArrowUp') name = 'Up'; else if (k === 'ArrowDown') name = 'Down';
    else if (k === 'ArrowLeft') name = 'Left'; else if (k === 'ArrowRight') name = 'Right';
    else if (k === 'Home') name = 'Home'; else if (k === 'End') name = 'End';
    else if (k === 'Delete') name = 'Delete'; else if (k === 'Backspace') name = 'Left Delete';
    else if (k === 'PageUp') name = 'PageUp'; else if (k === 'PageDown') name = 'PageDown';
    if (name) { ev.preventDefault(); flush(name); return; }
    if (k.length === 1) { ev.preventDefault(); typed += k; if (typeTimer) clearTimeout(typeTimer); typeTimer = setTimeout(function () { flush(); }, 300); }
  });
  screenEl.addEventListener('click', function (ev) {
    term.focus();
    var row = ev.target.closest ? ev.target.closest('.row') : null;
    if (!row || !view) return;
    var rect = screenEl.getBoundingClientRect();
    var chWidth = rect.width / view.cols;
    var col = Math.max(1, Math.min(view.cols, Math.floor((ev.clientX - rect.left) / chWidth) + 1));
    flush();
    call('ibmi.tn5250.click', { row: Number(row.dataset.row), col: col, doubleClick: ev.detail >= 2 });
  });
  document.getElementById('refresh').addEventListener('click', function () { call('ibmi.tn5250.readScreen', {}); });
  liveBtn.addEventListener('click', function () { if (view && view.liveViewUrl) request('ui/open-link', { url: view.liveViewUrl }).catch(function (e) { msg.textContent = e.message; }); });

  setInterval(function () {
    if (ready && connectionName && !busy && !typed && document.visibilityState === 'visible') call('ibmi.tn5250.readScreen', {});
  }, 2000);

  if (window.ResizeObserver) new ResizeObserver(function () {
    notify('ui/notifications/size-changed', { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
  }).observe(document.body);

  request('ui/initialize', {
    protocolVersion: '2026-01-26',
    capabilities: {},
    clientInfo: { name: 'mcp-for-i-5250', version: '${version}' },
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] }
  }).then(function (res) {
    ready = true;
    if (res && res.hostContext) applyTheme(res.hostContext.theme);
    notify('ui/notifications/initialized', {});
  }).catch(function (e) { msg.textContent = 'Could not start: ' + e.message; });
})();
</script>
</body>
</html>`;
}
