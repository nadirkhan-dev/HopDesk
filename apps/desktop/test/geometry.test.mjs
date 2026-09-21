import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scaleFor, pictureRect, pointToRemote, nearestRemotePoint, remotePixel,
} from '../renderer/geometry.js';

/**
 * The bug these exist for: a Mac screen shown letterboxed in a wider window had
 * every pointer position measured against the window instead of the picture, so
 * clicks landed high and the bottom row — where the Dock is — could not be
 * reached at all.
 */

// A 16:10 Mac screen shown in a 16:9 window: bars top and bottom.
const mac = { width: 1920, height: 1200 };
const window16x9 = { left: 0, top: 0, width: 1600, height: 900 };

test('fit shows the whole screen, centred, with bars on the short side', () => {
  const picture = pictureRect('fit', window16x9, mac);
  assert.equal(picture.scale, 0.75);                 // 900 / 1200
  assert.equal(picture.width, 1440);
  assert.equal(picture.height, 900);
  assert.equal(picture.left, 80);                    // (1600 - 1440) / 2
  assert.equal(picture.top, 0);
});

test('the bottom row of the remote screen is reachable, which is where the Dock is', () => {
  // A 16:10 window showing a 16:9 screen: bars top and bottom.
  const box = { left: 0, top: 0, width: 1440, height: 1000 };
  const screen = { width: 1440, height: 900 };
  const picture = pictureRect('fit', box, screen);
  assert.equal(picture.top, 50);

  const bottom = pointToRemote({ x: 700, y: picture.top + picture.height }, 'fit', box, screen);
  assert.equal(bottom.y, 1, 'the last row was not reachable');
  assert.equal(remotePixel(bottom.y, screen.height), 899, 'the Dock row is off by one');

  // And the top row, where the menu bar is.
  const top = pointToRemote({ x: 700, y: picture.top }, 'fit', box, screen);
  assert.equal(top.y, 0);
  assert.equal(remotePixel(top.y, screen.height), 0);
});

test('the outermost pixel reaches the outermost row, however small the picture', () => {
  /* A 768-row screen drawn 643 pixels tall: without snapping, the last pixel
     maps to row 766 and a Mac's Dock never appears. */
  const box = { left: 0, top: 0, width: 1023, height: 643 };
  const screen = { width: 1024, height: 768 };
  const picture = pictureRect('fit', box, screen);

  const lastPixel = { x: 500, y: picture.top + picture.height - 0.5 };
  const at = pointToRemote(lastPixel, 'fit', box, screen);
  assert.equal(at.y, 1, 'the last displayed pixel did not map to the last row');
  assert.equal(remotePixel(at.y, screen.height), 767);

  const firstPixel = { x: 500, y: picture.top + 0.5 };
  assert.equal(pointToRemote(firstPixel, 'fit', box, screen).y, 0);

  // The whole outermost display pixel counts as the edge, inside or just outside.
  assert.equal(pointToRemote({ x: 500, y: picture.top + picture.height - 1 }, 'fit', box, screen).y, 1,
    'a mouse on the last visible row did not reach the last remote row');
  assert.equal(pointToRemote({ x: 500, y: picture.top - 0.4 }, 'fit', box, screen).y, 0);
  assert.equal(pointToRemote({ x: 500, y: picture.top - 3 }, 'fit', box, screen), null);
});

test('a point on a letterbox bar is not a point on the remote screen', () => {
  const box = { left: 0, top: 0, width: 1440, height: 1000 };
  const screen = { width: 1440, height: 900 };
  // 20px above the picture: over the bar.
  assert.equal(pointToRemote({ x: 700, y: 30 }, 'fit', box, screen), null);
  // The old, wrong answer measured against the element would have been 0.03.
  assert.equal(pointToRemote({ x: 700, y: 970 }, 'fit', box, screen), null);
});

