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
  return isTrustedFrom(event, [{ contents: appContents, url: uiUrl }]);
}

/**
 * The same rule for an app with more than one window of its own — the hidden
 * window that captures the screen is a second legitimate caller, and it must be
 * matched against its own page, not the main one.
 */
export function isTrustedFrom(
  event: SenderLike,
  allowed: { contents: unknown | null; url: string }[],
): boolean {
  const frame = event.senderFrame;
  // A destroyed frame reports null: nothing to trust.
  if (!frame || frame.parent) return false;
  return allowed.some(entry =>
    entry.contents !== null && entry.contents !== undefined
    && event.sender === entry.contents
    && stripHash(frame.url) === stripHash(entry.url));
}

const stripHash = (url: string) => url.replace(/[#?].*$/, '');
