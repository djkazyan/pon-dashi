'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { pack, unpack } = require('../app/backup.js');

test('書き出して読み込むと、目録とファイルの中身が戻る', async () => {
  const a = new File([new Uint8Array([1, 2, 3])], '曲A.wav', { type: 'audio/wav' });
  const b = new File([new Uint8Array(1000).fill(7)], 'SE.mp3', { type: 'audio/mpeg' });
  const blob = pack({ kind: 'event', shows: [{ id: 's1', name: '本番' }] }, [{ key: 't1', file: a }, { key: 'p1', file: b }]);
  const out = await unpack(blob);
  assert.equal(out.manifest.kind, 'event');
  assert.equal(out.manifest.shows[0].name, '本番');
  assert.deepEqual([...new Uint8Array(await out.files.t1.arrayBuffer())], [1, 2, 3]);
  assert.equal(out.files.t1.name, '曲A.wav');
  assert.equal(out.files.p1.size, 1000);
  assert.equal(out.files.p1.type, 'audio/mpeg');
});

test('ファイルが0個でも読み込める', async () => {
  const out = await unpack(pack({ kind: 'all', shows: [] }, []));
  assert.deepEqual(out.manifest.shows, []);
  assert.deepEqual(out.files, {});
});

test('別のファイルは断る', async () => {
  await assert.rejects(unpack(new Blob(['RIFF....WAVEfmt something'])), /書き出しファイルではありません/);
  await assert.rejects(unpack(new Blob(['abc'])), /書き出しファイルではありません/);
});

test('途中で切れたファイルは断る', async () => {
  const blob = pack({ kind: 'event' }, [{ key: 't1', file: new File([new Uint8Array(500)], 'x.wav') }]);
  await assert.rejects(unpack(blob.slice(0, blob.size - 10)), /途中で切れています/);
});

test('新しい形式の版は更新を促す', async () => {
  const blob = pack({ kind: 'event' }, []);
  const buf = new Uint8Array(await blob.arrayBuffer());
  new DataView(buf.buffer).setUint32(8, 99, true);
  await assert.rejects(unpack(new Blob([buf])), /更新してください/);
});
