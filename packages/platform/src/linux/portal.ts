import * as dbusModule from '@homebridge/dbus-native';
import type { InputController, PointerButton } from '../interfaces.js';

/* The library ships types for systemBus() only, so the session bus is reached
   through the narrow shape this file actually uses. */
const dbus = dbusModule as unknown as { sessionBus(): Bus };

/**
 * Input injection on Wayland, through xdg-desktop-portal's RemoteDesktop
 * interface.
 *
 * On X11 any client can move the pointer of any other; on Wayland nothing can,
 * by design. The sanctioned route is this portal: the compositor asks the
 * person at the keyboard whether to allow remote control, and only then accepts
 * the events. That dialog is not an obstacle to work around — it is the
 * permission model, and HopDesk has no business bypassing it.
 *
 * The session also selects a screen to share, because absolute pointer
 * positions are expressed in the coordinates of a shared stream. HopDesk uses
 * that stream's size as the display size, so a viewer's clicks land where the
 * viewer sees them.
 *
 * A restore token, where the desktop supports it, means the question is asked
 * once rather than at every start.
 */

const PORTAL = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const REMOTE_DESKTOP = 'org.freedesktop.portal.RemoteDesktop';
const SCREEN_CAST = 'org.freedesktop.portal.ScreenCast';
const REQUEST = 'org.freedesktop.portal.Request';
const SESSION = 'org.freedesktop.portal.Session';

/** Device types the RemoteDesktop portal knows. */
const DEVICE = { keyboard: 1, pointer: 2, touchscreen: 4 } as const;
/** Source types for ScreenCast: a whole monitor. */
const SOURCE_MONITOR = 1;
/** Cursor modes: 2 = drawn into the stream, which is what a viewer expects. */
const CURSOR_EMBEDDED = 2;
/** persist_mode 2: remember until the user revokes it. */
const PERSIST_UNTIL_REVOKED = 2;

/** evdev button codes, which is what the portal expects. */
const BUTTON_CODE: Record<PointerButton, number> = { 1: 0x110, 2: 0x112, 3: 0x111 };

/** Axis numbers for NotifyPointerAxisDiscrete. */
const AXIS = { vertical: 0, horizontal: 1 } as const;

export class PortalUnavailable extends Error {}
export class PortalRefused extends Error {}

type Variant = [{ type: string; child: unknown[] }, unknown[]];
type DictEntry = [string, [string, unknown]];

interface Bus {
  name: string | null;
  connection: {
    on(event: 'message', handler: (message: RawMessage) => void): void;
    /** The underlying socket; closing it is how a connection is given up. */
    stream?: { end(): void; destroy(): void; unref?(): void };
  };
  invoke(options: InvokeOptions, callback: (err: Error | null, ...result: unknown[]) => void): void;
  addMatch(rule: string, callback: (err: Error | null) => void): void;
}

interface InvokeOptions {
  destination: string;
  path: string;
  interface: string;
  member: string;
  signature?: string;
  body?: unknown[];
}

interface RawMessage {
  type: number;
  path?: string;
  interface?: string;
  member?: string;
  body?: unknown[];
}

/** A request/response pair with the portal, correlated by object path. */
class PortalBus {
  private readonly pending = new Map<string, (body: unknown[]) => void>();
  private counter = 0;
  /** This connection's unique name, with the punctuation portals expect. */
  private sender = '';

  private constructor(private readonly bus: Bus) {}

  static async connect(): Promise<PortalBus> {
    if (!process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.XDG_RUNTIME_DIR) {
      throw new PortalUnavailable('There is no session bus to reach the desktop portal on');
    }
    let bus: Bus;
    try {
      bus = dbus.sessionBus();
    } catch (err) {
      throw new PortalUnavailable(`Could not connect to the session bus: ${(err as Error).message}`);
    }

    const portal = new PortalBus(bus);
    bus.connection.on('message', message => portal.onMessage(message));
    await new Promise<void>((resolve, reject) => {
      bus.addMatch(`type='signal',interface='${REQUEST}',member='Response'`, err => err ? reject(err) : resolve());
    });

    /* Request object paths are derived from this connection's unique name, so
       an answer can be matched to its question without guessing. */
    portal.sender = (await portal.waitForName()).replace(/^:/, '').replace(/\./g, '_');
    return portal;
  }

