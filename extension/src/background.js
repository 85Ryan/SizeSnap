import { createController } from './controller.js';
const controller = createController(chrome);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  controller.handle(message).then(
    data => sendResponse({ ok: true, data }),
    error => sendResponse({ ok: false, error: error.message || '操作失败，请重试。' })
  );
  // Keep the worker alive even when resizing closes the action popup.
  return true;
});

chrome.windows.onRemoved.addListener(id => { controller.cleanup(id).catch(console.error); });
chrome.commands.onCommand.addListener(async command => {
  let win;
  try {
    win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    const result = await controller.handle({ type: command === 'undo-window' ? 'undo' : command, windowId: win.id });
    await chrome.storage.session.set({ [`notice:${win.id}`]: result.message });
    await chrome.action.setBadgeBackgroundColor({ color: '#28c840' });
    await chrome.action.setBadgeText({ text: '✓' });
  } catch (error) {
    if (win) await chrome.storage.session.set({ [`notice:${win.id}`]: `操作失败：${error.message}` });
    await chrome.action.setBadgeBackgroundColor({ color: '#b33d32' });
    await chrome.action.setBadgeText({ text: '!' });
  }
});
