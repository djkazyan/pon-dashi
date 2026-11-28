// キーの推定のテスト（合成した曲で）
const test = require('node:test');
const assert = require('node:assert');
const K = require('../app/key-detect.js');

const RATE = 22050;
function tone(buf, start, dur, midi, amp) {
  const f = 440 * Math.pow(2, (midi - 69) / 12);
  const s0 = Math.floor(start * RATE), n = Math.floor(dur * RATE);
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const t = i / RATE, env = Math.min(1, t * 50) * Math.exp(-t * 1.5);
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t) / (h * h);
    buf[s0 + i] += v * amp * env;
  }
}
function song(buf, tonic, minor, from, seconds) {
  const prog = minor ? [[0, 3, 7], [5, 8, 12], [7, 11, 14], [0, 3, 7]] : [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]];
  const scale = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  let seed = tonic + 5;
  const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let t = 0; t < seconds; t += 2) {
    const ch = prog[(t / 2) % 4];
    ch.forEach((iv) => tone(buf, from + t, 2, 48 + tonic + iv, 0.12));
    tone(buf, from + t, 2, 36 + tonic + ch[0], 0.2);
    for (let m = 0; m < 4; m++) tone(buf, from + t + m * 0.5, 0.5, 60 + tonic + scale[Math.floor(r() * 7)], 0.08);
  }
}
function buffer(seconds, fill) {
  const d = new Float32Array(seconds * RATE);
  fill(d);
  return { sampleRate: RATE, length: d.length, numberOfChannels: 1, getChannelData: () => d };
}

test('キーの名前・平行調・スケール', () => {
  assert.equal(K.keyName(3), 'E♭');
  assert.equal(K.keyName(12 + 9), 'Am');
  assert.equal(K.keyName(K.relativeOf(0)), 'Am');
  assert.equal(K.keyName(K.relativeOf(12)), 'E♭');
  assert.deepEqual(K.scaleNotes(3), ['E♭', 'F', 'G', 'A♭', 'B♭', 'C', 'D']);
  assert.deepEqual(K.scaleNotes(6), ['F♯', 'G♯', 'A♯', 'B', 'C♯', 'D♯', 'F']);
  assert.deepEqual(K.scaleNotes(12 + 9), ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
});

test('メジャー・マイナーのキーを当てる', async () => {
  for (const k of [0, 3, 7, 10, 12 + 9, 12 + 4, 12 + 1]) {
    const r = await K.analyze(buffer(40, (d) => song(d, k % 12, k >= 12, 0, 40)), { sync: true });
    assert.equal(r.name, K.keyName(k));
    assert.equal(r.segments.length, 1);
  }
});

test('転調（ラスサビで半音上げ）を区間で出す', async () => {
  const r = await K.analyze(buffer(120, (d) => { song(d, 3, false, 0, 80); song(d, 4, false, 80, 40); }), { sync: true });
  assert.equal(r.name, 'E♭');
  assert.deepEqual(r.segments.map((s) => s.name), ['E♭', 'E']);
  assert.ok(Math.abs(r.segments[1].start - 80) < 4, String(r.segments[1].start));
});

test('ほぼ無音でも落ちない', async () => {
  const r = await K.analyze(buffer(5, () => {}), { sync: true });
  assert.ok(r === null || typeof r.name === 'string');
});
