/**
 * What a HopDesk Host needs from the operating system, expressed so each
 * platform can supply its own implementation and nothing above this layer has
 * to know which one is in use.
 *
 * Linux is implemented first (X11 through XTest, Wayland through the
 * xdg-desktop-portal RemoteDesktop portal later). Windows (SendInput, Desktop
 * Duplication) and macOS (CGEvent, ScreenCaptureKit) follow the same shapes.
 */

export interface DisplayInfo {
  id: string;
  /** Size in physical pixels. */
  width: number;
  height: number;
  /** Device pixel ratio, so a HiDPI host does not look half-size to a viewer. */
  scale: number;
  primary: boolean
  label?: string;
}

export interface DisplayManager {
  list(): Promise<DisplayInfo[]>;
  /** Notifies when displays are added, removed or resized. Returns an unsubscribe. */
  onChange(handler: () => void): () => void;
  /** Resizes a display to suit the viewer's window, where the platform allows it. */
  resize?(id: string, width: number, height: number): Promise<boolean>;
}

export interface CaptureSource {
  /** Opaque to everything above; meaningful only to the implementation. */
  id: string;
  displayId: string;
  label: string;
}

export interface ScreenCapture {
  sources(): Promise<CaptureSource[]>;
  /** Which source a capture request should be answered with. */
  select(sourceId: string): void;
  /**
   * True where the operating system itself asks the user before sharing
   * (Wayland portals, macOS Screen Recording). The Host must not pretend a
   * session is live until that has been answered.
   */
  readonly requiresSystemConsent: boolean;
}

export type PointerButton = 1 | 2 | 3;

export interface InputController {
  /** Absolute position, in physical pixels of the shared display. */
  movePointer(x: number, y: number): void;
  button(button: PointerButton, down: boolean): void;
  /** Scroll in wheel clicks; positive dy scrolls down, positive dx scrolls right. */
  wheel(dx: number, dy: number): void;
  key(keysym: number, down: boolean): void;
  /** Releases every key and button this controller is holding. */
  releaseAll(): void;
  /** Where the pointer is now, which is also how tests verify injection. */
  pointerPosition(): { x: number; y: number };
  close(): void;
}

export interface ClipboardProvider {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

export type PermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported';

export interface PermissionManager {
  /** Whether the Host may capture the screen and inject input right now. */
  check(): Promise<{ capture: PermissionState; input: PermissionState; detail?: string }>;
  /** Asks the platform to prompt. Returns the state afterwards. */
  request(): Promise<{ capture: PermissionState; input: PermissionState; detail?: string }>;
}

export interface HostServiceStatus {
  running: boolean;
  /** Whether the Host starts with the user's session. */
  enabledAtLogin: boolean;
  detail?: string;
}

export interface HostService {
  status(): Promise<HostServiceStatus>;
  enableAtLogin(enabled: boolean): Promise<void>;
}
