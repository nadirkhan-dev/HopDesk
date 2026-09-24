/**
 * The HopDesk half of the interface: this computer's own identity, connecting
 * to another computer by Device ID and access code, the Allow/Reject prompt,
 * and the live session view.
 *
 * Kept apart from app.js, which is the client for standard protocols (VNC and
 * RDP). The two share the window but nothing else.
 */
import { createPeerSession, servePeerCalls } from './peer.js';
import { pointToRemote, nearestRemotePoint, pictureRect, MODES } from './geometry.js';
import {
  mergeComputers, defaultMethod, connectability, METHOD_LABELS, METHOD_HINTS,
} from './computers.js';
import { osIcon } from './os-icons.js';

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
    /** How the other computer's screen is shown: fit, fill or actual (1:1). */
    scale: 'fit',
    clipboardSeq: 0,
    lastClipboardSent: '',
    /* Why turning remote access on last failed. A toast says it once and
       vanishes; this one stays, because "it just says Off" is otherwise all
       anyone can report. */
    hostError: null,
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
    const detail = ui.hostError
      ?? permissionDetail ?? status.detail ?? (status.inputAvailable === false ? status.inputDetail : '');
    $('#mine-detail').textContent = detail ?? '';
    $('#mine-detail').hidden = !detail;
    renderScreens(status.screens ?? [], status.sharedScreen);
    renderTrusted(status.trusted ?? []);
    renderWatching(status.sessions ?? []);
    const items = status.permissions?.items ?? [];
    const fix = $('#mine-fix');
    // Where every permission is listed with its own button, the single one is redundant.
    fix.hidden = !status.permissions?.action || items.length > 0;
    fix.onclick = () => api.openPermissionSettings(status.permissions.action);
    // The step-by-step screen, reachable again whenever something is missing.
    const setupButton = $('#mine-setup');
    setupButton.hidden = !items.some(i => !i.granted);
    setupButton.onclick = () => { void openSetup(); };
    renderPermissions(items);
    const print = $('#mine-fingerprint');
    print.hidden = !status.keyFingerprint;
    print.textContent = status.keyFingerprint ? `Key fingerprint: ${status.keyFingerprint}` : '';
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
   * Which screen is shared, on a computer with more than one.
   *
   * Chromium captures one monitor, not the desktop as a whole, so on a laptop
   * with an external monitor the windows on the other one are not dimmed or
   * cropped - they are absent. Whoever is sharing chooses, and the choice
   * reaches anyone already watching without reconnecting them.
   */
  function renderScreens(screens, shared) {
    const field = $('#mine-screen-field');
    field.hidden = screens.length < 2;
    if (field.hidden) return;
    const select = $('#mine-screen');
    const wanted = screens.map(s => `${s.id}:${s.label}`).join('|');
    if (select.dataset.screens !== wanted) {
      select.dataset.screens = wanted;
      select.replaceChildren();
      for (const item of screens) {
        const option = document.createElement('option');
        option.value = String(item.id);
        option.textContent = item.label;
        select.append(option);
      }
    }
    if (document.activeElement !== select) select.value = String(shared ?? '');
  }

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
        /* A switch turned on in Settings may not reach this running copy until
           it restarts, so the way to do that is always beside it. */
        const restart = document.createElement('button');
        restart.className = 'btn small';
        restart.textContent = 'Reopen HopDesk';
        restart.onclick = () => api.relaunch();
        row.append(why, how, open, restart);
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

  /**
   * While anyone is connected, this stays on screen. Someone who walks up to
   * this computer should be able to see that its screen is being watched
   * without opening anything.
   */
  function renderWatching(sessions) {
    const bar = $('#watching');
    bar.hidden = !sessions.length;
    if (!sessions.length) return;
    bar.replaceChildren();
    const dot = document.createElement('span');
    dot.className = 'dot';
    const text = document.createElement('span');
    const names = sessions.map(s => s.viewerName || s.viewerId).join(', ');
    text.textContent = sessions.length === 1
      ? `${names} is connected to this computer and can see this screen.`
      : `${sessions.length} computers are connected to this one: ${names}.`;
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const stop = document.createElement('button');
    stop.className = 'btn ghost small';
    stop.textContent = sessions.length === 1 ? 'Disconnect' : 'Disconnect all';
    stop.onclick = async () => {
      for (const session of sessions) await api.endHostSession(session.id, 'user-disconnected');
      toast(sessions.length === 1 ? 'Disconnected.' : 'All computers disconnected.');
    };
    bar.append(dot, text, spacer, stop);
  }

  /** Opening at login, so this computer is reachable after a restart. */
  async function renderLoginItem() {
    const state = await api.loginItem?.();
    const wrap = $('#mine-login');
    if (!state?.supported) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const check = $('#mine-login-check');
    check.checked = state.openAtLogin;
    check.onchange = async () => {
      const next = await api.setLoginItem(check.checked);
      check.checked = next.openAtLogin;
      toast(next.openAtLogin
        ? 'HopDesk will open when you log in.'
        : 'HopDesk will no longer open at login.');
    };
  }

  /**
   * Computers allowed in without asking, with a way to stop. Removing one also
   * disconnects it if it is connected right now.
   */
  function renderTrusted(list) {
    const box = $('#mine-trusted');
    const rows = $('#mine-trusted-list');
    box.hidden = !list.length;
    rows.replaceChildren();
    for (const device of list) {
      const row = document.createElement('div');
      row.className = 'saved-row';
      row.dataset.deviceId = device.deviceId;
      const who = document.createElement('div');
      who.className = 'who';
      const name = document.createElement('b');
      name.textContent = device.name || device.deviceId;
      const detail = document.createElement('span');
      const used = device.lastUsed ? `last connected ${whenWords(device.lastUsed)}` : 'not connected yet';
      detail.textContent = `${device.deviceId} · ${used} · expires ${whenWords(device.expiresAt)}`;
      who.append(name, detail);
      const stop = document.createElement('button');
      stop.className = 'btn ghost small';
      stop.textContent = 'Stop trusting';
      stop.onclick = async () => {
        if (!(await confirmDialog('Stop trusting this computer?',
          `${device.name || device.deviceId} will need an access code and someone here to allow it. If it is connected now, it will be disconnected.`,
          'Stop trusting'))) return;
        await api.trustedRemove(device.deviceId);
        toast('That computer is no longer trusted.');
        await refreshHost();
      };
      row.append(who, stop);
      rows.append(row);
    }
  }

  /** "in 87 days", "3 days ago" — plain words instead of a timestamp. */
  function whenWords(at) {
    if (!at) return 'never';
    const days = Math.round((at - Date.now()) / 86400000);
    if (days > 1) return `in ${days} days`;
    if (days === 1) return 'tomorrow';
    if (days === 0) return 'today';
    if (days === -1) return 'yesterday';
    return `${Math.abs(days)} days ago`;
  }

  /** Saved computers: the ones that paired with this one. One click connects. */
  /* --------------------------------------------------------- computers */

  /**
   * Every computer this one can reach, in one list.
   *
   * Two sources feed it - the account's devices and the ones connected to
   * before - and merging them is in renderer/computers.js, away from the DOM,
   * because "which of these two records is the same machine" is a rule worth
   * testing rather than eyeballing.
   */
  let accountState = { signedIn: false, computers: [], relay: 'offline' };
  /** The way in last used for each computer, from settings. */
  let choices = {};

  async function renderComputers() {
    const known = (await api.knownDevices?.()) ?? [];
    choices = (await api.connectChoices?.()) ?? choices;
    const rows = mergeComputers({
      account: accountState.computers ?? [],
      known,
      signedIn: accountState.signedIn === true,
    });
    const card = $('#computers');
    card.hidden = !rows.length && !accountState.signedIn;
    const list = $('#computers-list');
    list.replaceChildren();

    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = accountState.signedIn
        ? 'No other computers on this account yet. Sign in to HopDesk on another computer and it appears here.'
        : 'No computers yet. Connect to one with its Device ID and access code, and it stays in this list.';
      list.append(empty);
    }

    for (const row of rows) list.append(computerRow(row));
    // Said once, under the list: how to turn a prompt into one click.
    $('#computers-hint').hidden = !rows.some(r => !r.paired);
  }

  /** One computer: what it is, whether it can be reached, and the ways in. */
  function computerRow(row) {
    const el = document.createElement('div');
    el.className = 'computer-row';
    el.dataset.deviceId = row.deviceId;
    el.dataset.status = row.status;

    el.insertAdjacentHTML('afterbegin', osIcon(row.os ?? 'other'));
    const who = document.createElement('div');
    who.className = 'who';
    const name = document.createElement('b');
    name.textContent = row.name;
    const sub = document.createElement('span');
    sub.className = 'sub';
    /* Two facts, in the order they are wanted: can I reach it, and which one
       is it. A computer not on the account has nothing authoritative to say
       about being reachable, so it says when it was last connected to
       instead - which is what someone would go on anyway. */
    sub.textContent = row.waiting
      ? `Waiting to be approved · ${row.deviceId}`
      : [
        row.status === 'online' ? 'Online'
          : row.lastSeen ? lastSeenText(row.lastSeen)
            : 'Not connected yet',
        row.deviceId,
      ].join(' · ');
    who.append(name, sub);

    const dot = document.createElement('span');
    dot.className = `dot ${row.status === 'online' ? 'on' : 'off'}`;

    el.append(dot, who, row.waiting ? approveControl(row) : connectControl(row), removeButton(row));
    return el;
  }

  /**
   * A computer waiting to be let onto the account.
   *
   * Email and password are enough to add a computer; they are not enough to
   * make it one of yours. So a new one waits here until somebody at a computer
   * that is already approved says yes - and is shown its fingerprint first,
   * because that is the only thing that distinguishes the machine you just
   * set up from one somebody else added.
   */
  function approveControl(row) {
    const wrap = document.createElement('div');
    wrap.className = 'connect-control';
    const approve = document.createElement('button');
    approve.className = 'btn small primary connect-go';
    approve.textContent = 'Approve';
    approve.title = 'Let this computer onto your account';
    approve.onclick = async () => {
      const print = row.publicKey ? keyFingerprint(row.publicKey) : 'unknown';
      if (!(await confirmDialog('Approve this computer?',
        `${row.name} will be able to connect to the computers on your account.\n\n`
        + `Its fingerprint is ${print}. Approve it only if that is a computer you set up yourself — `
        + 'check the fingerprint on it, under "This computer".', 'Approve'))) return;
      approve.disabled = true;
      approve.textContent = 'Approving…';
      try {
        accountState = await api.accountApproveComputer(row.deviceId);
        await renderComputers();
        toast(`${row.name} can now connect.`);
      } catch (err) {
        toast(friendlyError(err.message));
        approve.disabled = false;
        approve.textContent = 'Approve';
      }
    };
    wrap.append(approve);
    return wrap;
  }

  /**
   * The Connect button, and the other ways in behind it.
   *
   * The choice is remembered per computer, because someone who has to ask
   * permission every time for one machine and never for another should not
   * have to re-pick which of those it is.
   */
  function connectControl(row) {
    const wrap = document.createElement('div');
    wrap.className = 'connect-control';
    let method = defaultMethod(row, rememberedMethod(row.deviceId));

    const go = document.createElement('button');
    go.className = 'btn small primary connect-go';
    const more = document.createElement('button');
    more.className = 'btn small connect-more';
    more.textContent = '▾';
    more.title = 'Other ways to connect';
    more.hidden = row.methods.length < 2;
    const menu = document.createElement('div');
    menu.className = 'connect-menu';
    menu.hidden = true;

    const paint = () => {
      const can = connectability(row, method);
      go.textContent = METHOD_LABELS[method];
      go.disabled = !can.ok;
      go.title = can.ok ? METHOD_HINTS[method] : can.why;
    };

    go.onclick = async () => {
      const can = connectability(row, method);
      if (!can.ok) { toast(can.why); return; }
      rememberMethod(row.deviceId, method);
      go.disabled = true;
      go.textContent = 'Connecting…';
      try {
        await connectBy(row, method);
      } catch (err) {
        toast(friendlyError(err.message));
      } finally {
        go.disabled = false;
        paint();
      }
    };

    more.onclick = () => { menu.hidden = !menu.hidden; };
    for (const option of row.methods) {
      const item = document.createElement('button');
      item.className = 'btn small connect-option';
      item.dataset.method = option;
      item.innerHTML = '';
      const label = document.createElement('b');
      label.textContent = METHOD_LABELS[option];
      const hint = document.createElement('span');
      hint.className = 'sub';
      hint.textContent = METHOD_HINTS[option];
      item.append(label, hint);
      item.onclick = () => {
        method = option;
        rememberMethod(row.deviceId, option);
        menu.hidden = true;
        paint();
      };
      menu.append(item);
    }

    paint();
    wrap.append(go, more, menu);
    return wrap;
  }

  /** Does what the chosen way in means. */
  async function connectBy(row, method) {
    if (method === 'trusted') return api.connectSaved(row.deviceId);
    if (method === 'ask') return api.connectComputer(row.deviceId);
    // The code is the one thing HopDesk cannot supply: fill in the rest.
    $('#cd-id').value = row.deviceId;
    $('#cd-address').value = row.address ?? '';
    $('#cd-code').value = '';
    $('#cd-code').focus();
    toast(`Enter the access code shown on ${row.name}.`);
    return undefined;
  }

  function removeButton(row) {
    const remove = document.createElement('button');
    remove.className = 'btn ghost small';
    remove.textContent = 'Remove';
    remove.onclick = async () => {
      const fromAccount = row.onAccount;
      const question = fromAccount
        ? `${row.name} will no longer be reachable through this account until it signs in again.`
        : `${row.name} will disappear from this list. It can still be connected to with its Device ID and access code.`;
      if (!(await confirmDialog('Remove this computer?', question, 'Remove'))) return;
      try {
        if (fromAccount) accountState = await api.accountRemoveComputer(row.deviceId);
        else await api.forgetDevice(row.deviceId);
        await renderComputers();
      } catch (err) { toast(friendlyError(err.message)); }
    };
    return remove;
  }

  /* Per computer, so one machine that always asks and another that never does
     are each remembered as they are. In settings beside everything else about
     this installation, not in the window's own storage, which belongs to
     Chromium's profile and does not outlive it. */
  const rememberedMethod = deviceId => choices[deviceId];
  const rememberMethod = (deviceId, method) => {
    if (choices[deviceId] === method) return;
    choices[deviceId] = method;
    void api.rememberConnectMethod?.(deviceId, method);
  };

  /* ------------------------------------------------- first-launch setup */

  /**
   * The two permissions macOS will not let an app grant itself, one step at a
   * time. Each step asks macOS for its own dialog first; macOS only shows that
   * once per app, so when it declines to, the step falls back to opening the
   * right Settings page. Steps tick themselves as the permissions arrive.
   */
  const setup = { open: false, timer: null, screenWasMissing: false };

  const setupStepFor = id => $(id === 'screen-recording' ? '#setup-step-1' : '#setup-step-2');

  function renderSetup(items) {
    if (!setup.open) return;
    let allGranted = items.length > 0;
    for (const item of items) {
      const step = setupStepFor(item.id);
      if (!step) continue;
      step.querySelector('.setup-name').textContent = item.name;
      step.querySelector('.setup-state').textContent = item.granted ? '✓ Allowed' : 'Not allowed yet';
      step.classList.toggle('done', item.granted);
      step.querySelector('.setup-why').textContent = item.why;
      const how = step.querySelector('.setup-how');
      const ask = step.querySelector('.setup-ask');
      const settings = step.querySelector('.setup-settings');
      const restart = step.querySelector('.setup-restart');
      const promptGone = step.dataset.promptGone === 'yes';
      if (item.granted) {
        how.textContent = '';
        ask.hidden = true;
        settings.hidden = true;
        /* Screen Recording only takes effect after a restart, so if it was
           missing when this opened, offer one. */
        if (restart) restart.hidden = !(item.id === 'screen-recording' && setup.screenWasMissing);
      } else {
        allGranted = false;
        how.textContent = promptGone ? item.how : '';
        ask.hidden = promptGone;
        settings.hidden = !promptGone;
        /* A switch turned on in Settings may not reach this running copy:
           Screen Recording never does before a restart, and Accessibility
           sometimes does not either. So once Settings has been opened, offer
           the restart even though the permission still reads as missing. */
        if (restart) restart.hidden = step.dataset.settingsOpened !== 'yes';
      }
    }
    /* Once Settings has been opened for something still missing, it may be a
       stale switch from an older build, which only starting over fixes. */
    $('#setup-stuck').hidden = allGranted || !items.some(i => !i.granted
      && setupStepFor(i.id)?.dataset.settingsOpened === 'yes');
    $('#setup-done').hidden = !allGranted;
    $('#setup-done-text').hidden = !allGranted;
    $('#setup-later').textContent = allGranted ? 'Close' : 'Do this later';
  }

  async function openSetup() {
    const status = await api.hostStatus();
    const items = status.permissions?.items ?? [];
    if (!items.length) return;                       // nothing to ask for on this platform
    setup.open = true;
    setup.screenWasMissing = !items.find(i => i.id === 'screen-recording')?.granted;
    for (const id of ['screen-recording', 'accessibility']) {
      delete setupStepFor(id).dataset.promptGone;
      delete setupStepFor(id).dataset.settingsOpened;
    }
    renderSetup(items);
    const dialog = $('#dlg-setup');
    if (!dialog.open) dialog.showModal();
    // Ticks each step as the permission arrives, without anyone pressing anything.
    clearInterval(setup.timer);
    setup.timer = setInterval(async () => {
      const report = await api.checkPermissions();
      renderSetup(report?.items ?? []);
    }, 1500);
  }

  function closeSetup() {
    setup.open = false;
    clearInterval(setup.timer);
    setup.timer = null;
    if ($('#dlg-setup').open) $('#dlg-setup').close();
    /* The other computer's key is not the one pinned for it: both fingerprints,
     and a decision. */
  api.onKeyChangeRequest?.(request => {
    $('#keychange-who').textContent = request.hostName || request.deviceId;
    $('#keychange-old').textContent = request.oldFingerprint;
    $('#keychange-new').textContent = request.newFingerprint;
    $('#keychange-why').textContent = keyChangeWarning(request);
    const dialog = $('#dlg-keychange');
    const answer = accepted => {
      if (dialog.open) dialog.close();
      void api.answerKeyChange(request.id, accepted);
    };
    $('#keychange-refuse').onclick = () => answer(false);
    $('#keychange-accept').onclick = () => answer(true);
    dialog.addEventListener('cancel', e => { e.preventDefault(); answer(false); }, { once: true });
    if (!dialog.open) dialog.showModal();
  });

  void refreshHost();
  }

  for (const id of ['screen-recording', 'accessibility']) {
    const step = setupStepFor(id);
    step.querySelector('.setup-ask').onclick = async () => {
      const result = await api.askPermission(id);
      /* macOS asks once per app, and whether it showed anything cannot be
         told from here: the call returns before the person answers either
         way. So after one ask the rest is done in Settings; its dialog, if it
         appeared, stays on screen beside this one. */
      if (!result.granted) step.dataset.promptGone = 'yes';
      renderSetup(result.report?.items ?? []);
    };
    step.querySelector('.setup-settings').onclick = async () => {
      step.dataset.settingsOpened = 'yes';
      await api.openPermissionSettings(id === 'screen-recording' ? 'open-screen-recording' : 'open-accessibility');
      renderSetup((await api.checkPermissions())?.items ?? []);
    };
    const restart = step.querySelector('.setup-restart');
    if (restart) restart.onclick = () => api.relaunch();
  }
  $('#setup-reset').onclick = async () => {
    const result = await api.resetPermissions();
    // On success HopDesk restarts; only a failure comes back here.
    const error = $('#setup-stuck-error');
    error.hidden = result?.ok !== false;
    error.textContent = 'Could not start over. In System Settings, select HopDesk in both lists, '
      + 'remove it with the − button, then reopen HopDesk.';
  };
  $('#setup-later').onclick = () => closeSetup();
  $('#setup-done').onclick = () => closeSetup();
  $('#dlg-setup').addEventListener('cancel', e => { e.preventDefault(); closeSetup(); });

  const refreshHost = async () => renderHost(await api.hostStatus());

  $('#mine-toggle').onclick = async () => {
    const status = ui.status ?? await api.hostStatus();
    try {
      if (!status.enabled) {
        const next = await api.setRemoteAccess({ enabled: true });
        ui.hostError = null;
        renderHost(next);
        toast('This computer can now be connected to with its Device ID and access code.');
      } else {
        if (status.sessions.length
          && !(await confirmDialog('Turn off remote access?',
            'Someone is connected to this computer. Turning remote access off will disconnect them.', 'Turn off'))) return;
        ui.hostError = null;
        renderHost(await api.setRemoteAccess({ enabled: false }));
        toast('Remote access is off. No one can connect to this computer.');
      }
    } catch (err) {
      ui.hostError = `Could not turn remote access on: ${friendlyError(err.message)}`;
      toast(friendlyError(err.message));
      renderHost(ui.status);
    }
  };

  $('#mine-screen').onchange = async event => {
    const screen = Number(event.target.value);
    try {
      renderHost(await api.setRemoteAccess({ screen: Number.isFinite(screen) ? screen : null }));
      toast('Sharing that screen now.');
    } catch (err) {
      toast(friendlyError(err.message));
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
    const trust = $('#consent-trust');
    trust.checked = false;
    // Only offered for a typed code: an account connection is already vouched for.
    const offerTrust = request.auth === 'code';
    $('#consent-trust-wrap').hidden = !offerTrust;
    $('#consent-trust-hint').hidden = !offerTrust;
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
  $('#consent-allow').onclick = () => answer($('#consent-trust').checked ? 'allow-and-trust' : 'allow');
  $('#consent-reject').onclick = () => answer('reject');
  $('#dlg-consent').addEventListener('cancel', e => { e.preventDefault(); answer('reject'); });

  /* --------------------------------------------- the account, and its computers */

  const renderAccount = state => {
    accountState = state ?? accountState;
    $('#btn-signin').hidden = state.signedIn;
    $('#account-actions').hidden = !state.signedIn;
    const relay = $('#mc-relay');
    relay.hidden = !state.signedIn;
    relay.textContent = state.relay === 'online' ? 'Connected' : state.relay === 'connecting' ? 'Connecting…' : 'Offline';
    $('#mc-detail').textContent = state.signedIn
      ? (state.detail ?? (state.email ? `Signed in as ${state.email}` : '')) : '';
    void renderComputers();
  };

  api.onAccountState?.(renderAccount);
  $('#mc-refresh').onclick = async () => {
    try { renderAccount(await api.accountRefresh()); } catch (err) { toast(friendlyError(err.message)); }
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
      $('#cd-id').value = '';
      /* The list is how this computer is reached next time, so it has to
         appear now rather than on the next launch. */
      void renderComputers();
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
    const clean = cleanMessage(message);
    const friendly = friendlyError(clean);
    $('#cd-error').textContent = friendly;
    $('#cd-error').hidden = false;
    /* The raw text only when it says something the sentence above does not.
       Shown otherwise, it reads as an error about an error. */
    const detail = $('#cd-error-detail');
    const worthShowing = friendly === clean && clean.length > 0;
    detail.textContent = worthShowing ? clean : '';
    detail.hidden = !worthShowing;
  };

  api.onDeviceSession?.(status => {
    ui.session = status;
    if (status.state === 'connected') {
      setConnectBusy(false);
      void renderComputers();
      $('#cd-error').hidden = true;
      $('#cd-error-detail').hidden = true;
      showSession(status);
    } else if (status.state === 'ended') {
      setConnectBusy(false);
      hideSession();
      // A connection may have just paired this computer with another.
      void renderComputers();
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
    applyScale();
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
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    hideRemoteCursor();
    $('#hd-notice').hidden = true;
    document.body.classList.remove('hd-session');
    $('#hd-view').hidden = true;
    $('#hd-status').textContent = 'Not connected';
    if (ui.video) ui.video.srcObject = null;
  }

  $('#hd-disconnect').onclick = () => { void api.disconnectDevice(); };

  /* ---------------------------------------- full screen and how it is shown */

  /**
   * Real full screen, with every key going to the other computer.
   *
   * Keyboard lock is what stops this computer from swallowing Cmd, Alt+Tab and
   * the rest; the browser only grants it in full screen, and holding Escape
   * still leaves, which is why Ctrl+Alt+Enter exists as a way out that no
   * remote application wants.
   */
  async function toggleFullscreen() {
    const view = $('#hd-view');
    if (document.fullscreenElement) {
      try { navigator.keyboard?.unlock?.(); } catch { /* not supported here */ }
      await document.exitFullscreen().catch(() => {});
      return;
    }
    try {
      await view.requestFullscreen();
    } catch (err) {
      toast(`This computer would not let HopDesk go full screen: ${err.message}`);
      return;
    }
    try {
      // Named keys, because lock() with no argument takes the lot and browsers
      // are stricter about that; these are the ones a desktop would steal.
      await navigator.keyboard?.lock?.(['Escape', 'Tab', 'MetaLeft', 'MetaRight',
        'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'F11']);
    } catch {
      toast('Some keys, like Cmd and Alt+Tab, will stay on this computer.');
    }
    ui.video?.focus();
  }

  $('#hd-fullscreen').onclick = () => { void toggleFullscreen(); };

  document.addEventListener('fullscreenchange', () => {
    const immersive = Boolean(document.fullscreenElement);
    $('#hd-view').classList.toggle('immersive', immersive);
    $('#hd-fullscreen').textContent = immersive ? 'Leave full screen' : 'Fullscreen';
    if (!immersive) { try { navigator.keyboard?.unlock?.(); } catch { /* fine */ } }
    peekToolbar(immersive);          // shown briefly, then out of the way
    applyScale();
    ui.video?.focus();
  });

  /* In full screen the toolbar hides; touching the top edge slides it back. */
  let peekTimer = null;
  function peekToolbar(show) {
    const view = $('#hd-view');
    clearTimeout(peekTimer);
    view.classList.toggle('peek', show);
    if (show && document.fullscreenElement) {
      peekTimer = setTimeout(() => view.classList.remove('peek'), 2500);
    }
  }
  $('#hd-view').addEventListener('mousemove', e => {
    if (!document.fullscreenElement) return;
    const nearTop = e.clientY <= 4;
    const overBar = e.target.closest?.('.hd-bar');
    if (nearTop || overBar) peekToolbar(true);
    else if (!overBar && e.clientY > 60) $('#hd-view').classList.remove('peek');
  });

  /** Fit, Fill or 1:1 — the same words the pointer mapping uses. */
  function applyScale() {
    const video = ui.video;
    if (!video) return;
    for (const mode of MODES) video.classList.toggle(mode, mode === ui.scale);
    $('#hd-scale').value = ui.scale;
  }
  $('#hd-scale').onchange = () => {
    ui.scale = MODES.includes($('#hd-scale').value) ? $('#hd-scale').value : 'fit';
    applyScale();
    ui.video?.focus();
  };

  /* The other computer's pointer, drawn here. A Mac does not put its cursor in
     the video, so without this the mouse looks dead however well it works. */
  function showRemoteCursor(at) {
    const video = ui.video;
    const cursor = $('#hd-cursor');
    if (!video || !cursor) return;
    if (!video.videoWidth || !video.videoHeight) return;
    const box = video.getBoundingClientRect();
    const stage = $('#hd-stage').getBoundingClientRect();
    const picture = pictureRect(ui.scale, { left: 0, top: 0, width: box.width, height: box.height },
      { width: video.videoWidth, height: video.videoHeight });
    cursor.style.left = `${box.left - stage.left + picture.left + at.x * picture.width}px`;
    cursor.style.top = `${box.top - stage.top + picture.top + at.y * picture.height}px`;
    cursor.hidden = false;
    $('#hd-stage').classList.add('controlling');
  }
  function hideRemoteCursor() {
    $('#hd-cursor').hidden = true;
    $('#hd-stage').classList.remove('controlling');
  }

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

    /* Measured against the *picture*, not the element: with the screen
       letterboxed the two differ by the size of the bars, which put every
       click out and made the bottom row — the Dock — unreachable. */
    const position = (e, { nearest = false } = {}) => {
      const box = video.getBoundingClientRect();
      const point = { x: e.clientX - box.left, y: e.clientY - box.top };
      const size = { width: video.videoWidth, height: video.videoHeight };
      const map = nearest ? nearestRemotePoint : pointToRemote;
      return map(point, ui.scale, { left: 0, top: 0, width: box.width, height: box.height }, size);
    };
    const pointer = (e, buttons) => {
      // While a button is held, a stray onto a bar still drags the far edge.
      const at = position(e, { nearest: (buttons ?? e.buttons) !== 0 });
      if (!at) return;                       // over a bar, not over the screen
      showRemoteCursor(at);
      sendInput({ type: 'pointer', x: at.x, y: at.y, buttons: buttons ?? e.buttons });
    };

    video.addEventListener('mousemove', e => pointer(e));
    video.addEventListener('mousedown', e => { e.preventDefault(); video.focus(); pointer(e); });
    video.addEventListener('mouseup', e => { e.preventDefault(); pointer(e); });
    video.addEventListener('contextmenu', e => e.preventDefault());
    video.addEventListener('mouseleave', e => { hideRemoteCursor(); pointer(e, 0); });
    video.addEventListener('wheel', e => {
      e.preventDefault();
      // Pixels to wheel clicks, the unit the host injects.
      sendInput({ type: 'wheel', dx: e.deltaX / 100, dy: e.deltaY / 100 });
    }, { passive: false });

    const send = (e, down) => {
      /* Two shortcuts stay on this computer, and nothing else does. Ctrl+Alt+Enter
         leaves full screen — it has to be something no remote application wants,
         because in full screen even Cmd and Alt+Tab go to the other computer. */
      if (down && e.ctrlKey && e.altKey && e.key === 'Enter') { toggleFullscreen(); return; }
      if (down && e.key === 'F11') { toggleFullscreen(); return; }
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
  void renderComputers();
  void renderLoginItem();
  /* First launch, or any launch where something is still missing: show the
     steps rather than leaving them to be found in a panel. */
  void api.hostStatus().then(status => {
    const items = status.permissions?.items ?? [];
    if (items.length && items.some(i => !i.granted)) void openSetup();
  });
  void api.accountState?.().then(renderAccount).catch(() => {});
  return { refreshHost };
}

const formatCode = code => (code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code);

/**
 * What a changed identity key means, in the two cases that produce it.
 *
 * Said plainly and without deciding for anyone: HopDesk cannot tell a
 * reinstalled computer from a substituted one, and the person can - they know
 * whether they reinstalled it. What they must not be told is that it is
 * probably fine.
 */
export function keyChangeWarning({ hostName, deviceId, viaServer } = {}) {
  const who = hostName || deviceId || 'That computer';
  return `Accept only if you know why it changed - if ${who} was reinstalled, or HopDesk was `
    + 'set up on it again. Otherwise this may be a different computer answering in its place'
    + (viaServer ? ', which is what a compromised server would look like.' : '.');
}

/**
 * The first eight bytes of a public key, in the same shape the rest of HopDesk
 * shows them.
 *
 * It has to be the same shape, because the whole point is that two computers
 * show it and a person compares the two by eye. Kept in step with
 * `fingerprint` in apps/desktop/src/trusted.ts.
 */
export function keyFingerprint(publicKeyBase64) {
  try {
    const raw = atob(publicKeyBase64);
    let hex = '';
    for (let i = 0; i < Math.min(8, raw.length); i++) hex += raw.charCodeAt(i).toString(16).padStart(2, '0');
    return hex.replace(/(.{4})(?=.)/g, '$1 ');
  } catch {
    return 'unreadable';
  }
}

/**
 * "last seen 3 hours ago", in the words a person would use.
 *
 * Offline on its own says nothing about whether a computer is switched off for
 * the night or has not been seen since March, and those call for different
 * actions.
 */
export function lastSeenText(lastSeen) {
  if (!lastSeen) return 'never connected';
  const seconds = Math.max(0, Math.round((Date.now() - lastSeen) / 1000));
  if (seconds < 90) return 'last seen just now';
  const units = [
    { limit: 3600, size: 60, one: 'a minute', many: 'minutes' },
    { limit: 86_400, size: 3600, one: 'an hour', many: 'hours' },
    { limit: 2_592_000, size: 86_400, one: 'a day', many: 'days' },
  ];
  for (const unit of units) {
    if (seconds >= unit.limit) continue;
    const count = Math.round(seconds / unit.size);
    return `last seen ${count === 1 ? unit.one : `${count} ${unit.many}`} ago`;
  }
  return `last seen on ${new Date(lastSeen).toLocaleDateString()}`;
}

/** Handshake failures in plain words; the technical text stays available. */
/**
 * Electron puts its own wrapper round anything an IPC call throws, and the
 * protocol's own errors are codes rather than sentences. Neither belongs in
 * front of a person: "Error invoking remote method 'connectDevice':
 * HandshakeError: unknown-device" is what this strips back to "unknown-device".
 */
export function cleanMessage(message) {
  return String(message ?? '')
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(?:[A-Za-z]*Error):\s*/, '')
    .trim();
}

export function friendlyError(message) {
  const text = cleanMessage(message);
  if (/bad-auth|access code is not correct/i.test(text)) return 'That access code is not correct. Check the code shown on the other computer — it changes.';
  if (/rate-limited/i.test(text)) return 'Too many attempts were refused. Wait a moment, then try the new code shown on the other computer.';
  if (/not-found|No computer with the Device ID/i.test(text)) return 'No computer with that Device ID answered on this network. Check the ID, or that HopDesk is open and remote access is on there.';
  if (/unknown-device/i.test(text)) return 'That computer answered but has a different Device ID. Check the ID you entered.';
  if (/identity-mismatch/i.test(text)) return 'This computer\'s identity key is not the one seen before. It could be a different machine — do not continue unless you know why it changed.';
  if (/rejected|user-rejected/i.test(text)) return 'The person at the other computer did not allow the connection.';
  if (/timeout/i.test(text)) return 'The other computer did not answer in time.';
  if (/code-disabled/i.test(text)) return 'That computer is not accepting connections by access code right now.';
  if (/not-paired/i.test(text)) return 'That computer is not paired with this one any more. Connect with its access code, and tick "Let this computer connect again without asking".';
  if (/ECONNREFUSED/i.test(text)) return 'That computer refused the connection. HopDesk may not be running there.';
  return text;
}
