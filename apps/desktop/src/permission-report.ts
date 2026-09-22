import type { PermissionState } from '@hopdesk/platform';

/**
 * What the operating system allows this computer to share, in words a person
 * can act on. Kept apart from Electron so the wording and the logic are tested
 * on every platform, not only on a Mac.
 *
 * On macOS both halves of hosting are gated by switches in System Settings, and
 * a switch that is off fails *silently*: capture hands back a blank picture and
 * posted mouse and keyboard events are dropped without an error. So every
 * permission is listed, granted or not, with what it is for and exactly where
 * to turn it on.
 */

export type PermissionId = 'screen-recording' | 'accessibility';
export type PermissionAction = 'open-screen-recording' | 'open-accessibility';

export interface PermissionItem {
  id: PermissionId;
  /** The name macOS uses for it, so it can be found in System Settings. */
  name: string;
  state: PermissionState;
  granted: boolean;
  /** What the other computer cannot do without it. */
  why: string;
  /** Where to turn it on, step by step. Empty when granted. */
  how: string;
  action: PermissionAction;
}

export interface PermissionReport {
  capture: PermissionState;
  input: PermissionState;
  /** Every permission this platform has, granted or not. Empty where none are needed. */
  items: PermissionItem[];
  /** One sentence for the first thing that is missing, or nothing when all is well. */
  detail?: string;
  action?: PermissionAction;
}

const SETTINGS = 'System Settings → Privacy & Security';

export function macReport(capture: PermissionState, input: PermissionState): PermissionReport {
  const items: PermissionItem[] = [
    {
      id: 'screen-recording',
      name: 'Screen Recording',
      state: capture,
      granted: capture === 'granted',
      why: 'Without it, someone connecting sees a blank screen or only the desktop background.',
      how: `Open ${SETTINGS} → Screen Recording (called "Screen & System Audio Recording" on newer macOS), `
        + 'switch HopDesk on, then quit and reopen HopDesk — macOS applies this one only after a restart. '
        + 'If it is already on and still not allowed, select HopDesk, remove it with the − button, and add it again.',
      action: 'open-screen-recording',
    },
    {
      id: 'accessibility',
      name: 'Accessibility',
      state: input,
      granted: input === 'granted',
      why: 'Without it, someone connecting can watch but their mouse and keyboard do nothing.',
      how: `Open ${SETTINGS} → Accessibility and switch HopDesk on. `
        + 'If HopDesk is not in the list, add it with the + button from your Applications folder. '
        + 'If it is already on and still not allowed, select HopDesk, remove it with the − button, add it again, '
        + 'and reopen HopDesk.',
      action: 'open-accessibility',
    },
  ];
  for (const item of items) if (item.granted) item.how = '';
  const missing = items.filter(i => !i.granted);
  return {
    capture,
    input,
    items,
    ...(missing.length ? {
      detail: missing.length === 2
        ? 'macOS has not given HopDesk Screen Recording or Accessibility yet, so this Mac cannot be seen or controlled from another computer.'
        : missing[0]!.id === 'screen-recording'
          ? 'macOS has not given HopDesk Screen Recording yet, so someone connecting would not see this screen.'
          : 'macOS has not given HopDesk Accessibility yet, so someone connecting could watch but not control this Mac.',
      action: missing[0]!.action,
    } : {}),
  };
}

/**
 * What the viewer is told when this computer cannot fully be shared — shown on
 * the other computer, so it names this one as "the other computer's".
 */
export function viewerNotices(report: PermissionReport | null, inputProblem: string | null, otherLimits: (string | null)[] = []): string[] {
  const notices: string[] = [];
  const screen = report?.items.find(i => i.id === 'screen-recording');
  if (screen && !screen.granted) {
    notices.push('The other Mac has not allowed HopDesk to record its screen, so the picture may be blank. '
      + 'On that Mac: System Settings → Privacy & Security → Screen Recording → switch HopDesk on, then reopen HopDesk.');
  }
  const access = report?.items.find(i => i.id === 'accessibility');
  if (access && !access.granted) {
    notices.push('You can watch but not control: the other Mac has not allowed HopDesk to use its mouse and keyboard. '
      + 'On that Mac: System Settings → Privacy & Security → Accessibility → switch HopDesk on.');
  } else if (inputProblem) {
    notices.push(`You can watch but not control: the other computer cannot accept mouse and keyboard input (${inputProblem}).`);
  }
  for (const limit of otherLimits) if (limit) notices.push(limit);
  return notices.map(n => n.slice(0, 400)).slice(0, 4);
}
