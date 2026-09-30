export const MAX_PRESETS = 100;
export const STATES = { normal: '普通窗口', maximized: '最大化', fullscreen: '全屏' };
export const QUICK_SIZES = [
  { ratio: '16:9', width: 2560, height: 1440 },
  { ratio: '4:3', width: 2560, height: 1920 },
  { ratio: '3:2', width: 2400, height: 1600 },
  { ratio: '16:10', width: 2560, height: 1600 },
  { ratio: '1:1', width: 2560, height: 2560 },
];
const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

// Work areas exclude the menu bar, taskbar and Dock. Do not change the entered
// dimensions: the restore path independently fits oversize windows to the screen.
export function centerPosition(size, workArea) {
  const { width, height } = boundsOf({ ...size, left: 0, top: 0 });
  const area = boundsOf(workArea);
  return {
    left: area.left + Math.round((area.width - width) / 2),
    top: area.top + Math.round((area.height - height) / 2),
  };
}

export function boundsOf(value) {
  const result = {};
  for (const key of ['left', 'top', 'width', 'height']) {
    const n = value?.[key];
    if (!Number.isInteger(n) || Math.abs(n) > 100000 || ((key === 'width' || key === 'height') && n < 1)) {
      throw new Error('尺寸和坐标必须为有效整数，宽度和高度必须大于 0。');
    }
    result[key] = n;
  }
  return result;
}

export function validatePreset(value) {
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 40) {
    throw new Error('请填写 1-40 个字符的预设名称。');
  }
  if (!Object.hasOwn(STATES, value.state)) throw new Error('不支持的窗口状态。');
  let display = null;
  if (value.display != null) {
    if (typeof value.display.id !== 'string') throw new Error('显示器数据无效。');
    display = { id: value.display.id, workArea: boundsOf(value.display.workArea) };
  }
  return { name: value.name.trim(), ...boundsOf(value), state: value.state, display };
}

export function overlap(a, b) {
  return Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
}

export function displayFor(bounds, displays) {
  return [...displays].sort((a, b) => overlap(bounds, b.workArea) - overlap(bounds, a.workArea))[0];
}

export function capture(win, displays) {
  const bounds = boundsOf(win);
  const display = displayFor(bounds, displays);
  return { ...bounds, state: Object.hasOwn(STATES, win.state) ? win.state : 'normal',
    display: display ? { id: display.id, workArea: boundsOf(display.workArea) } : null };
}

// Keep a saved display-relative position if the monitor layout changes. If that
// display is gone, move to the current window's screen and keep the window visible.
export function fitToDisplays(preset, displays, current) {
  if (!displays.length) throw new Error('无法读取显示器信息，请稍后重试。');
  const original = boundsOf(preset);
  const same = displays.find(d => d.id === preset.display?.id);
  const best = displayFor(original, displays);
  const target = same || (preset.display ? displayFor(current, displays) :
    (overlap(original, best.workArea) > 0 ? best : displayFor(current, displays))) || displays.find(d => d.isPrimary) || displays[0];
  const area = target.workArea;
  let { left, top, width, height } = original;
  if (preset.display) {
    left += area.left - preset.display.workArea.left;
    top += area.top - preset.display.workArea.top;
  }
  width = Math.min(width, area.width);
  height = Math.min(height, area.height);
  left = clamp(left, area.left, area.left + area.width - width);
  top = clamp(top, area.top, area.top + area.height - height);
  const bounds = { left, top, width, height };
  return { bounds, adjusted: Object.keys(bounds).some(k => bounds[k] !== original[k]) };
}

export function parseBackup(input) {
  if (input?.app !== 'SizeSnap' || input.version !== 1 || !Array.isArray(input.presets) || input.presets.length > MAX_PRESETS) {
    throw new Error('备份格式无效，或预设数量超过 100 个。');
  }
  return input.presets.map(validatePreset);
}
