const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  ipcRenderer.removeAllListeners(channel); // 다시 불러도 듣는 쪽이 쌓이지 않게
  ipcRenderer.on(channel, (_, arg) => cb(arg));
}

contextBridge.exposeInMainWorld('api', {
  get: () => ipcRenderer.invoke('data:get'),
  set: (patch) => ipcRenderer.send('data:set', patch),
  onChanged: (cb) => on('data:changed', cb),

  open: (name, arg) => ipcRenderer.send('win:open', name, arg),
  hideList: () => ipcRenderer.send('list:hide'),
  onListShow: (cb) => on('list:show', cb),
  onSettingsGo: (cb) => on('settings:go', cb),
  onBoardFocus: (cb) => on('board:focus', cb),

  charMouse: (inside) => ipcRenderer.send('char:mouse', inside),
  dragStart: () => ipcRenderer.send('char:dragStart'),
  dragMove: () => ipcRenderer.send('char:dragMove'),
  dragEnd: () => ipcRenderer.send('char:dragEnd'),
  onKey: (cb) => on('char:key', cb),
  onSay: (cb) => on('char:say', cb),
  onDone: (cb) => on('char:done', cb),

  pickFile: (kind) => ipcRenderer.invoke('file:pick', kind),
  exportChar: (id) => ipcRenderer.invoke('char:export', id),
  importChar: () => ipcRenderer.invoke('char:import'),
  fonts: () => ipcRenderer.invoke('fonts:list'),
  setHotkey: (accel) => ipcRenderer.invoke('hotkey:set', accel),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  onUpdate: (cb) => on('update:status', cb),
  openFolder: (which) => ipcRenderer.send('open:folder', which),
  quit: () => ipcRenderer.send('app:quit'),
});
