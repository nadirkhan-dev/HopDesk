/**
 * Renderer.
 *
 * Talks to the main process through `window.hopdesk`, the narrow bridge exposed
 * by the preload script. The renderer never touches the filesystem, spawns a
 * process, or opens a socket — an XSS in a UI that could do those things would
 * be a full machine compromise rather than a cosmetic bug.
 */

import {
  KeyTracker, keysymsForText, framebufferPoint, buttonMask, wheelMask, SPECIAL_COMBOS,
} from '../dist/keymap.js';

/* The mock exists only so the UI can be opened in an ordinary browser during
   development. Inside Electron a missing bridge is a broken install, and
   pretending otherwise ("Not available in browser preview") hides it. */
const runningInElectron = /\bElectron\//.test(navigator.userAgent);
const api = window.hopdesk ?? (runningInElectron ? brokenBridgeApi() : mockApi());
const $ = sel => document.querySelector(sel);

const state = {
  connections: [], selected: null, filter: '',
  session: null, settings: null, editing: null,
  nearby: null,
};

const DEFAULT_PORT = { vnc: 5900, rdp: 3389, spice: 5900 };
const PROTOCOL_NAME = { rdp: 'Remote Desktop', vnc: 'Screen Sharing', spice: 'Virtual machine' };
const OS_NAME = { windows: 'Windows', macos: 'Mac', linux: 'Linux', other: 'Computer' };
const DEFAULT_PROTOCOL_FOR_OS = { windows: 'rdp', macos: 'vnc', linux: 'rdp', other: 'vnc' };
const ZOOM_STEPS = [25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 300];

/* Simple, brand-free glyphs: a four-pane window, a laptop, a terminal, a monitor. */
const OS_ICON = {
  windows: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
  macos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>',
  linux: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 10 3 2.5L7 15M12 15h5"/></svg>',
  other: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/></svg>',
};
const osOf = c => c.os ?? (c.protocol === 'rdp' ? 'windows' : 'other');
const osBadge = os => `<span class="os ${esc(os)}" aria-hidden="true">${OS_ICON[os] ?? OS_ICON.other}</span>`;

/* ------------------------------------------------------------- the list */

function renderList() {
  const list = $('#list');
  const term = state.filter.trim().toLowerCase();
  const items = state.connections.filter(c =>
    !term || c.name.toLowerCase().includes(term) || c.host.toLowerCase().includes(term)
    || (c.username ?? '').toLowerCase().includes(term));
  $('#count').textContent = state.connections.length ? String(state.connections.length) : '';

  if (!items.length) {
    list.innerHTML = `<p class="muted" style="padding:16px;text-align:center;font-size:13px">
      ${state.connections.length ? 'Nothing matches that search.' : 'No computers yet.'}</p>`;
    return;
  }

  list.innerHTML = items.map(c => {
    const live = state.session?.connectionId === c.id && state.session.state === 'connected';
    return `
    <button class="item" role="option" data-id="${esc(c.id)}" aria-selected="${state.selected === c.id}"
            title="Double-click to connect">
      ${osBadge(osOf(c))}
      <span class="meta">
        <span class="name">${esc(c.name)}</span>
        <span class="sub">${esc(c.host)}${c.username ? ' · ' + esc(c.username) : ''}</span>
        <span class="when">${c.lastConnectedAt ? 'Connected ' + esc(relativeTime(c.lastConnectedAt)) : esc(PROTOCOL_NAME[c.protocol] ?? '')}</span>
      </span>
      ${live ? '<span class="live-dot" aria-label="Connected"></span>' : ''}
      ${c.favorite ? '<span class="star" aria-label="Favourite">★</span>' : ''}
    </button>`;
  }).join('');

  list.querySelectorAll('.item').forEach(el => {
    el.onclick = () => { state.selected = el.dataset.id; render(); };
    el.ondblclick = () => { state.selected = el.dataset.id; render(); void connect(el.dataset.id); };
    el.oncontextmenu = e => { e.preventDefault(); state.selected = el.dataset.id; render(); openMenu(el.dataset.id, e.clientX, e.clientY); };
    el.onkeydown = e => { if (e.key === 'Enter') void connect(el.dataset.id); };
  });
}

