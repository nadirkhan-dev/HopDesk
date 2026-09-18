import { shell, systemPreferences } from 'electron';
import type { PermissionManager, PermissionState } from '@hopdesk/platform';

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

export interface PermissionReport {
  capture: PermissionState;
  input: PermissionState;
  detail?: string;
  /** Something the user can do about it, when there is something. */
  action?: 'open-screen-recording' | 'open-accessibility';
}

const SCREEN_RECORDING_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const ACCESSIBILITY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

class MacPermissions implements PermissionManager {
  async check(): Promise<PermissionReport> {
    const capture = toState(systemPreferences.getMediaAccessStatus('screen'));
    // `false` asks nothing; it only reports whether the permission is there.
    const input: PermissionState = systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'prompt';
    return this.describe(capture, input);
  }

  async request(): Promise<PermissionReport> {
    /* There is no API that opens the Screen Recording prompt directly: macOS
       shows it the first time something actually captures, so the Host's first
       capture is the prompt. Accessibility does have one. */
    const input: PermissionState = systemPreferences.isTrustedAccessibilityClient(true) ? 'granted' : 'prompt';
    const capture = toState(systemPreferences.getMediaAccessStatus('screen'));
    return this.describe(capture, input);
  }

  private describe(capture: PermissionState, input: PermissionState): PermissionReport {
    if (capture !== 'granted') {
      return {
        capture,
        input,
        detail: 'macOS has not allowed HopDesk to record the screen yet. '
          + 'Open Privacy & Security → Screen Recording, switch HopDesk on, then quit and reopen HopDesk.',
        action: 'open-screen-recording',
      };
    }
    if (input !== 'granted') {
      return {
        capture,
        input,
        detail: 'Someone connecting can see this screen but cannot control it. '
          + 'Open Privacy & Security → Accessibility and switch HopDesk on to allow the mouse and keyboard.',
        action: 'open-accessibility',
      };
    }
    return { capture, input };
  }
}

class NoPermissionsNeeded implements PermissionManager {
  private readonly report: PermissionReport;
  constructor(detail?: string) {
    this.report = detail
      ? { capture: 'unsupported', input: 'unsupported', detail }
      : { capture: 'granted', input: 'granted' };
  }
  async check() { return this.report; }
  async request() { return this.report; }
}

export function createPermissionManager(): PermissionManager {
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
