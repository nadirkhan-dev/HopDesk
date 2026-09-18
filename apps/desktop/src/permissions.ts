import { shell, systemPreferences } from 'electron';
import type { PermissionManager, PermissionState } from '@hopdesk/platform';
import { macReport, type PermissionReport } from './permission-report.js';

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

function toState(status: string): PermissionState {
  switch (status) {
    case 'granted': return 'granted';
    case 'denied': return 'denied';
    case 'restricted': return 'denied';
    case 'not-determined': return 'prompt';
    default: return 'unsupported';
  }
}
