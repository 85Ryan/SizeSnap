import test from 'node:test';
import assert from 'node:assert/strict';
import { boundsOf, capture, fitToDisplays, parseBackup, validatePreset } from '../extension/src/model.js';
import { createController } from '../extension/src/controller.js';

const primary = { id: 'main', isPrimary: true, workArea: { left: 0, top: 25, width: 1440, height: 875 } };
const secondary = { id: 'side', workArea: { left: -1920, top: 0, width: 1920, height: 1080 } };
const original = { id: 7, type: 'normal', left: 100, top: 80, width: 1000, height: 700, state: 'normal' };
const preset = { name: '专注', left: 200, top: 100, width: 800, height: 600, state: 'normal', display: { id: 'main', workArea: primary.workArea } };
function storage() {
  const values = {};
  return { values, async get(keys) {
    if (typeof keys === 'string') return { [keys]: structuredClone(values[keys]) };
    if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, structuredClone(values[k])]));
    return { ...structuredClone(keys), ...structuredClone(values) };
  }, async set(data) { Object.assign(values, structuredClone(data)); }, async remove(keys) { for (const key of [keys].flat()) delete values[key]; } };
}
function fixture() {
  const calls = [];
  const wins = { 7: { ...original }, 8: { ...original, id: 8, left: 300 } };
  let screens = [primary, secondary];
  let fail = false;
  let id = 0;
  const api = { storage: { local: storage(), session: storage() }, system: { display: { async getInfo() { return screens; } } }, windows: {
    async get(n) { if (!wins[n]) throw new Error('Window closed'); return { ...wins[n] }; },
    async update(n, change) { if (fail) throw new Error('Native update failed'); calls.push({ n, ...change }); Object.assign(wins[n], change); return { ...wins[n] }; }
  } };
  const controller = createController(api, { wait: async () => {}, uuid: () => `id-${++id}` });
  const send = (type, extra = {}) => controller.handle({ type, windowId: 7, ...extra });
  return { api, controller, send, wins, calls, setScreens: value => { screens = value; }, fail: value => { fail = value; } };
}

