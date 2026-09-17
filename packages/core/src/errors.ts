/**
 * Failures as a person understands them.
 *
 * Every protocol reports problems in its own vocabulary — `ECONNREFUSED`,
 * `ERRCONNECT_LOGON_FAILURE`, "Unexpected message type 150". None of that is
 * what someone trying to reach their office PC needs to read first. A failure
 * is classified into a category the UI can act on (ask for the password again,
 * show a certificate warning), a short title, one or two sentences on what to
 * check, and the original text kept as `detail` for the diagnostics panel.
 *
 * Getting the category right matters more than the wording: telling someone to
 * "check the firewall" when their password was wrong sends them the wrong way.
 */

export type ErrorCategory =
  | 'unreachable'          // no route, host down, DNS
  | 'refused'              // host up, nothing listening
  | 'timeout'              // no answer
  | 'auth-failed'          // wrong username or password
  | 'auth-required'        // a password is needed and none was given
  | 'account-restricted'   // right password, account not allowed in
  | 'certificate-changed'
  | 'certificate-rejected'
  | 'unsupported'          // the server wants something HopDesk cannot do
  | 'client-missing'       // FreeRDP / Virt Viewer not installed
  | 'closed-by-remote'     // the remote side ended an established session
  | 'network-lost'         // the connection dropped
  | 'unknown';

export interface FriendlyError {
  category: ErrorCategory;
  title: string;
  message: string;
  /** The technical text, for the diagnostics panel. Never contains secrets. */
  detail: string;
}

interface Target { host: string; port: number }

const where = (c: Target) => `${c.host}:${c.port}`;

/** Failures from the built-in VNC client and its socket. */
export function classifyVncError(raw: string, c: Target): FriendlyError {
  const detail = raw;
  const f = (category: ErrorCategory, title: string, message: string): FriendlyError =>
    ({ category, title, message, detail });

  if (/ENOTFOUND|EAI_AGAIN|could not be found/.test(raw)) {
    return f('unreachable', 'Computer not found',
      `The name "${c.host}" could not be found on this network. Check the spelling, or use the computer's IP address.`);
  }
  if (/EHOSTUNREACH|ENETUNREACH|cannot be reached/.test(raw)) {
    return f('unreachable', 'Computer unreachable',
      `${c.host} cannot be reached. Check that both computers are on the same network or VPN, and that the remote computer is switched on.`);
  }
  if (/ECONNREFUSED|Nothing is accepting/.test(raw)) {
    return f('refused', 'Connection refused',
      `${where(c)} is not accepting screen sharing connections. Check that screen sharing (VNC) is turned on and that the port is correct.`);
  }
  if (/ETIMEDOUT|No response from|did not respond/.test(raw)) {
    return f('timeout', 'No response',
      `${where(c)} did not answer. The computer may be asleep, or a firewall may be blocking the port.`);
  }
  if (/needs a password/i.test(raw)) {
    return f('auth-required', 'Password required', 'This computer needs a password.');
  }
  if (/Authentication failed/i.test(raw)) {
    return f('auth-failed', 'Wrong password',
      'The remote computer did not accept the password. Enter it again.');
  }
  if (/Apple Remote Desktop/.test(raw)) {
    return f('unsupported', 'VNC password access is off',
      'On the Mac, open System Settings → General → Sharing → Screen Sharing → ⓘ and turn on "VNC viewers may control screen with password".');
  }
  if (/No supported authentication method|not supported|Not a VNC server/i.test(raw)) {
    return f('unsupported', 'Unsupported server',
      /Not a VNC server/.test(raw)
        ? `Something other than a VNC server answered at ${where(c)}. Check the port number.`
        : 'This server requires a security method HopDesk does not support yet (for example TLS-only VNC). Allow VNC password authentication on the server.');
  }
  if (/closed the connection during the handshake|refused the connection/i.test(raw)) {
    return f('closed-by-remote', 'Connection closed',
      'The remote computer closed the connection before it was set up. It may allow only one viewer, or limit who can connect.');
  }
  if (/ECONNRESET|EPIPE|connection closed|Connection closed/i.test(raw)) {
    return f('network-lost', 'Connection lost',
      'The connection to the remote computer was interrupted.');
  }
  return f('unknown', 'Connection failed', 'The connection could not be established.');
}

