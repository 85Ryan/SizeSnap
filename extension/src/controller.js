import { MAX_PRESETS, boundsOf, capture, fitToDisplays, parseBackup, validatePreset } from './model.js';

export function createController(api, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)), uuid = () => crypto.randomUUID() } = {}) {
  let queue = Promise.resolve();
  const serialize = task => {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  };
  const read = async () => {
    const data = await api.storage.local.get({ presets: [], lastPresetId: null });
    if (!Array.isArray(data.presets)) throw new Error('本地预设数据无法读取，请先导出备份。');
    return data;
  };
  const displays = async () => {
    const values = (await api.system.display.getInfo()).filter(d => d.isEnabled !== false && d.workArea.width > 0 && d.workArea.height > 0);
    if (!values.length) throw new Error('没有可用的显示器。');
    return values;
  };
  const windowFor = async id => {
    const win = await api.windows.get(id);
    if (win.type !== 'normal') throw new Error('请在普通 Chrome 浏览器窗口中使用快窗。');
    return win;
  };
  const undoKey = id => `undo:${id}`;
  const noticeKey = id => `notice:${id}`;
  const notice = async (id, message) => api.storage.session.set({ [noticeKey(id)]: message });

  async function setGeometry(id, target, screens, current) {
    const fit = fitToDisplays(target, screens, current);
    if (current.state !== 'normal') {
      await api.windows.update(id, { state: 'normal' });
      // macOS exits a fullscreen Space asynchronously; wait before setting bounds.
      let normal = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await wait(100);
        if ((await api.windows.get(id)).state === 'normal') { normal = true; break; }
      }
      if (!normal) throw new Error('窗口仍在切换全屏状态，请退出全屏后重试。');
      if (current.state === 'fullscreen') await wait(400);
    }
    let result = await api.windows.update(id, { ...fit.bounds, focused: true });
    // Recheck committed bounds once to handle delayed native window transitions.
    await wait(120);
    result = await api.windows.get(id);
    if (Object.keys(fit.bounds).some(k => Math.abs(result[k] - fit.bounds[k]) > 2)) {
      result = await api.windows.update(id, fit.bounds);
    }
    if (target.state !== 'normal') result = await api.windows.update(id, { state: target.state, focused: true });
    const osAdjusted = target.state === 'normal' && Object.keys(fit.bounds).some(k => Math.abs(result[k] - fit.bounds[k]) > 2);
    return { result, adjusted: fit.adjusted || osAdjusted };
  }

  async function restore(id, target, label) {
    const current = await windowFor(id);
    const screens = await displays();
    await api.storage.session.set({ [undoKey(id)]: capture(current, screens) });
    const { adjusted } = await setGeometry(id, target, screens, current);
    const message = adjusted ? `${label}；已按当前屏幕或系统限制调整。` : label;
    await notice(id, message);
    return { message };
  }

  async function dispatch(message) {
    const { type, windowId } = message;
    if (type === 'snapshot') {
      const consumeNotice = message.consumeNotice !== false;
      const [data, win, screens, session] = await Promise.all([
        read(), windowFor(windowId), displays(),
        api.storage.session.get(consumeNotice ? [undoKey(windowId), noticeKey(windowId)] : undoKey(windowId)),
      ]);
      if (consumeNotice && Object.hasOwn(session, noticeKey(windowId))) {
        await api.storage.session.remove(noticeKey(windowId));
      }
      return { ...data, current: capture(win, screens), canUndo: Boolean(session[undoKey(windowId)]), notice: session[noticeKey(windowId)] || '' };
    }
    if (type === 'save-current') {
      const data = await read();
      if (data.presets.length >= MAX_PRESETS) throw new Error('最多保存 100 个预设，请先删除不再使用的预设。');
      const win = await windowFor(windowId);
      const value = validatePreset({ ...capture(win, await displays()), name: message.name || `窗口 ${win.width} × ${win.height}` });
      const preset = { ...value, id: uuid(), createdAt: Date.now() };
      await api.storage.local.set({ presets: [...data.presets, preset] });
      return { message: '已保存当前窗口。', preset };
    }
    if (type === 'save-preset') {
      const data = await read();
      const value = validatePreset(message.preset);
      const existing = message.id ? data.presets.find(p => p.id === message.id) : null;
      if (message.id && !existing) throw new Error('这个预设已被删除，请重新打开面板。');
      if (!existing && data.presets.length >= MAX_PRESETS) throw new Error('最多保存 100 个预设。');
      // Renaming must preserve the saved monitor, including when it is unplugged.
      // Only newly entered coordinates refer to today's desktop layout.
      const sameBounds = existing && ['left', 'top', 'width', 'height'].every(key => existing[key] === value[key]);
      const metadata = sameBounds ? existing.display : capture(value, await displays()).display;
      const preset = { ...value, display: metadata, id: existing?.id || uuid(), createdAt: existing?.createdAt || Date.now() };
      await api.storage.local.set({ presets: existing ? data.presets.map(p => p.id === existing.id ? preset : p) : [...data.presets, preset] });
      return { message: existing ? '预设已更新。' : '新预设已保存。', preset };
    }
    if (type === 'delete') {
      const data = await read();
      await api.storage.local.set({ presets: data.presets.filter(p => p.id !== message.id), lastPresetId: data.lastPresetId === message.id ? null : data.lastPresetId });
      return { message: '预设已删除。' };
    }
    if (type === 'restore' || type === 'restore-last') {
      const data = await read();
      const id = type === 'restore-last' ? data.lastPresetId || data.presets.at(-1)?.id : message.id;
      const preset = data.presets.find(p => p.id === id);
      if (!preset) throw new Error('还没有可恢复的预设，请先保存当前窗口。');
      const result = await restore(windowId, validatePreset(preset), `已恢复「${preset.name}」`);
      await api.storage.local.set({ lastPresetId: id });
      return result;
    }
    if (type === 'apply-custom') {
      return restore(windowId, { ...boundsOf(message.bounds), state: 'normal', display: null }, '已应用自定义尺寸与位置');
    }
    if (type === 'undo') {
      const key = undoKey(windowId);
      const saved = (await api.storage.session.get(key))[key];
      if (!saved) throw new Error('这个窗口还没有可以撤销的调整。');
      const current = await windowFor(windowId);
      const { adjusted } = await setGeometry(windowId, saved, await displays(), current);
      await api.storage.session.remove(key);
      const result = { message: adjusted ? '已撤销；已按当前屏幕或系统限制调整。' : '已恢复调整前的窗口。' };
      await notice(windowId, result.message);
      return result;
    }
    if (type === 'export') {
      const data = await read();
      return { app: 'SizeSnap', version: 1, presets: data.presets.map(validatePreset) };
    }
    if (type === 'import') {
      const incoming = parseBackup(message.data);
      const data = await read();
      if (data.presets.length + incoming.length > MAX_PRESETS) throw new Error('导入后将超过 100 个预设，请先清理部分预设。');
      await api.storage.local.set({ presets: [...data.presets, ...incoming.map(p => ({ ...p, id: uuid(), createdAt: Date.now() }))] });
      return { message: `已导入 ${incoming.length} 个预设，原有预设已保留。` };
    }
    throw new Error('未知操作，请重新打开快窗。');
  }
  return { handle: message => serialize(() => dispatch(message)),
    cleanup: id => serialize(() => api.storage.session.remove([undoKey(id), noticeKey(id)])) };
}
