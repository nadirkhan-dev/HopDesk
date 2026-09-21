import { shell, systemPreferences } from 'electron';
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
   * `prompted: false` means macOS decided not to show anything — it only ever
   * asks once — so the caller should fall back to opening System Settings.
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