function openMenu(id, x, y) {
  const c = state.connections.find(k => k.id === id);
  if (!c) return;
  const menu = $('#menu');
  menu.innerHTML = `
    <button data-act="connect">Connect</button>
    <button data-act="edit">Edit…</button>
    <button data-act="duplicate">Duplicate</button>
    <button data-act="favorite">${c.favorite ? 'Remove from favourites' : 'Add to favourites'}</button>
    <button data-act="delete" class="danger">Delete…</button>`;
  menu.hidden = false;
  menu.style.left = `${Math.min(x, innerWidth - 190)}px`;
  menu.style.top = `${Math.min(y, innerHeight - 200)}px`;
  menu.querySelector('button').focus();
  menu.onclick = async e => {
    const act = e.target.closest('button')?.dataset.act;
    menu.hidden = true;
    if (act === 'connect') await connect(id);
    if (act === 'edit') openEditor(c);
    if (act === 'duplicate') await duplicate(id);
    if (act === 'favorite') { await api.toggleFavorite(id); await refresh(); }
    if (act === 'delete') await removeComputer(c);
  };
}
document.addEventListener('click', e => { if (!e.target.closest('#menu')) $('#menu').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#menu').hidden = true; });

/* ------------------------------------------------------------ the pane */

function renderPane() {
  const pane = $('#pane');
  const c = state.connections.find(x => x.id === state.selected);
  const s = c && state.session?.connectionId === c.id ? state.session : null;
  const live = s && ['connected', 'connecting', 'reconnecting'].includes(s.state);

  if (c && live && c.protocol === 'vnc' && screen.connectionId === c.id) {
    renderSession(pane, c, s);
    return;
  }
  pane.classList.remove('session-mode');
  document.body.classList.remove('focus-session');
  view.observer?.disconnect();

  if (!c) {
    pane.innerHTML = state.connections.length ? `
      <div class="empty"><div>
        <h1>Choose a computer</h1>
        <p class="muted">Select a computer on the left, or double-click it to connect.</p>
      </div></div>` : `
      <div class="empty"><div>
        <h1>Add your first computer</h1>
        <p class="muted" style="max-width:420px;margin:8px auto 0;line-height:1.6">
          Control a Windows PC, a Mac or a Linux computer from here.
          What kind of computer do you want to reach?
        </p>
        <div class="choices">
          ${['windows', 'macos', 'linux'].map(os => `
            <button class="choice" data-os="${os}">${osBadge(os)}<b>${OS_NAME[os]}</b>
              <small>${os === 'windows' ? 'Remote Desktop' : os === 'macos' ? 'Screen Sharing' : 'Remote Desktop or VNC'}</small></button>`).join('')}
        </div>
        <p class="muted" style="margin-top:22px;font-size:13px">
          Or <button class="btn ghost" id="btn-empty-discover">find computers on this network</button>
        </p>
      </div></div>`;
    pane.querySelectorAll('.choice').forEach(b => { b.onclick = () => openEditor(null, { os: b.dataset.os }); });
    $('#btn-empty-discover') && ($('#btn-empty-discover').onclick = () => discover());
    return;
  }

  const trusted = c.protocol === 'rdp' && c.options?.trustedCertificate;
  pane.innerHTML = `
    <div class="detail-head">
      ${osBadge(osOf(c))}
      <div style="flex:1;min-width:0">
        <h1>${esc(c.name)}</h1>
        <p class="muted" style="margin:4px 0 0">${esc(PROTOCOL_NAME[c.protocol])} · ${esc(c.host)}${c.port !== DEFAULT_PORT[c.protocol] ? ':' + esc(c.port) : ''}</p>
      </div>
      <button class="btn" id="btn-fav" aria-pressed="${c.favorite}">${c.favorite ? '★ Favourite' : '☆ Favourite'}</button>
      <button class="btn" id="btn-edit">Edit</button>
      <button class="btn" id="btn-dup">Duplicate</button>
      <button class="btn danger" id="btn-del">Delete</button>
    </div>

    <div class="detail-actions">
      ${live
        ? '<button class="btn big" id="btn-disconnect">Disconnect</button>'
        : '<button class="btn primary big" id="btn-connect">Connect</button>'}
      <div class="status" id="status" aria-live="polite">
        <span class="dot ${esc(s?.state ?? '')}"></span>${esc(statusLabel(s))}
      </div>
    </div>

    ${s?.state === 'failed' || s?.lastError ? errorCard(c, s) : ''}
    ${(s?.warnings ?? []).map(w => `<div class="alert warn">${esc(w)}</div>`).join('')}

    ${live && c.protocol !== 'vnc' ? `<div class="alert info">
      <div class="t">${c.protocol === 'rdp' ? 'The remote desktop is open in its own window' : 'The virtual machine is open in its own window'}</div>
      Use that window to work on ${esc(c.name)}. Closing it, or pressing Disconnect here, ends the session.
    </div>` : ''}

    <h2>Details</h2>
    <div class="tiles">
      <div class="card tile"><div class="k">Address</div><div class="v">${esc(c.host)}:${esc(c.port)}</div></div>
      <div class="card tile"><div class="k">Connection</div><div class="v">${esc(PROTOCOL_NAME[c.protocol])}</div></div>
      ${c.username ? `<div class="card tile"><div class="k">Username</div><div class="v">${c.domain ? esc(c.domain) + '\\' : ''}${esc(c.username)}</div></div>` : ''}
      <div class="card tile"><div class="k">Last connected</div><div class="v" title="${c.lastConnectedAt ? esc(new Date(c.lastConnectedAt).toLocaleString()) : ''}">${c.lastConnectedAt ? esc(relativeTime(c.lastConnectedAt)) : 'Never'}</div></div>
      ${trusted ? `<div class="card tile"><div class="k">Trusted certificate</div>
        <div class="v fingerprint" title="${esc(trusted)}">${esc(trusted.slice(0, 23))}…</div>
        <button class="btn ghost" id="btn-forget-cert" style="margin-top:6px;padding:3px 8px">Forget</button></div>` : ''}
    </div>

    <h2>Session history</h2>
    <div class="card" id="history"><p class="muted" style="font-size:13px;margin:0">Loading…</p></div>`;

  $('#btn-connect') && ($('#btn-connect').onclick = () => connect(c.id));
  $('#btn-disconnect') && ($('#btn-disconnect').onclick = () => api.disconnect());
  $('#btn-retry') && ($('#btn-retry').onclick = () => connect(c.id));
  $('#btn-err-edit') && ($('#btn-err-edit').onclick = () => openEditor(c));
  $('#btn-err-log') && ($('#btn-err-log').onclick = () => api.openLogFolder());
  $('#btn-forget-cert') && ($('#btn-forget-cert').onclick = async () => {
    await api.update(c.id, { options: { trustedCertificate: null } });
    toast('The certificate will be checked again next time you connect.');
    await refresh();
  });
  $('#btn-fav').onclick = async () => { await api.toggleFavorite(c.id); await refresh(); };
  $('#btn-edit').onclick = () => openEditor(c);
  $('#btn-dup').onclick = () => duplicate(c.id);
  $('#btn-del').onclick = () => removeComputer(c);

  void loadHistory(c.id);
}

function errorCard(c, s) {
  const e = s.error;
  const title = e?.title ?? 'Connection failed';
  const message = e?.message ?? s.lastError ?? '';
  const detail = [e?.detail, s.lastError && s.lastError !== message ? s.lastError : null].filter(Boolean).join('\n');
  const authProblem = ['auth-failed', 'auth-required', 'account-restricted'].includes(e?.category);
  return `<div class="alert error" role="alert">
    <div class="t">${esc(title)}</div>
    <div>${esc(message)}</div>
    <div class="actions">
      <button class="btn" id="btn-retry">Try again</button>
      ${authProblem ? '<button class="btn" id="btn-err-edit">Edit computer…</button>' : ''}
    </div>
    ${detail ? `<details><summary>Technical details</summary><pre>${esc(detail)}</pre>
      <button class="btn ghost" id="btn-err-log" type="button">Open log folder</button></details>` : ''}
  </div>`;
}

function statusLabel(s) {
  if (!s) return 'Not connected';
  if (s.state === 'failed') return s.error?.title ? `Failed — ${s.error.title}` : 'Failed';
  return {
    connecting: 'Connecting…',
    connected: 'Connected',
    // Retries before the first successful connection are not re-connections.
    reconnecting: s.connectedAt ? `Reconnecting… (attempt ${s.attempt})` : `Retrying… (attempt ${s.attempt})`,
    disconnected: 'Disconnected',
    idle: 'Not connected',
  }[s.state] ?? s.state;
}

async function loadHistory(id) {
  const rows = await api.history(id);
  const el = $('#history');
  if (!el || state.selected !== id) return;
  if (!rows.length) { el.innerHTML = '<p class="muted" style="font-size:13px;margin:0">No sessions yet.</p>'; return; }
  el.innerHTML = rows.slice(0, 12).map(h => {
    const when = new Date(h.connectedAt ?? h.startedAt);
    let text;
    if (h.outcome === 'connected') {
      text = h.endedAt
        ? `Connected · ${fmtDuration(h.durationMs ?? 0)}${h.endReason === 'error' || h.endReason === 'remote' ? ' · ended by the remote side or network' : ''}`
        : 'Connected';
    } else if (h.outcome === 'failed') {
      text = `Failed${h.error ? ' · ' + h.error : ''}`;
    } else {
      text = 'Cancelled';
    }
    return `<div class="history-row">
      <span class="dot ${h.outcome === 'connected' ? 'connected' : h.outcome === 'failed' ? 'failed' : ''}"></span>
      <span class="when-col" title="${esc(when.toLocaleString())}">${esc(when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</span>
      <span class="muted">${esc(text)}</span>
    </div>`;
  }).join('');
}

/* -------------------------------------------------------------- session view */

/** Per-session display state: how the remote screen is fitted into the window. */
const view = { connectionId: null, mode: 'fit', zoom: 100, observer: null, resizeTimer: null, resizeRefused: false, lastAsked: '' };

function renderSession(pane, c, s) {
  if (view.connectionId !== c.id) {
    view.connectionId = c.id;
    view.mode = c.options?.scaling ?? 'fit';
    view.zoom = c.options?.zoom ?? 100;
    view.resizeRefused = false;
    view.lastAsked = '';
  }
  pane.classList.add('session-mode');
  pane.innerHTML = `
    <div class="session" id="session">
      <div class="hotzone"></div>
      <div class="session-bar" role="toolbar" aria-label="Session">
        <button class="btn ghost" id="btn-sidebar" title="Show or hide the computer list" aria-pressed="${document.body.classList.contains('focus-session')}">☰</button>
        <span class="title">${esc(c.name)}</span>
        <div class="status" id="status" aria-live="polite"><span class="dot ${esc(s.state)}"></span>${esc(statusLabel(s))}</div>
        <span class="spacer"></span>
        <select id="view-mode" aria-label="Screen size" title="Screen size">
          <option value="fit"${view.mode === 'fit' ? ' selected' : ''}>Fit to window</option>
          <option value="none"${view.mode === 'none' ? ' selected' : ''}>Actual size</option>
          <option value="fill"${view.mode === 'fill' ? ' selected' : ''}>Match window size</option>
        </select>
        <span id="zoom-controls" ${view.mode === 'none' ? '' : 'hidden'}>
          <button class="btn" id="btn-zoom-out" aria-label="Zoom out">−</button>
          <span class="zoom-label" id="zoom-label">${view.zoom}%</span>
          <button class="btn" id="btn-zoom-in" aria-label="Zoom in">+</button>
        </span>
        <button class="btn" id="btn-clip" title="Send this computer's clipboard to the remote computer">Send clipboard</button>
        <button class="btn" id="btn-cad" title="Send Ctrl+Alt+Delete">Ctrl+Alt+Del</button>
        <button class="btn" id="btn-full" title="Full screen (Ctrl+Alt+Enter)">Full screen</button>
        <button class="btn" id="btn-fav" aria-pressed="${c.favorite}">${c.favorite ? '★ Favourite' : '☆ Favourite'}</button>
        <button class="btn primary" id="btn-disconnect">Disconnect</button>
      </div>
      <div class="viewport ${view.mode === 'none' ? 'scroll' : ''}" id="viewport">
        <div id="screen-slot"></div>
        ${s.state !== 'connected' ? `<div class="overlay"><div class="box">
          <div style="font-size:16px;font-weight:700">${esc(statusLabel(s))}</div>
          ${s.state === 'reconnecting' && s.error ? `<div style="margin-top:6px">${esc(s.error.message)}</div>` : ''}
          <button class="btn" id="btn-overlay-cancel">Cancel</button>
        </div></div>` : ''}
      </div>
      <div class="stats" id="stats"></div>
    </div>`;

  $('#screen-slot').replaceWith(screen.el);
  renderStats();
  $('#btn-sidebar').onclick = () => { document.body.classList.toggle('focus-session'); renderPane(); };
  $('#view-mode').onchange = e => setViewMode(c, e.target.value);
  $('#btn-zoom-in').onclick = () => stepZoom(c, +1);
  $('#btn-zoom-out').onclick = () => stepZoom(c, -1);
  $('#btn-clip').onclick = () => { api.input({ type: 'clipboard-sync' }); toast('Clipboard sent.'); screen.input.focus(); };
  $('#btn-cad').onclick = () => sendCombo(SPECIAL_COMBOS['ctrl-alt-del']);
  $('#btn-full').onclick = () => toggleFullscreen();
  $('#btn-fav').onclick = async () => { await api.toggleFavorite(c.id); await refresh(); };
  $('#btn-disconnect').onclick = () => api.disconnect();
  $('#btn-overlay-cancel') && ($('#btn-overlay-cancel').onclick = () => api.disconnect());

  view.observer?.disconnect();
  view.observer = new ResizeObserver(() => applyView());
  view.observer.observe($('#viewport'));
  applyView();
}

function setViewMode(c, mode) {
  view.mode = mode;
  view.lastAsked = '';
  c.options = { ...c.options, scaling: mode };
  void api.update(c.id, { options: { scaling: mode } });
  renderPane();
  screen.input.focus({ preventScroll: true });
}

function stepZoom(c, dir) {
  const i = ZOOM_STEPS.findIndex(z => z >= view.zoom);
  const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, (i < 0 ? ZOOM_STEPS.length - 1 : i) + dir))];
  view.zoom = next;
  c.options = { ...c.options, zoom: next };
  void api.update(c.id, { options: { zoom: next } });
  $('#zoom-label') && ($('#zoom-label').textContent = `${next}%`);
  applyView();
}

