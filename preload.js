// 画面側に渡す、アプリ版だけの機能（ボーカル分離）
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const listeners = {};
ipcRenderer.on('vocal-progress', (event, msg) => {
  const fn = listeners[msg.id];
  if (fn) fn(msg.done, msg.total);
});

contextBridge.exposeInMainWorld('ponNative', {
  vocalSeparation: true,
  // left/right：44.1kHz の Float32Array。戻り値：{ left, right }（ボーカルだけ）
  separateVocals(id, left, right, onProgress) {
    listeners[id] = onProgress;
    return ipcRenderer.invoke('vocal-separate', { id, left, right }).finally(() => { delete listeners[id]; });
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
  }
});
