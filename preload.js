// 画面側に渡す、アプリ版だけの機能（ボーカル分離）
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const listeners = {};
ipcRenderer.on('vocal-progress', (event, msg) => {
  const fn = listeners[msg.id];
  if (fn) fn(msg.done, msg.total, msg.phase || '');
});

contextBridge.exposeInMainWorld('ponNative', {
  vocalSeparation: true,
  platform: process.platform,
  // left/right：44.1kHz の Float32Array。device：'gpu' か 'cpu'。戻り値：{ left, right（ボーカルだけ）, stats }
  // opts：{ device: 'gpu' | 'cpu', gpuDevice: 使う GPU の番号（未定なら null） }
  separateVocals(id, left, right, onProgress, opts) {
    listeners[id] = onProgress;
    const o = typeof opts === 'string' ? { device: opts } : (opts || {});
    return ipcRenderer.invoke('vocal-separate', { id, left, right, device: o.device || 'cpu', gpuDevice: o.gpuDevice == null ? null : o.gpuDevice }).finally(() => { delete listeners[id]; });
  },
  cancelVocals(id) {
    ipcRenderer.send('vocal-cancel', id);
  },
  // 映像出力
  video: {
    displays() { return ipcRenderer.invoke('video-displays'); },
    open(target) { return ipcRenderer.invoke('video-open', target); },
    close() { return ipcRenderer.invoke('video-close'); },
    onClosed(fn) { ipcRenderer.on('video-closed', () => fn()); }
  },
  // 音楽CDから取り込む（Mac のみ）
  cd: {
    supported() { return ipcRenderer.invoke('cd-supported'); },
    list() { return ipcRenderer.invoke('cd-list'); },
    read(dir, file) { return ipcRenderer.invoke('cd-read', dir, file); }
  },
  // 新しい版のお知らせ（調べるだけ。ダウンロードは配布ページから）
  update: {
    check() { return ipcRenderer.invoke('update-check'); },
    open(which) { return ipcRenderer.invoke('update-open', which); },
    onRequest(fn) { ipcRenderer.on('update-check-request', () => fn()); }
  }
});