test('negative coordinates and exact saved bounds remain on a connected secondary display', () => {
  const target = { ...preset, left: -1800, top: 60, display: { id: 'side', workArea: secondary.workArea } };
  assert.deepEqual(fitToDisplays(target, [primary, secondary], original), { bounds: boundsOf(target), adjusted: false });
});
test('monitor unplug moves a saved window onto the current screen', () => {
  const target = { ...preset, left: -1800, top: 60, display: { id: 'side', workArea: secondary.workArea } };
  const fitted = fitToDisplays(target, [primary], original);
  assert.deepEqual(fitted.bounds, { left: 120, top: 85, width: 800, height: 600 });
  assert.equal(fitted.adjusted, true);
});
test('rearranged monitor uses saved relative position', () => {
  const moved = { ...primary, workArea: { ...primary.workArea, left: 1920 } };
  assert.equal(fitToDisplays(preset, [moved], original).bounds.left, 2120);
});
test('oversized or offscreen geometry is fitted within work area', () => {
  assert.deepEqual(fitToDisplays({ left: 5000, top: -2000, width: 2000, height: 1400 }, [primary], original).bounds, primary.workArea);
});
test('largest intersection determines the screen; minimized capture becomes normal', () => {
  const result = capture({ ...original, left: -1200, state: 'minimized' }, [primary, secondary]);
  assert.equal(result.display.id, 'side'); assert.equal(result.state, 'normal');
});
test('invalid bounds, names, state and backup are rejected', () => {
  for (const value of [NaN, Infinity, 0, -1, 1.5, '800']) assert.throws(() => boundsOf({ ...preset, width: value }));
  for (const value of ['', ' '.repeat(5), 'x'.repeat(41)]) assert.throws(() => validatePreset({ ...preset, name: value }));
  assert.throws(() => validatePreset({ ...preset, state: 'minimized' }));
  assert.throws(() => validatePreset({ ...preset, state: 'toString' }));
  assert.throws(() => parseBackup({ app: 'other', version: 1, presets: [] }));
});
test('save captures real window; storage persists across controller restarts', async () => {
  const f = fixture(); const { preset: saved } = await f.send('save-current', { name: '写作' });
  assert.equal(saved.left, original.left); assert.equal(saved.name, '写作');
  const restarted = createController(f.api);
  assert.equal((await restarted.handle({ type: 'snapshot', windowId: 7 })).presets[0].id, saved.id);
});
test('concurrent saves are serialized without lost updates', async () => {
  const f = fixture(); await Promise.all(Array.from({ length: 20 }, () => f.send('save-current')));
  const data = await f.send('snapshot'); assert.equal(data.presets.length, 20); assert.equal(new Set(data.presets.map(p => p.id)).size, 20);
});
test('restore changes only the requested window; undo returns its original geometry', async () => {
  const f = fixture(); const { preset: saved } = await f.send('save-preset', { preset });
  await f.send('restore', { id: saved.id });
  assert.deepEqual(boundsOf(f.wins[7]), boundsOf(preset)); assert.equal(f.wins[8].left, 300);
  assert.equal((await f.send('snapshot')).canUndo, true);
  await f.send('undo'); assert.deepEqual(boundsOf(f.wins[7]), boundsOf(original));
  assert.equal((await f.send('snapshot')).canUndo, false);
});
test('exit fullscreen before changing bounds, and restore fullscreen on undo', async () => {
  const f = fixture(); f.wins[7].state = 'fullscreen';
  await f.send('apply-custom', { bounds: preset });
  assert.deepEqual(f.calls[0], { n: 7, state: 'normal' });
  assert.equal(f.calls[1].width, 800);
  await f.send('undo'); assert.equal(f.wins[7].state, 'fullscreen');
  for (const call of f.calls) if (call.state && call.state !== 'normal') assert.equal(call.width, undefined);
});
test('restoring maximized preset applies bounds before setting its state', async () => {
  const f = fixture(); const { preset: saved } = await f.send('save-preset', { preset: { ...preset, state: 'maximized' } });
  await f.send('restore', { id: saved.id });
  assert.equal(f.calls[0].width, preset.width); assert.equal(f.calls.at(-1).state, 'maximized');
});
test('restore-last uses the last used preset, with newest saved fallback', async () => {
  const f = fixture(); const a = (await f.send('save-preset', { preset })).preset;
  const b = (await f.send('save-preset', { preset: { ...preset, width: 1100 } })).preset;
  await f.send('restore-last'); assert.equal(f.wins[7].width, b.width);
  await f.send('restore', { id: a.id }); await f.send('restore-last'); assert.equal(f.wins[7].width, a.width);
});
test('manual edit refreshes screen metadata and preserves id', async () => {
  const f = fixture(); const a = (await f.send('save-preset', { preset })).preset;
  const b = (await f.send('save-preset', { id: a.id, preset: { ...a, name: '副屏', left: -1500 } })).preset;
  assert.equal(b.display.id, 'side'); assert.equal(b.id, a.id); assert.equal((await f.send('snapshot')).presets.length, 1);
});
test('renaming an unplugged display preset preserves original monitor metadata', async () => {
  const f = fixture();
  const a = (await f.send('save-preset', { preset: { ...preset, left: -1500 } })).preset;
  f.setScreens([primary]);
  const b = (await f.send('save-preset', { id: a.id, preset: { ...a, name: '重命名副屏' } })).preset;
  assert.deepEqual(b.display, a.display);
});
test('delete removes last preset reference, and stale edits cannot recreate it', async () => {
  const f = fixture(); const a = (await f.send('save-preset', { preset })).preset;
  await f.send('restore', { id: a.id }); await f.send('delete', { id: a.id });
  assert.equal((await f.send('snapshot')).lastPresetId, null);
  await assert.rejects(f.send('save-preset', { id: a.id, preset }), /删除/);
});
test('backup round trip merges with fresh ids and retains existing presets', async () => {
  const f = fixture(); await f.send('save-preset', { preset });
  const data = await f.send('export'); await f.send('import', { data });
  const list = (await f.send('snapshot')).presets;
  assert.equal(list.length, 2); assert.notEqual(list[0].id, list[1].id); assert.equal(list[0].name, list[1].name);
});
test('invalid import is atomic; preset limit rejects overflow', async () => {
  const f = fixture(); await f.send('save-preset', { preset });
  await assert.rejects(f.send('import', { data: { app: 'SizeSnap', version: 1, presets: [preset, { ...preset, width: -1 }] } }));
  assert.equal((await f.send('snapshot')).presets.length, 1);
  await f.send('import', { data: { app: 'SizeSnap', version: 1, presets: Array(99).fill(preset) } });
  await assert.rejects(f.send('save-current'), /100/);
});
test('failure is surfaced, queue recovers, and undo data survives failure', async () => {
  const f = fixture(); f.fail(true);
  await assert.rejects(f.send('apply-custom', { bounds: preset }), /Native/);
  assert.equal((await f.send('snapshot')).canUndo, true);
  f.fail(false); await f.send('undo'); assert.deepEqual(boundsOf(f.wins[7]), boundsOf(original));
});
test('undo is per window and closing the window clears session data', async () => {
  const f = fixture(); await f.send('apply-custom', { bounds: preset });
  assert.equal((await f.send('snapshot', { windowId: 8 })).canUndo, false);
  await f.controller.cleanup(7); assert.equal((await f.send('snapshot')).canUndo, false);
});
test('unsupported windows and missing displays do not move windows', async () => {
  const f = fixture(); f.wins[7].type = 'popup'; await assert.rejects(f.send('save-current'), /普通/);
  f.wins[7].type = 'normal'; f.setScreens([]); await assert.rejects(f.send('apply-custom', { bounds: preset }), /显示器/);
  assert.equal(f.calls.length, 0);
});
test('OS-imposed bounds are reported instead of claiming exact success', async () => {
  const f = fixture(); const update = f.api.windows.update;
  f.api.windows.update = (id, change) => update(id, { ...change, width: Math.max(change.width || 0, 500) });
  const result = await f.send('apply-custom', { bounds: { ...preset, width: 200 } });
  assert.match(result.message, /系统限制/);
});
