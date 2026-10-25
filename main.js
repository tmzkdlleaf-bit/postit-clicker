// 포스트잇 클리커 — 프로그램 본체
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, Notification, dialog, shell, globalShortcut, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');
const S = require('./src/shared.js');
const Sync = require('./sync.js');
let sync = null;

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (e) { console.warn('[업데이트] electron-updater 없음'); }
let uIOhook = null;
try { ({ uIOhook } = require('uiohook-napi')); } catch (e) { console.warn('[키보드 감지] uiohook-napi 없음'); }

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId('com.nabi.postit-clicker');

const SRC = path.join(__dirname, 'src');
const ICON = path.join(SRC, 'icon.png');
const PRELOAD = path.join(__dirname, 'preload.js');
let DATA_FILE, ASSET_DIR, BACKUP_DIR;
let data;
const charWins = new Map(); // 캐릭터 id → 창
let listWin = null, boardWin = null, settingsWin = null, tray = null;
let hotkeyNow = '';

/* ---------- 저장 ---------- */
function loadData() {
  try { return S.normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); }
  catch (e) {
    if (fs.existsSync(DATA_FILE)) { try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.broken-' + Date.now()); } catch (_) {} }
    return S.defaultData();
  }
}
let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  try { const tmp = DATA_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, DATA_FILE); }
  catch (e) { console.error('[저장 실패]', e); }
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); }
function allWins() { return [...charWins.values(), listWin, boardWin, settingsWin].filter(w => w && !w.isDestroyed()); }
function broadcast(except) {
  if (sync) data.state.deleted = sync.deletedIds(); // 다른 기기에서 지운 것도 화면이 알 수 있게
  for (const w of allWins()) if (w.webContents !== except) w.webContents.send('data:changed', data);
}
const charById = id => data.settings.characters.find(c => c.id === id);
const idOfWin = win => { for (const [id, w] of charWins) if (w === win) return id; return null; };

/* ---------- 캐릭터 창 ---------- */
function winSize(c) { const s = c.size || 160; return { width: Math.max(s + 80, 280), height: s + 130 }; }
function defaultPos(size, i = 0) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - size.width - 40 - i * (size.width - 60), y: wa.y + wa.height - size.height };
}
function onScreen(x, y, w, h) {
  return screen.getAllDisplays().some(d => { const a = d.workArea; const cx = x + w / 2, cy = y + h / 2;
    return cx > a.x && cx < a.x + a.width && cy > a.y && cy < a.y + a.height; });
}
function createCharWin(c) {
  const size = winSize(c);
  let p = c.pos;
  if (!p || !onScreen(p.x, p.y, size.width, size.height)) p = defaultPos(size, data.settings.characters.indexOf(c));
  const win = new BrowserWindow({
    ...size, x: Math.round(p.x), y: Math.round(p.y),
    frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false, backgroundColor: '#00000000',
    // webSecurity 끔: 고른 그림의 투명한 부분을 읽어 클릭 통과를 정확히 하려고. 이 창은 내 컴퓨터 파일만 띄움
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, webSecurity: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(SRC, 'character.html'), { query: { id: c.id } });
  win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => { if (charWins.get(c.id) === win) charWins.delete(c.id); });
  charWins.set(c.id, win);
}
// 설정이 바뀌면 캐릭터 창을 맞춰서 열고 닫고 크기 바꾸기
const lastSize = new Map();
function syncCharWins() {
  const ids = new Set();
  data.settings.characters.forEach(c => {
    if (c.visible === false) return;
    ids.add(c.id);
    const w = charWins.get(c.id);
    if (!w) { createCharWin(c); lastSize.set(c.id, c.size); return; }
    if (lastSize.get(c.id) !== c.size) {
      const size = winSize(c), b = w.getBounds();
      w.setBounds({ x: Math.round(b.x + b.width / 2 - size.width / 2), y: Math.round(b.y + b.height - size.height), ...size });
      lastSize.set(c.id, c.size);
    }
  });
  for (const [id, w] of charWins) if (!ids.has(id)) { w.destroy(); charWins.delete(id); }
}
function firstChar() { for (const c of data.settings.characters) { const w = charWins.get(c.id); if (w) return w; } return null; }

