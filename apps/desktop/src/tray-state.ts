/**
 * What the menu bar or tray icon is saying, in three states.
 *
 * Someone walking past a computer that is sharing its screen should be able to
 * tell, without opening anything, which of three things is true: nobody can
 * connect, somebody could, or somebody is. That is the whole vocabulary -
 * Offline, Ready, In session - and it is worth being exact about which is
 * which, because the difference between "could" and "is" is the difference
 * between a computer at rest and a computer being watched.
 *
 * Kept apart from Electron so the wording is tested rather than eyeballed on
 * whichever desktop happens to be to hand.
 */

export type TrayState = 'offline' | 'ready' | 'in-session';

export interface TraySummary {
  state: TrayState;
  /** The first line of the menu, which is not a button. */
  label: string;
  /** What hovering the icon says. */
  tooltip: string;
  /** Whether anyone is connected right now, which is what the icon shows. */
  connected: boolean;
}

export function trayState(
  status: { enabled?: boolean; listening?: boolean; sessions?: { id: string }[] } | null | undefined,
): TraySummary {
  const sessions = status?.sessions?.length ?? 0;
  if (sessions > 0) {
    const who = sessions === 1 ? '1 computer connected' : `${sessions} computers connected`;
    return { state: 'in-session', label: `In session — ${who}`, tooltip: `HopDesk — in session, ${who}`, connected: true };
  }
  /* Enabled but not listening yet is still not reachable, and saying "Ready"
     then would be a promise the computer cannot keep. */
  if (status?.enabled && status?.listening) {
    return { state: 'ready', label: 'Ready — waiting for connections', tooltip: 'HopDesk — ready for connections', connected: false };
  }
  return {
    state: 'offline',
    label: status?.enabled ? 'Offline — starting…' : 'Offline — not sharing this computer',
    tooltip: 'HopDesk — offline',
    connected: false,
  };
}