  private async waitForName(): Promise<string> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (this.bus.name) return this.bus.name;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new PortalUnavailable('The session bus never gave this connection a name');
  }

  private onMessage(message: RawMessage) {
    if (message.type !== 4 || message.member !== 'Response' || message.interface !== REQUEST) return;
    const waiter = message.path ? this.pending.get(message.path) : undefined;
    if (!waiter || !message.path) return;
    this.pending.delete(message.path);
    waiter(message.body ?? []);
  }

  /** A fresh token, and the request path the portal will answer on. */
  private token(): { token: string; path: string } {
    const token = `hopdesk${process.pid}_${++this.counter}`;
    return { token, path: `/org/freedesktop/portal/desktop/request/${this.sender}/${token}` };
  }

  /**
   * Calls a portal method that answers with a Response signal, and resolves
   * with its results — or rejects if the person said no.
   */
  async ask(
    iface: string,
    member: string,
    signature: string,
    body: (token: string) => unknown[],
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const { token, path } = this.token();
    const answer = new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(path);
        reject(new PortalRefused(`The desktop did not answer ${member} in time`));
      }, timeoutMs);
      this.pending.set(path, result => { clearTimeout(timer); resolve(result); });
    });

    await this.invoke({ destination: PORTAL, path: PORTAL_PATH, interface: iface, member, signature, body: body(token) });
    const [code, results] = await answer;
    if (code !== 0) {
      // 1 is "the user said no", 2 is "it ended some other way".
      throw new PortalRefused(code === 1
        ? `Sharing this screen was not allowed (${member})`
        : `The desktop ended the request (${member})`);
    }
    return fromDict(results);
  }

  /** A method call with no Response signal: the Notify* input methods. */
  invoke(options: InvokeOptions): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      this.bus.invoke(options, (err, ...result) => err ? reject(err) : resolve(result));
    });
  }

  /** Reads a property of the portal object. */
  async property(iface: string, name: string): Promise<unknown> {
    const [value] = await this.invoke({
      destination: PORTAL, path: PORTAL_PATH, interface: 'org.freedesktop.DBus.Properties',
      member: 'Get', signature: 'ss', body: [iface, name],
    });
    return unwrap(value);
  }

  /** Fire and forget: an input event must not wait for a round trip. */
  send(options: InvokeOptions, onError: (err: Error) => void) {
    this.bus.invoke(options, err => { if (err) onError(err); });
  }

  /**
   * Gives up the bus connection. Without this the open socket keeps the process
   * alive — an application that would not quit, and a test run that never ends.
   */
  disconnect() {
    this.pending.clear();
    try {
      this.bus.connection.stream?.end();
      this.bus.connection.stream?.destroy();
    } catch { /* already gone */ }
  }
}

/* ------------------------------------------------------------ variants */

const variant = (type: string, value: unknown): [string, unknown] => [type, value];
/** An a{sv} argument is the array of entries itself, not an array around it. */
const dict = (entries: DictEntry[]) => entries;

/** Turns the portal's a{sv} results into a plain object. */
function fromDict(results: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(results)) return out;
  for (const entry of results as unknown[]) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [key, value] = entry as [string, Variant];
    out[key] = unwrap(value);
  }
  return out;
}

function unwrap(value: unknown): unknown {
  // dbus-native hands back [signature, [value]] for a variant.
  if (Array.isArray(value) && value.length === 2 && Array.isArray(value[1])) {
    const inner = (value[1] as unknown[])[0];
    return inner;
  }
  return value;
}

/**
 * How far the portal can be taken without asking the user anything: a session
 * is created and the devices and screen are selected, but `Start` — the call
 * that shows the dialog — is not made. Enough to tell whether remote control is
 * possible on this desktop at all, and used by the tests, which cannot click.
 */