/* ---------- 할 일 목록 창 ---------- */
function createListWin() {
  listWin = new BrowserWindow({
    width: 360, height: 540, show: false, frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, maximizable: false, fullscreenable: false, backgroundColor: '#00000000',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  listWin.setAlwaysOnTop(true, 'pop-up-menu');
  listWin.loadFile(path.join(SRC, 'list.html'));
  listWin.on('blur', () => { if (listWin && !listWin.webContents.isDevToolsOpened()) listWin.hide(); });
  listWin.on('closed', () => { listWin = null; });
}
function showList(fromWin, toggle) {
  if (!listWin) createListWin();
  if (toggle && listWin.isVisible()) { listWin.hide(); return; } // 단축키·트레이: 한 번 더 누르면 닫기
  const [lw, lh] = listWin.getSize();
  const cw = fromWin && !fromWin.isDestroyed() ? fromWin : null;
  let anchor;
  if (cw) anchor = cw.getBounds();
  else { const c = screen.getCursorScreenPoint(); anchor = { x: c.x, y: c.y, width: 0, height: 0 }; }
  const wa = screen.getDisplayMatching(anchor).workArea;
  let x = anchor.x - lw + 30; if (x < wa.x) x = anchor.x + anchor.width - 30;
  let y = cw ? anchor.y + anchor.height - lh : anchor.y - 20;
  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - lw);
  y = Math.min(Math.max(y, wa.y), wa.y + wa.height - lh);
  listWin.setPosition(Math.round(x), Math.round(y));
  const go = () => { listWin.show(); listWin.focus(); listWin.webContents.send('list:show', data); };
  if (listWin.webContents.isLoading()) listWin.webContents.once('did-finish-load', go); else go();
}

/* ---------- 판 / 설정 창 ---------- */
function openBoard(focus) {
  if (listWin && listWin.isVisible()) listWin.hide();
  const sendFocus = () => { if (focus && boardWin) boardWin.webContents.send('board:focus', focus); };
  if (boardWin) { if (boardWin.isMinimized()) boardWin.restore(); boardWin.show(); boardWin.focus(); sendFocus(); return; }
  const b = data.settings.boardBounds;
  boardWin = new BrowserWindow({
    width: (b && b.width) || 1200, height: (b && b.height) || 800, x: b && b.x, y: b && b.y,
    minWidth: 520, minHeight: 360, title: '포스트잇', icon: ICON, autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191918' : '#f9f9f8',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  boardWin.setMenu(null); // 판 안에서 Ctrl+휠·Ctrl+=를 확대·축소로 쓰려고 기본 메뉴 단축키를 뺌
  boardWin.loadFile(path.join(SRC, 'board.html'));
  boardWin.webContents.once('did-finish-load', () => setTimeout(sendFocus, 300));
  boardWin.on('close', () => { data.settings.boardBounds = boardWin.getBounds(); save(); });
  boardWin.on('closed', () => { boardWin = null; });
}
function openSettings(section) {
  if (listWin && listWin.isVisible()) listWin.hide();
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); if (section) settingsWin.webContents.send('settings:go', section); return; }
  settingsWin = new BrowserWindow({
    width: 760, height: 780, minWidth: 600, minHeight: 480, title: '설정', icon: ICON, autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111110' : '#fdfdfc',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.loadFile(path.join(SRC, 'settings.html'), section ? { hash: section } : undefined);
  settingsWin.on('closed', () => { settingsWin = null; });
}

/* ---------- 트레이 ---------- */
function buildTray() {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip('포스트잇 클리커');
    tray.on('click', () => showList(firstChar(), true));
  }
  const chars = data.settings.characters.map(c => ({
    label: c.name, type: 'checkbox', checked: c.visible !== false,
    click: () => { c.visible = !(c.visible !== false); save(); syncCharWins(); buildTray(); broadcast(null); },
  }));
  const updItems = [];
  if (upd.state === 'available') updItems.push({ label: `새 버전 ${upd.version} 받기`, click: () => autoUpdater.downloadUpdate() });
  else if (upd.state === 'downloading') updItems.push({ label: `새 버전 받는 중 ${upd.percent || 0}%`, enabled: false });
  else if (upd.state === 'ready') updItems.push({ label: `재시작해서 ${upd.version} 설치`, click: installNow });
  if (updItems.length) updItems.push({ type: 'separator' });
  tray.setContextMenu(Menu.buildFromTemplate([
    ...updItems,
    { label: '할 일 목록', accelerator: hotkeyNow || undefined, click: () => showList(firstChar(), true) },
    { label: '포스트잇 판', click: openBoard },
    { type: 'separator' },
    ...chars,
    { label: '캐릭터 위치 되돌리기', click: () => {
        data.settings.characters.forEach((c, i) => { const w = charWins.get(c.id); if (!w) return;
          const p = defaultPos(winSize(c), i); w.setPosition(p.x, p.y); c.pos = p; }); save(); } },
    { type: 'separator' },
    { label: '설정', click: () => openSettings() },
    { label: '업데이트 확인', click: () => checkUpdate(true) },
    { label: '종료', click: () => app.quit() },
  ]));
}

/* ---------- 단축키 / 화면 밝기 ---------- */
function applyHotkey(accel) {
  if (hotkeyNow) { try { globalShortcut.unregister(hotkeyNow); } catch (_) {} hotkeyNow = ''; }
  if (!accel) return true;
  let ok = false;
  try { ok = globalShortcut.register(accel, () => showList(firstChar(), true)); } catch (_) { ok = false; }
  if (ok) hotkeyNow = accel;
  return ok;
}
function applyTheme() { nativeTheme.themeSource = data.settings.theme || 'system'; }

/* ---------- 키보드 감지 ---------- */
function startHook() {
  if (!uIOhook) return;
  let last = 0;
  uIOhook.on('keydown', () => {
    const t = Date.now(); if (t - last < 45) return; last = t;
    for (const [id, w] of charWins) { const c = charById(id); if (c && c.typeReact) w.webContents.send('char:key'); }
  });
  try { uIOhook.start(); } catch (e) { console.warn('[키보드 감지] 시작 실패', e); }
}

/* ---------- 알림 ---------- */
function checkReminders() {
  const nowT = Date.now();
  let changed = false, shown = 0;
  for (const n of data.state.notes) for (const b of n.blocks) {
    if (b.type !== 'check' || b.done || !b.remindAt || b.reminded) continue;
    const t = new Date(b.remindAt).getTime();
    if (isNaN(t) || t > nowT) continue;
    b.reminded = true; changed = true;
    if (sync) sync.touchNote(n);
    if (nowT - t > 12 * 3600e3 || shown >= 3) continue; // 오래 꺼져 있었으면 한꺼번에 울리지 않음
    shown++;
    const label = S.dueLabel(b.due), text = (b.text || '').trim() || '할 일';
    if (Notification.isSupported()) {
      const nt = new Notification({ title: text, body: label || '알림', icon: ICON });
      nt.on('click', () => openBoard({ noteId: n.id, blockId: b.id }));
      nt.show();
    }
    const w = firstChar();
    if (w) w.webContents.send('char:say', { item: { text, due: b.due } });
  }
  if (changed) { save(); broadcast(null); }
}

/* ---------- 자동 업데이트 (GitHub 릴리스) ---------- */
let upd = { state: 'idle', version: '', percent: 0, error: '' };
let manualCheck = false, askedVersion = '';
function setUpd(p) {
  upd = Object.assign({}, upd, p);
  if (tray) buildTray();
  if (settingsWin) settingsWin.webContents.send('update:status', updStatus());
}
const updStatus = () => Object.assign({}, upd, { current: app.getVersion(), packaged: app.isPackaged });
function checkUpdate(manual) {
  if (!autoUpdater || !app.isPackaged) { setUpd({ state: 'dev' }); return; }
  if (upd.state === 'downloading' || upd.state === 'ready') { if (manual && upd.state === 'ready') installNow(); return; }
  manualCheck = !!manual;
  autoUpdater.checkForUpdates().catch(e => setUpd({ state: 'error', error: String((e && e.message) || e) }));
}
async function askDownload(info) {
  if (askedVersion === info.version && !manualCheck) return; // 「나중에」 고른 버전은 다시 묻지 않음
  askedVersion = info.version;
  const w = firstChar(); if (w) w.webContents.send('char:say', { text: `새 버전 ${info.version}이 나왔어.` });
  const r = await dialog.showMessageBox({ type: 'info', title: '업데이트', icon: ICON,
    message: `새 버전 ${info.version}이 있어요.`, detail: `지금 버전 ${app.getVersion()}`,
    buttons: ['받기', '나중에'], defaultId: 0, cancelId: 1 });
  if (r.response === 0) autoUpdater.downloadUpdate().catch(e => setUpd({ state: 'error', error: String(e.message || e) }));
}
async function askInstall(info) {
  const r = await dialog.showMessageBox({ type: 'info', title: '업데이트', icon: ICON,
    message: `${info.version} 설치 준비가 끝났어요.`, buttons: ['지금 재시작', '끌 때 설치'], defaultId: 0, cancelId: 1 });
  if (r.response === 0) installNow();
}
function installNow() { if (data) saveNow(); setImmediate(() => autoUpdater.quitAndInstall(false, true)); }
function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = false;        // 받기 전에 물어봄
  autoUpdater.autoInstallOnAppQuit = true; // 받아둔 건 끌 때 설치
  autoUpdater.on('checking-for-update', () => setUpd({ state: 'checking' }));
  autoUpdater.on('update-available', info => { setUpd({ state: 'available', version: info.version }); askDownload(info); });
  autoUpdater.on('update-not-available', () => setUpd({ state: 'none' }));
  autoUpdater.on('download-progress', p => setUpd({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', info => { setUpd({ state: 'ready', version: info.version }); askInstall(info); });
  autoUpdater.on('error', e => setUpd({ state: 'error', error: String((e && e.message) || e) }));
  setTimeout(() => checkUpdate(false), 8000);
  setInterval(() => checkUpdate(false), 6 * 3600e3);
}
ipcMain.handle('update:check', () => { checkUpdate(true); return updStatus(); });
ipcMain.handle('update:status', () => updStatus());

/* ---------- 날마다 자동 백업 (14일치) ---------- */
function dailyBackup() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const t = new Date(), key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    const dest = path.join(BACKUP_DIR, `postit-data-${key}.json`);
    if (!fs.existsSync(dest)) fs.copyFileSync(DATA_FILE, dest);
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^postit-data-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    files.slice(0, Math.max(0, files.length - 14)).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
  } catch (e) { console.warn('[백업 실패]', e); }
}

/* ---------- 데이터 주고받기 ---------- */
ipcMain.handle('data:get', () => data);
ipcMain.on('data:set', (e, patch) => {
  if (!patch || typeof patch !== 'object') return;
  const before = S.countDone(data.state);
  const oldState = data.state, oldSettings = JSON.parse(JSON.stringify(data.settings));
  if (patch.state) data.state = patch.state;
  if (patch.settings) {
    const oldS = data.settings;
    const posOf = {}; oldS.characters.forEach(c => posOf[c.id] = c.pos); // 위치는 본체가 관리
    data.settings = Object.assign({}, patch.settings, { boardBounds: oldS.boardBounds });
    data.settings.characters.forEach(c => { if (posOf[c.id]) c.pos = posOf[c.id]; });
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!data.settings.autoLaunch });
  }
  data = S.normalize(data);
  if (sync) sync.localChange(patch.state ? oldState : null, data.state, patch.settings ? oldSettings : null, patch.settings ? data.settings : null);
  save();
  broadcast(e.sender);
  if (patch.state && S.countDone(data.state) > before) for (const w of charWins.values()) w.webContents.send('char:done');
  if (patch.settings) {
    applyTheme(); syncCharWins(); buildTray();
    if (data.settings.hotkey !== hotkeyNow) applyHotkey(data.settings.hotkey);
  }
});

