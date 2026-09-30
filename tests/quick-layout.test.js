import test from 'node:test';
import assert from 'node:assert/strict';
import { centerPosition, QUICK_SIZES } from '../extension/src/model.js';

test('center uses the work area, accounting for menu bar and Dock', () => {
  assert.deepEqual(centerPosition({ width: 1280, height: 720 }, { left: 0, top: 25, width: 1440, height: 875 }), { left: 80, top: 103 });
});
test('center supports screens left of and above the primary display', () => {
  assert.deepEqual(centerPosition({ width: 1200, height: 800 }, { left: -1920, top: -1080, width: 1920, height: 1080 }), { left: -1560, top: -940 });
});
test('center rounds to integral coordinates and keeps entered size intact', () => {
  const size = { width: 1024, height: 768 };
  assert.deepEqual(centerPosition(size, { left: 40, top: 30, width: 1365, height: 901 }), { left: 211, top: 97 });
  assert.deepEqual(size, { width: 1024, height: 768 });
});
test('oversize centering does not silently change dimensions', () => {
  assert.deepEqual(centerPosition({ width: 1280, height: 720 }, { left: 0, top: 0, width: 800, height: 600 }), { left: -240, top: -60 });
});
test('center rejects invalid dimensions or work areas', () => {
  for (const width of [NaN, 0, -1, 1.5, Infinity]) assert.throws(() => centerPosition({ width, height: 500 }, { left: 0, top: 0, width: 1440, height: 900 }));
});
test('quick sizes exactly match their labeled ratios', () => {
  for (const size of QUICK_SIZES) {
    const [w, h] = size.ratio.split(':').map(Number);
    assert.equal(size.width * h, size.height * w);
  }
});