/**
 * Sizes the canvas for the chosen mode. The canvas keeps the remote
 * resolution; only its displayed size changes, always with the aspect ratio
 * kept, so the picture is never stretched.
 */
function applyView() {
  const viewport = $('#viewport');
  if (!viewport || !screen.width || !screen.height) return;
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  const canvas = screen.canvas;
  viewport.classList.toggle('scroll', view.mode === 'none');

  if (view.mode === 'none') {
    const z = view.zoom / 100;
    canvas.style.width = `${Math.round(screen.width * z)}px`;
    canvas.style.height = `${Math.round(screen.height * z)}px`;
    return;
  }
  const scale = Math.min(vw / screen.width, vh / screen.height);
  canvas.style.width = `${Math.max(1, Math.floor(screen.width * scale))}px`;
  canvas.style.height = `${Math.max(1, Math.floor(screen.height * scale))}px`;

  if (view.mode === 'fill') requestRemoteSize(vw, vh);
}

/** Match window size: ask the remote computer to use the window's size, once it settles. */
function requestRemoteSize(vw, vh) {
  const s = state.session;
  if (!s || s.state !== 'connected' || view.resizeRefused) return;
  if (!s.canResize) {
    if (view.lastAsked !== 'unsupported') {
      view.lastAsked = 'unsupported';
      toast('This computer cannot change its resolution from here, so the screen is scaled to fit instead.');
    }
    return;
  }
  const w = Math.floor(vw / 2) * 2, h = Math.floor(vh / 2) * 2;
  if (Math.abs(w - screen.width) < 8 && Math.abs(h - screen.height) < 8) return;
  const key = `${w}x${h}`;
  if (key === view.lastAsked) return;
  clearTimeout(view.resizeTimer);
  view.resizeTimer = setTimeout(() => {
    view.lastAsked = key;
    api.input({ type: 'resize', width: w, height: h });
  }, 400);
}

function toggleFullscreen() {
  const el = $('#session');
  if (document.fullscreenElement) void document.exitFullscreen();
  else if (el) void el.requestFullscreen?.();
  screen.input.focus({ preventScroll: true });
}

function renderStats() {
  const el = $('#stats');
  const s = screen.stats;
  if (!el) return;
  el.innerHTML = `
    <span>Latency <b>${s.latencyMs != null ? s.latencyMs + ' ms' : '—'}</b></span>
    <span>Frames <b>${s.framesReceived ?? 0}</b></span>
    <span>Received <b>${fmtBytes(s.bytesReceived ?? 0)}</b></span>
    <span>Screen <b>${screen.width || '?'}×${screen.height || '?'}</b></span>
    <span>Clipboard <b>${state.session?.unicodeClipboard ? 'all languages' : 'Latin only'}</b></span>`;
}

