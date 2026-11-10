/**
 * The live 5250 view page. One self-contained HTML document: it reads the
 * token and session from its own URL, follows the screen over server-sent
 * events and sends the person's keys and clicks back.
 *
 * The client script below must not contain backticks or "${", because it
 * sits inside a template literal.
 */
export function renderLivePage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Live 5250</title>
<style>
  :root {
    --bg: #000000; --panel: #0d130f; --line: #24312a; --text: #d7e4dc; --muted: #8aa094;
    /* 5250 base colours, tuned to a real green-screen / ACS palette. */
    --green: #2fe02f; --white: #ffffff; --red: #ff564d; --turquoise: #2fd4d4; --yellow: #ffd93b;
    --pink: #ff5fd0; --blue: #6f8dff; --accent: #2fe02f; --warn: #ffb347;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--line); background: var(--panel); flex-wrap: wrap; }
  header h1 { font-size: 14px; margin: 0; font-weight: 600; }
  select, button { font: inherit; color: var(--text); background: #1a241e; border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  .badge { padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); font-size: 12px; }
  .badge.agent { color: var(--yellow); border-color: var(--yellow); }
  .badge.person { color: var(--accent); border-color: var(--accent); }
  main { padding: 16px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  #wrap { position: relative; outline: none; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: #000; max-width: 100%; overflow-x: auto; }
  #wrap:focus { border-color: var(--accent); }
  #screen { position: relative; font: 16px/1.25 "Cascadia Mono", Consolas, "DejaVu Sans Mono", Menlo, monospace; white-space: pre; user-select: none; }
  .row { height: 1.25em; position: relative; z-index: 1; }
  .row span { cursor: text; }
  .c-green { color: var(--green); } .c-white { color: var(--white); } .c-red { color: var(--red); }
  .c-turquoise { color: var(--turquoise); } .c-yellow { color: var(--yellow); } .c-pink { color: var(--pink); } .c-blue { color: var(--blue); }
  .rev { background: currentColor; }
  .rev > i { color: #000; font-style: normal; }
  .ul { text-decoration: underline; }
  /* Block cursor (overwrite): a white box that inverts the character under it, like a real 5250. */
  #cursor { position: absolute; width: 1ch; height: 1.25em; background: #ffffff; mix-blend-mode: difference; pointer-events: none; z-index: 3; animation: blink 1.06s steps(1, start) infinite; }
  /* Underline cursor (insert mode). */
  #cursor.insert { height: 2px; margin-top: calc(1.25em - 2px); background: var(--accent); mix-blend-mode: normal; }
  @keyframes blink { 50% { opacity: 0; } }
  #status { display: flex; gap: 14px; flex-wrap: wrap; width: 100%; max-width: 1100px; color: var(--muted); font-size: 12px; justify-content: center; }
  #status .on { color: var(--warn); }
  #error { color: var(--red); min-height: 1.2em; font-size: 12px; text-align: center; }
  #keys { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; max-width: 1100px; }
  #keys button { min-width: 44px; font-size: 12px; }
  .hint { color: var(--muted); font-size: 12px; text-align: center; max-width: 900px; }
  .closed { opacity: .5; }
  /* Configurable chrome: hide parts of the UI via URL params or the toggle. */
  body.hide-header header { display: none; }
  body.hide-keys #keys { display: none; }
  body.hide-hint .hint { display: none; }
  body.hide-status #status, body.hide-status #error { display: none; }
  body.bare #wrap { border: none; border-radius: 0; padding: 0; }
  body.bare main { padding: 0; gap: 0; }
  #display-toggle { position: fixed; top: 8px; right: 8px; z-index: 10; opacity: .35; }
  #display-toggle:hover { opacity: 1; }
  body.hide-header #display-toggle { opacity: .18; }
</style>
</head>
<body>
<button id="display-toggle" title="Show or hide the toolbar, keys and help (screen-only mode)">Display</button>
<header>
  <h1>Live 5250</h1>
  <select id="session" aria-label="Session"></select>
  <span id="actor" class="badge">Waiting</span>
  <span id="conn" class="badge"></span>
</header>
<main>
  <div id="wrap" tabindex="0" aria-label="5250 screen. Click here and type.">
    <div id="screen"><div id="cursor"></div></div>
  </div>
  <div id="status"></div>
  <div id="error" role="status"></div>
  <div id="keys"></div>
  <p class="hint">Click the screen and type. Enter, F1-F12 (Shift for F13-F24), Tab, arrows, Home, End, Insert, Delete, Page Up/Down work as in an emulator. Esc is Attn, Shift+Esc is SysReq, the Ctrl key on its own is Reset, keypad + and - are Field+ and Field-. Click moves the cursor, a click on a key legend such as F3=Exit presses it, a double click presses Enter. While you type, the agent waits.</p>
</main>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var token = params.get('t') || '';
  var current = params.get('s') || '';
  var screenEl = document.getElementById('screen');
  var cursorEl = document.getElementById('cursor');
  var wrap = document.getElementById('wrap');
  var statusEl = document.getElementById('status');
  var errorEl = document.getElementById('error');
  var actorEl = document.getElementById('actor');
  var connEl = document.getElementById('conn');
  var sessionEl = document.getElementById('session');
  var source = null;
  var last = null;
  var pending = '';
  var flushTimer = null;
  var queue = Promise.resolve();

  // Configurable chrome. URL params set the initial look; the Display button
  // and localStorage remember a per-browser preference after that.
  // ?view=screen (or ?bare=1) shows only the screen. ?keys=0 / ?header=0 /
  // ?hint=0 / ?status=0 hide individual parts. ?chrome=full forces everything on.
  var CHROME_KEY = 'tn5250.chrome';
  function truthyParam(name, def) {
    var v = params.get(name);
    if (v === null) return def;
    return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
  }
  function applyChrome(c) {
    document.body.classList.toggle('hide-header', !c.header);
    document.body.classList.toggle('hide-keys', !c.keys);
    document.body.classList.toggle('hide-hint', !c.hint);
    document.body.classList.toggle('hide-status', !c.status);
    document.body.classList.toggle('bare', !!c.bare);
  }
  function defaultChrome() {
    var screenOnly = params.get('view') === 'screen' || truthyParam('bare', false);
    var base = screenOnly
      ? { header: false, keys: false, hint: false, status: false, bare: true }
      : { header: true, keys: true, hint: true, status: true, bare: false };
    if (params.get('chrome') === 'full') base = { header: true, keys: true, hint: true, status: true, bare: false };
    // Individual overrides win over the preset.
    base.header = truthyParam('header', truthyParam('bar', base.header));
    base.keys = truthyParam('keys', base.keys);
    base.hint = truthyParam('hint', base.hint);
    base.status = truthyParam('status', base.status);
    return base;
  }
  var chrome;
  var hasParam = ['view', 'bare', 'chrome', 'header', 'bar', 'keys', 'hint', 'status'].some(function (n) { return params.get(n) !== null; });
  try {
    var saved = hasParam ? null : window.localStorage.getItem(CHROME_KEY);
    chrome = saved ? JSON.parse(saved) : defaultChrome();
  } catch (e) { chrome = defaultChrome(); }
  applyChrome(chrome);
  document.getElementById('display-toggle').addEventListener('click', function () {
    var full = chrome.header && chrome.keys && chrome.hint && chrome.status && !chrome.bare;
    chrome = full
      ? { header: false, keys: false, hint: false, status: false, bare: true }
      : { header: true, keys: true, hint: true, status: true, bare: false };
    applyChrome(chrome);
    try { window.localStorage.setItem(CHROME_KEY, JSON.stringify(chrome)); } catch (e) {}
    wrap.focus();
  });

  function api(path) { return path + (path.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(token) + '&s=' + encodeURIComponent(current); }

  function send(input) {
    queue = queue.then(function () {
      return fetch(api('/api/input'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
        .then(function (r) { return r.json(); })
        .then(function (res) { errorEl.textContent = res.ok ? (res.note || '') : res.error; })
        .catch(function (err) { errorEl.textContent = String(err); });
    });
    return queue;
  }
  function flushText() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!pending) return;
    var text = pending; pending = '';
    send({ text: text });
  }
  function key(name) { flushText(); send({ keys: name }); }

  function render(view) {
    if (!view || view.missing) {
      screenEl.querySelectorAll('.row').forEach(function (n) { n.remove(); });
      statusEl.textContent = current ? 'The session ' + current + ' is not open.' : 'No 5250 session is open yet.';
      return;
    }
    last = view;
    var frag = document.createDocumentFragment();
    (view.runs || []).forEach(function (runs, r) {
      var row = document.createElement('div');
      row.className = 'row';
      var col = 1;
      runs.forEach(function (run) {
        var span = document.createElement('span');
        span.className = 'c-' + run.color + (run.underline ? ' ul' : '') + (run.reverse ? ' rev' : '');
        span.dataset.row = String(r + 1);
        span.dataset.col = String(col);
        if (run.reverse) { var i = document.createElement('i'); i.textContent = run.text; span.appendChild(i); }
        else span.textContent = run.text;
        col += run.text.length;
        row.appendChild(span);
      });
      frag.appendChild(row);
    });
    screenEl.querySelectorAll('.row').forEach(function (n) { n.remove(); });
    screenEl.appendChild(frag);
    cursorEl.style.left = (view.cursor.col - 1) + 'ch';
    cursorEl.style.top = ((view.cursor.row - 1) * 1.25) + 'em';
    cursorEl.className = view.insertMode ? 'insert' : '';
    screenEl.classList.toggle('closed', !view.connected);
    var parts = [];
    parts.push(view.connected ? 'Connected to ' + view.host : 'Disconnected' + (view.closeReason ? ': ' + view.closeReason : ''));
    parts.push('Row ' + view.cursor.row + ', column ' + view.cursor.col);
    if (view.keyboardLocked && !view.inputInhibited) parts.push('<span class="on">X System (keyboard locked)</span>');
    if (view.inputInhibited) parts.push('<span class="on">Input inhibited: press Reset</span>');
    if (view.insertMode) parts.push('<span class="on">Insert</span>');
    if (view.messageWaiting) parts.push('<span class="on">Message waiting</span>');
    if (view.lastKey) parts.push('Last key ' + view.lastKey);
    statusEl.innerHTML = parts.join(' &middot; ');
    var actor = view.lastActor === 'person' ? 'person' : view.lastActor === 'agent' ? 'agent' : '';
    actorEl.className = 'badge ' + actor;
    actorEl.textContent = actor === 'agent' ? 'Agent acted last' : actor === 'person' ? 'You acted last' : 'Waiting';
    connEl.textContent = view.connectionName + ' ' + view.rows + 'x' + view.cols;
  }

  function renderSessions(list) {
    var names = list.map(function (s) { return s.connectionName; });
    if (!current && names.length) { current = names[0]; follow(); }
    sessionEl.innerHTML = '';
    if (current && names.indexOf(current) < 0) names.unshift(current);
    names.forEach(function (n) {
      var o = document.createElement('option'); o.value = n; o.textContent = n; if (n === current) o.selected = true; sessionEl.appendChild(o);
    });
    sessionEl.style.display = names.length > 1 ? '' : 'none';
  }

  function follow() {
    if (source) source.close();
    var url = '/api/events?t=' + encodeURIComponent(token) + '&s=' + encodeURIComponent(current);
    source = new EventSource(url);
    source.addEventListener('screen', function (e) { render(JSON.parse(e.data)); });
    source.addEventListener('sessions', function (e) { renderSessions(JSON.parse(e.data)); });
    var u = new URL(location.href); u.searchParams.set('s', current); history.replaceState(null, '', u.toString());
  }

  sessionEl.addEventListener('change', function () { current = sessionEl.value; follow(); });

  var clickTimer = null;
  function cellFrom(ev) {
    var target = ev.target.closest ? ev.target.closest('span[data-row]') : null;
    if (!target) return null;
    var range = document.caretRangeFromPoint ? document.caretRangeFromPoint(ev.clientX, ev.clientY) : null;
    var offset = range && range.startContainer && target.contains(range.startContainer) ? range.startOffset : 0;
    if (!range && document.caretPositionFromPoint) {
      var pos = document.caretPositionFromPoint(ev.clientX, ev.clientY);
      if (pos && target.contains(pos.offsetNode)) offset = pos.offset;
    }
    return { row: Number(target.dataset.row), col: Number(target.dataset.col) + offset };
  }
  screenEl.addEventListener('click', function (ev) {
    wrap.focus();
    var cell = cellFrom(ev);
    if (!cell) return;
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(function () { clickTimer = null; flushText(); send({ click: cell }); }, 260);
  });
  screenEl.addEventListener('dblclick', function (ev) {
    var cell = cellFrom(ev);
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    if (cell) { flushText(); send({ click: { row: cell.row, col: cell.col, doubleClick: true } }); }
  });

  var ctrlAlone = false;
  wrap.addEventListener('keydown', function (ev) {
    if (ev.key === 'Control') { ctrlAlone = true; return; }
    ctrlAlone = false;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    var k = ev.key;
    var name = null;
    if (/^F([1-9]|1[0-2])$/.test(k)) name = 'F' + (Number(k.substring(1)) + (ev.shiftKey ? 12 : 0));
    else if (k === 'Enter') name = 'Enter';
    else if (k === 'Escape') name = ev.shiftKey ? 'SysReq' : 'Attn';
    else if (k === 'Tab') name = ev.shiftKey ? 'BackTab' : 'Tab';
    else if (k === 'ArrowUp') name = 'Up';
    else if (k === 'ArrowDown') name = 'Down';
    else if (k === 'ArrowLeft') name = 'Left';
    else if (k === 'ArrowRight') name = 'Right';
    else if (k === 'Home') name = 'Home';
    else if (k === 'End') name = 'End';
    else if (k === 'Insert') name = 'Insert';
    else if (k === 'Delete') name = 'Delete';
    else if (k === 'Backspace') name = 'Left Delete';
    else if (k === 'PageUp') name = 'PageUp';
    else if (k === 'PageDown') name = 'PageDown';
    else if (ev.code === 'NumpadAdd') name = 'Field+';
    else if (ev.code === 'NumpadSubtract') name = 'Field-';
    if (name) { ev.preventDefault(); key(name); return; }
    if (k.length === 1) {
      ev.preventDefault();
      pending += k;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flushText, 40);
    }
  });
  wrap.addEventListener('paste', function (ev) {
    var text = (ev.clipboardData && ev.clipboardData.getData('text')) || '';
    text = text.split(/[\\r\\n]/)[0];
    if (!text) return;
    ev.preventDefault();
    pending += text;
    flushText();
  });
  wrap.addEventListener('keyup', function (ev) {
    if (ev.key === 'Control' && ctrlAlone) { ctrlAlone = false; key('Reset'); }
  });

  var keysEl = document.getElementById('keys');
  ['Attn', 'SysReq', 'Reset', 'Field+', 'Field-', 'FieldExit', 'Dup', 'EraseEOF', 'EraseInput', 'Clear', 'Help', 'Print', 'PageUp', 'PageDown']
    .concat(Array.from({ length: 24 }, function (_, i) { return 'F' + (i + 1); }))
    .forEach(function (name) {
      var b = document.createElement('button');
      b.textContent = name;
      b.addEventListener('click', function () { key(name); wrap.focus(); });
      keysEl.appendChild(b);
    });

  fetch('/api/sessions?t=' + encodeURIComponent(token)).then(function (r) { return r.json(); }).then(function (res) {
    var hadCurrent = Boolean(current);
    renderSessions(res.sessions || []);
    if (hadCurrent || !current) follow();
    if (!current) statusEl.textContent = 'No 5250 session is open yet. Ask the agent to connect with ibmi.tn5250.connect.';
  }).catch(function (err) { errorEl.textContent = String(err); });
  wrap.focus();
})();
</script>
</body>
</html>`;
}