export async function probePortal(): Promise<{
  available: true; persistSupported: boolean; version: number;
} | { available: false; reason: string }> {
  let portal: PortalBus;
  try {
    portal = await PortalBus.connect();
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
  try {
    const version = Number(await portal.property(REMOTE_DESKTOP, 'version')) || 0;
    const created = await portal.ask(REMOTE_DESKTOP, 'CreateSession', 'a{sv}',
      token => [dict([
        ['handle_token', variant('s', token)],
        ['session_handle_token', variant('s', `${token}_session`)],
      ])], 10_000);
    const session = String(created.session_handle ?? '');
    if (!session) return { available: false, reason: 'the portal created no session' };

    let persistSupported = true;
    try {
      await portal.ask(REMOTE_DESKTOP, 'SelectDevices', 'oa{sv}',
        token => [session, dict([
          ['handle_token', variant('s', token)],
          ['types', variant('u', DEVICE.keyboard | DEVICE.pointer)],
          ['persist_mode', variant('u', PERSIST_UNTIL_REVOKED)],
        ])], 10_000);
    } catch (err) {
      if (!/persist/i.test((err as Error).message)) throw err;
      persistSupported = false;
      await portal.ask(REMOTE_DESKTOP, 'SelectDevices', 'oa{sv}',
        token => [session, dict([
          ['handle_token', variant('s', token)],
          ['types', variant('u', DEVICE.keyboard | DEVICE.pointer)],
        ])], 10_000);
    }

    await portal.ask(SCREEN_CAST, 'SelectSources', 'oa{sv}',
      token => [session, dict([
        ['handle_token', variant('s', token)],
        ['types', variant('u', SOURCE_MONITOR)],
        ['multiple', variant('b', false)],
        ['cursor_mode', variant('u', CURSOR_EMBEDDED)],
      ])], 10_000);

    // Hand the session back; Start was never called, so nothing was shared.
    portal.send({ destination: PORTAL, path: session, interface: SESSION, member: 'Close' }, () => {});
    return { available: true, persistSupported, version };
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  } finally {
    portal.disconnect();
  }
}

/* --------------------------------------------------------------- input */

export interface WaylandInputOptions {
  /** A token from a previous session, so the desktop does not ask again. */
  restoreToken?: string;
  /** Called when the desktop issues a token worth keeping. */
  onRestoreToken?: (token: string) => void;
  /** How long to wait for the person to answer the dialog. */
  promptTimeoutMs?: number;
  maxWheelClicks?: number;
}

export class WaylandInput implements InputController {
  private readonly heldButtons = new Set<PointerButton>();
  private readonly heldKeys = new Set<number>();
  private closed = false;
  private last = { x: 0, y: 0 };

  readonly width: number;
  readonly height: number;
  /** The stream this session shares, which pointer positions are relative to. */
  readonly streamNode: number;

  private constructor(
    private readonly portal: PortalBus,
    private readonly session: string,
    stream: { node: number; width: number; height: number },
    private readonly maxWheelClicks: number,
    private readonly onError: (err: Error) => void,
  ) {
    this.streamNode = stream.node;
    this.width = stream.width;
    this.height = stream.height;
  }

  /**
   * Asks the desktop for permission to control this computer. Resolves once the
   * person has allowed it; rejects if they refuse or never answer.
   */
  static async create(opts: WaylandInputOptions = {}): Promise<WaylandInput> {
    const promptTimeout = opts.promptTimeoutMs ?? 120_000;
    const portal = await PortalBus.connect();
    const errors: Error[] = [];
    const onError = (err: Error) => { errors.push(err); };
    try {

      const created = await portal.ask(REMOTE_DESKTOP, 'CreateSession', 'a{sv}',
        token => [dict([
          ['handle_token', variant('s', token)],
          ['session_handle_token', variant('s', `${token}_session`)],
        ])], 15_000);
      const session = String(created.session_handle ?? '');
      if (!session) throw new PortalUnavailable('The portal created no session');

      /* Some desktops let a session be remembered, and some refuse to remember
         one that can control the machine — GNOME answers "Remote desktop sessions
         cannot persist". Ask for it, and drop it when the answer is no, rather
         than failing over a convenience. */
      let persist = true;
      const selectDevices = (withPersist: boolean) => portal.ask(REMOTE_DESKTOP, 'SelectDevices', 'oa{sv}',
        token => [session, dict([
          ['handle_token', variant('s', token)],
          ['types', variant('u', DEVICE.keyboard | DEVICE.pointer)],
          ...(withPersist ? [['persist_mode', variant('u', PERSIST_UNTIL_REVOKED)] as DictEntry] : []),
          ...(withPersist && opts.restoreToken ? [['restore_token', variant('s', opts.restoreToken)] as DictEntry] : []),
        ])], 15_000);

      try {
        await selectDevices(true);
      } catch (err) {
        if (!/persist/i.test((err as Error).message)) throw err;
        persist = false;
        await selectDevices(false);
      }

      /* Absolute pointer positions need a stream to be relative to, so the same
         session also selects the screen being shared. No persist_mode here: a
         session that can control the machine may not be remembered, which the
         portal enforces ("Remote desktop sessions cannot persist"). */
      void persist;
      await portal.ask(SCREEN_CAST, 'SelectSources', 'oa{sv}',
        token => [session, dict([
          ['handle_token', variant('s', token)],
          ['types', variant('u', SOURCE_MONITOR)],
          ['multiple', variant('b', false)],
          ['cursor_mode', variant('u', CURSOR_EMBEDDED)],
        ])], 15_000);

      // This is the call that shows the dialog.
      const started = await portal.ask(REMOTE_DESKTOP, 'Start', 'osa{sv}',
        token => [session, '', dict([['handle_token', variant('s', token)]])], promptTimeout);

      if (typeof started.restore_token === 'string' && opts.onRestoreToken) {
        opts.onRestoreToken(started.restore_token);
      }
      const stream = firstStream(started.streams);
      if (!stream) throw new PortalUnavailable('The desktop shared no screen with this session');

      const input = new WaylandInput(portal, session, stream, opts.maxWheelClicks ?? 10, onError);
      if (errors.length) throw errors[0]!;
      return input;
    } catch (err) {
      // A refused or failed request must not leave the bus connection open.
      portal.disconnect();
      throw err;
    }
  }

  private assertOpen() {
    if (this.closed) throw new Error('This input controller is closed');
  }

  private notify(member: string, signature: string, body: unknown[]) {
    this.portal.send({
      destination: PORTAL, path: PORTAL_PATH, interface: REMOTE_DESKTOP, member, signature, body,
    }, this.onError);
  }

  movePointer(x: number, y: number) {
    this.assertOpen();
    const point = {
      x: Math.min(this.width - 1, Math.max(0, Math.round(x))),
      y: Math.min(this.height - 1, Math.max(0, Math.round(y))),
    };
    this.last = point;
    this.notify('NotifyPointerMotionAbsolute', 'oa{sv}udd', [this.session, dict([]), this.streamNode, point.x, point.y]);
  }

  button(button: PointerButton, down: boolean) {
    this.assertOpen();
    const code = BUTTON_CODE[button];
    if (code === undefined) return;
    if (down) this.heldButtons.add(button); else this.heldButtons.delete(button);
    this.notify('NotifyPointerButton', 'oa{sv}iu', [this.session, dict([]), code, down ? 1 : 0]);
  }

  wheel(dx: number, dy: number) {
    this.assertOpen();
    const clamp = (v: number) => Math.max(-this.maxWheelClicks, Math.min(this.maxWheelClicks, Math.round(v)));
    const vertical = clamp(dy);
    const horizontal = clamp(dx);
    // The portal counts a positive step as down/right, which matches HopDesk.
    if (vertical) this.notify('NotifyPointerAxisDiscrete', 'oa{sv}ui', [this.session, dict([]), AXIS.vertical, vertical]);
    if (horizontal) this.notify('NotifyPointerAxisDiscrete', 'oa{sv}ui', [this.session, dict([]), AXIS.horizontal, horizontal]);
  }

  key(keysym: number, down: boolean) {
    this.assertOpen();
    if (!Number.isInteger(keysym) || keysym <= 0 || keysym > 0x1fffffff) return;
    /* The portal takes keysyms, which is exactly what HopDesk carries — no
       keycode table, and no dependence on the host's keyboard layout. */
    if (down) this.heldKeys.add(keysym); else this.heldKeys.delete(keysym);
    this.notify('NotifyKeyboardKeysym', 'oa{sv}iu', [this.session, dict([]), keysym, down ? 1 : 0]);
  }

  releaseAll() {
    if (this.closed) return;
    for (const keysym of [...this.heldKeys]) this.key(keysym, false);
    for (const button of [...this.heldButtons]) this.button(button, false);
  }

  /** Wayland does not let anything read the pointer, so this is what we last set. */
  pointerPosition(): { x: number; y: number } {
    return { ...this.last };
  }

  close() {
    if (this.closed) return;
    this.releaseAll();
    this.closed = true;
    // Closing the session withdraws the permission this process was given.
    this.portal.send({ destination: PORTAL, path: this.session, interface: SESSION, member: 'Close' },
      () => { /* the session may already be gone */ });
    // Let the close message leave before the socket goes.
    setTimeout(() => this.portal.disconnect(), 100).unref?.();
  }
}

/** The first stream of a Start response, with its size. */
function firstStream(streams: unknown): { node: number; width: number; height: number } | null {
  if (!Array.isArray(streams) || !streams.length) return null;
  const [node, props] = streams[0] as [number, unknown];
  const details = fromDict(props);
  const size = details.size;
  const [width, height] = Array.isArray(size) && size.length === 2 ? size as [number, number] : [0, 0];
  if (!Number.isInteger(node) || width <= 0 || height <= 0) return null;
  return { node, width, height };
}
