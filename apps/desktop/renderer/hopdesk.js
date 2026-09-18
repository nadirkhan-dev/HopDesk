/**
 * The HopDesk half of the interface: this computer's own identity, connecting
 * to another computer by Device ID and access code, the Allow/Reject prompt,
 * and the live session view.
 *
 * Kept apart from app.js, which is the client for standard protocols (VNC and
 * RDP). The two share the window but nothing else.
 */
import { createPeerSession, servePeerCalls } from './peer.js';

const $ = sel => document.querySelector(sel);

/** How a viewer's mouse buttons are reported: DOM `buttons` bitmask. */
const BUTTONS = { left: 1, right: 2, middle: 4 };

export function initHopdesk({ api, toast, confirmDialog }) {
  const ui = {
    status: null,
    session: null,
    video: null,
    peer: null,
    stats: null,
    clipboardSeq: 0,
    lastClipboardSent: '',
  };

  /* ------------------------------------------------- this computer (host) */

  const renderHost = status => {
    ui.status = status;
    const dot = $('#mine-dot');
    const state = $('#mine-state');
    const enabled = status.enabled && status.listening;
    dot.className = `dot ${enabled ? 'on' : 'off'}`;
    state.textContent = enabled ? 'Online' : status.enabled ? 'Starting…' : 'Off';
    $('#mine-id').textContent = status.deviceId || '—';
    $('#mine-code').textContent = status.accessCode ? formatCode(status.accessCode) : '— — —';
    $('#mine-toggle').textContent = status.enabled ? 'Turn off' : 'Turn on';
    $('#mine-toggle').classList.toggle('primary', !status.enabled);
    $('#mine-copy-code').disabled = !status.accessCode;
    $('#mine-regen').disabled = !status.accessCode;
    /* A permission the operating system has not granted is the one failure that
       otherwise looks like success: capture returns black frames and input does
       nothing at all. Say so, and offer the switch. */
    const permissionDetail = status.permissions?.detail;
    const detail = permissionDetail ?? status.detail ?? (status.inputAvailable === false ? status.inputDetail : '');
    $('#mine-detail').textContent = detail ?? '';
    $('#mine-detail').hidden = !detail;
    const items = status.permissions?.items ?? [];
    const fix = $('#mine-fix');
    // Where every permission is listed with its own button, the single one is redundant.
    fix.hidden = !status.permissions?.action || items.length > 0;
    fix.onclick = () => api.openPermissionSettings(status.permissions.action);
    renderPermissions(items);
    $('#mine-protection').textContent = status.deviceId ? `Identity key: ${status.keyProtection}` : '';

    const sessions = $('#mine-sessions');
    sessions.innerHTML = '';
    sessions.hidden = !status.sessions.length;
    for (const s of status.sessions) {
      const row = document.createElement('div');
      row.className = 'session-row';
      row.innerHTML = `<span class="who"></span><span class="badge">${s.state === 'connected' ? 'Viewing' : 'Connecting'}</span>`;
      row.querySelector('.who').textContent = `${s.viewerName} (${s.viewerId})`;
      const stop = document.createElement('button');
      stop.className = 'btn ghost small';
      stop.textContent = 'Disconnect';
      stop.onclick = async () => { await api.endHostSession(s.id, 'user-disconnected'); };
      row.append(stop);
      sessions.append(row);
    }
  };

  /**
   * Each permission macOS asks for, allowed or not: what it is for, where to
   * switch it on, and a button that opens that exact pane. Checked again each
   * time HopDesk comes back to the front, so the list follows System Settings.
   */
  const screenRecordingMissingAtSomePoint = { value: false };
  function renderPermissions(items) {
    const box = $('#mine-perms');
    box.hidden = !items.length;
    box.replaceChildren();
    for (const item of items) {
      const row = document.createElement('div');
      row.className = `perm ${item.granted ? 'ok' : 'missing'}`;
      row.dataset.permission = item.id;
      const head = document.createElement('div');
      head.className = 'perm-head';
      const name = document.createElement('span');
      name.textContent = item.name;
      const state = document.createElement('span');
      state.className = 'perm-state';
      state.textContent = item.granted ? '✓ Allowed' : '✗ Not allowed';
      head.append(name, state);
      row.append(head);
      if (!item.granted) {
        if (item.id === 'screen-recording') screenRecordingMissingAtSomePoint.value = true;
        const why = document.createElement('p');
        why.textContent = item.why;
        const how = document.createElement('p');
        how.textContent = item.how;
        const open = document.createElement('button');
        open.className = 'btn small';
        open.textContent = `Open ${item.name} settings`;
        open.onclick = () => api.openPermissionSettings(item.action);
        row.append(why, how, open);
      } else if (item.id === 'screen-recording' && screenRecordingMissingAtSomePoint.value) {
        /* Switched on while HopDesk was running: macOS applies it only after a restart. */
        const note = document.createElement('p');
        note.textContent = 'Just allowed. macOS applies this after HopDesk restarts.';
        const restart = document.createElement('button');
        restart.className = 'btn small primary';
        restart.textContent = 'Reopen HopDesk';
        restart.onclick = () => api.relaunch();
        row.append(note, restart);
      }
      box.append(row);
    }
  }

  const refreshHost = async () => renderHost(await api.hostStatus());

  $('#mine-toggle').onclick = async () => {
    const status = ui.status ?? await api.hostStatus();
    try {
      if (!status.enabled) {
        renderHost(await api.setRemoteAccess({ enabled: true }));
        toast('This computer can now be connected to with its Device ID and access code.');
      } else {
        if (status.sessions.length
          && !(await confirmDialog('Turn off remote access?',
            'Someone is connected to this computer. Turning remote access off will disconnect them.', 'Turn off'))) return;
        renderHost(await api.setRemoteAccess({ enabled: false }));
        toast('Remote access is off. No one can connect to this computer.');
      }
    } catch (err) {
      toast(err.message);
    }
  };

  $('#mine-regen').onclick = async () => {
    renderHost(await api.regenerateAccessCode());
    toast('New access code. The old one no longer works.');
  };

  $('#mine-copy-id').onclick = () => copy(ui.status?.deviceId, 'Device ID copied.');
  $('#mine-copy-code').onclick = () => copy(ui.status?.accessCode, 'Access code copied.');

  const copy = async (text, message) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast(message);
    } catch {
      // Clipboard access can be refused; showing the value is better than failing silently.
      toast(`Copy this: ${text}`);
    }
  };

  api.onHostStatus?.(renderHost);

  /* ------------------------------------------------- the consent prompt */

  let consentId = null;
  api.onConsentRequest?.(request => {
    consentId = request.id;
    $('#consent-who').textContent = request.viewerName || 'A computer';
    $('#consent-id').textContent = request.viewerId;
    $('#consent-method').textContent = request.auth === 'code'
      ? 'It has the access code shown on this computer.'
      : request.auth === 'account'
        ? 'It is signed in to the same HopDesk account as this computer.'
        : 'It is using access you granted earlier.';
    const dialog = $('#dlg-consent');
    if (!dialog.open) dialog.showModal();
  });
  api.onConsentWithdrawn?.(({ id }) => {
    if (consentId !== id) return;
    consentId = null;
    if ($('#dlg-consent').open) $('#dlg-consent').close();
  });
  const answer = decision => {
    const id = consentId;
    consentId = null;
    if ($('#dlg-consent').open) $('#dlg-consent').close();
    if (id) void api.answerConsent(id, decision);
  };
  $('#consent-allow').onclick = () => answer('allow');
  $('#consent-reject').onclick = () => answer('reject');
  $('#dlg-consent').addEventListener('cancel', e => { e.preventDefault(); answer('reject'); });

  /* --------------------------------------------- the account, and its computers */

  const renderAccount = state => {
    const card = $('#mycomputers');
    card.hidden = !state.signedIn;
    $('#btn-signin').hidden = state.signedIn;
    if (!state.signedIn) return;

    const relay = $('#mc-relay');
    relay.textContent = state.relay === 'online' ? 'Connected' : state.relay === 'connecting' ? 'Connecting…' : 'Offline';
    $('#mc-detail').textContent = state.detail ?? (state.email ? `Signed in as ${state.email}` : '');

    const list = $('#mc-list');
    list.innerHTML = '';
    const others = state.computers.filter(c => !c.self);
    if (!others.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No other computers yet. Sign in to this account on another computer and turn its remote access on.';
      list.append(empty);
    }
    for (const computer of others) {
      const row = document.createElement('div');
      row.className = 'computer';
      row.dataset.deviceId = computer.deviceId;
      const dot = document.createElement('span');
      dot.className = `dot ${computer.online ? 'on' : 'off'}`;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = computer.name;
      name.title = computer.deviceId;
      const connect = document.createElement('button');
      connect.className = 'btn small primary';
      connect.textContent = 'Connect';
      connect.disabled = !computer.online;
      connect.title = computer.online ? `Connect to ${computer.name}` : 'That computer is not online';
      connect.onclick = async () => {
        connect.disabled = true;
        connect.textContent = 'Connecting…';
        try {
          await api.connectComputer(computer.deviceId);
        } catch (err) {
          showConnectError(err.message);
        } finally {
          connect.textContent = 'Connect';
          connect.disabled = !computer.online;
        }
      };
      const remove = document.createElement('button');
      remove.className = 'btn ghost small';
      remove.textContent = 'Remove';
      remove.title = 'Remove this computer from the account';
      remove.onclick = async () => {
        if (!(await confirmDialog('Remove this computer?',
          `${computer.name} will no longer be reachable through this account until it signs in again.`, 'Remove'))) return;
        try {
          renderAccount(await api.accountRemoveComputer(computer.deviceId));
        } catch (err) { toast(err.message); }
      };
      row.append(dot, name, connect, remove);
      list.append(row);
    }
  };

  api.onAccountState?.(renderAccount);
  $('#mc-refresh').onclick = async () => {
    try { renderAccount(await api.accountRefresh()); } catch (err) { toast(err.message); }
  };
  $('#mc-signout').onclick = async () => {
    if (!(await confirmDialog('Sign out of this HopDesk server?',
      'This computer will be removed from the account and can no longer be reached through the server. '
      + 'Connections with a Device ID and access code still work.', 'Sign out'))) return;
    renderAccount(await api.accountSignOut());
  };

  $('#btn-signin').onclick = () => {
    $('#si-error').hidden = true;
    const dialog = $('#dlg-signin');
    if (!dialog.open) dialog.showModal();
    $('#si-server').focus();
  };
  // The token is only meaningful when creating an account.
  $('#si-create').onchange = () => { $('#si-token-field').hidden = !$('#si-create').checked; };
  $('#si-cancel').onclick = () => $('#dlg-signin').close();
  $('#si-submit').onclick = async () => {
    const button = $('#si-submit');
    button.disabled = true;
    button.textContent = 'Signing in…';
    try {
      const state = await api.accountSignIn({
        serverUrl: $('#si-server').value,
        email: $('#si-email').value,
        password: $('#si-password').value,
        create: $('#si-create').checked,
        token: $('#si-token').value,
      });
      $('#si-password').value = '';
      $('#si-token').value = '';
      $('#dlg-signin').close();
      renderAccount(state);
      toast('Signed in. This computer now appears under My computers.');
    } catch (err) {
      const box = $('#si-error');
      box.textContent = err.message;
      box.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  };

  /* ------------------------------------------- connecting to a computer */

  $('#btn-connect-device').onclick = async () => {
    const deviceId = $('#cd-id').value.trim();
    const code = $('#cd-code').value.trim();
    const address = $('#cd-address').value.trim();
    if (!deviceId || !code) { toast('Enter the Device ID and access code shown on the other computer.'); return; }
    setConnectBusy(true);
    try {
      await api.connectDevice({ deviceId, code, ...(address ? { address } : {}) });
      $('#cd-code').value = '';
    } catch (err) {
      setConnectBusy(false);
      showConnectError(err.message);
    }
  };

  const setConnectBusy = busy => {
    $('#btn-connect-device').disabled = busy;
    $('#btn-connect-device').textContent = busy ? 'Connecting…' : 'Connect';
  };

  const showConnectError = message => {
    const box = $('#cd-error');
    box.textContent = friendlyError(message);
    box.hidden = false;
    const detail = $('#cd-error-detail');
    detail.textContent = message;
    detail.hidden = false;
  };

  api.onDeviceSession?.(status => {
    ui.session = status;
    if (status.state === 'connected') {
      setConnectBusy(false);
      $('#cd-error').hidden = true;
      $('#cd-error-detail').hidden = true;
      showSession(status);
    } else if (status.state === 'ended') {
      setConnectBusy(false);
      hideSession();
      if (status.error) showConnectError(status.error.message);
    } else if (status.state === 'reconnecting') {
      $('#hd-status').textContent = 'Reconnecting…';
    } else {
      setConnectBusy(true);
      if (status.state === 'waiting-for-consent') {
        $('#btn-connect-device').textContent = 'Waiting for the other computer…';
      }
    }
  });

  /* --------------------------------------------------- the session view */

  function showSession(status) {
    document.body.classList.add('hd-session');
    $('#hd-view').hidden = false;
    $('#hd-name').textContent = status.hostName || status.deviceId;
    $('#hd-status').textContent = 'Connected';
    // Worth saying plainly: a relayed session goes through the server.
    const how = $('#hd-how');
    how.textContent = status.connection === 'relay' ? 'Through the relay'
      : status.connection === 'local' ? 'On this network'
        : status.connection === 'direct' ? 'Direct' : '';
    how.hidden = !how.textContent;
  }

  /**
   * What the other computer says it cannot do — be controlled, have its screen
   * recorded — shown over the session so a mouse that does nothing is explained.
   * Plain text only, bounded, from a peer that has already authenticated.
   */
  function showNotices(list, sessionId) {
    const notices = Array.isArray(list)
      ? list.filter(n => typeof n === 'string' && n.trim()).slice(0, 4).map(n => n.slice(0, 400))
      : [];
    const box = $('#hd-notice');
    box.replaceChildren(...notices.map(text => { const p = document.createElement('p'); p.textContent = text; return p; }));
    box.hidden = !notices.length;
    api.viewerLog?.(`session ${sessionId}: the other computer reports ${notices.length ? notices.length + ' problem(s)' : 'no problems'}`);
  }

  function hideSession() {
    $('#hd-notice').hidden = true;
    document.body.classList.remove('hd-session');
    $('#hd-view').hidden = true;
    $('#hd-status').textContent = 'Not connected';
    if (ui.video) ui.video.srcObject = null;
  }

  $('#hd-disconnect').onclick = () => { void api.disconnectDevice(); };
  $('#hd-fullscreen').onclick = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void $('#hd-view').requestFullscreen().catch(() => {});
  };
  $('#hd-send-clipboard').onclick = async () => {
    const text = await api.viewerClipboardRead();
    if (!text) { toast('This computer\'s clipboard is empty.'); return; }
    sendClipboard(text);
    toast('Clipboard sent to the other computer.');
  };

  const sendClipboard = text => {
    if (!ui.peer || text === ui.lastClipboardSent) return;
    ui.lastClipboardSent = text;
    const dropped = ui.peer.send('clipboard', { type: 'clipboard', seq: ++ui.clipboardSeq, text });
    if (dropped) api.viewerLog?.(`clipboard not sent: ${dropped}`);
  };

  /* The peer connection for a viewer session, created when the main process
     asks for an offer. Video arrives here; input goes out over a data channel. */
  servePeerCalls({
    bridge: api,
    create: sessionId => {
      const video = $('#hd-video');
      ui.video = video;
      const peer = createPeerSession({
        role: 'viewer',
        sessionId,
        bridge: api,
        onTrack: stream => {
          video.srcObject = stream;
          void video.play().catch(() => {});
        },
        onChannelMessage: (label, message) => {
          if (label === 'display' && message?.type === 'host-notice') { showNotices(message.notices, sessionId); return; }
          if (label !== 'clipboard' || typeof message?.text !== 'string') return;
          // The other computer's clipboard, put on this one's.
          ui.lastClipboardSent = message.text;
          void api.viewerClipboardWrite(message.text);
        },
        log: text => api.viewerLog?.(`session ${sessionId}: ${text}`),
      });
      /* A new session replaces the last one. Input reads ui.peer at the moment
         it sends, so it always reaches the session on screen now — never a
         closed one from before (which is how every session after the first in
         an app run used to get video but no mouse or keyboard). */
      ui.stats?.flush('replaced by a new session');
      ui.peer = peer;
      ui.stats = inputStats(sessionId);
      const close = peer.close;
      peer.close = () => {
        if (ui.peer === peer) {
          ui.stats?.flush('session closed');
          ui.peer = null;
          ui.stats = null;
        }
        close();
      };
      wireInput(video);
      return peer;
    },
  });

  /**
   * What happened to this session's input: how much was sent, and how much was
   * dropped and why. Counts only — never which keys, since keystrokes can be
   * passwords. Logged when the first message goes out, at most every five
   * seconds while it changes, and when the session ends.
   */
  function inputStats(sessionId) {
    const sent = {};
    const dropped = {};
    // The first summary waits a full interval; the first send has its own line.
    let lastLog = Date.now();
    const total = counts => Object.values(counts).reduce((a, b) => a + b, 0);
    const describe = counts => Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    const report = why => {
      api.viewerLog?.(`session ${sessionId} input${why ? ` (${why})` : ''}: sent ${total(sent)} [${describe(sent)}]; `
        + `dropped ${total(dropped)} [${describe(dropped)}]`);
      lastLog = Date.now();
    };
    return {
      record(type, reason) {
        if (reason) {
          if (!dropped[reason]) api.viewerLog?.(`session ${sessionId}: input not sent: ${reason}`);
          dropped[reason] = (dropped[reason] ?? 0) + 1;
        } else {
          if (!total(sent)) api.viewerLog?.(`session ${sessionId}: first input sent`);
          sent[type] = (sent[type] ?? 0) + 1;
        }
        if (Date.now() - lastLog >= 5000) report('');
      },
      // Always, so every session's log ends with what became of its input.
      flush(why) { report(why); },
    };
  }

  /** Sends one input message to the session currently on screen, and counts it. */
  function sendInput(message) {
    const reason = ui.peer ? ui.peer.send('input', message) : 'no session';
    if (ui.stats) ui.stats.record(message.type, reason);
    else if (reason) api.viewerLog?.(`input not sent: ${reason}`);
  }

  /** Mouse, keyboard and scrolling from the video element to the host. */
  function wireInput(video) {
    if (video.dataset.wired === 'yes') return;
    video.dataset.wired = 'yes';

    const position = e => {
      const r = video.getBoundingClientRect();
      // Normalised, so the host's resolution can change without misplacing clicks.
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
      const y = Math.min(1, Math.max(0, (e.clientY - r.top) / Math.max(1, r.height)));
      return { x, y };
    };
    const pointer = (e, buttons) => {
      const { x, y } = position(e);
      sendInput({ type: 'pointer', x, y, buttons: buttons ?? e.buttons });
    };

    video.addEventListener('mousemove', e => pointer(e));
    video.addEventListener('mousedown', e => { e.preventDefault(); video.focus(); pointer(e); });
    video.addEventListener('mouseup', e => { e.preventDefault(); pointer(e); });
    video.addEventListener('contextmenu', e => e.preventDefault());
    video.addEventListener('mouseleave', e => pointer(e, 0));
    video.addEventListener('wheel', e => {
      e.preventDefault();
      // Pixels to wheel clicks, the unit the host injects.
      sendInput({ type: 'wheel', dx: e.deltaX / 100, dy: e.deltaY / 100 });
    }, { passive: false });

    const send = (e, down) => {
      // HopDesk's own shortcut for leaving a fullscreen session stays local.
      if (down && e.ctrlKey && e.altKey && e.key === 'Enter') { $('#hd-fullscreen').click(); return; }
      e.preventDefault();
      sendInput({ type: 'key', code: e.code, key: e.key.length <= 8 ? e.key : '', down });
    };
    video.addEventListener('keydown', e => send(e, true));
    video.addEventListener('keyup', e => send(e, false));
    // Keys held when focus leaves would stay down on the other computer.
    video.addEventListener('blur', () => { if (ui.peer) sendInput({ type: 'release-all' }); });
    video.addEventListener('focus', async () => {
      const text = await api.viewerClipboardRead();
      if (text) sendClipboard(text);
    });
  }

  void refreshHost();
  void api.accountState?.().then(renderAccount).catch(() => {});
  return { refreshHost };
}