/* --------------------------------------------------------- remote screen */

/**
 * The remote framebuffer. Created once and moved between re-renders of the
 * pane, never rebuilt: a canvas is the framebuffer, and replacing it would wipe
 * everything not repainted by the next update.
 */
const screen = createScreen();

function createScreen() {
  const el = document.createElement('div');
  el.className = 'screen';
  const canvas = document.createElement('canvas');
  canvas.id = 'screen';
  canvas.width = 1024; canvas.height = 768;
  const input = document.createElement('textarea');
  input.className = 'keysink';
  input.setAttribute('aria-label', 'Remote keyboard input');
  input.autocapitalize = 'off';
  input.spellcheck = false;
  el.append(canvas, input);

  const s = {
    el, canvas, input,
    ctx: canvas.getContext('2d', { alpha: false }),
    connectionId: null, width: 0, height: 0,
    queue: [], scheduled: false,
    tracker: new KeyTracker(),
    mask: 0, lastPointer: '',
    stats: {},
  };
  wireScreenInput(s);
  return s;
}

function resetScreen(connectionId, width, height) {
  if (screen.connectionId !== connectionId) {
    screen.queue = [];
    screen.stats = {};
    // Another computer's picture must never show while this one connects.
    screen.ctx.fillStyle = '#000';
    screen.ctx.fillRect(0, 0, screen.canvas.width, screen.canvas.height);
  }
  screen.connectionId = connectionId;
  resizeScreen(width || screen.width || 1024, height || screen.height || 768);
}

function resizeScreen(width, height) {
  if (screen.width === width && screen.height === height) return;
  screen.width = width; screen.height = height;
  // Setting the size clears the canvas; the session asks for a full repaint.
  screen.canvas.width = width;
  screen.canvas.height = height;
  applyView();
}

function queueFrame(frame) {
  if (frame.connectionId !== screen.connectionId) { api.frameRendered(); return; }
  screen.queue.push(frame);
  if (screen.scheduled) return;
  screen.scheduled = true;
  // Painting is batched into animation frames so a burst of updates never
  // blocks input handling. A hidden window gets no animation frames, so it
  // paints on a timer instead of letting the queue grow.
  if (document.hidden) setTimeout(paintQueued, 0); else requestAnimationFrame(paintQueued);
}

function paintQueued() {
  screen.scheduled = false;
  const frames = screen.queue;
  screen.queue = [];
  for (const frame of frames) {
    if (frame.width !== screen.width || frame.height !== screen.height) resizeScreen(frame.width, frame.height);
    for (const r of frame.rects) paintRect(r);
    screen.stats = frame.stats ?? screen.stats;
    api.frameRendered();
  }
  renderStats();
}

function paintRect(r) {
  const ctx = screen.ctx;
  if (r.src) {
    // CopyRect: pixels already on screen move. drawImage from the canvas onto
    // itself is defined to copy the source first, so overlaps are safe.
    ctx.drawImage(screen.canvas, r.src.x, r.src.y, r.width, r.height, r.x, r.y, r.width, r.height);
    return;
  }
  if (!r.data || !r.width || !r.height) return;
  const pixels = new Uint8ClampedArray(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  ctx.putImageData(new ImageData(pixels, r.width, r.height), r.x, r.y);
}

function sendKey(keysym, down) {
  api.input({ type: 'key', keysym, down });
}

function sendCombo(keysyms) {
  for (const k of keysyms) sendKey(k, true);
  for (const k of [...keysyms].reverse()) sendKey(k, false);
  screen.input.focus();
}

function wireScreenInput(s) {
  const { canvas, input } = s;

  const pointer = (e, mask) => {
    const box = canvas.getBoundingClientRect();
    const { x, y } = framebufferPoint(e.clientX, e.clientY, box, canvas.width, canvas.height);
    const key = `${x},${y},${mask}`;
    if (key === s.lastPointer) return;
    s.lastPointer = key;
    api.input({ type: 'pointer', x, y, mask });
  };

  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    input.focus({ preventScroll: true });
    canvas.setPointerCapture?.(e.pointerId);
    s.mask = buttonMask(e.buttons);
    pointer(e, s.mask);
  });
  canvas.addEventListener('pointermove', e => {
    s.mask = buttonMask(e.buttons);
    pointer(e, s.mask);
  });
  canvas.addEventListener('pointerup', e => {
    s.mask = buttonMask(e.buttons);
    pointer(e, s.mask);
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const wheel = wheelMask(e.deltaY, e.deltaX);
    if (!wheel) return;
    // A wheel step is a press and release of a virtual button.
    s.lastPointer = '';
    pointer(e, s.mask | wheel);
    s.lastPointer = '';
    pointer(e, s.mask);
  }, { passive: false });

  input.addEventListener('keydown', e => {
    // During input-method composition the keys belong to the IME; the result
    // arrives as compositionend.
    if (e.isComposing || e.key === 'Process') return;
    // HopDesk's own shortcut, the same one FreeRDP uses: never sent to the remote.
    if (e.ctrlKey && e.altKey && e.key === 'Enter') {
      e.preventDefault();
      toggleFullscreen();
      return;
    }
    const keysym = s.tracker.down(e);
    if (keysym === null) return;
    e.preventDefault();
    sendKey(keysym, true);
  });
  input.addEventListener('keyup', e => {
    if (e.isComposing || e.key === 'Process') return;
    const keysym = s.tracker.up(e);
    if (keysym === null) return;
    e.preventDefault();
    sendKey(keysym, false);
  });
  input.addEventListener('compositionend', e => {
    for (const k of keysymsForText(e.data ?? '')) { sendKey(k, true); sendKey(k, false); }
    input.value = '';
  });
  input.addEventListener('input', e => {
    // Text that arrived without a key event (on-screen keyboards, emoji
    // pickers). Composition is handled above.
    if (!e.isComposing && e.inputType === 'insertText' && e.data) {
      for (const k of keysymsForText(e.data)) { sendKey(k, true); sendKey(k, false); }
    }
    if (!e.isComposing) input.value = '';
  });
  input.addEventListener('focus', () => api.input({ type: 'clipboard-sync' }));
  input.addEventListener('blur', () => {
    // Key-up events now go elsewhere; release everything so nothing sticks.
    for (const k of s.tracker.releaseAll()) sendKey(k, false);
    if (s.mask) { s.mask = 0; s.lastPointer = ''; }
  });
}

/* --------------------------------------------------------------- dialogs */

/** Shows a <dialog> and resolves with the button value it was closed with. */
function showDialog(dialog) {
  return new Promise(resolve => {
    dialog.returnValue = 'cancel';
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.showModal();
  });
}

async function showDialogFocused(dialog, selector) {
  const p = showDialog(dialog);
  $(selector)?.focus();
  return p;
}

