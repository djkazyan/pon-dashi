/*
 * ポン出し — 書き出しファイル（.ponbak）の形式
 *
 * イベントの設定と曲・SE・BGMのファイルを、1つのファイルにまとめる。
 *   先頭 8バイト  "PONDASHI"
 *   次の 4バイト  形式の版（1）
 *   次の 4バイト  目録（JSON）の長さ
 *   目録（UTF-8 の JSON）
 *   ファイルの中身を順に並べたもの（目録の files に位置と長さ）
 * 中身は Blob のまま組み立てる（大きなファイルを全部メモリに読み込まない）。
 */
(function (root) {
  'use strict';

  var MAGIC = 'PONDASHI';
  var FORMAT = 1;
  var EXT = '.ponbak';

  // manifest: { kind, shows, banks, ... }、files: [{ key, file(Blob), name, type }]
  function pack(manifest, files) {
    var offset = 0;
    var list = files.map(function (f) {
      var entry = { key: f.key, name: f.name || (f.file && f.file.name) || f.key, type: f.type || (f.file && f.file.type) || '', offset: offset, size: f.file.size };
      offset += f.file.size;
      return entry;
    });
    var meta = {};
    Object.keys(manifest).forEach(function (k) { meta[k] = manifest[k]; });
    meta.app = 'pon-dashi';
    meta.format = FORMAT;
    meta.files = list;
    var json = new TextEncoder().encode(JSON.stringify(meta));
    var head = new Uint8Array(16);
    for (var i = 0; i < 8; i++) head[i] = MAGIC.charCodeAt(i);
    var view = new DataView(head.buffer);
    view.setUint32(8, FORMAT, true);
    view.setUint32(12, json.length, true);
    return new Blob([head, json].concat(files.map(function (f) { return f.file; })), { type: 'application/octet-stream' });
  }

  // 戻り値：{ manifest, files: { key: File } }（File は元のファイルの一部を指すだけで、読み込みは後で）
  function unpack(blob) {
    if (!blob || blob.size < 16) return Promise.reject(new Error('ポン出しの書き出しファイルではありません'));
    return blob.slice(0, 16).arrayBuffer().then(function (buf) {
      var head = new Uint8Array(buf);
      var magic = String.fromCharCode.apply(null, Array.prototype.slice.call(head, 0, 8));
      if (magic !== MAGIC) throw new Error('ポン出しの書き出しファイルではありません');
      var view = new DataView(buf);
      var format = view.getUint32(8, true);
      if (format > FORMAT) throw new Error('新しい版のポン出しで書き出されたファイルです。ポン出しを更新してください');
      var len = view.getUint32(12, true);
      if (16 + len > blob.size) throw new Error('ファイルが途中で切れています');
      return blob.slice(16, 16 + len).text().then(function (text) {
        var manifest;
        try { manifest = JSON.parse(text); } catch (e) { throw new Error('ファイルが壊れています'); }
        if (!manifest || manifest.app !== 'pon-dashi') throw new Error('ポン出しの書き出しファイルではありません');
        var base = 16 + len;
        var files = {};
        (manifest.files || []).forEach(function (f) {
          var start = base + f.offset;
          if (start + f.size > blob.size) throw new Error('ファイルが途中で切れています');
          files[f.key] = new File([blob.slice(start, start + f.size)], f.name, { type: f.type || '' });
        });
        return { manifest: manifest, files: files };
      });
    });
  }

  var api = { pack: pack, unpack: unpack, EXT: EXT };
  root.PonBackup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
