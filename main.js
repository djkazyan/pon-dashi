/*
 * ポン出し — アプリ本体の枠（Electron）
 *
 * app/ フォルダの画面を、独立したウィンドウとして開く。
 * 現場で困る動作（再読み込み、ページの差し替わり、スリープ）をここで止める。
 */
'use strict';

const { app, BrowserWindow, Menu, dialog, powerSaveBlocker, session, ipcMain, screen } = require('electron');
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
// ---------- 画面（ディスプレイ）まわり ----------
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
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
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