test('measuring against the element instead of the picture is how far out it was', () => {
  const picture = pictureRect('fit', window16x9, mac);
  const point = { x: 800, y: 450 };                  // the middle of the element
  const correct = pointToRemote(point, 'fit', window16x9, mac);
  const naive = { x: point.x / window16x9.width, y: point.y / window16x9.height };
  assert.deepEqual(correct, { x: 0.5, y: 0.5 });
  // Horizontally the bars are 80px, which is 5% of the remote screen: 96 pixels.
  const offByPixels = Math.abs(remotePixel(correct.x, mac.width) - remotePixel(naive.x, mac.width));
  assert.equal(offByPixels, 0, 'the centre should agree');
  const nearLeft = { x: picture.left, y: 450 };
  assert.equal(remotePixel(pointToRemote(nearLeft, 'fit', window16x9, mac).x, mac.width), 0);
  assert.equal(remotePixel(nearLeft.x / window16x9.width, mac.width), 96,
    'the naive mapping is 96 pixels out at the left edge');
});

test('fill crops instead of letterboxing, and the visible part still maps correctly', () => {
  const box = { left: 0, top: 0, width: 1600, height: 900 };
  assert.equal(scaleFor('fill', box, mac), 1600 / 1920);
  const picture = pictureRect('fill', box, mac);
  assert.equal(picture.width, 1600);
  assert.equal(Math.round(picture.height), 1000);
  assert.equal(Math.round(picture.top), -50, 'the crop is not centred');

  // The middle of the element is still the middle of the screen.
  assert.deepEqual(pointToRemote({ x: 800, y: 450 }, 'fill', box, mac), { x: 0.5, y: 0.5 });
  // The top of the element is below the top of the screen, because it is cropped.
  const top = pointToRemote({ x: 800, y: 0 }, 'fill', box, mac);
  assert.ok(top.y > 0 && top.y < 0.1, `cropped top mapped to ${top.y}`);
});

test('1:1 shows one remote pixel per pixel here, panned when it does not fit', () => {
  const box = { left: 0, top: 0, width: 800, height: 600 };
  assert.equal(scaleFor('actual', box, mac), 1);

  const centred = pictureRect('actual', box, mac);
  assert.equal(centred.left, -(1920 - 800) / 2);
  assert.deepEqual(pointToRemote({ x: 400, y: 300 }, 'actual', box, mac), { x: 0.5, y: 0.5 });

  // Panned to the top left: the element's origin is the screen's origin.
  const panned = pictureRect('actual', box, mac, { x: 0, y: 0 });
  assert.equal(panned.left, 0);
  assert.deepEqual(pointToRemote({ x: 0, y: 0 }, 'actual', box, mac, { x: 0, y: 0 }), { x: 0, y: 0 });
  // Panned fully right: the element's right edge is the screen's right edge.
  const right = pointToRemote({ x: 800, y: 300 }, 'actual', box, mac, { x: 1, y: 0.5 });
  assert.equal(right.x, 1);
});

test('a drag that strays onto a bar keeps hold of the nearest edge', () => {
  const box = { left: 0, top: 0, width: 1440, height: 1000 };
  const screen = { width: 1440, height: 900 };
  assert.equal(pointToRemote({ x: 700, y: -40 }, 'fit', box, screen), null);
  assert.deepEqual(nearestRemotePoint({ x: 700, y: -40 }, 'fit', box, screen),
    { x: 700 / 1440, y: 0 });
  assert.deepEqual(nearestRemotePoint({ x: 2000, y: 2000 }, 'fit', box, screen), { x: 1, y: 1 });
});

test('a video with no size yet does not produce nonsense', () => {
  const box = { left: 0, top: 0, width: 800, height: 600 };
  assert.equal(pointToRemote({ x: 10, y: 10 }, 'fit', box, { width: 0, height: 0 }), null);
  assert.equal(remotePixel(0.5, 0), 0);
});

test('every fraction lands inside the screen, including exactly 1', () => {
  for (const size of [1, 2, 900, 1200, 3840]) {
    assert.equal(remotePixel(0, size), 0);
    assert.equal(remotePixel(1, size), size - 1);
    assert.ok(remotePixel(1.5, size) <= size - 1);
    assert.ok(remotePixel(-2, size) >= 0);
  }
});
