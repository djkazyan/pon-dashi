/*
 * ポン出し — アプリ本体の枠（Electron）
 *
 * app/ フォルダの画面を、独立したウィンドウとして開く。
 * 現場で困る動作（再読み込み、ページの差し替わり、スリープ）をここで止める。
 */
'use strict';

const { app, BrowserWindow, Menu, dialog, powerSaveBlocker, session, ipcMain, screen, net, shell } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');

let mainWindow = null;

// アプリの中の名前は英字（PonDashi）。日本語の名前だとMacで起動直後に落ちたため。
// 表示名と保存場所は「ポン出し」のまま（~/Library/Application Support/ポン出し）
app.setName('ポン出し');
app.setPath('userData', path.join(app.getPath('appData'), 'ポン出し'));

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#101216',
    title: 'ポン出し',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      // 背面に回っても、フェードのタイマーや表示更新を遅らせない
      backgroundThrottling: false
    }
  });
  mainWindow.on('closed', () => { closeVideoWindow(); mainWindow = null; });

  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));

  // ファイルをドロップした時などに、画面が別のページへ差し替わらないようにする
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // 曲を読み込んだ状態で閉じようとしたら確認する
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['終了する', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      message: 'ポン出しを終了しますか？',
      detail: '再生中の音は止まります。イベントは保存されています。'
    });
    if (choice === 0) event.preventDefault(); // 画面側の「閉じない」を取り消して閉じる
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------- ボーカル分離 ----------
// 分離は別スレッド（sep-worker.js）で行う。モデルはメモリを約1.5GB使うので、使い終わって3分たったら手放す
const MODEL_FILE = 'htdemucs_ft_vocals_fp16weights.onnx';
let sepWorker = null;
let sepIdleTimer = null;
const sepJobs = new Map(); // id -> { resolve, reject, sender }

function modelPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'models', MODEL_FILE)
    : path.join(__dirname, 'models', MODEL_FILE);
}

function getSepWorker() {
  clearTimeout(sepIdleTimer);
  if (sepWorker) return sepWorker;
  // 組み立てたアプリでは、分離の部品は app.asar の外（app.asar.unpacked）に置いてある
  const workerFile = path.join(__dirname, 'sep-worker.js').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  sepWorker = new Worker(workerFile, { workerData: { modelPath: modelPath() } });
  sepWorker.on('message', (msg) => {
    const job = sepJobs.get(msg.id);
    if (!job) return;
    if (msg.type === 'progress') {
      if (!job.sender.isDestroyed()) job.sender.send('vocal-progress', msg);
      return;
    }
    sepJobs.delete(msg.id);
    if (msg.type === 'done') job.resolve({ left: msg.left, right: msg.right });
    else job.reject(new Error(msg.message));
    if (!sepJobs.size) scheduleSepRelease();
  });
  sepWorker.on('error', (err) => {
    sepJobs.forEach((job) => job.reject(err));
    sepJobs.clear();
    sepWorker = null;
  });
  sepWorker.on('exit', () => { sepWorker = null; });
  return sepWorker;
}

function scheduleSepRelease() {
  clearTimeout(sepIdleTimer);
  sepIdleTimer = setTimeout(() => {
    if (sepWorker && !sepJobs.size) {
      sepWorker.terminate();
      sepWorker = null;
    }
  }, 3 * 60 * 1000);
}

ipcMain.handle('vocal-separate', (event, job) => {
  if (!require('fs').existsSync(modelPath())) {
    return Promise.reject(new Error('分離用のモデルが見つかりません'));
  }
  return new Promise((resolve, reject) => {
    sepJobs.set(job.id, { resolve, reject, sender: event.sender });
    getSepWorker().postMessage({ type: 'separate', id: job.id, left: job.left, right: job.right });
  });
});

ipcMain.on('vocal-cancel', (event, id) => {
  if (sepWorker) sepWorker.postMessage({ type: 'cancel', id });
});

// メニュー。再読み込み（Cmd+R）は誤操作で音が止まるので入れない
// ---------- 映像出力ウィンドウ ----------
// 外部モニターに、映像付きの曲の映像だけを全画面で出す。中身は app/video.html（本体と同じ保存領域を読む）
let videoWindow = null;

function displayList() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id, index: i + 1, primary: d.id === primary.id,
    width: d.size.width, height: d.size.height
  }));
}

function closeVideoWindow() {
  if (videoWindow && !videoWindow.isDestroyed()) videoWindow.destroy();
  videoWindow = null;
}

