/*
 * ポン出し — 保存（IndexedDB）
 *
 * イベント（曲の並び・グループ・設定）と、曲ファイルそのものをブラウザ内に保存する。
 * 曲ファイルはコピーして持つので、元のファイルやUSBメモリを外しても鳴る。
 */
(function (root) {
  'use strict';

  var DB_NAME = 'pon-dashi';
  var DB_VERSION = 2;
  var dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        if (!root.indexedDB) {
          reject(new Error('IndexedDB が使えません'));
          return;
        }
        var req = root.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains('shows')) db.createObjectStore('shows', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
          if (!db.objectStoreNames.contains('banks')) db.createObjectStore('banks', { keyPath: 'id' });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
        req.onblocked = function () { reject(new Error('保存領域が別のウィンドウで使用中です')); };
      });
      dbPromise.catch(function () { dbPromise = null; });
    }
    return dbPromise;
  }

  // ひとつのトランザクションを実行し、完了したら work の戻り値（リクエストなら結果）を返す
  function run(storeNames, mode, work) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeNames, mode);
        var out = work(tx);
        tx.oncomplete = function () {
          resolve(out && typeof out === 'object' && 'readyState' in out ? out.result : out);
        };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('保存が中断されました')); };
      });
    });
  }

  var api = {
    open: open,

    // ブラウザが容量不足の時に勝手に消さないよう頼む（認められない環境もある）
    persist: function () {
      if (root.navigator && root.navigator.storage && root.navigator.storage.persist) {
        return root.navigator.storage.persist().catch(function () { return false; });
      }
      return Promise.resolve(false);
    },

    listShows: function () {
      return run(['shows'], 'readonly', function (tx) {
        return tx.objectStore('shows').getAll();
      }).then(function (shows) {
        return (shows || []).map(function (s) {
          return {
            id: s.id,
            name: s.name,
            updatedAt: s.updatedAt || 0,
            trackCount: s.tracks ? Object.keys(s.tracks).length : 0,
            groupCount: s.groups ? s.groups.length : 0
          };
        });
      });
    },

    // 書き出し用：イベントの中身をすべて
    getAllShows: function () {
      return run(['shows'], 'readonly', function (tx) {
        return tx.objectStore('shows').getAll();
      }).then(function (shows) { return shows || []; });
    },

    getShow: function (id) {
      return run(['shows'], 'readonly', function (tx) {
        return tx.objectStore('shows').get(id);
      });
    },

    putShow: function (show) {
      return run(['shows'], 'readwrite', function (tx) {
        tx.objectStore('shows').put(show);
        return true;
      });
    },

    // イベントと、その曲ファイルをまとめて消す
    deleteShow: function (id, fileKeys) {
      return run(['shows', 'files'], 'readwrite', function (tx) {
        tx.objectStore('shows').delete(id);
        var files = tx.objectStore('files');
        (fileKeys || []).forEach(function (key) { files.delete(key); });
        return true;
      });
    },

    putFile: function (key, file) {
      return run(['files'], 'readwrite', function (tx) {
        tx.objectStore('files').put(file, key);
        return true;
      });
    },

    getFile: function (key) {
      return run(['files'], 'readonly', function (tx) {
        return tx.objectStore('files').get(key);
      });
    },

    // イベントをまたいで使う設定（共通のSEパッドなど）
    getBank: function (id) {
      return run(['banks'], 'readonly', function (tx) {
        return tx.objectStore('banks').get(id);
      });
    },

    putBank: function (bank) {
      return run(['banks'], 'readwrite', function (tx) {
        tx.objectStore('banks').put(bank);
        return true;
      });
    },

    deleteFiles: function (keys) {
      if (!keys || !keys.length) return Promise.resolve(true);
      return run(['files'], 'readwrite', function (tx) {
        var files = tx.objectStore('files');
        keys.forEach(function (key) { files.delete(key); });
        return true;
      });
    }
  };

  root.PonStore = api;
})(typeof self !== 'undefined' ? self : this);
