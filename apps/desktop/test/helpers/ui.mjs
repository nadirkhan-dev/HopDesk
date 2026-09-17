/** Steps a user takes in the HopDesk window, shared by the Electron tests. */

/** Selects a connection in the list and clicks Connect. */
export async function clickConnect(app, id) {
  await app.eval(`document.querySelector('.item[data-id="${id}"]').click(); return true`);
  await app.waitFor(`return !!document.querySelector('#btn-connect')`, 5000, 'Connect button');
  await app.eval(`document.querySelector('#btn-connect').click(); return true`);
}

/** Fills in and saves the Add computer dialog; resolves with the new id. */
export async function addViaUi(app, { protocol, name, host, port, username = '', password = '', os = '' }) {
  await app.eval(`
    document.querySelector('#btn-new').click();
    ${os ? `document.querySelector('#os-picker [data-os="${os}"]').click();` : ''}
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('change')); };
    set('#f-protocol', ${JSON.stringify(protocol)});
    set('#f-name', ${JSON.stringify(name)});
    set('#f-host', ${JSON.stringify(host)});
    set('#f-port', ${JSON.stringify(String(port))});
    set('#f-user', ${JSON.stringify(username)});
    set('#f-pass', ${JSON.stringify(password)});
    document.querySelector('#dlg-save').click();
    return true`);
  return app.waitFor(`
    const items = [...document.querySelectorAll('.item')];
    const item = items.find(i => i.querySelector('.name').textContent === ${JSON.stringify(name)});
    return item ? item.dataset.id : null`, 8000, `"${name}" to be saved`);
}

/** One canvas pixel as [r, g, b, a]. */
export const pixel = (app, x, y) => app.eval(`
  const c = document.querySelector('#screen');
  return [...c.getContext('2d').getImageData(${x}, ${y}, 1, 1).data]`);

/** Window coordinates of a framebuffer pixel, whatever the canvas scaling. */
export async function canvasPoint(app, x, y) {
  const box = await app.eval(`
    const r = document.querySelector('#screen').getBoundingClientRect();
    const c = document.querySelector('#screen');
    return { left: r.left, top: r.top, sx: r.width / c.width, sy: r.height / c.height }`);
  return { x: box.left + (x + 0.5) * box.sx, y: box.top + (y + 0.5) * box.sy };
}