ipcMain.on('win:open', (e, name, arg) => {
  if (name === 'board') openBoard(arg);
  else if (name === 'list') showList(BrowserWindow.fromWebContents(e.sender));
  else if (name === 'settings') openSettings(arg);
});
ipcMain.on('list:hide', () => { if (listWin) listWin.hide(); });

/* 캐릭터 창: 클릭 통과, 끌기 */
ipcMain.on('char:mouse', (e, inside) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.setIgnoreMouseEvents(!inside, { forward: true }); });
const drags = new Map();
ipcMain.on('char:dragStart', e => {
  const w = BrowserWindow.fromWebContents(e.sender); if (!w) return;
  const [x, y] = w.getPosition(); drags.set(w.id, { x, y, c: screen.getCursorScreenPoint() });
});
ipcMain.on('char:dragMove', e => {
  const w = BrowserWindow.fromWebContents(e.sender); const d = w && drags.get(w.id); if (!d) return;
  const c = screen.getCursorScreenPoint();
  w.setPosition(Math.round(d.x + c.x - d.c.x), Math.round(d.y + c.y - d.c.y));
});
ipcMain.on('char:dragEnd', e => {
  const w = BrowserWindow.fromWebContents(e.sender); if (!w) return;
  drags.delete(w.id);
  const ch = charById(idOfWin(w)); if (!ch) return;
  const [x, y] = w.getPosition(); ch.pos = { x, y }; save();
});

