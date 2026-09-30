import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(import.meta.dirname, '..');
const extensionRoot = join(root, 'dist');
const profile = await mkdtemp(join(tmpdir(), 'sizesnap-e2e-'));
await mkdir(join(root, 'test-results'), { recursive: true });
let context;
let passed = 0;
const pass = title => { passed++; console.log(`PASS ${title}`); };
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    headless: process.env.HEADED !== '1', channel: 'chromium', viewport: null,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = worker.url().split('/')[2];
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.waitForFunction(() => !document.getElementById('save-current').disabled);
  return { page, worker, id, errors };
}
const ready = page => page.waitForFunction(() => !document.getElementById('save-current').disabled);
const geometry = page => page.evaluate(async () => {
  const { left, top, width, height } = await chrome.windows.getCurrent(); return { left, top, width, height };
});
const screenshot = async (page, name) => {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
  await page.locator('body').screenshot({ path: join(root, 'test-results', name + '.png') });
};
try {
  let { page, worker, id, errors } = await launch();
  assert.equal(await page.locator('#empty').isVisible(), true);
  await screenshot(page, 'empty'); pass('Real extension loads with no presets');
  await page.click('#save-current'); await ready(page);
  assert.equal(await page.locator('.preset-row').count(), 1); pass('Save real Chrome window');
  await page.getByRole('button', { name: /^编辑 / }).click();
  await page.fill('#preset-name', '日常浏览'); await page.getByRole('button', { name: '保存预设', exact: true }).click(); await ready(page);
  assert.equal(await page.getByRole('button', { name: '恢复 日常浏览', exact: true }).count(), 1); pass('Rename stored preset');
  await page.evaluate(async () => {
    const { id } = await chrome.windows.getCurrent();
    await chrome.storage.session.set({ [`notice:${id}`]: '仅显示一次的提示' });
  });
  await page.reload(); await ready(page);
  assert.equal(await page.locator('#status-text').innerText(), '仅显示一次的提示');
  await page.click('#dismiss-status');
  await page.reload(); await ready(page);
  assert.equal(await page.locator('#status').isVisible(), false);
  pass('Dismissed notice does not reappear after reopening the popup');
  await page.click('#new-preset');
  const startingGeometry = await geometry(page);
  const sizes = [['16:9', 2560, 1440], ['4:3', 2560, 1920], ['3:2', 2400, 1600], ['16:10', 2560, 1600], ['1:1', 2560, 2560]];
  for (const [ratio, width, height] of sizes) {
    await page.getByRole('button', { name: `${ratio}，${width} × ${height}`, exact: true }).click();
    assert.equal(await page.inputValue('#preset-width'), String(width));
    assert.equal(await page.inputValue('#preset-height'), String(height));
    assert.equal(await page.inputValue('#preset-name'), `${ratio} 窗口`);
  }
  assert.deepEqual(await geometry(page), startingGeometry);
  pass('Five ratio sizes populate the form without moving the actual window');
  await page.fill('#preset-name', '保留自定义名称');
  await page.getByRole('button', { name: '16:9，2560 × 1440', exact: true }).click();
  assert.equal(await page.inputValue('#preset-name'), '保留自定义名称');
  await page.fill('#preset-width', '640'); await page.fill('#preset-height', '480');
  await page.click('#center-window'); await ready(page);
  const area = await page.evaluate(async () => {
    const current = await chrome.windows.getCurrent();
    return (await chrome.runtime.sendMessage({ type: 'snapshot', windowId: current.id })).data.current.display.workArea;
  });
  const centeredPosition = (width, height) => ({ left: area.left + Math.round((area.width - width) / 2), top: area.top + Math.round((area.height - height) / 2) });
  assert.equal(await page.inputValue('#preset-left'), String(centeredPosition(640, 480).left));
  assert.equal(await page.inputValue('#preset-top'), String(centeredPosition(640, 480).top));
  await page.click('#apply-custom'); await ready(page);
  assert.deepEqual(await geometry(page), { width: 640, height: 480, ...centeredPosition(640, 480) });
  await page.evaluate(bounds => chrome.windows.getCurrent().then(win => chrome.windows.update(win.id, bounds)), startingGeometry);
  if (await page.locator('#dismiss-status').isVisible()) await page.click('#dismiss-status');
  pass('Centered coordinates apply to the actual Chrome window');
  await page.fill('#preset-width', '700');
  assert.equal(await page.inputValue('#preset-left'), String(centeredPosition(700, 480).left));
  await page.getByRole('button', { name: '3:2，2400 × 1600', exact: true }).click();
  assert.equal(await page.inputValue('#preset-left'), String(centeredPosition(2400, 1600).left));
  await page.evaluate(() => { document.getElementById('main-scroll').scrollTop = 0; });
  await screenshot(page, 'editor-light');
  await page.emulateMedia({ colorScheme: 'dark' }); await screenshot(page, 'editor-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.fill('#preset-left', '80');
  assert.equal(await page.getAttribute('#center-window', 'aria-pressed'), 'false');
  await page.fill('#preset-width', '640');
  assert.equal(await page.inputValue('#preset-left'), '80');
  pass('Center uses the active display, follows size changes and exits on manual coordinates');
  await page.click('#cancel-edit');
  assert.equal(await page.locator('#discard-dialog').isVisible(), true);
  await page.click('#keep-editing');
  assert.equal(await page.inputValue('#preset-name'), '保留自定义名称');
  pass('Unsaved changes are protected when returning to presets');
  await page.fill('#preset-name', '专注写作');
  await page.fill('#preset-width', '640'); await page.fill('#preset-height', '480');
  await page.fill('#preset-left', '80'); await page.fill('#preset-top', '60');
  await page.getByRole('button', { name: '保存预设', exact: true }).click(); await ready(page);
  const before = await geometry(page);
  await page.getByRole('button', { name: '恢复 专注写作', exact: true }).click(); await ready(page);
  assert.deepEqual(await geometry(page), { width: 640, height: 480, left: 80, top: 60 }); pass('Restore actual Chrome bounds');
  await page.click('#undo'); await ready(page);
  assert.deepEqual(await geometry(page), before); pass('Undo actual Chrome bounds');
  await page.click('#new-preset');
  await page.fill('#preset-width', '700'); await page.fill('#preset-height', '500');
  await page.fill('#preset-left', '40'); await page.fill('#preset-top', '40');
  await page.click('#apply-custom'); await ready(page);
  assert.deepEqual(await geometry(page), { width: 700, height: 500, left: 40, top: 40 });
  await page.click('#cancel-edit'); await page.click('#discard-edit'); pass('Apply custom bounds without requiring a preset name');
  if (await page.locator('#dismiss-status').isVisible()) await page.click('#dismiss-status');
  await screenshot(page, 'presets-light');
  await page.emulateMedia({ colorScheme: 'dark' }); await screenshot(page, 'presets-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth), false); pass('Light/dark rendering has no horizontal overflow');
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return Object.fromEntries(['surface', 'canvas', 'soft', 'ink', 'muted', 'accent', 'on-accent', 'accent-text', 'tint', 'focus'].map(key => [key, style.getPropertyValue('--' + key).trim()]));
    });
    const luminance = hex => {
      const rgb = hex.slice(1).match(/.{2}/g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
    for (const [fg, bg] of [['on-accent', 'accent'], ['ink', 'surface'], ['muted', 'surface'], ['muted', 'canvas'], ['muted', 'soft'], ['accent-text', 'tint']]) {
      assert(contrast(tokens[fg], tokens[bg]) >= 4.5, `${scheme} ${fg}/${bg} must meet AA`);
    }
    assert.equal(tokens.accent.toLowerCase(), '#28c840');
    const iconResults = await page.evaluate(async () => Promise.all([...document.querySelectorAll('[data-icon]')].map(async element => (await fetch(`icons/ui/${element.dataset.icon}.svg`)).ok)));
    assert(iconResults.every(Boolean));
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  assert.equal(await page.locator('.view').first().evaluate(el => getComputedStyle(el).animationName), 'none');
  pass('Local icons, brand green, light/dark AA contrast and reduced motion');
  const downloadPromise = page.waitForEvent('download'); await page.click('#export');
  const download = await downloadPromise; const backup = join(profile, 'backup.json'); await download.saveAs(backup); await ready(page);
  await page.locator('#import-file').setInputFiles(backup); await ready(page);
  await page.waitForFunction(() => document.querySelectorAll('.preset-row').length === 4); pass('Export and import backup via real UI');
  await page.getByRole('button', { name: '删除 专注写作', exact: true }).last().click();
  await page.click('#cancel-delete'); assert.equal(await page.locator('.preset-row').count(), 4);
  await page.getByRole('button', { name: '删除 专注写作', exact: true }).last().click();
  await page.click('#confirm-delete'); await ready(page);
  assert.equal(await page.locator('.preset-row').count(), 3); pass('Delete confirmation and cancel');
  await page.locator('#import-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{bad}') });
  await page.waitForFunction(() => document.getElementById('status').classList.contains('error'));
  assert.equal(await page.locator('.preset-row').count(), 3); pass('Invalid import reports error and preserves presets');
  assert.deepEqual(errors, []);
  await context.close();
  ({ page, worker, id, errors } = await launch());
  assert.equal(await page.locator('.preset-row').count(), 3); pass('Presets survive browser restart');
  // Start a real message, close its sender while the worker is applying bounds.
  const windowId = await page.evaluate(async () => (await chrome.windows.getCurrent()).id);
  await page.evaluate(() => {
    chrome.windows.getCurrent().then(win => { chrome.runtime.sendMessage({ type: 'apply-custom', windowId: win.id, bounds: { left: 50, top: 50, width: 660, height: 490 } }).catch(() => {}); });
  });
  await worker.evaluate(async id => {
    for (let n = 0; n < 50; n++) {
      if ((await chrome.storage.session.get(`undo:${id}`))[`undo:${id}`]) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Message was not received');
  }, windowId);
  await page.close();
  await worker.evaluate(async id => {
    for (let n = 0; n < 50; n++) {
      const notice = (await chrome.storage.session.get(`notice:${id}`))[`notice:${id}`];
      if (notice) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Background operation did not finish');
  }, windowId);
  const actual = await worker.evaluate(async id => { const { width, height, left, top } = await chrome.windows.get(id); return { width, height, left, top }; }, windowId);
  assert.deepEqual(actual, { width: 660, height: 490, left: 50, top: 50 }); pass('Background completes after sender closes');
  assert.deepEqual(errors, []);
  // Stress the compact panel without touching the user's saved extension data.
  const stressPage = await context.newPage();
  await stressPage.goto(`chrome-extension://${id}/popup.html`);
  await ready(stressPage);
  await stressPage.evaluate(async () => {
    const presets = Array.from({ length: 30 }, (_, i) => ({ id: `stress-${i}`, name: '很长的预设名称'.repeat(5), width: 100000, height: 100000, left: -100000, top: -100000, state: 'normal', display: null }));
    await chrome.storage.local.set({ presets });
  });
  await stressPage.waitForFunction(() => document.querySelectorAll('.preset-row').length === 30);
  assert.equal(await stressPage.evaluate(() => document.getElementById('main-scroll').scrollWidth > document.getElementById('main-scroll').clientWidth), false);
  await stressPage.evaluate(() => { const main = document.getElementById('main-scroll'); main.scrollTop = main.scrollHeight; });
  const footer = await stressPage.locator('#home-footer').boundingBox();
  assert(footer.y + footer.height <= 601);
  await stressPage.click('#new-preset');
  assert.equal(await stressPage.evaluate(() => document.activeElement.id), 'preset-name');
  await stressPage.press('#preset-name', 'Escape');
  assert.equal(await stressPage.evaluate(() => document.activeElement.id), 'new-preset');
  pass('Long names and 30 presets stay within the panel; keyboard focus returns correctly');
  console.log(`${passed} browser checks passed.`);
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
