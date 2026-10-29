/**
 * The Admin page: the installations the authorization service knows about, and
 * what may be done to them.
 *
 * Nothing here holds the administrator token. Sign-in hands it to the main
 * process once and it stays there, in the keystore; every button below asks
 * for something to be done and is told what happened. A refusal with 401 means
 * the token was not good, and the page says so and goes back to asking for one
 * rather than leaving a table that is mysteriously always empty.
 *
 * Built with createElement and textContent throughout, like the rest of this
 * window: a Device ID, a reason and an administrator's address all arrive from
 * elsewhere, and none of them is markup.
 */

const $ = sel => document.querySelector(sel);

const WHEN = { dateStyle: 'medium', timeStyle: 'short' };
const when = at => (typeof at === 'number' && at > 0 ? new Date(at).toLocaleString(undefined, WHEN) : 'never');

/** "3 days ago", for a column people scan rather than read. */
function ago(at) {
  if (typeof at !== 'number' || at <= 0) return 'never';
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const ERRORS = {
  'token-not-valid': 'Token not valid.',
  'no-token': 'Sign in to administer installations.',
  'no-service': 'This build has no authorization service, and none has been given.',
  unreachable: 'Could not reach the authorization service.',
  refused: 'The service refused the request.',
};

export function initAdmin({ api, toast, confirmDialog }) {
  if (!api?.adminStatus) return;

  let installations = [];
  let openHistoryFor = null;

  const show = visible => {
    $('#admin-view').hidden = !visible;
    if (visible) { $('#home').hidden = true; $('#pane').hidden = true; }
  };

  const said = (el, message) => {
    el.textContent = message ?? '';
    el.hidden = !message;
  };

  /* ------------------------------------------------------------ signing in */

  async function refreshStatus() {
    const status = await api.adminStatus();
    const signedIn = status?.signedIn === true;
    $('#admin-signin').hidden = signedIn;
    $('#admin-main').hidden = !signedIn;
    if (!signedIn) $('#admin-history').hidden = true;

    /* A build made for a service administers that one and no other. Only a
       build with none compiled in asks where to point. */
    $('#admin-service-field').hidden = Boolean(status?.service);
    $('#admin-service-name').textContent = status?.service ?? '';

    /* On a computer with no keystore the token is held for this run only, and
       saying so is better than a person wondering why they are asked again. */
    if (signedIn && status?.remembered === false) {
      said($('#admin-error'), 'This computer has no keystore, so the token is kept for this run only. '
        + 'You will be asked for it again after a restart.');
    }
    if (signedIn) await load();
  }

  $('#admin-signin-go').onclick = async () => {
    const token = $('#admin-token').value.trim();
    const service = $('#admin-service').value.trim();
    said($('#admin-signin-error'), '');
    if (!token) { said($('#admin-signin-error'), 'Paste the administrator token.'); return; }

    $('#admin-signin-go').disabled = true;
    try {
      const answer = await api.adminSignIn(token, service || undefined);
      /* Cleared whatever happened: the field should not keep a credential
         after it has been handed over, or after it was refused. */
      $('#admin-token').value = '';
      if (!answer?.ok) {
        said($('#admin-signin-error'), answer?.detail || ERRORS[answer?.error] || 'That did not work.');
        return;
      }
      toast('Signed in as administrator');
      await refreshStatus();
    } finally {
      $('#admin-signin-go').disabled = false;
    }
  };

  $('#admin-token').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('#admin-signin-go').click();
  });

  $('#admin-signout').onclick = async () => {
    const sure = await confirmDialog('Sign out of administration?',
      'The token is removed from this computer. You will need it again to come back.', 'Sign out');
    if (!sure) return;
    await api.adminSignOut();
    installations = [];
    toast('Administrator token removed');
    await refreshStatus();
  };

  /* --------------------------------------------------------- the table */

  async function load() {
    said($('#admin-error'), '');
    const answer = await api.adminList();
    if (!answer?.ok) {
      /* The one refusal that changes what the page is: the token has been
         thrown away, so this goes back to asking for one. */
      if (answer?.error === 'token-not-valid') {
        said($('#admin-signin-error'), ERRORS['token-not-valid']);
        await refreshStatus();
        return;
      }
      said($('#admin-error'), answer?.detail || ERRORS[answer?.error] || 'Could not read the installations.');
      return;
    }
    installations = answer.installations ?? [];
    render();
  }

  function summary() {
    const total = installations.length;
    const blocked = installations.filter(i => i.status !== 'active').length;
    return [
      ['Total', total],
      ['Active', total - blocked],
      ['Blocked', blocked],
    ];
  }

  function render() {
    const cards = $('#admin-summary');
    cards.replaceChildren();
    for (const [label, value] of summary()) {
      const card = document.createElement('div');
      card.className = 'admin-stat';
      const n = document.createElement('div');
      n.className = 'admin-stat-value';
      n.textContent = String(value);
      const l = document.createElement('div');
      l.className = 'admin-stat-label';
      l.textContent = label;
      card.append(n, l);
      cards.append(card);
    }

    const needle = $('#admin-search').value.trim().toLowerCase();
    const rows = installations.filter(i => !needle
      || i.installationId.toLowerCase().includes(needle)
      || String(i.status).toLowerCase().includes(needle)
      || String(i.blockedReason ?? '').toLowerCase().includes(needle)
      || String(i.os ?? '').toLowerCase().includes(needle));

    const table = $('#admin-table');
    table.replaceChildren();

    if (!installations.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No installation has registered with this service yet. '
        + 'A computer appears here once it runs a build made for this service.';
      table.append(empty);
      return;
    }
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = `Nothing matches “${needle}”.`;
      table.append(empty);
      return;
    }

    const head = document.createElement('div');
    head.className = 'admin-row admin-head';
    for (const label of ['Device ID', 'Status', 'Last check', 'Reason', '']) {
      const cell = document.createElement('span');
      cell.textContent = label;
      head.append(cell);
    }
    table.append(head);

    for (const item of rows) {
      const blocked = item.status !== 'active';
      const row = document.createElement('div');
      row.className = 'admin-row';

      const id = document.createElement('span');
      id.className = 'mono';
      id.textContent = item.installationId;
      if (item.os || item.appVersion) {
        const sub = document.createElement('span');
        sub.className = 'hint';
        sub.textContent = ` ${[item.os, item.appVersion].filter(Boolean).join(' · ')}`;
        id.append(sub);
      }

      const status = document.createElement('span');
      const dot = document.createElement('span');
      dot.className = `dot ${blocked ? 'off' : 'on'}`;
      const word = document.createElement('span');
      word.textContent = blocked ? 'Blocked' : 'Active';
      status.append(dot, word);

      const seen = document.createElement('span');
      seen.textContent = ago(item.lastSeen);
      seen.title = when(item.lastSeen);

      const reason = document.createElement('span');
      reason.className = 'hint';
      reason.textContent = item.blockedReason ?? '';
      if (item.blockedBy) reason.title = `by ${item.blockedBy}`;

      const actions = document.createElement('span');
      actions.className = 'admin-actions';

      const historyButton = document.createElement('button');
      historyButton.className = 'btn ghost small';
      historyButton.textContent = 'History';
      historyButton.onclick = () => void showHistory(item.installationId);

      const toggle = document.createElement('button');
      toggle.className = blocked ? 'btn small' : 'btn small danger';
      toggle.textContent = blocked ? 'Unblock' : 'Block';
      toggle.onclick = () => void (blocked ? unblock(item) : block(item));

      actions.append(historyButton, toggle);
      row.append(id, status, seen, reason, actions);
      table.append(row);
    }
  }

  $('#admin-search').addEventListener('input', () => render());
  $('#admin-refresh').onclick = () => void load();

  /* ------------------------------------------------- blocking and history */

  /** The reason, and a last chance to not do it. */
  function askReason(installationId) {
    const dialog = $('#dlg-admin-block');
    $('#admin-block-who').textContent = installationId;
    $('#admin-block-reason').value = '';
    if (!dialog.open) dialog.showModal();
    $('#admin-block-reason').focus();
    return new Promise(resolve => {
      const done = value => {
        $('#admin-block-ok').onclick = null;
        $('#admin-block-cancel').onclick = null;
        if (dialog.open) dialog.close();
        resolve(value);
      };
      $('#admin-block-ok').onclick = () => done($('#admin-block-reason').value.trim());
      $('#admin-block-cancel').onclick = () => done(null);
      dialog.addEventListener('cancel', e => { e.preventDefault(); done(null); }, { once: true });
    });
  }

  async function block(item) {
    const reason = await askReason(item.installationId);
    if (reason === null) return;
    const answer = await api.adminBlock(item.installationId, reason);
    await afterChange(answer, `${item.installationId} is blocked`);
  }

  async function unblock(item) {
    const sure = await confirmDialog('Let this installation run again?',
      `${item.installationId} will be able to accept and make HopDesk connections again.`, 'Unblock');
    if (!sure) return;
    const answer = await api.adminUnblock(item.installationId);
    await afterChange(answer, `${item.installationId} may run again`);
  }

  async function afterChange(answer, message) {
    if (!answer?.ok) {
      if (answer?.error === 'token-not-valid') {
        said($('#admin-signin-error'), ERRORS['token-not-valid']);
        await refreshStatus();
        return;
      }
      said($('#admin-error'), answer?.detail || ERRORS[answer?.error] || 'That did not work.');
      return;
    }
    toast(message);
    await load();
    if (openHistoryFor) await showHistory(openHistoryFor);
  }

  async function showHistory(installationId) {
    const answer = await api.adminHistory(installationId);
    if (!answer?.ok) {
      if (answer?.error === 'token-not-valid') {
        said($('#admin-signin-error'), ERRORS['token-not-valid']);
        await refreshStatus();
        return;
      }
      said($('#admin-error'), answer?.detail || ERRORS[answer?.error] || 'Could not read the history.');
      return;
    }
    openHistoryFor = installationId;
    $('#admin-history-title').textContent = `HISTORY — ${installationId}`;
    const list = $('#admin-history-list');
    list.replaceChildren();

    if (!answer.events.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'Nothing has been done to this installation.';
      list.append(empty);
    }
    for (const event of answer.events) {
      const row = document.createElement('div');
      row.className = 'admin-row admin-event';

      const what = document.createElement('span');
      what.textContent = event.action;

      const who = document.createElement('span');
      who.textContent = `by ${event.actor}`;

      const at = document.createElement('span');
      at.textContent = when(event.at);

      const why = document.createElement('span');
      why.className = 'hint';
      why.textContent = event.reason ?? '';

      row.append(what, who, at, why);
      list.append(row);
    }
    $('#admin-history').hidden = false;
  }

  $('#admin-history-close').onclick = () => {
    openHistoryFor = null;
    $('#admin-history').hidden = true;
  };

  /* ----------------------------------------------------------- the way in */

  $('#btn-admin').onclick = async () => {
    const showing = !$('#admin-view').hidden;
    if (showing) {
      show(false);
      $('#home').hidden = false;
      return;
    }
    show(true);
    await refreshStatus();
  };

  return { refreshStatus };
}