const formatCode = code => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

/** Handshake failures in plain words; the technical text stays available. */
function friendlyError(message) {
  const text = String(message);
  if (/bad-auth|access code is not correct/i.test(text)) return 'That access code is not correct. Check the code shown on the other computer — it changes.';
  if (/rate-limited/i.test(text)) return 'Too many attempts were refused. Wait a moment, then try the new code shown on the other computer.';
  if (/not-found|No computer with the Device ID/i.test(text)) return 'No computer with that Device ID answered on this network. Check the ID, or that HopDesk is open and remote access is on there.';
  if (/unknown-device/i.test(text)) return 'That computer answered but has a different Device ID. Check the ID you entered.';
  if (/identity-mismatch/i.test(text)) return 'This computer\'s identity key is not the one seen before. It could be a different machine — do not continue unless you know why it changed.';
  if (/rejected|user-rejected/i.test(text)) return 'The person at the other computer did not allow the connection.';
  if (/timeout/i.test(text)) return 'The other computer did not answer in time.';
  if (/code-disabled/i.test(text)) return 'That computer is not accepting connections by access code right now.';
  if (/unattended-disabled/i.test(text)) return 'That computer does not allow unattended access.';
  if (/ECONNREFUSED/i.test(text)) return 'That computer refused the connection. HopDesk may not be running there.';
  return text;
}