async function askCredentials(c, fields, { vaultLocked = false, reason = '' } = {}) {
  const needUser = fields.includes('username');
  $('#cred-title').textContent = `Sign in to ${c.name}`;
  $('#cred-intro').textContent = reason || (c.protocol === 'vnc'
    ? 'This computer needs a password.'
    : 'Enter the account you use to sign in to this computer.');
  $('#wrap-cred-user').hidden = c.protocol === 'vnc' && !needUser;
  $('#cred-user').value = c.username ?? '';
  $('#cred-pass').value = '';
  $('#cred-locked').hidden = !vaultLocked;

  let unlocked = false;
  $('#cred-unlock').onclick = async () => {
    if (await unlockFlow()) { unlocked = true; $('#dlg-cred').close('unlocked'); }
  };

  const result = await showDialogFocused($('#dlg-cred'), needUser && !c.username ? '#cred-user' : '#cred-pass');
  if (unlocked || result === 'unlocked') return { unlocked: true };
  if (result !== 'ok') return null;
  return {
    username: $('#wrap-cred-user').hidden ? undefined : $('#cred-user').value.trim(),
    password: $('#cred-pass').value,
    savePassword: $('#cred-save').checked,
  };
}

/** Asks for the vault passphrase (or a new one). Resolves true once unlocked. */
async function unlockFlow() {
  const status = await api.vaultStatus();
  if (!status.locked) return true;
  const creating = !status.exists;
  $('#unlock-title').textContent = creating ? 'Protect saved passwords' : 'Unlock saved passwords';
  $('#unlock-intro').textContent = creating
    ? 'No system keyring was found, so saved passwords are kept in a file encrypted with a passphrase. Choose one now; you will need it each time HopDesk starts.'
    : 'Enter the passphrase that protects your saved passwords.';
  $('#wrap-unlock-confirm').hidden = !creating;
  $('#unlock-ok').textContent = creating ? 'Create' : 'Unlock';

  for (;;) {
    $('#unlock-pass').value = '';
    $('#unlock-confirm').value = '';
    const answer = await showDialogFocused($('#dlg-unlock'), '#unlock-pass');
    if (answer !== 'ok') return false;
    const pass = $('#unlock-pass').value;
    const box = $('#unlock-error');
    if (creating && pass !== $('#unlock-confirm').value) {
      box.textContent = 'The passphrases do not match.'; box.hidden = false;
      continue;
    }
    try {
      await api.unlockVault(pass);
      box.hidden = true;
      state.settings = await api.getSettings();
      return true;
    } catch (err) {
      box.textContent = cleanError(err); box.hidden = false;
    }
  }
}

async function askCertificate(c, prompt) {
  const cert = prompt.certificate;
  const changed = prompt.reason === 'changed';
  const reason = $('#cert-reason');
  reason.className = `alert ${changed ? 'error' : 'warn'}`;
  reason.innerHTML = changed
    ? `<div class="t">The certificate has changed</div>The identity of ${esc(c.host)} is different from the one you trusted. This happens after the computer is reinstalled or its certificate renewed — but it is also exactly what an attacker intercepting the connection looks like. Only continue if you know why it changed.`
    : `<div class="t">Is this the right computer?</div>HopDesk cannot confirm that ${esc(c.host)} is the computer you mean to reach, because its certificate is not issued by an authority this system trusts (${esc(cert.trustError ?? 'unknown issuer')}). This is normal for Windows PCs, which use their own certificates.`;
  $('#cert-details').innerHTML = `
    <dt>Subject</dt><dd>${esc(cert.subject)}</dd>
    <dt>Issuer</dt><dd>${esc(cert.issuer)}</dd>
    <dt>Valid</dt><dd>${esc(cert.validFrom)} – ${esc(cert.validTo)}</dd>
    <dt>SHA-256</dt><dd class="fingerprint">${esc(cert.fingerprint)}</dd>
    ${prompt.previousFingerprint ? `<dt>Previously</dt><dd class="fingerprint">${esc(prompt.previousFingerprint)}</dd>` : ''}`;
  const answer = await showDialog($('#dlg-cert'));
  return answer === 'once' || answer === 'always' ? answer : null;
}

async function confirmDialog(title, text, ok) {
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = ok;
  return (await showDialog($('#dlg-confirm'))) === 'ok';
}

/* --------------------------------------------------------------- editor */

const PROTO_HINT = {
  'windows:rdp': 'On the Windows PC: Settings → System → Remote Desktop → turn it on. Windows Home editions cannot accept connections.',
  'macos:vnc': 'On the Mac: System Settings → General → Sharing → turn on Screen Sharing, then under ⓘ turn on "VNC viewers may control screen with password".',
  'linux:rdp': 'On GNOME: Settings → System → Remote Desktop. On other desktops, install xrdp.',
  'linux:vnc': 'Needs a VNC server running on that computer, for example TigerVNC or x11vnc.',
  'other:vnc': 'Works with VNC servers such as TigerVNC, x11vnc, Raspberry Pi and many NAS devices.',
  'other:rdp': 'Works with Windows and with RDP servers such as xrdp.',
  'spice': 'For QEMU/KVM virtual machines. Needs Virt Viewer installed.',
};

function openEditor(c, preset = {}) {
  state.editing = c ?? null;
  const d = state.settings?.defaults ?? {};
  const o = c?.options ?? d;
  const os = c ? osOf(c) : (preset.os ?? '');
  $('#dlg-title').textContent = c ? `Edit ${c.name}` : 'Add computer';
  $('#f-os').value = os;
  $('#f-protocol').value = c?.protocol ?? preset.protocol ?? (os ? DEFAULT_PROTOCOL_FOR_OS[os] : 'rdp');
  $('#f-name').value = c?.name ?? preset.name ?? '';
  $('#f-host').value = c?.host ?? preset.host ?? '';
  $('#f-port').value = c?.port ?? preset.port ?? DEFAULT_PORT[$('#f-protocol').value];
  $('#f-user').value = c?.username ?? '';
  $('#f-domain').value = c?.domain ?? '';
  $('#f-pass').value = '';
  $('#f-pass').placeholder = c ? 'Unchanged — type to replace' : 'Leave blank to be asked when connecting';
  $('#f-save-pass').checked = true;
  $('#cred-hint').textContent = credentialHint();

  $('#f-scaling').value = o.scaling ?? 'fit';
  $('#f-resolution').value = /^\d+x\d+$/.test(o.resolution ?? '') ? o.resolution : 'auto';
  $('#f-multimon').value = o.multiMonitor ? (o.monitors?.length ? 'selected' : 'all') : 'single';
  $('#f-fullscreen').checked = Boolean(o.fullscreenOnConnect);
  $('#f-clipboard').checked = o.shareClipboard !== false;
  $('#f-audio').checked = Boolean(o.enableAudio);
  $('#f-viewonly').checked = Boolean(o.viewOnly);
  $('#f-reconnect').checked = o.autoReconnect !== false;
  $('#f-folder').value = c?.options?.redirectFolder ?? '';
  $('#monitor-picks').innerHTML = '';
  $('#sec-display').open = false;

  for (const id of ['err-host', 'err-port']) $(`#${id}`).hidden = true;
  $('#f-host').removeAttribute('aria-invalid');
  $('#f-port').removeAttribute('aria-invalid');
  $('#dlg-error').hidden = true;
  syncOsPicker();
  syncProtocolFields();
  $('#dlg-edit').showModal();
  (os ? $('#f-host') : $('#os-picker button'))?.focus();
  if (c?.protocol === 'rdp' || $('#f-protocol').value === 'rdp') void loadMonitors(o.monitors ?? []);
}