/** Failures reported by FreeRDP, by its error name. */
export function classifyRdpError(
  code: string | null, c: Target, context: { reachable?: boolean; exitCode?: number | null } = {},
): FriendlyError {
  const detail = code ?? (context.exitCode !== undefined ? `exit code ${context.exitCode}` : 'no error reported');
  const f = (category: ErrorCategory, title: string, message: string): FriendlyError =>
    ({ category, title, message, detail });

  switch (code) {
    case 'ERRCONNECT_LOGON_FAILURE':
    case 'ERRCONNECT_AUTHENTICATION_FAILED':
    case 'ERRCONNECT_WRONG_PASSWORD':
    case 'ERRCONNECT_NO_OR_MISSING_CREDENTIALS':
      return f('auth-failed', 'Wrong username or password',
        'The remote computer did not accept the sign-in. For a Microsoft account use its e-mail address and password, not the PIN.');
    case 'ERRCONNECT_PASSWORD_EXPIRED':
    case 'ERRCONNECT_PASSWORD_CERTAINLY_EXPIRED':
    case 'ERRCONNECT_PASSWORD_MUST_CHANGE':
      return f('account-restricted', 'Password expired', 'Sign in on the computer itself to set a new password.');
    case 'ERRCONNECT_ACCOUNT_DISABLED':
    case 'ERRCONNECT_ACCOUNT_EXPIRED':
      return f('account-restricted', 'Account disabled', 'This account is disabled or has expired.');
    case 'ERRCONNECT_ACCOUNT_LOCKED_OUT':
      return f('account-restricted', 'Account locked', 'Too many failed sign-ins. Wait, or ask an administrator to unlock the account.');
    case 'ERRCONNECT_ACCOUNT_RESTRICTION':
    case 'ERRCONNECT_LOGON_TYPE_NOT_GRANTED':
    case 'ERRCONNECT_INSUFFICIENT_PRIVILEGES':
    case 'ERRCONNECT_ACCESS_DENIED':
      return f('account-restricted', 'Remote sign-in not allowed',
        'This account may not sign in remotely. Add it to the Remote Desktop Users group on that computer.');
    case 'ERRCONNECT_TLS_CONNECT_FAILED':
      return f('certificate-rejected', 'Secure connection failed',
        'The remote computer’s certificate was not accepted, or it has changed.');
    case 'ERRCONNECT_DNS_ERROR':
    case 'ERRCONNECT_DNS_NAME_NOT_FOUND':
      return f('unreachable', 'Computer not found',
        `The name "${c.host}" could not be found. Check the spelling, or use the computer's IP address.`);
    case 'ERRCONNECT_SECURITY_NEGO_CONNECT_FAILED':
      return f('unsupported', 'Security settings not accepted',
        'The computer rejected the connection’s security settings. It may require Network Level Authentication with a username and password.');
    case 'ERRCONNECT_CONNECT_CANCELLED':
      return f('closed-by-remote', 'Connection cancelled', 'The connection was cancelled.');
    case 'ERRCONNECT_KDC_UNREACHABLE':
      return f('unreachable', 'Domain controller unreachable', 'The domain controller could not be reached to check the account.');
    case 'ERRCONNECT_CONNECT_TRANSPORT_FAILED':
    case 'ERRCONNECT_CONNECT_FAILED':
      // The probe HopDesk runs before launching FreeRDP proves reachability.
      if (context.reachable) {
        return f('auth-failed', 'Connection closed during sign-in',
          'The remote computer closed the connection while signing in. Check that Remote Desktop is enabled and that the username and password are correct.');
      }
      return f('unreachable', 'Computer unreachable',
        `Could not reach ${where(c)}. Check the address, that Remote Desktop is turned on, and that the port is not blocked.`);
    default:
      if (code) return f('unknown', 'Connection failed', 'The remote desktop connection could not be established.');
      return f('closed-by-remote', 'Session ended',
        'The remote desktop window closed unexpectedly. Open the diagnostics for details.');
  }
}
