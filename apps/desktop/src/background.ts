import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { UNIT_NAME, executablePath, unitText } from './login-item.js';
import { trayState } from './tray-state.js';
import { app, Tray, Menu, nativeImage, powerMonitor, Notification, type NativeImage } from 'electron';
import type { HostStatus } from './host.js';

/**
 * Staying reachable when the window is closed.
 *
 * A computer you connect *to* has to be listening when nobody is at it. So on
 * macOS, closing the window hides the app instead of quitting it, and a menu
 * bar item is what remains: it shows whether remote access is on, who is
 * connected, and how to stop them or quit for real.
 *
 * Quitting still ends every session (see `shutdown` in main.ts) — hiding is not
 * quitting, and the menu bar item is how someone can tell the difference.
 */

export interface BackgroundOptions {
  show: () => void;
  status: () => HostStatus;
  setRemoteAccess: (enabled: boolean) => Promise<unknown>;
  endSession: (id: string) => void;
  quit: () => void;
  log: (line: string) => void;
  /** Called after the machine wakes, so the host can check it is still listening. */
  onWake?: () => void;
}

/** 16pt template images: macOS colours them for light and dark menu bars. */
function trayIcon(connected: boolean): NativeImage {
  /* Drawn here rather than shipped as a file: two 16x16 shapes, a hollow
     screen and a filled one, so "someone is connected" is visible at a glance. */
  const svg = connected
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect x="1" y="3" width="14" height="9" rx="1.5" fill="black"/><rect x="5" y="13" width="6" height="1.5" fill="black"/></svg>'
    : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect x="1.75" y="3.75" width="12.5" height="7.5" rx="1.25" fill="none" stroke="black" stroke-width="1.5"/><rect x="5" y="13" width="6" height="1.5" fill="black"/></svg>';
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  image.setTemplateImage(true);
  return image;
}

export class BackgroundMode {
  private tray: Tray | null = null;
  private quitting = false;
  private readonly notifications = new Map<string, Notification>();

  constructor(private readonly opts: BackgroundOptions) {}

  start(): void {
    /**
     * A tray icon is a nicety; starting at all is not.
     *
     * On Linux the tray is somebody else's program - a StatusNotifier host, or
     * the desktop's own panel - reached over the session bus. A machine
     * without one, or with a bus that cannot be spoken to, is perfectly
     * ordinary: a server, a bare window manager, a test runner. HopDesk has to
     * come up there exactly as it always did, so a tray that refuses to exist
     * is written down and then ignored. Without it, closing the window quits,
     * which is what it did before there was a tray to find the app by.
     */
    try {
      this.tray = new Tray(trayIcon(false));
      this.tray.setToolTip('HopDesk');
      this.tray.on('click', () => this.opts.show());
      this.refresh();
    } catch (err) {
      this.tray = null;
      this.opts.log(`no tray icon on this desktop: ${(err as Error).message}`);
    }

    /* Waking up: the network was gone while asleep, so the listener and the
       announcement on the network may need starting again. */
    powerMonitor.on('resume', () => {
      this.opts.log('this computer woke up; checking remote access is still listening');
      this.opts.onWake?.();
      this.refresh();
    });
    powerMonitor.on('suspend', () => this.opts.log('this computer is going to sleep'));
  }

  /** Called when the host status changes: the icon and menu follow it. */
  refresh(): void {
    if (!this.tray) return;
    const status = this.opts.status();
    const sessions = status.sessions ?? [];
    const state = trayState(status);
    this.tray.setImage(trayIcon(state.connected));
    this.tray.setToolTip(state.tooltip);
    this.tray.setContextMenu(Menu.buildFromTemplate(this.menu(status, sessions)));

    /* Someone connecting while nobody is watching the screen should be visible
       without the window: one notification per session, with a way to stop it. */
    for (const session of sessions) {
      if (!this.notifications.has(session.id)) this.announce(session.id, session.viewerName || session.viewerId);
    }
    for (const [id, notification] of this.notifications) {
      if (!sessions.some(s => s.id === id)) { notification.close(); this.notifications.delete(id); }
    }
  }

