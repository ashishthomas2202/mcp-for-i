/**
 * The live 5250 view page. One self-contained HTML document: it reads the
 * token and session from its own URL, follows the screen over server-sent
 * events and sends the person's keys and clicks back.
 *
 * The screen fills the available space (fit to width or height), so the page
 * works embedded in a product at any size. URL params configure the chrome:
 *   view=screen | bare=1   show only the screen
 *   chrome=full            show every control
 *   header=0 keys=0 hint=0 status=0   hide individual parts
 * The choice is remembered per browser; a param always wins.
 *
 * The client script below must not contain backticks or "${", because it
 * sits inside a template literal.
 */
export function renderLivePage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>Live 5250</title>
<style>
  :root {
    /* Chrome neutrals (a tuned ramp, not pure grey). */
    --bg: #000000; --panel: #0c110e; --elevated: #141b16; --border: rgba(255,255,255,.09);
    --text: #dfe9e2; --text-2: #94a89c; --text-3: #5f7268;
    --ui-accent: #35e06a; --warn: #ffc24d; --danger: #ff6a60;
    /* 5250 base colours, tuned to a real green-screen / ACS palette. */
    --green: #2fe02f; --white: #ffffff; --red: #ff564d; --turquoise: #2fd4d4; --yellow: #ffd93b;
    --pink: #ff5fd0; --blue: #6f8dff;
    --cursor: #ffffff;
    --r-sm: 6px; --r-md: 8px;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow: hidden; }

  #app { height: 100%; display: flex; flex-direction: column; }

  /* Top bar (chrome). */
  header { flex: none; display: flex; align-items: center; gap: 10px; height: 38px; padding: 0 12px; background: var(--panel); border-bottom: 1px solid var(--border); }
  .eyebrow { font: 600 11px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; letter-spacing: .14em; text-transform: uppercase; color: var(--ui-accent); }
  .spacer { flex: 1 1 auto; }
  select { font: 500 12px/1 system-ui, sans-serif; color: var(--text); background: var(--elevated); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 4px 8px; cursor: pointer; }
  select:focus-visible { outline: none; border-color: var(--ui-accent); }
  .badge { padding: 2px 9px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-3); font: 500 11px/1.5 system-ui, sans-serif; white-space: nowrap; }
  .badge.agent { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 45%, transparent); }
  .badge.person { color: var(--ui-accent); border-color: color-mix(in srgb, var(--ui-accent) 45%, transparent); }
  #conn { color: var(--text-3); font: 500 11px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; }

  /* The stage holds the screen and scales it to fill. */
  #stage { flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: 16px; background: var(--bg); }
  #wrap { position: relative; outline: none; border: 1px solid var(--border); border-radius: var(--r-md); background: #000; }
  #wrap:focus-visible { border-color: color-mix(in srgb, var(--ui-accent) 55%, var(--border)); }
  #screen { position: relative; font: 16px/1.25 "Cascadia Mono", Consolas, "DejaVu Sans Mono", Menlo, monospace; white-space: pre; -webkit-user-select: text; user-select: text; padding: 2px 4px; }
  .row { height: 1.25em; }
  /* Cells are inline-block the full line height so reverse-video blocks fill solidly. */
  .row span { cursor: text; display: inline-block; height: 1.25em; line-height: 1.25em; vertical-align: top; }
  .c-green { color: var(--green); } .c-white { color: var(--white); } .c-red { color: var(--red); }
  .c-turquoise { color: var(--turquoise); } .c-yellow { color: var(--yellow); } .c-pink { color: var(--pink); } .c-blue { color: var(--blue); }
  .rev { background: currentColor; }
  .rev > i { color: #000; font-style: normal; }
  .ul { text-decoration: underline; }
  /* Cursor: white underline (overwrite) or white block (insert), blinking from script. */
  #cursor { position: absolute; width: 1ch; height: 3px; margin-top: calc(1.25em - 3px); background: var(--cursor); pointer-events: none; z-index: 3; box-shadow: 0 0 4px var(--cursor); }
  #cursor.insert { height: 1.25em; margin-top: 0; background: #fff; mix-blend-mode: difference; box-shadow: none; }
  #cursor.blink-off { opacity: 0; }

  /* Bottom bar (chrome): status, keys, hint. */
  footer { flex: none; background: var(--panel); border-top: 1px solid var(--border); padding: 8px 12px 10px; display: flex; flex-direction: column; gap: 8px; }
  #status { display: flex; gap: 6px 14px; flex-wrap: wrap; justify-content: center; color: var(--text-3); font: 500 11px/1.4 ui-monospace, "Cascadia Mono", Consolas, monospace; }
  #status .on { color: var(--warn); }
  #error { color: var(--danger); min-height: 0; font-size: 11px; text-align: center; }
  #error:empty { display: none; }
  #keys { display: flex; flex-direction: column; gap: 5px; align-items: center; }
  .keyrow { display: flex; flex-wrap: wrap; gap: 4px; justify-content: center; max-width: 1180px; }
  #keys button { font: 500 12px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; color: var(--text-2); background: var(--elevated); border: 1px solid var(--border); border-radius: var(--r-sm); padding: 5px 9px; min-width: 42px; cursor: pointer; transition: border-color .1s, color .1s, background .1s, transform .04s; }
  #keys button:hover { border-color: color-mix(in srgb, var(--ui-accent) 55%, var(--border)); color: var(--text); }
  #keys button:active { transform: translateY(1px); }
  #keys button:focus-visible { outline: none; border-color: var(--ui-accent); }
  .keyrow.special button { color: var(--text); background: #18211b; }
  #keys button.pulse { border-color: var(--warn); color: var(--warn); animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 50% { background: #3a2e14; } }
  .hint { color: var(--text-3); font-size: 11.5px; line-height: 1.5; text-align: center; max-width: 960px; margin: 2px auto 0; }
  .hint b { color: var(--text-2); font-weight: 600; }

  /* Chrome toggles (a param or the Controls button). */
  body.hide-header header { display: none; }
  body.hide-keys #keys { display: none; }
  body.hide-hint .hint { display: none; }
  body.hide-status #status { display: none; }
  body.bare #stage { padding: 0; }
  body.bare #wrap { border: none; border-radius: 0; }
  footer:empty, body.hide-keys.hide-hint.hide-status footer { display: none; }

  /* Floating controls toggle. */
  #display-toggle { position: fixed; top: 8px; right: 8px; z-index: 30; font: 500 12px/1 system-ui, sans-serif; color: var(--text-2); background: color-mix(in srgb, var(--panel) 85%, transparent); border: 1px solid var(--border); border-radius: 999px; padding: 5px 11px; cursor: pointer; backdrop-filter: blur(6px); opacity: .5; transition: opacity .12s, border-color .12s, color .12s; }
  #display-toggle:hover { opacity: 1; border-color: color-mix(in srgb, var(--ui-accent) 55%, var(--border)); color: var(--text); }

  /* Floating notices (they float above the plane, so a soft shadow is earned). */
  #state-chip { position: fixed; top: 8px; left: 8px; z-index: 22; padding: 4px 11px; border-radius: 999px; font: 500 12px/1.4 system-ui, sans-serif; background: #241a06; color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent); display: none; box-shadow: 0 6px 20px rgba(0,0,0,.4); }
  #state-chip.show { display: block; }
  #working { position: fixed; left: 50%; bottom: 54px; transform: translateX(-50%); z-index: 24; display: none; padding: 6px 13px; border-radius: 999px; font: 500 12px/1.4 system-ui, sans-serif; background: #0f2419; color: var(--ui-accent); border: 1px solid color-mix(in srgb, var(--ui-accent) 45%, transparent); box-shadow: 0 6px 20px rgba(0,0,0,.4); }
  #working.show { display: block; }
  #working::before { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ui-accent); margin-right: 8px; vertical-align: middle; animation: pulse2 .8s ease-in-out infinite; }
  @keyframes pulse2 { 50% { opacity: .2; } }
  #toast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 26; max-width: 92%; padding: 8px 15px; border-radius: var(--r-md); font: 500 13px/1.45 system-ui, sans-serif; display: none; box-shadow: 0 8px 26px rgba(0,0,0,.45); }
  #toast.show { display: block; }
  #toast.err { background: #221212; color: #ffdede; border: 1px solid color-mix(in srgb, var(--danger) 55%, transparent); }
  #toast.info { background: #0f2419; color: #d7f5e2; border: 1px solid color-mix(in srgb, var(--ui-accent) 45%, transparent); }
</style>
</head>
<body>
<button id="display-toggle" title="Show or hide the controls">Controls</button>
<div id="state-chip" aria-live="polite"></div>
<div id="working">Waiting for the host…</div>
<div id="toast" role="status"></div>
<div id="app">
  <header>
    <span class="eyebrow">5250</span>
    <select id="session" aria-label="Session" style="display:none"></select>
    <span class="spacer"></span>
    <span id="actor" class="badge">Waiting</span>
    <span id="conn" class="badge"></span>
  </header>
  <div id="stage">
    <div id="wrap" tabindex="0" aria-label="5250 screen. Click here and type.">
      <div id="screen"><div id="cursor"></div></div>
    </div>
  </div>
  <footer>
    <div id="status"></div>
    <div id="error" role="status"></div>
    <div id="keys"></div>
    <p class="hint">Click an underlined field and type. The arrows move the cursor; <b>Page Up / Page Down (or the mouse wheel) scroll</b>. Enter, F1-F24, Tab, Home, End, Insert, Delete work as in an emulator. Esc is Attn, Shift+Esc is SysReq, Ctrl alone is Reset. A click moves the cursor (a key legend like F3=Exit presses it), a double click presses Enter, and you can drag to select text. While you type, the agent waits.</p>
  </footer>
</div>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var token = params.get('t') || '';
  var current = params.get('s') || '';
  var screenEl = document.getElementById('screen');
  var cursorEl = document.getElementById('cursor');
  var wrap = document.getElementById('wrap');
  var stage = document.getElementById('stage');
  var statusEl = document.getElementById('status');
  var errorEl = document.getElementById('error');
  var actorEl = document.getElementById('actor');
  var connEl = document.getElementById('conn');
  var sessionEl = document.getElementById('session');
  var toastEl = document.getElementById('toast');
  var stateChip = document.getElementById('state-chip');
  var workingEl = document.getElementById('working');
  var resetBtn = null;
  var source = null;
  var last = null;
  var pending = '';
  var flushTimer = null;
  var queue = Promise.resolve();

  setInterval(function () { if (cursorEl) cursorEl.classList.toggle('blink-off'); }, 520);

  var inflight = 0, workTimer = null;
  function workStart() {
    inflight += 1;
    if (!workTimer) workTimer = setTimeout(function () { workTimer = null; if (inflight > 0) workingEl.classList.add('show'); }, 300);
  }
  function workEnd() {
    inflight = Math.max(0, inflight - 1);
    if (inflight === 0) { if (workTimer) { clearTimeout(workTimer); workTimer = null; } workingEl.classList.remove('show'); }
  }

  var toastTimer = null;
  function showToast(msg, kind) {
    if (!msg) { toastEl.className = ''; return; }
    toastEl.textContent = msg;
    toastEl.className = 'show ' + (kind || 'err');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = ''; }, 4500);
  }
  function friendlyError(e) {
    e = e || 'Something went wrong';
    if (/not in an input field/i.test(e)) return 'The cursor is not in an input field. Click an underlined field, then type.';
    if (/keyboard is locked/i.test(e)) return 'The host is still working (X System). Wait a moment, then try again.';
    if (/input is inhibited|RESET key/i.test(e)) return 'Input is blocked by a host message. Press Reset (the Ctrl key, or the Reset button).';
    if (/read-only/i.test(e)) return 'This connection is read-only, so keys sent to the host are blocked.';
    return e;
  }

  // Configurable chrome.
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
    fit();
  }
  function defaultChrome() {
    var screenOnly = params.get('view') === 'screen' || truthyParam('bare', false);
    var base = screenOnly
      ? { header: false, keys: false, hint: false, status: false, bare: true }
      : { header: true, keys: true, hint: true, status: true, bare: false };
    if (params.get('chrome') === 'full') base = { header: true, keys: true, hint: true, status: true, bare: false };
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

  // Fit the 80x24 (or 27x132) grid to fill the stage: scale the font so the
  // grid fills whichever of width or height runs out first.
  var charRatioCache = 0;
  function charRatio() {
    if (charRatioCache) return charRatioCache;
    var probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:100px/1.25 "Cascadia Mono",Consolas,"DejaVu Sans Mono",Menlo,monospace;';
    probe.textContent = '0000000000';
    document.body.appendChild(probe);
    var w = probe.getBoundingClientRect().width / 10 / 100;
    document.body.removeChild(probe);
    charRatioCache = w || 0.6;
    return charRatioCache;
  }
  function fit() {
    var cols = (last && last.cols) || 80, rows = (last && last.rows) || 24;
    var availW = stage.clientWidth, availH = stage.clientHeight;
    if (availW < 10 || availH < 10) return;
    // Leave room for the wrap border (1px) and screen padding (a few px each side).
    availW -= 12; availH -= 8;
    var r = charRatio();
    var f = Math.min(availW / (cols * r), availH / (rows * 1.25));
    f = Math.max(7, Math.floor(f * 10) / 10);
    screenEl.style.fontSize = f + 'px';
  }
  var fitTimer = null;
  window.addEventListener('resize', function () { if (fitTimer) clearTimeout(fitTimer); fitTimer = setTimeout(fit, 60); });

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
    var sizeChanged = !last || last.cols !== view.cols || last.rows !== view.rows;
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
    if (sizeChanged) fit();
    var blocked = view.inputInhibited ? 'Input blocked — press Reset (Ctrl, or the Reset button)'
      : (view.keyboardLocked ? 'Host busy — X System' : '');
    stateChip.textContent = blocked;
    stateChip.classList.toggle('show', !!blocked);
    if (resetBtn) resetBtn.classList.toggle('pulse', !!view.inputInhibited);
    var parts = [];
    parts.push(view.connected ? 'Connected' : 'Disconnected' + (view.closeReason ? ': ' + view.closeReason : ''));
    parts.push('R' + view.cursor.row + ' C' + view.cursor.col);
    if (view.keyboardLocked && !view.inputInhibited) parts.push('<span class="on">X System</span>');
    if (view.inputInhibited) parts.push('<span class="on">Input inhibited</span>');
    if (view.insertMode) parts.push('<span class="on">Insert</span>');
    if (view.messageWaiting) parts.push('<span class="on">Message waiting</span>');
    if (view.lastKey) parts.push('Last ' + view.lastKey);
    statusEl.innerHTML = parts.join(' &middot; ');
    var actor = view.lastActor === 'person' ? 'person' : view.lastActor === 'agent' ? 'agent' : '';
    actorEl.className = 'badge ' + actor;
    actorEl.textContent = actor === 'agent' ? 'Agent acted last' : actor === 'person' ? 'You acted last' : 'Waiting';
    connEl.textContent = (view.connectionName || '') + '  ' + view.rows + 'x' + view.cols + (view.host ? '  ' + view.host : '');
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
    if (window.getSelection && String(window.getSelection()).replace(/\\s+/g, '').length) return;
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
  var lastWheel = 0;
  wrap.addEventListener('wheel', function (ev) {
    if (!last || !last.connected || last.keyboardLocked || last.inputInhibited) return;
    ev.preventDefault();
    var now = Date.now();
    if (now - lastWheel < 350) return;
    lastWheel = now;
    key(ev.deltaY > 0 ? 'PageDown' : 'PageUp', true);
  }, { passive: false });

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
  function keyRow(names, cls) {
    var rowEl = document.createElement('div');
    rowEl.className = 'keyrow' + (cls ? ' ' + cls : '');
    names.forEach(function (name) {
      var b = document.createElement('button');
      b.textContent = name;
      b.addEventListener('click', function () { key(name); wrap.focus(); });
      if (name === 'Reset') resetBtn = b;
      rowEl.appendChild(b);
    });
    keysEl.appendChild(rowEl);
  }
  keyRow(['Enter', 'Attn', 'SysReq', 'Reset', 'Field+', 'Field-', 'FieldExit', 'Dup', 'EraseEOF', 'EraseInput', 'Clear', 'Help', 'Print', 'PageUp', 'PageDown'], 'special');
  keyRow(Array.from({ length: 12 }, function (_, i) { return 'F' + (i + 1); }));
  keyRow(Array.from({ length: 12 }, function (_, i) { return 'F' + (i + 13); }));

  fetch('/api/sessions?t=' + encodeURIComponent(token)).then(function (r) { return r.json(); }).then(function (res) {
    var hadCurrent = Boolean(current);
    renderSessions(res.sessions || []);
    if (hadCurrent || !current) follow();
    if (!current) statusEl.textContent = 'No 5250 session is open yet. Ask the agent to connect with ibmi.tn5250.connect.';
  }).catch(function (err) { errorEl.textContent = String(err); });
  fit();
  wrap.focus();
})();
</script>
</body>
</html>`;
}
