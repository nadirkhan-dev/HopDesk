/**
 * Starting HopDesk when the person logs in.
 *
 * macOS and Windows have an API for this and Electron wraps it. Linux does
 * not: `setLoginItemSettings` is a silent no-op there, which is why "open at
 * login" was hidden on Linux and a computer meant to be reachable stopped
 * being reachable the moment it rebooted.
 *
 * On Linux it is a systemd *user* service. A user service and not a system
 * one, deliberately: it runs as the person who enabled it, after they log in,
 * and a computer with nobody logged in stays unreachable. That is the same
 * promise the macOS login item makes, kept the way Linux keeps it.
 *
 * The unit text is built here, away from systemd, so what goes in the file is
 * tested rather than discovered on someone's machine.
 */

export const UNIT_NAME = 'hopdesk.service';

/**
 * Where the app was started from, as the unit has to name it.
 *
 * An AppImage is one file that mounts itself, and argv[0] points inside that
 * mount - a path that exists only while it runs. `APPIMAGE` is the file
 * itself, which is what a unit can start next time.
 */
export function executablePath(env = process.env, execPath = process.execPath): string {
  return env.APPIMAGE ?? execPath;
}

/**
 * A systemd user unit that starts HopDesk with the graphical session.
 *
 * `import-environment` is the awkward part and not avoidable: a user service
 * inherits nothing from the session, so without DISPLAY (or WAYLAND_DISPLAY)
 * the app starts and finds no desktop to draw on. Importing them from the
 * session manager is how graphical user services are normally written.
 */
export function unitText(exec: string): string {
  return `[Unit]
Description=HopDesk, so this computer can be reached after a restart
Documentation=https://github.com/nadirkhan-dev/HopDesk
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
# A user service starts with no idea which display it belongs to.
ExecStartPre=-/usr/bin/systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY XDG_SESSION_TYPE XDG_RUNTIME_DIR
ExecStart=${exec}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=graphical-session.target default.target
`;
}