/* 파일 고르기 → 프로그램 폴더로 복사 */
const FILTERS = {
  image: [{ name: '그림', extensions: ['png', 'webp', 'gif', 'apng', 'jpg', 'jpeg'] }],
  gif: [{ name: '움직이는 그림', extensions: ['gif', 'png', 'apng', 'webp'] }],
  sound: [{ name: '소리', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }],
};
function copyAsset(src) {
  const dest = path.join(ASSET_DIR, Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + path.extname(src).toLowerCase());
  fs.copyFileSync(src, dest);
  return pathToFileURL(dest).href;
}
ipcMain.handle('file:pick', async (e, kind) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile'], filters: FILTERS[kind] || FILTERS.image });
  if (r.canceled || !r.filePaths[0]) return null;
  return copyAsset(r.filePaths[0]);
});

/* 캐릭터 내보내기 / 가져오기 (.pchar = 설정 + 그림·소리를 한 파일에) */
const MIME = { '.png': 'image/png', '.apng': 'image/apng', '.gif': 'image/gif', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };
const EXT = Object.fromEntries(Object.entries(MIME).map(([k, v]) => [v, k]));
function toDataUrl(fileUrl) {
  try { const p = fileURLToPath(fileUrl); return `data:${MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'};base64,${fs.readFileSync(p).toString('base64')}`; }
  catch (_) { return ''; }
}
function fromDataUrl(du) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(du || ''); if (!m || !EXT[m[1]]) return '';
  const dest = path.join(ASSET_DIR, Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + EXT[m[1]]);
  fs.writeFileSync(dest, Buffer.from(m[2], 'base64'));
  return pathToFileURL(dest).href;
}
function mapAssets(c, fn) {
  ['head1', 'head2', 'body'].forEach(k => { if (c.parts[k]) c.parts[k] = fn(c.parts[k]); });
  ['idle', 'typing', 'done'].forEach(k => { if (c.gifs[k]) c.gifs[k] = fn(c.gifs[k]); });
  if (c.sound.file) c.sound.file = fn(c.sound.file);
}
ipcMain.handle('char:export', async (e, id) => {
  const c = charById(id); if (!c) return false;
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    defaultPath: `${c.name || '캐릭터'}.pchar`, filters: [{ name: '포스트잇 캐릭터', extensions: ['pchar'] }] });
  if (r.canceled || !r.filePath) return false;
  const out = S.clone(c); delete out.pos; delete out.id;
  mapAssets(out, u => u.startsWith('file:') ? toDataUrl(u) : u);
  fs.writeFileSync(r.filePath, JSON.stringify({ type: 'postit-character', version: 1, character: out }));
  return true;
});
ipcMain.handle('char:import', async e => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    properties: ['openFile'], filters: [{ name: '포스트잇 캐릭터', extensions: ['pchar'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  let obj;
  try { obj = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); } catch (_) { return { error: '파일을 읽을 수 없어요.' }; }
  if (!obj || obj.type !== 'postit-character' || !obj.character) return { error: '포스트잇 캐릭터 파일이 아니에요.' };
  const c = S.normalizeChar(obj.character);
  c.id = S.uid(); c.pos = null; c.visible = true;
  mapAssets(c, u => u.startsWith('data:') ? fromDataUrl(u) : (u.startsWith('file:') ? '' : u));
  data.settings.characters.push(c);
  save(); syncCharWins(); buildTray(); broadcast(null);
  return { id: c.id };
});

/* 글꼴 목록 (내 컴퓨터에 깔린 것) */
let fontCache = null;
ipcMain.handle('fonts:list', async () => {
  if (fontCache) return fontCache;
  try { const fl = require('font-list'); fontCache = (await fl.getFonts({ disableQuoting: true })).filter(Boolean); }
  catch (_) { fontCache = []; }
  return fontCache;
});
ipcMain.handle('hotkey:set', (_, accel) => {
  const ok = applyHotkey(accel);
  if (!ok && data.settings.hotkey) applyHotkey(data.settings.hotkey); // 실패하면 원래 것 되살리기
  buildTray();
  return ok;
});
/* 동기화 */
ipcMain.handle('sync:status', () => sync ? sync.status : { state: 'off' });
ipcMain.handle('sync:signin', (_, { email, password }) => sync.signIn(email, password));
ipcMain.handle('sync:signup', (_, { email, password }) => sync.signUp(email, password));
ipcMain.handle('sync:signout', () => sync.signOut());
ipcMain.handle('sync:now', async () => { await sync.pullAll(); await sync.pushNow(); return sync.status; });

ipcMain.on('open:folder', (_, which) => shell.openPath(which === 'backup' ? BACKUP_DIR : ASSET_DIR));
ipcMain.on('app:quit', () => app.quit());

/* ---------- 시작 / 끝 ---------- */
app.whenReady().then(() => {
  DATA_FILE = path.join(app.getPath('userData'), 'postit-data.json');
  ASSET_DIR = path.join(app.getPath('userData'), 'assets');
  BACKUP_DIR = path.join(app.getPath('userData'), 'backups');
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  // 0.1에서 쓰던 그림 폴더도 그대로 읽힘 (경로를 저장해 두었으므로)
  data = loadData();
  dailyBackup();
  sync = new Sync({
    dir: app.getPath('userData'),
    getData: () => data,
    onRemote: () => { data = S.normalize(data); save(); broadcast(null); },
    onStatus: st => { if (settingsWin) settingsWin.webContents.send('sync:status', st); if (tray) tray.setToolTip('포스트잇 클리커' + (st.state === 'synced' ? ' (동기화됨)' : st.state === 'offline' ? ' (연결 안 됨)' : '')); },
  });
  sync.init().catch(e => console.warn('[동기화 시작 실패]', e.message));
  setInterval(dailyBackup, 3 * 3600e3); // 켜둔 채 날이 바뀌어도 백업
  applyTheme();
  data.settings.characters.forEach(c => lastSize.set(c.id, c.size));
  syncCharWins();
  createListWin();
  buildTray();
  if (!applyHotkey(data.settings.hotkey)) console.warn('[단축키] 등록 실패', data.settings.hotkey);
  buildTray();
  startHook();
  setupUpdater();
  checkReminders();
  setInterval(checkReminders, 20 * 1000);
  screen.on('display-removed', () => {
    data.settings.characters.forEach((c, i) => { const w = charWins.get(c.id); if (!w) return; const b = w.getBounds();
      if (!onScreen(b.x, b.y, b.width, b.height)) { const p = defaultPos(winSize(c), i); w.setPosition(p.x, p.y); c.pos = p; } });
    save();
  });
});
app.on('second-instance', () => openBoard());
app.on('window-all-closed', () => { /* 캐릭터와 트레이로 계속 실행 */ });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('before-quit', () => {
  try { if (uIOhook) uIOhook.stop(); } catch (e) {}
  if (data) saveNow();
});