function credentialHint() {
  const s = state.settings;
  if (!s) return '';
  return s.credentialBackend === 'keyring'
    ? 'Passwords are kept in your system keyring.'
    : 'Passwords are kept in a file encrypted with your HopDesk passphrase.';
}

function syncOsPicker() {
  const os = $('#f-os').value;
  document.querySelectorAll('#os-picker .os-pick').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.os === os));
    const badge = b.querySelector('.os');
    if (!badge.innerHTML) badge.innerHTML = OS_ICON[b.dataset.os];
  });
}

function syncProtocolFields() {
  const p = $('#f-protocol').value;
  const os = $('#f-os').value || 'other';
  $('#proto-hint').textContent = p === 'spice' ? PROTO_HINT.spice : (PROTO_HINT[`${os}:${p}`] ?? PROTO_HINT[`other:${p}`] ?? '');
  const rdp = p === 'rdp';
  $('#wrap-domain').style.display = rdp ? '' : 'none';
  $('#wrap-user').style.display = p === 'vnc' ? 'none' : '';
  $('#wrap-resolution').style.display = rdp ? '' : 'none';
  $('#wrap-monitors').style.display = rdp ? '' : 'none';
  $('#wrap-audio').style.display = rdp ? '' : 'none';
  $('#wrap-folder').style.display = rdp ? '' : 'none';
  $('#monitor-picks').style.display = $('#f-multimon').value === 'selected' ? '' : 'none';
  const port = $('#f-port');
  // Only follow the protocol when the user has not chosen a port themselves.
  if (!port.value || Object.values(DEFAULT_PORT).includes(Number(port.value))) {
    port.value = DEFAULT_PORT[p];
  }
}

async function loadMonitors(selected) {
  const monitors = await api.listMonitors?.().catch(() => []) ?? [];
  const box = $('#monitor-picks');
  if (!monitors.length) {
    box.innerHTML = '<p class="hint">Monitors are listed here when Remote Desktop support is installed.</p>';
    return;
  }
  box.innerHTML = monitors.map(m => `
    <label class="check"><input type="checkbox" data-monitor="${m.id}" ${selected.includes(m.id) || (!selected.length && m.primary) ? 'checked' : ''}>
      Monitor ${m.id + 1} — ${m.width} × ${m.height}${m.primary ? ' (main)' : ''}</label>`).join('');
}

document.querySelectorAll('#os-picker .os-pick').forEach(b => {
  b.onclick = () => {
    $('#f-os').value = b.dataset.os;
    $('#f-protocol').value = DEFAULT_PROTOCOL_FOR_OS[b.dataset.os];
    syncOsPicker();
    syncProtocolFields();
    if ($('#f-protocol').value === 'rdp') void loadMonitors([]);
    $('#f-host').focus();
  };
});
$('#f-protocol').onchange = () => { syncProtocolFields(); if ($('#f-protocol').value === 'rdp') void loadMonitors([]); };
$('#f-multimon').onchange = syncProtocolFields;

