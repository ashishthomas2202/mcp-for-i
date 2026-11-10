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
  #screen { position: relative; font: 16px/1.25 "Cascadia Mono", Consolas, "DejaVu Sans Mono", Menlo, monospace; white-space: pre; -webkit-user-select: text; user-select: text; }
  .row { height: 1.25em; }
  /* Cells are inline-block so reverse-video blocks fill the whole line height: no black gaps between rows. */
  .row span { cursor: text; display: inline-block; height: 1.25em; line-height: 1.25em; vertical-align: top; }
  .c-green { color: var(--green); } .c-white { color: var(--white); } .c-red { color: var(--red); }
  .c-turquoise { color: var(--turquoise); } .c-yellow { color: var(--yellow); } .c-pink { color: var(--pink); } .c-blue { color: var(--blue); }
  .rev { background: currentColor; }
  .rev > i { color: #000; font-style: normal; }
  .ul { text-decoration: underline; }
  /* Underline cursor (overwrite mode): a blinking bar under the character, like ACS. */
  #cursor { position: absolute; width: 1ch; height: 3px; margin-top: calc(1.25em - 3px); background: var(--accent); pointer-events: none; z-index: 3; box-shadow: 0 0 2px var(--accent); }
  /* Block cursor (insert mode): inverts the character under it. */
  #cursor.insert { height: 1.25em; margin-top: 0; background: #ffffff; mix-blend-mode: difference; box-shadow: none; }
  #cursor.blink-off { opacity: 0; }
  #status { display: flex; gap: 14px; flex-wrap: wrap; width: 100%; max-width: 1100px; color: var(--muted); font-size: 12px; justify-content: center; }
  #status .on { color: var(--warn); }
  #error { color: var(--red); min-height: 1.2em; font-size: 12px; text-align: center; }
  #keys { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; max-width: 1100px; }
  #keys button { min-width: 44px; font-size: 12px; }
  #keys button.pulse { border-color: var(--warn); color: var(--warn); animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 50% { background: #3a2e14; } }
  .hint { color: var(--muted); font-size: 12px; text-align: center; max-width: 900px; }
  .closed { opacity: .5; }
  /* Always-visible notice and state chip, so a blocked keyboard is clear even in screen-only mode. */
  #toast { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 20; max-width: 92%; padding: 7px 14px; border-radius: 8px; font-size: 13px; display: none; }
  #toast.show { display: block; }
  #toast.err { background: #2a1414; color: #ffdede; border: 1px solid var(--red); }
  #toast.info { background: #122019; color: #d7f5e2; border: 1px solid var(--accent); }
  #state-chip { position: fixed; top: 8px; left: 8px; z-index: 12; padding: 3px 10px; border-radius: 999px; font-size: 12px; background: #2a1e0a; color: var(--warn); border: 1px solid var(--warn); display: none; }
  #state-chip.show { display: block; }
  /* Shown while a key is in flight to the host, so a wait reads as progress, not a freeze. */
  #working { position: fixed; left: 50%; bottom: 52px; transform: translateX(-50%); z-index: 19; display: none; padding: 5px 12px; border-radius: 999px; font-size: 12px; background: #11271f; color: var(--accent); border: 1px solid var(--accent); }
  #working.show { display: block; }
  #working::before { content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); margin-right: 7px; vertical-align: middle; animation: pulse2 .8s ease-in-out infinite; }
  @keyframes pulse2 { 50% { opacity: .2; } }
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
<div id="state-chip" aria-live="polite"></div>
<div id="working">Waiting for the host…</div>
<div id="toast" role="status"></div>
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
  <p class="hint">Click an underlined field and type. The arrows move the cursor; <b>Page Up / Page Down (or the mouse wheel) scroll</b> the screen. Enter, F1-F12 (Shift for F13-F24), Tab, Home, End, Insert, Delete work as in an emulator. Esc is Attn, Shift+Esc is SysReq, the Ctrl key on its own is Reset, keypad + and - are Field+ and Field-. A click moves the cursor (a click on a key legend such as F3=Exit presses it), a double click presses Enter, and you can drag to select text to copy. While you type, the agent waits.</p>
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
  var toastEl = document.getElementById('toast');
  var stateChip = document.getElementById('state-chip');
  var workingEl = document.getElementById('working');
  var resetBtn = null;
  var inflight = 0, workTimer = null;
  function workStart() {
    inflight += 1;
    if (!workTimer) workTimer = setTimeout(function () { workTimer = null; if (inflight > 0) workingEl.classList.add('show'); }, 300);
  }
  function workEnd() {
    inflight = Math.max(0, inflight - 1);
    if (inflight === 0) { if (workTimer) { clearTimeout(workTimer); workTimer = null; } workingEl.classList.remove('show'); }
  }
  var source = null;
  var last = null;
  var pending = '';
  var flushTimer = null;
  var queue = Promise.resolve();

  // Blink the cursor from JS so it works regardless of CSS animation support.
  setInterval(function () { if (cursorEl) cursorEl.classList.toggle('blink-off'); }, 520);

  var toastTimer = null;
  function showToast(msg, kind) {
    if (!msg) { toastEl.className = ''; return; }
    toastEl.textContent = msg;
    toastEl.className = 'show ' + (kind || 'err');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = ''; }, 4500);
  }
  // Turn a raw host/server error into something a person can act on.
  function friendlyError(e) {
    e = e || 'Something went wrong';
    if (/not in an input field/i.test(e)) return 'The cursor is not in an input field. Click an underlined field, then type.';
    if (/keyboard is locked/i.test(e)) return 'The host is still working (X System). Wait a moment, then try again.';
    if (/input is inhibited|RESET key/i.test(e)) return 'Input is blocked by a host message. Press Reset (the Ctrl key, or the Reset button).';
    if (/read-only/i.test(e)) return 'This connection is read-only, so keys sent to the host are blocked.';
    return e;
  }

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

  function send(input, quiet) {
    queue = queue.then(function () {
      workStart();
      return fetch(api('/api/input'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (res.ok) { errorEl.textContent = res.note || ''; if (res.note) showToast(res.note, 'info'); }
          else if (!quiet) { var m = friendlyError(res.error); errorEl.textContent = m; showToast(m, 'err'); }
        })
        .catch(function (err) { if (!quiet) { errorEl.textContent = String(err); showToast(String(err), 'err'); } })
        .then(function () { workEnd(); });
    });
    return queue;
  }
  function flushText() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!pending) return;
    var text = pending; pending = '';
    send({ text: text });
  }
  function key(name, quiet) { flushText(); send({ keys: name }, quiet); }

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
    cursorEl.className = (view.insertMode ? 'insert' : '') + (cursorEl.classList.contains('blink-off') ? ' blink-off' : '');
    screenEl.classList.toggle('closed', !view.connected);
    // A blocked keyboard is shown even when the toolbar is hidden.
    var blocked = view.inputInhibited ? 'Input blocked — press Reset (Ctrl, or the Reset button)'
      : (view.keyboardLocked ? 'Host busy — X System' : '');
    stateChip.textContent = blocked;
    stateChip.classList.toggle('show', !!blocked);
    if (resetBtn) resetBtn.classList.toggle('pulse', !!view.inputInhibited);
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
    // If the person selected text (to copy), don't move the cursor.
    if (window.getSelection && String(window.getSelection()).replace(/\s+/g, '').length) return;
    wrap.focus();
    var cell = cellFrom(ev);
    if (!cell) return;
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(function () { clickTimer = null; flushText(); send({ click: cell }); }, 260);
  });
  // Mouse wheel scrolls (rolls) the screen, like dragging a scroll bar.
  var lastWheel = 0;
  wrap.addEventListener('wheel', function (ev) {
    if (!last || !last.connected || last.keyboardLocked || last.inputInhibited) return;
    ev.preventDefault();
    var now = Date.now();
    if (now - lastWheel < 350) return;
    lastWheel = now;
    key(ev.deltaY > 0 ? 'PageDown' : 'PageUp', true);
  }, { passive: false });
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
      if (name === 'Reset') resetBtn = b;
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