  private menu(status: HostStatus, sessions: HostStatus['sessions']): Electron.MenuItemConstructorOptions[] {
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: trayState(status).label, enabled: false },
    ];
    if (status.enabled && status.listening && status.deviceId) {
      items.push({ label: `Device ID: ${status.deviceId}`, enabled: false });
    }
    items.push({ type: 'separator' });
    for (const session of sessions) {
      items.push({
        label: `Disconnect ${session.viewerName || session.viewerId}`,
        click: () => this.opts.endSession(session.id),
      });
    }
    if (sessions.length) items.push({ type: 'separator' });
    items.push(
      { label: 'Show HopDesk', click: () => this.opts.show() },
      {
        label: status.enabled ? 'Stop sharing this computer' : 'Let other computers connect',
        click: () => { void this.opts.setRemoteAccess(!status.enabled); },
      },
      { type: 'separator' },
      {
        label: 'Open at login',
        type: 'checkbox',
        checked: openAtLogin(),
        click: menuItem => { setOpenAtLogin(menuItem.checked); this.refresh(); },
      },
      { type: 'separator' },
      { label: 'Quit HopDesk', click: () => { this.quitting = true; this.opts.quit(); } },
    );
    return items;
  }

  private announce(sessionId: string, who: string): void {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: 'Someone is connected to this computer',
      body: `${who} can see and control this screen.`,
      actions: [{ type: 'button', text: 'Disconnect' }],
      closeButtonText: 'Close',
      urgency: 'critical',
    });
    notification.on('action', () => this.opts.endSession(sessionId));
    notification.on('click', () => this.opts.show());
    notification.show();
    this.notifications.set(sessionId, notification);
  }

  /**
   * Whether closing the window should hide the app instead of quitting it.
   *
   * Only while this computer is actually reachable. Hiding exists so that
   * closing the window does not cut off someone who is connected, or take this
   * computer off the network without saying so - and the menu bar item is
   * there to show it is still running. With remote access off there is nothing
   * to stay running for, and an app that will not close when asked is its own
   * kind of broken.
   */
  shouldHideOnClose(): boolean {
    /* Wherever there is a tray icon to find it by again. Linux has one now, so
       closing the window there means the same thing it means on a Mac. */
    if (!this.tray || this.quitting) return false;
    const status = this.opts.status();
    return status.enabled || status.sessions.length > 0;
  }

  /** Quitting has begun (⌘Q, the menu, a signal): stop intercepting the close. */
  beginQuit(): void { this.quitting = true; }

  stop(): void {
    for (const notification of this.notifications.values()) notification.close();
    this.notifications.clear();
    this.tray?.destroy();
    this.tray = null;
  }
}

export function openAtLogin(): boolean {
  if (process.platform === 'linux') return linuxUnitEnabled();
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

/* ------------------------------------------------- Linux: a systemd unit */

const unitDir = () => path.join(homedir(), '.config', 'systemd', 'user');
const unitPath = () => path.join(unitDir(), UNIT_NAME);

/** Whether systemd will start HopDesk for this user. */
function linuxUnitEnabled(): boolean {
  try {
    if (!existsSync(unitPath())) return false;
    // systemd's own answer, not the file's existence: it may be installed and off.
    const result = spawnSync('systemctl', ['--user', 'is-enabled', UNIT_NAME], { encoding: 'utf8' });
    return result.stdout.trim() === 'enabled';
  } catch {
    return false;
  }
}

/**
 * Writes (or removes) the unit and tells systemd about it.
 *
 * Throws with what systemd said, rather than quietly doing nothing: a switch
 * that reports success and leaves the computer unreachable after a reboot is
 * worse than one that says it failed.
 */
function setLinuxUnit(open: boolean): void {
  if (!open) {
    spawnSync('systemctl', ['--user', 'disable', '--now', UNIT_NAME], { encoding: 'utf8' });
    try { unlinkSync(unitPath()); } catch { /* already gone */ }
    spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
    return;
  }
  mkdirSync(unitDir(), { recursive: true });
  writeFileSync(unitPath(), unitText(executablePath()), { mode: 0o644 });
  spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
  const enabled = spawnSync('systemctl', ['--user', 'enable', UNIT_NAME], { encoding: 'utf8' });
  if (enabled.status !== 0) {
    throw new Error(`systemd would not enable it: ${(enabled.stderr || enabled.stdout || '').trim()}`);
  }
}

/**
 * A *user* login item, which is what `setLoginItemSettings` creates: it runs as
 * the person who set it, after they log in. Not a system daemon — a computer
 * with nobody logged in should not be reachable.
 */
export function setOpenAtLogin(open: boolean): void {
  if (process.platform === 'linux') { setLinuxUnit(open); return; }
  try {
    app.setLoginItemSettings({ openAtLogin: open });
  } catch {
    // Unsupported on this platform: the menu item simply does nothing.
  }
}