function openVideoWindow(target) {
  closeVideoWindow();
  const preview = target === 'preview';
  let display = null;
  if (!preview) {
    display = screen.getAllDisplays().find((d) => String(d.id) === String(target));
    if (!display) throw new Error('その画面が見つかりません');
  }
  const b = preview ? null : display.bounds;
  videoWindow = new BrowserWindow({
    x: preview ? undefined : b.x, y: preview ? undefined : b.y,
    width: preview ? 640 : b.width, height: preview ? 360 : b.height,
    frame: preview, resizable: preview, movable: true,
    backgroundColor: '#000000', show: false, title: 'ポン出し 映像出力',
    skipTaskbar: !preview, focusable: preview, hasShadow: preview,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  if (!preview) {
    videoWindow.setBounds(b);
    videoWindow.setAlwaysOnTop(true, 'screen-saver'); // メニューバー・タスクバーより上に
    videoWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  videoWindow.setMenu(null);
  videoWindow.loadFile(path.join(__dirname, 'app', 'video.html'), { hash: preview ? 'preview' : '' });
  videoWindow.once('ready-to-show', () => {
    if (!videoWindow) return;
    videoWindow.showInactive(); // 本体のウィンドウからフォーカスを奪わない（Space で GO できるように）
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
  });
  const win = videoWindow;
  videoWindow.on('closed', () => {
    if (videoWindow === win) videoWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('video-closed');
  });
  return { label: preview ? '小さいウィンドウ' : (display.id === screen.getPrimaryDisplay().id ? 'この画面' : '画面 ' + (screen.getAllDisplays().indexOf(display) + 1)) + '（' + display.size.width + '×' + display.size.height + '）' };
}

ipcMain.handle('video-displays', () => displayList());
ipcMain.handle('video-open', (event, target) => openVideoWindow(target));
ipcMain.handle('video-close', () => { closeVideoWindow(); return true; });

// ---------- 画面（ディスプレイ）まわり ----------
// ---- 音楽CDから取り込む（Mac のみ） ----
// macOS は音楽CDを入れると /Volumes/<CD名>/ に「1 曲名.aiff」のようなファイルとして見せる。
// それを読んで画面側に渡す（画面側で AIFF を読み、アプリの中にコピーする）。
const CD_ROOT = process.env.PON_CD_ROOT || '/Volumes';
const CD_AIFF = /\.aiff?$/i;

function cdSupported() {
  return process.platform === 'darwin' || !!process.env.PON_CD_ROOT;
}

async function listAudioCds() {
  if (!cdSupported()) return [];
  const fsp = require('fs').promises;
  const pathMod = require('path');
  let vols = [];
  try { vols = await fsp.readdir(CD_ROOT, { withFileTypes: true }); } catch (e) { return []; }
  const cds = [];
  for (const v of vols) {
    if (!v.isDirectory() && !v.isSymbolicLink()) continue;
    const dir = pathMod.join(CD_ROOT, v.name);
    let names = [];
    try { names = await fsp.readdir(dir); } catch (e) { continue; }
    const tracks = names.filter((n) => CD_AIFF.test(n) && !n.startsWith('.'))
      .sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
    // 音楽CDは「1 〜.aiff」から始まる番号付きの AIFF だけが並ぶ
    if (!tracks.length || !tracks.every((n) => /^\d+[ _.-]/.test(n))) continue;
    const list = [];
    for (const n of tracks) {
      let size = 0;
      try { size = (await fsp.stat(pathMod.join(dir, n))).size; } catch (e) { /* 大きさ不明 */ }
      list.push({ file: n, size });
    }
    cds.push({ name: v.name, dir, tracks: list });
  }
  return cds;
}

ipcMain.handle('cd-supported', () => cdSupported());
ipcMain.handle('cd-list', () => listAudioCds());
ipcMain.handle('cd-read', async (event, dir, file) => {
  const pathMod = require('path');
  // 決まった場所の AIFF だけ読む
  const full = pathMod.resolve(String(dir), String(file));
  if (pathMod.dirname(pathMod.dirname(full)) !== pathMod.resolve(CD_ROOT) || !CD_AIFF.test(full)) throw new Error('読めない場所です');
  const buf = await require('fs').promises.readFile(full);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
});

// ---- 新しい版のお知らせ ----
// GitHub の最新リリースを調べるだけ。ダウンロードと入れ替えは各自で（署名のない自作アプリのため自動更新はしない）
const RELEASE_API = 'https://api.github.com/repos/djkazyan/pon-dashi/releases/latest';
const DOWNLOAD_PAGE = 'https://djkazyan.github.io/pon-dashi/';

async function checkLatestRelease() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await net.fetch(RELEASE_API, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'PonDashi/' + app.getVersion() },
      signal: ctrl.signal
    });
    if (!res.ok) return { ok: false, status: res.status };
    const r = await res.json();
    const version = String(r.tag_name || r.name || '').replace(/^[^0-9]*/, '');
    if (!/^\d+\.\d+\.\d+/.test(version)) return { ok: false, status: 'no-version' };
    return {
      ok: true,
      version,
      title: String(r.name || ''),
      notes: String(r.body || '').slice(0, 4000),
      publishedAt: r.published_at || '',
      url: String(r.html_url || '')
    };
  } catch (err) {
    return { ok: false, status: 'offline' };
  } finally {
    clearTimeout(timer);
  }
}

