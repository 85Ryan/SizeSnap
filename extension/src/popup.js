import { STATES, QUICK_SIZES, centerPosition } from './model.js';
const $ = id => document.getElementById(id);
let windowId;
let snapshot;
let editingId = null;
let deletingId = null;
let busy = false;
let centered = false;
let initialForm = '';
let suggestedName = '';
let restoreFocus = null;
let notificationTimer;
let refreshing = false;

function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.style.setProperty('--icon', `url("../icons/ui/${name}.svg")`);
  return span;
}
for (const element of document.querySelectorAll('[data-icon]')) {
  element.style.setProperty('--icon', `url("../icons/ui/${element.dataset.icon}.svg")`);
}

async function send(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ type, windowId, ...data });
  if (!response?.ok) throw new Error(response?.error || '后台未响应，请在扩展程序页面重新加载快窗。');
  return response.data;
}
function notify(message, error = false) {
  clearTimeout(notificationTimer);
  $('status-text').textContent = message;
  $('status').classList.toggle('error', error);
  $('status-icon').style.setProperty('--icon', `url("../icons/ui/${error ? 'warning-circle' : 'check-circle'}.svg")`);
  $('status').hidden = !message;
  if (message && !error) notificationTimer = setTimeout(() => { $('status').hidden = true; }, 4500);
}
function setBusy(value) {
  busy = value;
  $('main-scroll').setAttribute('aria-busy', String(value));
  document.querySelectorAll('button').forEach(button => {
    if (!['help-toggle', 'close-help', 'dismiss-status'].includes(button.id)) button.disabled = value;
  });
  $('undo').disabled = value || !snapshot?.canUndo;
  if (!value && restoreFocus) {
    restoreFocus.focus();
    restoreFocus = null;
  }
}
async function run(task) {
  if (busy) return;
  setBusy(true);
  $('form-error').hidden = true;
  try { await task(); } catch (error) {
    if (!$('editor').hidden) {
      $('form-error').textContent = error.message;
      $('form-error').hidden = false;
      $('form-error').scrollIntoView({ block: 'nearest' });
    } else notify(error.message, true);
  } finally { setBusy(false); }
}
function matchesCurrent(preset) {
  return preset.state === snapshot.current.state && ['width', 'height', 'left', 'top'].every(key => Math.abs(preset[key] - snapshot.current[key]) <= 2);
}
function presetRow(preset) {
  const row = document.createElement('div');
  row.className = 'preset-row';
  const matching = matchesCurrent(preset);
  row.classList.toggle('is-current', matching);
  const restore = document.createElement('button');
  restore.className = 'preset-restore';
  restore.title = `恢复 ${preset.name}：${preset.width} × ${preset.height}，位置 ${preset.left}, ${preset.top}`;
  restore.setAttribute('aria-label', `恢复 ${preset.name}`);
  // A real aspect-ratio thumbnail for this preset's saved dimensions.
  const thumbnail = document.createElement('span');
  thumbnail.className = 'preset-thumbnail';
  thumbnail.setAttribute('aria-hidden', 'true');
  const rectangle = document.createElement('span');
  rectangle.className = 'preset-rectangle';
  const scale = Math.min(34 / preset.width, 26 / preset.height);
  rectangle.style.setProperty('--preview-width', `${Math.max(6, preset.width * scale)}px`);
  rectangle.style.setProperty('--preview-height', `${Math.max(6, preset.height * scale)}px`);
  thumbnail.append(rectangle);
  const copy = document.createElement('span'); copy.className = 'preset-copy';
  const nameLine = document.createElement('span'); nameLine.className = 'preset-name-line';
  const name = document.createElement('span'); name.className = 'preset-name'; name.textContent = preset.name;
  nameLine.append(name);
  if (matching) {
    const tag = document.createElement('span'); tag.className = 'current-tag'; tag.textContent = '当前';
    nameLine.append(tag);
  }
  const meta = document.createElement('span'); meta.className = 'preset-meta';
  meta.textContent = `${preset.width} × ${preset.height} · ${preset.state === 'normal' ? `${preset.left}, ${preset.top}` : STATES[preset.state]}`;
  copy.append(nameLine, meta); restore.append(thumbnail, copy);
  restore.addEventListener('click', () => run(async () => {
    const result = await send('restore', { id: preset.id });
    await refresh(); notify(result.message);
    restoreFocus = findPresetButton(preset.id);
  }));
  restore.dataset.id = preset.id;
  const actions = document.createElement('div'); actions.className = 'preset-actions';
  const edit = document.createElement('button'); edit.className = 'row-action'; edit.append(icon('pencil-simple'));
  edit.setAttribute('aria-label', `编辑 ${preset.name}`); edit.title = '编辑预设';
  edit.addEventListener('click', () => openEditor(preset));
  const remove = document.createElement('button'); remove.className = 'row-action delete'; remove.append(icon('trash'));
  remove.setAttribute('aria-label', `删除 ${preset.name}`); remove.title = '删除预设';
  remove.addEventListener('click', () => {
    deletingId = preset.id;
    $('delete-name').textContent = `「${preset.name}」将从本机移除，此操作无法撤销。`;
    $('delete-dialog').showModal(); $('cancel-delete').focus();
  });
  actions.append(edit, remove); row.append(restore, actions);
  return row;
}
function findPresetButton(id) {
  return [...document.querySelectorAll('.preset-restore')].find(button => button.dataset.id === id) || $('new-preset');
}
function render() {
  const current = snapshot.current;
  $('current-width').textContent = current.width;
  $('current-height').textContent = current.height;
  $('current-position').textContent = `位置  X ${current.left}   ·   Y ${current.top}`;
  $('window-state').textContent = STATES[current.state];
  $('preset-count').textContent = snapshot.presets.length;
  $('empty').hidden = snapshot.presets.length > 0;
  $('list-hint').hidden = snapshot.presets.length === 0;
  // Keep the keyboard focus on the corresponding action during passive refreshes.
  const activeLabel = document.activeElement?.closest('.preset-row') ? document.activeElement.getAttribute('aria-label') : null;
  $('preset-list').replaceChildren(...snapshot.presets.map(presetRow));
  if (activeLabel) [...document.querySelectorAll('.preset-row button')].find(button => button.getAttribute('aria-label') === activeLabel)?.focus();
  $('undo').disabled = busy || !snapshot.canUndo;
  if (centered && !$('editor').hidden) recenter();
}
async function refresh(consumeNotice = true) { snapshot = await send('snapshot', { consumeNotice }); render(); }
async function passiveRefresh() {
  if (busy || refreshing) return;
  refreshing = true;
  try { await refresh(false); } catch (error) { notify(error.message, true); }
  finally { refreshing = false; }
}
function fillForm(preset) {
  for (const key of ['name', 'width', 'height', 'left', 'top', 'state']) $('preset-' + key).value = preset[key] ?? '';
  updateEditor();
}
function formValue() {
  return { name: $('preset-name').value.trim(), state: $('preset-state').value, display: null,
    ...Object.fromEntries(['width', 'height', 'left', 'top'].map(key => [key, $('preset-' + key).valueAsNumber])) };
}
function formFingerprint() {
  return JSON.stringify(['name', 'width', 'height', 'left', 'top', 'state'].map(key => $('preset-' + key).value));
}
function openEditor(preset = null) {
  editingId = preset?.id || null;
  centered = false;
  suggestedName = '';
  $('editor-title').textContent = preset ? '编辑预设' : '自定义预设';
  fillForm(preset || { ...snapshot.current, name: '', state: 'normal' });
  initialForm = formFingerprint();
  $('home-view').hidden = true; $('editor').hidden = false;
  $('home-footer').hidden = true; $('editor-footer').hidden = false;
  $('form-error').hidden = true;
  notify('');
  $('main-scroll').scrollTop = 0;
  if (busy) restoreFocus = $('preset-name');
  else $('preset-name').focus({ preventScroll: true });
}
function closeEditor(force = false) {
  if (!force && formFingerprint() !== initialForm) {
    $('discard-dialog').showModal(); $('keep-editing').focus(); return;
  }
  $('editor').hidden = true; $('home-view').hidden = false;
  $('editor-footer').hidden = true; $('home-footer').hidden = false;
  centered = false;
  const target = editingId ? findPresetButton(editingId) : $('new-preset');
  editingId = null;
  $('main-scroll').scrollTop = 0;
  if (busy) restoreFocus = target;
  else target.focus();
}
function recenter() {
  const value = formValue();
  const area = snapshot?.current.display?.workArea;
  if (!area || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 200 || value.height < 120 || value.width > 100000 || value.height > 100000) return;
  const position = centerPosition(value, area);
  $('preset-left').value = position.left;
  $('preset-top').value = position.top;
}
function updateEditor() {
  const value = formValue();
  for (const button of $('quick-sizes').children) {
    const size = QUICK_SIZES[Number(button.dataset.index)];
    button.setAttribute('aria-pressed', String(value.width === size.width && value.height === size.height));
  }
  $('center-window').setAttribute('aria-pressed', String(centered));
  $('center-label').textContent = centered ? '保持居中' : '屏幕居中';
  $('center-window').title = centered ? '尺寸变化时保持居中；点击取消' : '在当前窗口所在屏幕的可用区域居中';
  const area = snapshot?.current.display?.workArea;
  $('editor-hint').textContent = value.state !== 'normal'
    ? '最大化或全屏时，显示尺寸由系统决定。'
    : area && (value.width > area.width || value.height > area.height)
      ? '尺寸超出当前屏幕，应用时会自动适配到可见区域。'
      : centered ? '已按当前屏幕居中，修改尺寸会自动更新坐标。' : '位置以桌面左上角为原点，副屏可使用负值。';
}
QUICK_SIZES.forEach((size, index) => {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'quick-size'; button.dataset.index = index;
  button.setAttribute('aria-label', `${size.ratio}，${size.width} × ${size.height}`);
  button.setAttribute('aria-pressed', 'false');
  const title = document.createElement('strong'); title.textContent = size.ratio;
  const dimensions = document.createElement('small'); dimensions.textContent = `${size.width}×${size.height}`;
  button.append(title, dimensions);
  button.addEventListener('click', () => {
    $('preset-width').value = size.width; $('preset-height').value = size.height;
    $('preset-state').value = 'normal';
    if (!$('preset-name').value.trim() || $('preset-name').value === suggestedName) {
      suggestedName = `${size.ratio} 窗口`;
      $('preset-name').value = suggestedName;
    }
    if (centered) recenter();
    updateEditor();
  });
  $('quick-sizes').append(button);
});
$('center-window').addEventListener('click', () => run(async () => {
  if (centered) centered = false;
  else {
    for (const key of ['width', 'height']) if (!$('preset-' + key).reportValidity()) return;
    await refresh();
    if (!snapshot.current.display?.workArea) throw new Error('无法读取当前屏幕的可用区域。');
    centered = true;
    $('preset-state').value = 'normal';
    recenter();
  }
  updateEditor(); restoreFocus = $('center-window');
}));
for (const key of ['width', 'height', 'left', 'top', 'state']) {
  $('preset-' + key).addEventListener('input', () => {
    if (['left', 'top', 'state'].includes(key)) centered = false;
    if (centered) recenter();
    updateEditor();
  });
}
$('save-current').addEventListener('click', () => run(async () => {
  await send('save-current'); await refresh(); notify('窗口已保存，可用右侧编辑按钮命名。');
  restoreFocus = $('save-current');
}));
$('new-preset').addEventListener('click', () => openEditor());
$('cancel-edit').addEventListener('click', () => closeEditor());
$('keep-editing').addEventListener('click', () => $('discard-dialog').close());
$('discard-edit').addEventListener('click', () => { $('discard-dialog').close(); closeEditor(true); });
$('preset-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!$('preset-form').reportValidity()) return;
  run(async () => {
    const result = await send('save-preset', { id: editingId, preset: formValue() });
    await refresh(); closeEditor(true); notify(result.message);
  });
});
$('use-current').addEventListener('click', () => run(async () => {
  await refresh(); centered = false;
  fillForm({ ...snapshot.current, name: $('preset-name').value });
  restoreFocus = $('use-current');
}));
$('apply-custom').addEventListener('click', () => {
  for (const key of ['width', 'height', 'left', 'top']) if (!$('preset-' + key).reportValidity()) return;
  run(async () => {
    const result = await send('apply-custom', { bounds: formValue() });
    await refresh(); notify(result.message);
    restoreFocus = $('apply-custom');
  });
});
$('undo').addEventListener('click', () => run(async () => {
  const result = await send('undo'); await refresh(); notify(result.message); restoreFocus = $('save-current');
}));
$('cancel-delete').addEventListener('click', () => $('delete-dialog').close());
$('confirm-delete').addEventListener('click', () => run(async () => {
  const result = await send('delete', { id: deletingId });
  $('delete-dialog').close(); await refresh(); notify(result.message); restoreFocus = $('new-preset');
}));
$('help-toggle').addEventListener('click', () => { $('help').showModal(); $('help-toggle').setAttribute('aria-expanded', 'true'); });
$('close-help').addEventListener('click', () => $('help').close());
$('help').addEventListener('close', () => $('help-toggle').setAttribute('aria-expanded', 'false'));
$('dismiss-status').addEventListener('click', () => notify(''));
$('shortcuts').addEventListener('click', () => run(() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })));
$('export').addEventListener('click', () => run(async () => {
  const data = await send('export');
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `SizeSnap-${new Date().toISOString().slice(0, 10)}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000); notify('已导出预设备份。');
}));
$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', () => run(async () => {
  const file = $('import-file').files[0]; $('import-file').value = ''; if (!file) return;
  if (file.size > 1024 * 1024) throw new Error('备份文件不能超过 1 MB。');
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error('无法解析备份文件，请选择快窗导出的 JSON 文件。'); }
  const result = await send('import', { data }); await refresh(); notify(result.message);
}));
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || document.querySelector('dialog[open]') || $('editor').hidden || busy) return;
  event.preventDefault(); closeEditor();
});

async function init() {
  setBusy(true);
  if (!globalThis.chrome?.runtime?.id) {
    document.body.classList.remove('loading');
    notify('请在 Chrome 扩展程序中加载 SizeSnap，再从工具栏打开快窗。', true); return;
  }
  try {
    windowId = (await chrome.windows.getCurrent()).id;
    await refresh();
    if (snapshot.notice) notify(snapshot.notice, snapshot.notice.startsWith('操作失败'));
    await chrome.action.setBadgeText({ text: '' });
    document.body.classList.remove('loading');
    setBusy(false);
    chrome.windows.onBoundsChanged.addListener(win => { if (win.id === windowId) passiveRefresh(); });
    chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.presets) passiveRefresh(); });
  } catch (error) {
    document.body.classList.remove('loading');
    notify(`无法读取窗口：${error.message}。请重新打开快窗。`, true);
  }
}
init();
