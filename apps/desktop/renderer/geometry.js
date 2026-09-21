/**
 * Where the other computer's screen actually is on this one, and which point on
 * it the mouse is over.
 *
 * The video is drawn inside its element, not across it: in "fit" there are bars
 * at the sides or top and bottom, in "fill" the picture is cropped, and at 1:1
 * it may be larger than the element and panned. Measuring the pointer against
 * the *element* instead of the picture is what put every click out by the size
 * of those bars — and made the last row of pixels unreachable, so a Mac's Dock
 * never appeared.
 *
 * Kept free of the DOM so it can be tested without a browser.
 */

/** @typedef {{ width: number, height: number }} Size */
/** @typedef {{ left: number, top: number, width: number, height: number }} Rect */

export const MODES = ['fit', 'fill', 'actual'];

/**
 * How much the remote picture is scaled to be drawn here.
 *  - fit:    the whole screen, letterboxed rather than cropped
 *  - fill:   fills the element, cropping the overflow
 *  - actual: one remote pixel per CSS pixel, panned if it does not fit
 */
export function scaleFor(mode, box, video) {
  if (!video.width || !video.height || !box.width || !box.height) return 1;
  const wide = box.width / video.width;
  const tall = box.height / video.height;
  if (mode === 'fill') return Math.max(wide, tall);
  if (mode === 'actual') return 1;
  return Math.min(wide, tall);
}

/**
 * The rectangle the picture occupies, in the element's coordinates. With "fill"
 * or "actual" it can be larger than the element and start at a negative
 * position — that is the part hidden by cropping or panning.
 *
 * `pan` is 0..1 per axis: which part of an oversized picture is shown. 0.5 is
 * centred, which is what a viewer that never scrolls always uses.
 */
export function pictureRect(mode, box, video, pan = { x: 0.5, y: 0.5 }) {
  const scale = scaleFor(mode, box, video);
  const width = video.width * scale;
  const height = video.height * scale;
  return {
    // `noNegativeZero`: panning fully to one side otherwise yields -0, which
    // reads oddly in a CSS offset and confuses an equality check.
    left: noNegativeZero(width <= box.width
      ? (box.width - width) / 2
      : -(width - box.width) * clamp01(pan.x)),
    top: noNegativeZero(height <= box.height
      ? (box.height - height) / 2
      : -(height - box.height) * clamp01(pan.y)),
    width,
    height,
    scale,
  };
}

/**
 * A point in the element (client coordinates minus the element's origin) as a
 * fraction of the remote screen, 0..1 on each axis.
 *
 * Returns null when the pointer is over a letterbox bar rather than the
 * picture: there is no remote pixel under it, and pretending there is would
 * plant the pointer on an edge it is not near.
 */
export function pointToRemote(point, mode, box, video, pan = { x: 0.5, y: 0.5 }) {
  const picture = pictureRect(mode, box, video, pan);
  if (picture.width <= 0 || picture.height <= 0) return null;
  const x = axis(point.x, picture.left, picture.width);
  const y = axis(point.y, picture.top, picture.height);
  if (x === null || y === null) return null;
  return { x, y };
}

/**
 * One axis, with the outermost half-pixel snapped to the very edge.
 *
 * Without that snap the edges are unreachable whenever the picture is smaller
 * than the screen it shows: a 768-row screen drawn 643 pixels tall moves about
 * 1.2 rows per pixel, so the last pixel lands on row 766 and the Dock, the menu
 * bar and hot corners never trigger. Half a pixel outside counts as the edge
 * too, because the browser rounds pointer positions.
 */
function axis(value, start, size) {
  /* One display pixel: a mouse on the outermost visible row of the picture is
     asking for the outermost row of the remote screen, and its coordinate can
     be a whole pixel inside the boundary. */
  const EDGE = 1;
  if (value <= start + EDGE) return value < start - EDGE ? null : 0;
  if (value >= start + size - EDGE) return value > start + size + EDGE ? null : 1;
  return clamp01((value - start) / size);
}

/**
 * The same, but never null: the nearest point on the picture. Used while a
 * button is held, so a drag that strays onto a bar keeps controlling the far
 * edge instead of stopping dead.
 */
export function nearestRemotePoint(point, mode, box, video, pan = { x: 0.5, y: 0.5 }) {
  const picture = pictureRect(mode, box, video, pan);
  if (picture.width <= 0 || picture.height <= 0) return { x: 0, y: 0 };
  return {
    x: axis(point.x, picture.left, picture.width) ?? clamp01((point.x - picture.left) / picture.width),
    y: axis(point.y, picture.top, picture.height) ?? clamp01((point.y - picture.top) / picture.height),
  };
}

/**
 * A fraction of the remote screen as a pixel on it. The last row and column are
 * reachable: 1 maps to size - 1, which is the edge the Dock and the menu bar
 * live on.
 */
export function remotePixel(fraction, size) {
  if (!size) return 0;
  return Math.min(size - 1, Math.max(0, Math.round(fraction * (size - 1))));
}

function noNegativeZero(value) {
  return value === 0 ? 0 : value;
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
