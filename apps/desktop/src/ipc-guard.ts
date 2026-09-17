/**
 * Who may call the main process.
 *
 * Kept free of Electron imports so the rule can be tested directly. A message
 * is trusted only if it comes from the app's own window, from its top-level
 * frame, while that frame shows the bundled UI. That rejects other windows,
 * iframes (were one ever injected), and the window after something navigated
 * it elsewhere.
 */

export interface SenderLike {
  sender: unknown;
  senderFrame?: { url: string; parent: unknown } | null;
}

export function isTrustedSender(
  event: SenderLike,
  appContents: unknown | null,
  uiUrl: string,
): boolean {
  if (!appContents || event.sender !== appContents) return false;
  const frame = event.senderFrame;
  // A destroyed frame reports null: nothing to trust.
  if (!frame) return false;
  if (frame.parent) return false;
  return stripHash(frame.url) === stripHash(uiUrl);
}

const stripHash = (url: string) => url.replace(/[#?].*$/, '');