ipcMain.handle('update-check', () => checkLatestRelease());
ipcMain.handle('update-open', (event, which) => {
  // 開いてよいのは決まった配布先だけ
  const url = which === 'releases' ? 'https://github.com/djkazyan/pon-dashi/releases' : DOWNLOAD_PAGE;
  shell.openExternal(url);
  return true;
});

function askUpdateCheck() {
  if (mainWindow) mainWindow.webContents.send('update-check-request');
}

// macOS は、ウィンドウの大部分がある画面で最大化・フルスクリーンにする。
// 2つの画面にまたがっていると、思っていない方の画面で大きくなるので、
// 「いまウィンドウの真ん中がある画面」に収めてから大きくする。

function displayOfWindow(win) {
  const b = win.getBounds();
  return screen.getDisplayNearestPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
}

// ウィンドウをその画面の中に収める（はみ出していたら縮めて真ん中へ）
function fitInto(win, display) {
  const wa = display.workArea;
  const b = win.getBounds();
  const width = Math.min(b.width, wa.width);
  const height = Math.min(b.height, wa.height);
  const inside = b.x >= wa.x && b.y >= wa.y && b.x + b.width <= wa.x + wa.width && b.y + b.height <= wa.y + wa.height;
  if (inside) return;
  win.setBounds({
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    width, height
  });
}

function toggleFullScreenHere() {
  const win = mainWindow;
  if (!win) return;
  if (win.isFullScreen()) { win.setFullScreen(false); return; }
  fitInto(win, displayOfWindow(win));
  setTimeout(() => win.setFullScreen(true), 80); // 移動が反映されてから
}

function maximizeHere() {
  const win = mainWindow;
  if (!win) return;
  if (win.isFullScreen()) win.setFullScreen(false);
  win.setBounds(displayOfWindow(win).workArea);
}

function moveToNextDisplay() {
  const win = mainWindow;
  if (!win) return;
  if (win.isFullScreen()) { toastToWindow('フルスクリーンを解除してから移してください'); return; }
  const all = screen.getAllDisplays();
  if (all.length < 2) return;
  const cur = displayOfWindow(win);
  const next = all[(all.findIndex((d) => d.id === cur.id) + 1) % all.length];
  const wa = next.workArea;
  const b = win.getBounds();
  const width = Math.min(b.width, wa.width);
  const height = Math.min(b.height, wa.height);
  win.setBounds({ x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2), width, height });
}

function toastToWindow(msg) {
  if (mainWindow) mainWindow.webContents.executeJavaScript('window.__ponToast && window.__ponToast(' + JSON.stringify(msg) + ')').catch(() => {});
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: 'ポン出し',
      submenu: [
        { role: 'about', label: 'ポン出しについて' },
        { label: 'アップデートを確認…', click: askUpdateCheck },
        { type: 'separator' },
        { role: 'hide', label: 'ポン出しを隠す' },
        { role: 'hideOthers', label: 'ほかを隠す' },
        { role: 'unhide', label: 'すべてを表示' },
        { type: 'separator' },
        { role: 'quit', label: 'ポン出しを終了' }
      ]
    }] : []),
    {
      label: '表示',
      submenu: [
        { label: 'フルスクリーン（今の画面で）', accelerator: isMac ? 'Ctrl+Command+F' : 'F11', click: toggleFullScreenHere },
        { label: '最大化（今の画面で）', accelerator: isMac ? 'Alt+Command+F' : 'Alt+Ctrl+F', click: maximizeHere },
        { label: '次の画面へ移す', accelerator: isMac ? 'Alt+Command+Right' : 'Alt+Ctrl+Right', click: moveToNextDisplay },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '開発者ツール' }
      ]
    },
    {
      label: 'ウインドウ',
      submenu: [
        { role: 'minimize', label: 'しまう' },
        ...(isMac ? [] : [{ role: 'quit', label: '終了' }])
      ]
    },
    {
      label: 'ヘルプ',
      submenu: [
        { label: 'アップデートを確認…', click: askUpdateCheck },
        { label: '配布ページを開く', click: () => shell.openExternal(DOWNLOAD_PAGE) }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // 映像出力中の画面が外されたら、映像出力を閉じる
  screen.on('display-removed', () => {
    if (!videoWindow) return;
    const b = videoWindow.getBounds();
    const still = screen.getAllDisplays().some((d) => b.x >= d.bounds.x && b.x < d.bounds.x + d.bounds.width && b.y >= d.bounds.y && b.y < d.bounds.y + d.bounds.height);
    if (!still) closeVideoWindow();
  });
  // 出力デバイスの一覧取得と切り替えを許可する（それ以外の権限要求は断る）
  const allowed = new Set(['media', 'speaker-selection']);
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => allowed.has(permission));

  // 本番中に画面が消えたりスリープしたりしないようにする
  powerSaveBlocker.start('prevent-display-sleep');

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ウィンドウを閉じたらアプリも終了する（Macでも）
app.on('window-all-closed', () => app.quit());
