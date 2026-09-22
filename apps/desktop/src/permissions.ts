import { app, shell, systemPreferences } from 'electron';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PermissionManager, PermissionState } from '@hopdesk/platform';
import { macReport, type PermissionReport } from './permission-report.js';
import { requestScreenRecording, screenRecordingAllowed } from '@hopdesk/platform';

/**
 * What the operating system has to allow before this computer can be shared.
 *
 * On macOS both capture and input are gated by TCC — Screen Recording and
 * Accessibility. The important part is that a refused permission is *silent*:
 * `CGEventPost` returns nothing and capture hands back black frames, so a Host
 * that did not check would look like it was working and simply do nothing. So
 * HopDesk asks first, says which switch is missing, and offers to open the
 * right pane of System Settings.
 *
 * On Linux/X11 there is nothing to ask for. Wayland asks per session through
 * the portal, which is handled where the portal is used, not here.
 */

export type { PermissionReport } from './permission-report.js';

/** The platform's permission manager, reporting every permission rather than the first missing one. */
interface Permissions extends PermissionManager {
  check(): Promise<PermissionReport>;
  request(): Promise<PermissionReport>;
  /** Shows the operating system's own prompt, where there is one. */
  ask?(id: 'screen-recording' | 'accessibility'): Promise<{ granted: boolean; prompted: boolean }>;
}

const SCREEN_RECORDING_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const ACCESSIBILITY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

class MacPermissions implements Permissions {
  async check(): Promise<PermissionReport> {
    // `false` asks nothing; it only reports whether the permission is there.
    return macReport(
      toState(systemPreferences.getMediaAccessStatus('screen')),
      systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'prompt');
  }

  /**
   * Asks macOS itself for one permission, so its own dialog appears and HopDesk
   * lands in the Settings list without anyone hunting for it with +.
   *
   * `prompted: false` means HopDesk knows nothing was shown. `true` only means
   * macOS was asked: it shows each prompt once per app and returns straight
   * away whether or not it did, so the caller should offer System Settings
   * after any ask that did not grant.
   */
  async ask(id: 'screen-recording' | 'accessibility'): Promise<{ granted: boolean; prompted: boolean }> {
    if (id === 'accessibility') {
      if (systemPreferences.isTrustedAccessibilityClient(false)) return { granted: true, prompted: false };
      // `true` is AXIsProcessTrustedWithOptions with the prompt option.
      const granted = systemPreferences.isTrustedAccessibilityClient(true);
      return { granted, prompted: !granted };
    }
    try {
      return requestScreenRecording();
    } catch {
      // Quartz could not be loaded: the Settings route still works.
      return { granted: screenRecordingSafe(), prompted: false };
    }
  }

  async request(): Promise<PermissionReport> {
    /* There is no API that opens the Screen Recording prompt directly: macOS
       shows it the first time something actually captures, so the Host's first
       capture is the prompt. Accessibility does have one. */
    const input: PermissionState = systemPreferences.isTrustedAccessibilityClient(true) ? 'granted' : 'prompt';
    return macReport(toState(systemPreferences.getMediaAccessStatus('screen')), input);
  }
}

class NoPermissionsNeeded implements Permissions {
  private readonly report: PermissionReport;
  constructor(detail?: string) {
    this.report = detail
      ? { capture: 'unsupported', input: 'unsupported', items: [], detail }
      : { capture: 'granted', input: 'granted', items: [] };
  }
  async check() { return this.report; }
  async request() { return this.report; }
}

export function createPermissionManager(): Permissions {
  if (process.platform === 'darwin') return new MacPermissions();
  if (process.platform === 'linux') return new NoPermissionsNeeded();
  return new NoPermissionsNeeded(`HopDesk cannot share this computer's screen on ${process.platform} yet.`);
}

/** Opens the System Settings pane a report points at. */
export function openPermissionSettings(action: PermissionReport['action']) {
  if (action === 'open-screen-recording') void shell.openExternal(SCREEN_RECORDING_PANE);
  if (action === 'open-accessibility') void shell.openExternal(ACCESSIBILITY_PANE);
}

/**
 * Forgets what macOS remembers about HopDesk's two permissions, so the next
 * launch asks afresh.
 *
 * macOS remembers a permission against the app's code signature. A build that
 * is signed ad hoc (no Developer ID) gets a new signature every time it is
 * built, so after an update the switch in System Settings still shows "on" but
 * belongs to the old build: turning it on and off changes nothing for the copy
 * that is running. Resetting removes that stale entry; the next ask adds the
 * running build in its place.
 */
export async function resetMacPermissions(): Promise<{ ok: boolean; bundleId?: string; detail?: string }> {
  if (process.platform !== 'darwin') return { ok: false, detail: 'Only macOS has these permissions.' };
  const bundleId = macBundleId();
  if (!bundleId) return { ok: false, detail: 'Could not tell which app this is.' };
  const failures: string[] = [];
  for (const service of ['ScreenCapture', 'Accessibility']) {
    try {
      await new Promise<void>((resolve, reject) =>
        execFile('/usr/bin/tccutil', ['reset', service, bundleId], err => (err ? reject(err) : resolve())));
    } catch (err) {
      failures.push(`${service}: ${(err as Error).message}`);
    }
  }
  return failures.length ? { ok: false, bundleId, detail: failures.join('; ') } : { ok: true, bundleId };
}

/**
 * Clears entries left behind by an earlier build of HopDesk, once per version.
 *
 * Without an Apple Developer ID certificate every build of HopDesk is signed
 * ad hoc, which gives it a new signature each time. macOS remembers a
 * permission against the signature that was granted it, so after installing a
 * new version the switch in System Settings is still there, still on — and
 * means nothing to the build now running, which is why turning it off and on
 * changes nothing. Worse, macOS counts the old build's prompt as already
 * answered and so shows nothing when this one asks.
 *
 * Clearing puts both back to untouched, so the prompts appear again and the
 * switches belong to the build that is running. Only done when a permission is
 * missing — a working one is never disturbed — and only once for each version,
 * recorded beside the other application data.
 */
export async function clearStaleMacPermissions(
  dataDir: string, version: string, missing: boolean,
): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const marker = path.join(dataDir, 'mac-permissions.json');
  let done: string | null = null;
  try {
    done = (JSON.parse(readFileSync(marker, 'utf8')) as { clearedFor?: string }).clearedFor ?? null;
  } catch { /* never run, or unreadable: treat as never run. */ }
  if (done === version) return false;
  const record = () => {
    try { writeFileSync(marker, JSON.stringify({ clearedFor: version }), { mode: 0o600 }); } catch { /* not fatal */ }
  };
  if (!missing) { record(); return false; }     // nothing stale: this build is already allowed
  const result = await resetMacPermissions();
  record();                                     // one attempt per version, successful or not
  return result.ok;
}

/** The running app's bundle identifier, from its own Info.plist. */
function macBundleId(): string | null {
  try {
    // …/HopDesk.app/Contents/MacOS/HopDesk → …/HopDesk.app/Contents/Info.plist
    const plist = readFileSync(path.join(path.dirname(app.getPath('exe')), '..', 'Info.plist'), 'utf8');
    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}

function screenRecordingSafe(): boolean {
  try { return screenRecordingAllowed(); } catch { return false; }
}

function toState(status: string): PermissionState {
  switch (status) {
    case 'granted': return 'granted';
    case 'denied': return 'denied';
    case 'restricted': return 'denied';
    case 'not-determined': return 'prompt';
    default: return 'unsupported';
  }
}