/** Checks the form before sending it; returns the payload or null. */
function readEditor() {
  let ok = true;
  const fail = (field, id, text) => {
    ok = false;
    $(`#${id}`).textContent = text; $(`#${id}`).hidden = false;
    $(field).setAttribute('aria-invalid', 'true');
  };
  for (const id of ['err-host', 'err-port']) $(`#${id}`).hidden = true;
  $('#f-host').removeAttribute('aria-invalid');
  $('#f-port').removeAttribute('aria-invalid');

  const protocol = $('#f-protocol').value;
  const host = $('#f-host').value.trim();
  const port = Number($('#f-port').value || DEFAULT_PORT[protocol]);
  if (!host) fail('#f-host', 'err-host', 'Enter the computer’s name or IP address.');
  else if (/\s/.test(host)) fail('#f-host', 'err-host', 'A computer address cannot contain spaces.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('#f-port', 'err-port', 'Use a port from 1 to 65535.');
  if (!ok) return null;

  const multi = $('#f-multimon').value;
  const monitors = multi === 'selected'
    ? [...document.querySelectorAll('#monitor-picks [data-monitor]:checked')].map(i => Number(i.dataset.monitor))
    : undefined;
  return {
    protocol,
    os: $('#f-os').value || (protocol === 'rdp' ? 'windows' : 'other'),
    name: $('#f-name').value,
    host,
    port,
    username: $('#f-user').value.trim() || undefined,
    domain: $('#f-domain').value.trim() || undefined,
    options: {
      scaling: $('#f-scaling').value,
      fullscreenOnConnect: $('#f-fullscreen').checked,
      shareClipboard: $('#f-clipboard').checked,
      enableAudio: $('#f-audio').checked,
      viewOnly: $('#f-viewonly').checked,
      autoReconnect: $('#f-reconnect').checked,
      multiMonitor: multi !== 'single',
      monitors: monitors?.length ? monitors : undefined,
      resolution: $('#f-resolution').value,
      redirectFolder: $('#f-folder').value.trim() || undefined,
    },
  };
}

$('#dlg-save').onclick = async e => {
  e.preventDefault();
  const payload = readEditor();
  if (!payload) return;
  const pass = $('#f-pass').value;
  const remember = $('#f-save-pass').checked;

  const save = async () => {
    if (state.editing) {
      const patch = { ...payload };
      if (pass && remember) patch.password = pass;
      // Unticking "Remember password" forgets the saved one.
      else if (!remember) patch.password = '';
      await api.update(state.editing.id, patch);
    } else {
      const created = await api.add({ ...payload, password: pass && remember ? pass : undefined });
      state.selected = created.id;
    }
  };

  try {
    try {
      await save();
    } catch (err) {
      // Saving a password needs the vault; unlock it and try once more.
      if (!/VAULT_LOCKED/.test(cleanError(err))) throw err;
      $('#dlg-edit').close();
      if (!(await unlockFlow())) return;
      await save();
    }
    if ($('#dlg-edit').open) $('#dlg-edit').close();
    await refresh();
  } catch (err) {
    if (!$('#dlg-edit').open) $('#dlg-edit').showModal();
    const box = $('#dlg-error');
    box.textContent = cleanError(err);
    box.hidden = false;
  }
};

async function duplicate(id) {
  try {
    const { connection, passwordCopied } = await api.duplicate(id);
    state.selected = connection.id;
    await refresh();
    toast(passwordCopied
      ? `Created “${connection.name}” with the same saved password.`
      : `Created “${connection.name}”. No saved password was copied; you will be asked for one when connecting.`);
  } catch (err) {
    toast(cleanError(err));
  }
}

async function removeComputer(c) {
  if (!(await confirmDialog(`Delete ${c.name}?`,
    'Its saved password and session history are removed too. This cannot be undone.', 'Delete'))) return;
  await api.remove(c.id);
  state.selected = null;
  await refresh();
}

/* ----------------------------------------------------------- discovery */

async function discover() {
  const panel = $('#nearby');
  const list = $('#nearby-list');
  panel.hidden = false;
  list.innerHTML = '<p class="muted" style="padding:10px;font-size:13px">Looking for computers…</p>';
  let found = [];
  try { found = await api.discover(); } catch { found = []; }
  state.nearby = found;
  if (!found.length) {
    list.innerHTML = `<p class="muted" style="padding:10px;font-size:12px;line-height:1.5">
      Nothing found. Macs with Screen Sharing on, and Linux computers that announce VNC or
      Remote Desktop, appear here. Windows PCs do not announce themselves — add them by address.</p>`;
    return;
  }
  list.innerHTML = found.map((f, i) => {
    const saved = state.connections.some(c => (c.host === f.address || c.host === f.hostname) && c.port === f.port);
    return `<div class="item">
      ${osBadge(f.os ?? (f.protocol === 'rdp' ? 'linux' : 'other'))}
      <span class="meta"><span class="name">${esc(f.name)}</span>
        <span class="sub">${esc(f.hostname ?? f.address)} · ${esc(PROTOCOL_NAME[f.protocol])}</span></span>
      ${saved ? '<span class="muted" style="font-size:12px">Saved</span>' : `<button class="btn" data-add="${i}">Add</button>`}
    </div>`;
  }).join('');
  list.querySelectorAll('[data-add]').forEach(b => {
    b.onclick = () => {
      const f = state.nearby[Number(b.dataset.add)];
      openEditor(null, { os: f.os, protocol: f.protocol, name: f.name, host: f.hostname ?? f.address, port: f.port });
    };
  });
}
$('#btn-discover').onclick = () => discover();
$('#btn-nearby-close').onclick = () => { $('#nearby').hidden = true; };

/* ------------------------------------------------------------- settings */

async function openSettings() {
  state.settings = await api.getSettings();
  const s = state.settings;
  const vault = s.vault ?? {};
  $('#settings-body').innerHTML = `
    <h2 style="margin-top:0">Saved passwords</h2>
    <div class="alert ${s.credentialBackend === 'keyring' ? 'info' : 'warn'}">
      ${s.credentialBackend === 'keyring'
        ? 'Passwords are stored in your system keyring, unlocked with your login password.'
        : 'No system keyring was found, so passwords are stored in a file encrypted with your HopDesk passphrase. Installing GNOME Keyring or KWallet gives stronger protection.'}
      ${s.credentialBackend === 'file' ? `<div class="actions">${vault.locked
        ? `<button class="btn" type="button" id="s-unlock">${vault.exists ? 'Unlock saved passwords' : 'Set a passphrase'}</button>`
        : '<button class="btn" type="button" id="s-lock">Lock saved passwords now</button>'}</div>` : ''}
    </div>

    <h2>New computers start with</h2>
    <div class="field"><label for="s-scaling">Screen size</label>
      <select id="s-scaling">
        <option value="fit"${s.defaults.scaling === 'fit' ? ' selected' : ''}>Fit to window</option>
        <option value="fill"${s.defaults.scaling === 'fill' ? ' selected' : ''}>Match window size</option>
        <option value="none"${s.defaults.scaling === 'none' ? ' selected' : ''}>Actual size (100%)</option>
      </select></div>
    ${toggle('fullscreenOnConnect', 'Open full screen', s.defaults.fullscreenOnConnect)}
    ${toggle('shareClipboard', 'Share clipboard', s.defaults.shareClipboard)}
    ${toggle('viewOnly', 'View only — do not send mouse or keyboard', s.defaults.viewOnly)}
    ${toggle('enableAudio', 'Play remote sound (Remote Desktop)', s.defaults.enableAudio)}
    ${toggle('autoReconnect', 'Reconnect automatically if the network drops', s.defaults.autoReconnect)}

    <h2>Remote Desktop support</h2>
    <p class="hint" style="font-size:13px">${s.rdpAvailable
      ? 'Installed. Windows and other Remote Desktop computers can be reached.'
      : 'Not installed. To connect to Windows, install FreeRDP from your software centre, or run: sudo apt install freerdp2-x11 (freerdp3-x11 on Ubuntu 24.04 and later).'}</p>

    <h2>Keyboard shortcuts</h2>
    <p class="hint" style="font-size:13px">Ctrl+Alt+Enter — full screen on and off. All other keys, including
    Super and Alt+Tab where your desktop allows, go to the remote computer while its screen has focus.</p>

    <h2>Diagnostics</h2>
    <p class="hint">Log file: <code>${esc(s.logPath)}</code></p>
    <button class="btn" id="s-openlog" type="button">Open log folder</button>`;

  $('#settings-body').querySelectorAll('.switch').forEach(el => {
    el.onclick = async () => {
      const key = el.dataset.key;
      const next = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', String(next));
      await api.updateSettings({ defaults: { [key]: next } });
      state.settings = await api.getSettings();
    };
  });
  $('#s-scaling').onchange = async e => {
    await api.updateSettings({ defaults: { scaling: e.target.value } });
    state.settings = await api.getSettings();
  };
  $('#s-openlog').onclick = () => api.openLogFolder();
  $('#s-unlock') && ($('#s-unlock').onclick = async () => {
    $('#dlg-settings').close();
    if (await unlockFlow()) void openSettings();
  });
  $('#s-lock') && ($('#s-lock').onclick = async () => {
    await api.lockVault();
    void openSettings();
  });
  if (!$('#dlg-settings').open) $('#dlg-settings').showModal();
}

const toggle = (key, label, on) => `
  <div class="toggle">
    <span>${label}</span>
    <button type="button" class="switch" role="switch" data-key="${key}"
            aria-checked="${!!on}" aria-label="${label}"></button>
  </div>`;

/* ---------------------------------------------------------------- wiring */

/**
 * Starts a connection, and handles whatever the main process needs first:
 * credentials, unlocking the password vault, or a certificate decision.
 */
async function connect(id, request = {}) {
  const c = state.connections.find(x => x.id === id);
  if (!c) return;
  state.selected = id;
  let result;
  try {
    result = await api.connect(id, request);
  } catch (err) {
    showSessionError(id, cleanError(err));
    return;
  }

  switch (result?.status) {
    case 'started':
    case 'failed':
      return;
    case 'needs-unlock':
      if (await unlockFlow()) await connect(id, request);
      return;
    case 'needs-credentials': {
      const creds = await askCredentials(c, result.fields, { vaultLocked: result.vaultLocked });
      if (creds?.unlocked) await connect(id);
      else if (creds) await connect(id, creds);
      return;
    }
    case 'certificate': {
      const choice = await askCertificate(c, result);
      if (!choice) return;
      await api.trustCertificate(id, result.certificate.fingerprint, choice === 'always');
      await refresh();
      await connect(id, request);
      return;
    }
  }
}

function showSessionError(id, message) {
  state.session = {
    connectionId: id, state: 'failed', lastError: message, attempt: 0, warnings: [],
    error: { category: 'unknown', title: 'Could not connect', message, detail: message },
  };
  renderPane();
}

async function refresh() {
  state.connections = await api.list();
  if (state.selected && !state.connections.some(c => c.id === state.selected)) state.selected = null;
  render();
}

function render() { renderList(); renderPane(); }

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** IPC errors arrive as "Error invoking remote method 'x': Error: message". */
const cleanError = err => String(err?.message ?? err ?? 'Something went wrong')
  .replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const fmtBytes = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB'
  : n > 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B';
const fmtDuration = ms => ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)} h ${Math.round((ms % 3_600_000) / 60000)} min`
  : ms > 60000 ? Math.round(ms / 60000) + ' min' : Math.max(1, Math.round(ms / 1000)) + ' s';

function relativeTime(iso) {
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return '';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return rtf.format(-min, 'minute');
  const h = Math.round(min / 60);
  if (h < 24) return rtf.format(-h, 'hour');
  const days = Math.round(h / 24);
  if (days < 30) return rtf.format(-days, 'day');
  return new Date(iso).toLocaleDateString();
}

// Buttons that close their dialog with a value without submitting the form,
// so Enter never activates Cancel or a trust decision by accident.
document.querySelectorAll('dialog [data-close]').forEach(btn => {
  btn.addEventListener('click', () => btn.closest('dialog').close(btn.dataset.close));
});

$('#btn-new').onclick = () => openEditor(null);
$('#btn-settings').onclick = () => openSettings();
$('#search').oninput = e => { state.filter = e.target.value; renderList(); };

api.onSession?.(async s => {
  const previous = state.session;
  state.session = s;

  if (s.protocol === 'vnc' && ['connecting', 'connected', 'reconnecting'].includes(s.state)) {
    resetScreen(s.connectionId, s.width, s.height);
  } else if (s.connectionId === screen.connectionId && ['disconnected', 'failed'].includes(s.state)) {
    screen.connectionId = null;
    for (const k of screen.tracker.releaseAll()) sendKey(k, false);
    if (document.fullscreenElement) void document.exitFullscreen();
  }

  // Re-render only when something visible changed — not for every stats tick.
  const changed = !previous || previous.connectionId !== s.connectionId || previous.state !== s.state
    || previous.lastError !== s.lastError || previous.width !== s.width || previous.height !== s.height
    || previous.canResize !== s.canResize
    || (previous.warnings?.length ?? 0) !== (s.warnings?.length ?? 0);
  if (changed) {
    renderList();
    if (s.connectionId === state.selected) renderPane();
  }
  if (s.state === 'connected' && previous?.state !== 'connected' && s.connectionId === screen.connectionId) {
    screen.input.focus({ preventScroll: true });
    const c = state.connections.find(x => x.id === s.connectionId);
    if (c?.options?.fullscreenOnConnect && !document.fullscreenElement) toggleFullscreen();
  }
  if (s.canResize && !previous?.canResize) applyView();

  const c = state.connections.find(x => x.id === s.connectionId);
  if (!c) return;
  if (s.credentialsRequired) {
    const creds = await askCredentials(c, s.credentialsRequired, { reason: s.error?.message ?? s.lastError });
    if (creds?.unlocked) await connect(c.id);
    else if (creds) await connect(c.id, creds);
  } else if (s.certificatePrompt) {
    const choice = await askCertificate(c, s.certificatePrompt);
    if (choice) {
      await api.trustCertificate(c.id, s.certificatePrompt.certificate.fingerprint, choice === 'always');
      await refresh();
      await connect(c.id);
    }
  }
});

api.onFrame?.(queueFrame);

api.onNotice?.(n => {
  if (n.kind === 'clipboard-lossy') {
    toast('This computer only accepts Latin text on its clipboard, so some characters could not be sent.');
  } else if (n.kind === 'resize-rejected') {
    view.resizeRefused = true;
    toast('The remote computer declined to change its resolution; the screen is scaled to fit instead.');
  }
});

(async () => {
  state.settings = await api.getSettings();
  await refresh();
  // Lets automated tests know the UI is wired up.
  window.__hopdeskReady = true;
})();

/** In Electron without the preload bridge: say so plainly instead of faking it. */
function brokenBridgeApi() {
  const banner = document.querySelector('#banner');
  banner.textContent = 'HopDesk could not load its secure bridge (preload.cjs). Reinstall or rebuild the app.';
  banner.className = 'banner error';
  banner.hidden = false;
  const fail = async () => { throw new Error('The HopDesk bridge is not loaded; the app cannot connect.'); };
  return {
    list: async () => [], add: fail, update: fail, remove: fail, toggleFavorite: fail, duplicate: fail,
    history: async () => [], discover: async () => [], listMonitors: async () => [],
    vaultStatus: async () => ({ backend: 'none', locked: false, exists: false }), unlockVault: fail, lockVault: fail,
    connect: fail, trustCertificate: fail, disconnect: async () => {}, input: () => {}, frameRendered: () => {},
    getSettings: async () => ({ credentialBackend: 'none', vault: {}, logPath: '', defaults: {} }),
    updateSettings: async () => {}, openLogFolder: () => {}, onSession: () => {}, onFrame: () => {}, onNotice: () => {},
  };
}

/** Lets the UI be exercised in a plain browser during development and tests. */
function mockApi() {
  const banner = document.querySelector('#banner');
  banner.textContent = 'Browser preview: connections are not available outside the HopDesk app.';
  banner.hidden = false;
  let store = [];
  return {
    isElectron: false,
    list: async () => store,
    add: async c => { const n = { ...c, id: crypto.randomUUID(), favorite: false }; store.push(n); return n; },
    update: async (id, p) => { Object.assign(store.find(c => c.id === id), p); },
    remove: async id => { store = store.filter(c => c.id !== id); },
    toggleFavorite: async id => { const c = store.find(x => x.id === id); c.favorite = !c.favorite; },
    duplicate: async id => {
      const n = { ...store.find(c => c.id === id), id: crypto.randomUUID() };
      n.name += ' (copy)'; store.push(n);
      return { connection: n, passwordCopied: false };
    },
    history: async () => [],
    discover: async () => [],
    listMonitors: async () => [],
    vaultStatus: async () => ({ backend: 'file', locked: false, exists: true }),
    unlockVault: async () => ({ backend: 'file', locked: false, exists: true }),
    lockVault: async () => ({ backend: 'file', locked: true, exists: true }),
    connect: async () => { throw new Error('Not available in browser preview'); },
    trustCertificate: async () => ({ ok: true }),
    disconnect: async () => {},
    input: () => {},
    frameRendered: () => {},
    getSettings: async () => ({
      credentialBackend: 'file', logPath: '~/.local/share/hopdesk/hopdesk.log',
      vault: { backend: 'file', locked: false, exists: true }, rdpAvailable: false,
      defaults: {
        scaling: 'fit', fullscreenOnConnect: false, viewOnly: false,
        shareClipboard: true, enableAudio: false, autoReconnect: true,
      },
    }),
    updateSettings: async () => {},
    openLogFolder: () => {},
    onSession: () => {},
    onFrame: () => {},
    onNotice: () => {},
  };
}
