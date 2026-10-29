import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchApp, electronUnavailableReason, waitFor } from './helpers/electron.mjs';

/**
 * The Admin page in the real application, against a service that is really
 * answering.
 *
 * What this proves that the unit tests cannot: that the IPC handlers are wired
 * to the window at all, that the token the window hands over never comes back
 * through the bridge, and that a service which refuses it puts the page back to
 * asking for one rather than leaving an empty table.
 */

const skip = electronUnavailableReason() ?? false;
const TOKEN = 'hda_0123456789abcdefghijklmnop';

/** A stand-in for the authorization service, on loopback. */
async function fakeService({ refuse = false } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (refuse) return send(401, { error: 'unauthorised' });
    if (req.url === '/api/admin/installations') {
      return send(200, {
        installations: [
          { installationId: 'HD-AAAA-BBBB', os: 'linux', appVersion: '0.2.8', status: 'active',
            registeredAt: Date.now() - 86_400_000, lastSeen: Date.now() - 3600_000,
            blockedAt: null, blockedReason: null, blockedBy: null },
          { installationId: 'HD-CCCC-DDDD', os: 'macos', appVersion: '0.2.8', status: 'blocked',
            registeredAt: Date.now() - 172_800_000, lastSeen: Date.now() - 7200_000,
            blockedAt: Date.now() - 600_000, blockedReason: 'licence shared', blockedBy: 'me@example.com' },
        ],
      });
    }
    if (/\/block$/.test(req.url ?? '')) return send(200, { ok: true, status: 'blocked' });
    if (/\/unblock$/.test(req.url ?? '')) return send(200, { ok: true, status: 'active' });
    if (/\/history$/.test(req.url ?? '')) {
      return send(200, { events: [
        { at: Date.now() - 600_000, actor: 'me@example.com', action: 'block', subject: 'HD-CCCC-DDDD', reason: 'licence shared' },
      ] });
    }
    return send(404, { error: 'not-found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, base: `http://127.0.0.1:${server.address().port}` };
}

test('the Admin page signs in, lists installations, blocks and shows history', { skip, timeout: 90_000 }, async () => {
  const service = await fakeService();
  const app = await launchApp({ env: { HOPDESK_CREDENTIAL_BACKEND: 'file' } });
  try {
    // The page is reachable from the window, and asks for a token first.
    await app.eval(`document.querySelector('#btn-admin').click(); return true`);
    await app.waitFor(`return !document.querySelector('#admin-view').hidden`, 10_000, 'the admin view to open');
    assert.equal(await app.eval(`return !document.querySelector('#admin-signin').hidden`), true);
    assert.equal(await app.eval(`return !document.querySelector('#admin-main').hidden`), false);

    /* This build has no service compiled in, so the page asks where to point
       it - exactly as it will for anyone building from source. */
    assert.equal(await app.eval(`return !document.querySelector('#admin-service-field').hidden`), true);

    await app.eval(`
      document.querySelector('#admin-service').value = ${JSON.stringify(service.base)};
      document.querySelector('#admin-token').value = ${JSON.stringify(TOKEN)};
      document.querySelector('#admin-signin-go').click();
      return true`);
    await app.waitFor(`return !document.querySelector('#admin-main').hidden`, 10_000, 'the installations to appear');

    /* The field is cleared, and the bridge never gives the token back. */
    assert.equal(await app.eval(`return document.querySelector('#admin-token').value`), '');
    const status = await app.eval(`return JSON.stringify(await window.hopdesk.adminStatus())`);
    assert.equal(JSON.parse(status).signedIn, true);
    assert.ok(!status.includes(TOKEN), 'the status reply carried the token');

    // Both rows, with the summary counting them.
    const table = await app.eval(`return document.querySelector('#admin-table').textContent`);
    assert.match(table, /HD-AAAA-BBBB/);
    assert.match(table, /HD-CCCC-DDDD/);
    assert.match(table, /licence shared/);
    const summary = await app.eval(`return document.querySelector('#admin-summary').textContent`);
    assert.match(summary, /2.*Total/s);

    // The search box narrows it.
    await app.eval(`
      const s = document.querySelector('#admin-search');
      s.value = 'CCCC'; s.dispatchEvent(new Event('input'));
      return true`);
    await app.waitFor(`return !document.querySelector('#admin-table').textContent.includes('HD-AAAA-BBBB')`,
      10_000, 'the search to narrow the table');
    await app.eval(`
      const s = document.querySelector('#admin-search');
      s.value = ''; s.dispatchEvent(new Event('input'));
      return true`);

    // History opens a panel with who did it and why.
    await app.eval(`
      const rows = [...document.querySelectorAll('#admin-table .admin-row')];
      const row = rows.find(r => r.textContent.includes('HD-CCCC-DDDD'));
      [...row.querySelectorAll('button')].find(b => b.textContent === 'History').click();
      return true`);
    await app.waitFor(`return !document.querySelector('#admin-history').hidden`, 10_000, 'the history panel');
    const history = await app.eval(`return document.querySelector('#admin-history-list').textContent`);
    assert.match(history, /block/);
    assert.match(history, /me@example\.com/);

    /* Blocking asks for a reason before anything is sent, and the dialog is a
       real one rather than a window.confirm. */
    await app.eval(`
      const rows = [...document.querySelectorAll('#admin-table .admin-row')];
      const row = rows.find(r => r.textContent.includes('HD-AAAA-BBBB'));
      [...row.querySelectorAll('button')].find(b => b.textContent === 'Block').click();
      return true`);
    await app.waitFor(`return document.querySelector('#dlg-admin-block').open`, 10_000, 'the reason dialog');
    assert.equal(await app.eval(`return document.querySelector('#admin-block-who').textContent`), 'HD-AAAA-BBBB');
    await app.eval(`
      document.querySelector('#admin-block-reason').value = 'testing';
      document.querySelector('#admin-block-ok').click();
      return true`);
    await app.waitFor(`return !document.querySelector('#dlg-admin-block').open`, 10_000, 'the dialog to close');
    await waitFor(() => service.seen.some(r => /\/block$/.test(r.url ?? '')),
      10_000, 'the block never reached the service');

    // Every request carried the credential the main process is holding.
    assert.ok(service.seen.every(r => r.auth === `Bearer ${TOKEN}`), 'a request went without the token');

    // Signing out removes it.
    await app.eval(`document.querySelector('#admin-signout').click(); return true`);
    await app.waitFor(`return document.querySelector('#dlg-confirm').open`, 10_000, 'the sign-out confirmation');
    await app.eval(`document.querySelector('#confirm-ok').click(); return true`);
    await app.waitFor(`return !document.querySelector('#admin-signin').hidden`, 10_000, 'the sign-in form to come back');
    assert.equal(JSON.parse(await app.eval(`return JSON.stringify(await window.hopdesk.adminStatus())`)).signedIn, false);
  } finally {
    await app.close();
    service.server.close();
  }
});

test('a token the service refuses says so and is not kept', { skip, timeout: 90_000 }, async () => {
  const service = await fakeService({ refuse: true });
  const app = await launchApp({ env: { HOPDESK_CREDENTIAL_BACKEND: 'file' } });
  try {
    await app.eval(`document.querySelector('#btn-admin').click(); return true`);
    await app.waitFor(`return !document.querySelector('#admin-view').hidden`, 10_000, 'the admin view');
    await app.eval(`
      document.querySelector('#admin-service').value = ${JSON.stringify(service.base)};
      document.querySelector('#admin-token').value = ${JSON.stringify(TOKEN)};
      document.querySelector('#admin-signin-go').click();
      return true`);

    await app.waitFor(`return !document.querySelector('#admin-signin-error').hidden`, 10_000, 'the refusal to be shown');
    const message = await app.eval(`return document.querySelector('#admin-signin-error').textContent`);
    assert.match(message, /not valid/i, `expected "Token not valid", got: ${message}`);

    // Still asking, and nothing was kept.
    assert.equal(await app.eval(`return !document.querySelector('#admin-signin').hidden`), true);
    assert.equal(JSON.parse(await app.eval(`return JSON.stringify(await window.hopdesk.adminStatus())`)).signedIn, false);
    assert.equal(await app.eval(`return document.querySelector('#admin-token').value`), '');
  } finally {
    await app.close();
    service.server.close();
  }
});
