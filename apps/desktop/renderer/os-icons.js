/**
 * The little picture of a computer, by what it runs.
 *
 * Shared, because the same Mac appears in both halves of the interface - the
 * HopDesk list and the saved VNC and RDP computers - and it would be strange
 * for it to be drawn differently in each.
 */
export const OS_ICON = {
  windows: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
  macos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>',
  linux: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 10 3 2.5L7 15M12 15h5"/></svg>',
  other: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/></svg>',
};

export const OS_NAMES = { windows: 'Windows', macos: 'Mac', linux: 'Linux', other: 'Computer' };

/** The markup for one computer's icon; anything unrecognised gets the plain one. */
export function osIcon(os) {
  return `<span class="os ${OS_ICON[os] ? os : 'other'}" aria-hidden="true">${OS_ICON[os] ?? OS_ICON.other}</span>`;
}
