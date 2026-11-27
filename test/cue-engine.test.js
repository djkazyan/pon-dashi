'use strict';
// GOの動作エンジンのテスト。実行: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngine } = require('../app/cue-engine.js');

// M1〜Mn を登録したエンジンを作る。全曲「準備完了」にしておく。
function setup(options, count = 5) {
  const engine = createEngine(options);
  for (let i = 1; i <= count; i++) engine.addTrack({ id: 'M' + i, ready: true });
  return engine;
}

test('最初の曲がスタンバイになる', () => {
  const e = setup({ goMode: 'single' });
  assert.equal(e.getState(0).standbyId, 'M1');
  assert.equal(e.getState(0).playingId, null);
});

test('1回押し：GOでスタンバイ曲が出て、スタンバイは次へ進む', () => {
  const e = setup({ goMode: 'single' });
  const r = e.go(1000);
  assert.deepEqual(r, { type: 'play', trackId: 'M1', cutTrackId: null, cause: 'manual' });
  const s = e.getState(1000);
  assert.equal(s.playingId, 'M1');
  assert.equal(s.standbyId, 'M2');
});

test('【事故の再現】GO直後の連打では次の次へ進まない', () => {
  const e = setup({ goMode: 'single' });
  e.go(1000);                     // M1
  e.stop();
  assert.equal(e.go(5000).trackId, 'M2');
  // 直後に連打（押し直し・二度押し）
  for (const t of [5100, 5300, 5800, 6500, 6999]) {
    const r = e.go(t);
    assert.equal(r.type, 'ignored');
    assert.equal(r.reason, 'guard');
  }
  const s = e.getState(6999);
  assert.equal(s.playingId, 'M2', '再生中はM2のまま');
  assert.equal(s.standbyId, 'M3', 'スタンバイはM3のまま');
  // ガードが明ければ、次のGOで出るのはM3
  assert.equal(e.go(7000).trackId, 'M3');
});

test('【事故の再現】曲が自然に終わってもスタンバイは動かない', () => {
  const e = setup({ goMode: 'single' });
  e.go(1000);                                  // M1 再生、スタンバイ M2
  assert.equal(e.trackEnded('M1', 60000).type, 'ended');
  assert.equal(e.getState(60000).standbyId, 'M2');
  // 終わった直後に押しても、出るのはM2（M3ではない）
  assert.equal(e.go(60050).trackId, 'M2');
});

test('【事故の再現】曲の終わり際にGO → 終了通知が後から来ても影響しない', () => {
  const e = setup({ goMode: 'single' });
  e.go(1000);                                  // M1
  const r = e.go(60000);                       // 終わり際にGO → M2（M1は即カット）
  assert.equal(r.trackId, 'M2');
  assert.equal(r.cutTrackId, 'M1');
  // M1の「自然終了」が遅れて届いても無視される
  assert.equal(e.trackEnded('M1', 60010).type, 'ignored');
  const s = e.getState(60010);
  assert.equal(s.playingId, 'M2');
  assert.equal(s.standbyId, 'M3');
});

test('再生中のGOは即カットしてスタンバイ曲を出す', () => {
  const e = setup({ goMode: 'single' });
  e.go(1000);
  const r = e.go(4000);
  assert.deepEqual(r, { type: 'play', trackId: 'M2', cutTrackId: 'M1', cause: 'manual' });
});

test('2回押し：1回目は構えるだけ、2回目で出る', () => {
  const e = setup({ goMode: 'double' });
  const first = e.go(1000);
  assert.deepEqual(first, { type: 'armed', trackId: 'M1' });
  assert.equal(e.getState(1000).playingId, null, '1回目では音は出ない');
  assert.equal(e.getState(1000).standbyId, 'M1', 'スタンバイも動かない');
  const second = e.go(1500);
  assert.equal(second.type, 'play');
  assert.equal(second.trackId, 'M1');
  assert.equal(e.getState(1500).armed, false);
});

test('2回押し：構えは時間が経っても解除されない', () => {
  const e = setup({ goMode: 'double' });
  e.go(1000);
  assert.equal(e.getState(10 * 60 * 1000).armed, true);
  assert.equal(e.go(10 * 60 * 1000).type, 'play');
});

test('2回押し：出した直後の連打では、次の曲を構えることもできない', () => {
  const e = setup({ goMode: 'double' });
  e.go(1000);
  e.go(1500);                                  // M1 再生
  assert.equal(e.go(1700).reason, 'guard');
  assert.equal(e.go(2500).reason, 'guard');
  assert.equal(e.getState(2500).armed, false);
  assert.equal(e.go(3500).type, 'armed');      // ガード明け（1500+2000）
});

test('構え中のSTOPは構えの解除だけ。再生中の曲は止めない', () => {
  const e = setup({ goMode: 'double' });
  e.go(1000);
  e.go(1500);                                  // M1 再生
  e.go(5000);                                  // M2 を構える
  assert.equal(e.getState(5000).armed, true);
  assert.deepEqual(e.stop(), { type: 'disarmed' });
  assert.equal(e.getState(5000).playingId, 'M1');
  assert.equal(e.getState(5000).armed, false);
  // もう一度STOPで今度は止まる
  assert.deepEqual(e.stop(), { type: 'stop', trackId: 'M1' });
});

test('キーのチャタリング（極端に短い間隔の2連打）は1回として扱う', () => {
  const e = setup({ goMode: 'double' });
  assert.equal(e.go(1000).type, 'armed');
  assert.equal(e.go(1030).reason, 'bounce');
  assert.equal(e.getState(1030).playingId, null);
  assert.equal(e.go(1200).type, 'play');
});

test('スタンバイを明示的に変えられる。変えると構えは解除される', () => {
  const e = setup({ goMode: 'double' });
  e.go(1000);                                  // M1 を構える
  assert.equal(e.setStandby('M4'), true);
  const s = e.getState(1000);
  assert.equal(s.standbyId, 'M4');
  assert.equal(s.armed, false);
  e.go(1200);
  assert.equal(e.go(1400).trackId, 'M4');
  assert.equal(e.getState(1400).standbyId, 'M5', 'M4の次がスタンバイ');
});

test('同じ曲をスタンバイにし直しても構えは保たれる', () => {
  const e = setup({ goMode: 'double' });
  e.go(1000);
  e.setStandby('M1');
  assert.equal(e.getState(1000).armed, true);
});

test('再生中の曲をスタンバイにすれば、頭からやり直せる', () => {
  const e = setup({ goMode: 'single' });
  e.go(1000);                                  // M1
  e.setStandby('M1');
  const r = e.go(4000);
  assert.deepEqual(r, { type: 'play', trackId: 'M1', cutTrackId: 'M1', cause: 'manual' });
  assert.equal(e.getState(4000).standbyId, 'M2');
});

test('最後の曲を出したらスタンバイは空になり、GOは何もしない', () => {
  const e = setup({ goMode: 'single' }, 2);
  e.go(1000);
  e.go(4000);
  assert.equal(e.getState(4000).standbyId, null);
  assert.equal(e.go(9000).reason, 'no-standby');
  assert.equal(e.getState(9000).playingId, 'M2');
});

test('続けて再生：曲が終わるとスタンバイ曲が自動で出る', () => {
  const e = setup({ goMode: 'double' });
  e.setAfterAction('M1', 'continue');
  e.go(1000);
  e.go(1500);                                  // M1
  const r = e.trackEnded('M1', 60000);
  assert.deepEqual(r, { type: 'play', trackId: 'M2', cutTrackId: null, cause: 'auto' });
  assert.equal(e.getState(60000).standbyId, 'M3');
});

test('【事故の再現】続けて再生で自動的に出た直後のGOは、次の次へ進めない', () => {
  const e = setup({ goMode: 'single' });
  e.setAfterAction('M1', 'continue');
  e.go(1000);                                  // M1
  e.trackEnded('M1', 60000);                   // 自動でM2
  assert.equal(e.go(60100).reason, 'guard');   // 境目で押してしまった
  assert.equal(e.getState(60100).playingId, 'M2');
  assert.equal(e.getState(60100).standbyId, 'M3');
});

test('続けて再生：構え中でも自動で出て、構えは解除される', () => {
  const e = setup({ goMode: 'double' });
  e.setAfterAction('M1', 'continue');
  e.go(1000);
  e.go(1500);                                  // M1
  e.go(30000);                                 // M2 を構える
  e.trackEnded('M1', 60000);                   // 自動でM2
  const s = e.getState(60000);
  assert.equal(s.playingId, 'M2');
  assert.equal(s.armed, false);
});

test('フェードアウト：終わるまでは再生中。フェード中のGOは即カットして次を出す', () => {
  const e = setup({ goMode: 'single' });
  e.go(1000);
  assert.deepEqual(e.fade(), { type: 'fade', trackId: 'M1' });
  assert.equal(e.getState(3000).fading, true);
  assert.equal(e.fade().reason, 'already-fading');
  const r = e.go(4000);
  assert.equal(r.trackId, 'M2');
  assert.equal(r.cutTrackId, 'M1');
  assert.equal(e.getState(4000).fading, false);
  assert.equal(e.fadeCompleted('M1').type, 'ignored', '古いフェード完了通知は無視');
});

test('フェードアウトが終わると停止。スタンバイは動かない', () => {
  const e = setup({ goMode: 'single' });
  e.go(1000);
  e.fade();
  assert.deepEqual(e.fadeCompleted('M1'), { type: 'stopped', trackId: 'M1' });
  const s = e.getState(5000);
  assert.equal(s.playingId, null);
  assert.equal(s.standbyId, 'M2');
});

test('フェードアウトは構えを解除しない', () => {
  const e = setup({ goMode: 'double' });
  e.go(1000);
  e.go(1500);                                  // M1
  e.go(5000);                                  // M2 を構える
  e.fade();
  assert.equal(e.getState(5000).armed, true);
});

test('読み込み準備ができていない曲はGOしても出ない', () => {
  const e = createEngine({ goMode: 'single' });
  e.addTrack({ id: 'A', ready: false });
  const r = e.go(1000);
  assert.equal(r.reason, 'not-ready');
  assert.equal(e.getState(1000).goState, 'not-ready');
  e.setReady('A', true);
  assert.equal(e.go(1100).type, 'play');
});

test('読み込めない曲はスタンバイにならず、飛ばされる', () => {
  const e = createEngine({ goMode: 'single' });
  e.addTrack({ id: 'A', ready: true });
  e.addTrack({ id: 'B', ready: true, playable: false });
  e.addTrack({ id: 'C', ready: true });
  e.go(1000);                                  // A
  assert.equal(e.getState(1000).standbyId, 'C');
  assert.equal(e.setStandby('B'), false);
});

test('スタンバイ中の曲が読み込めないと分かったら、次の曲へ移る', () => {
  const e = setup({ goMode: 'double' }, 3);
  e.go(1000);                                  // M1 を構える
  e.setPlayable('M1', false);
  const s = e.getState(1000);
  assert.equal(s.standbyId, 'M2');
  assert.equal(s.armed, false);
});

test('並べ替えてもスタンバイは同じ曲のまま', () => {
  const e = setup({ goMode: 'single' });
  e.go(1000);                                  // M1 再生、スタンバイ M2
  e.moveTrack('M2', 4);                        // M2 を最後へ
  assert.equal(e.getState(1000).standbyId, 'M2');
  assert.deepEqual(e.getState(1000).order, ['M1', 'M3', 'M4', 'M5', 'M2']);
});

test('再生中の曲はリストから外せない。スタンバイ曲を外すと次の曲へ移る', () => {
  const e = setup({ goMode: 'single' });
  e.go(1000);                                  // M1 再生、スタンバイ M2
  assert.equal(e.removeTrack('M1'), false);
  assert.equal(e.removeTrack('M2'), true);
  assert.equal(e.getState(1000).standbyId, 'M3');
});

test('最後まで出した後に曲を追加すると、追加した曲がスタンバイになる', () => {
  const e = setup({ goMode: 'single' }, 1);
  e.go(1000);
  assert.equal(e.getState(1000).standbyId, null);
  e.addTrack({ id: 'X', ready: true });
  assert.equal(e.getState(1000).standbyId, 'X');
});

test('GOの押し方を切り替えると構えは解除される', () => {
  const e = setup({ goMode: 'double' });
  e.go(1000);
  e.setGoMode('single');
  assert.equal(e.getState(1000).armed, false);
  assert.equal(e.getState(1000).goState, 'will-play');
});

test('GOボタンの状態表示（goState）', () => {
  const e = setup({ goMode: 'double' });
  assert.equal(e.getState(0).goState, 'will-arm');     // 枠だけ：次は構えるだけ
  e.go(1000);
  assert.equal(e.getState(1000).goState, 'will-play'); // 塗りつぶし：次で音が出る
  e.go(1500);
  assert.equal(e.getState(1600).goState, 'guard');     // グレー：ガード中
  assert.equal(e.getState(3500).goState, 'will-arm');
});

test('先読みする曲は、再生中・スタンバイ・その先2曲', () => {
  const e = setup({ goMode: 'single' }, 6);
  assert.deepEqual(e.preloadIds(2), ['M1', 'M2', 'M3']);
  e.go(1000);
  assert.deepEqual(e.preloadIds(2), ['M1', 'M2', 'M3', 'M4']);
});

test('長い本番を通して、出る曲は常にその時のスタンバイ曲と一致する', () => {
  const e = setup({ goMode: 'double' }, 12);
  let now = 0;
  const playedOrder = [];
  for (let i = 0; i < 12; i++) {
    const expected = e.getState(now).standbyId;
    e.go(now);                                 // 構え
    now += 300;
    const r = e.go(now);                       // 再生
    assert.equal(r.type, 'play');
    assert.equal(r.trackId, expected);
    playedOrder.push(r.trackId);
    // 直後に慌てて連打
    for (let k = 1; k <= 6; k++) assert.equal(e.go(now + k * 250).type, 'ignored');
    now += 200000;
    e.trackEnded(r.trackId, now);
    now += 100;
  }
  assert.deepEqual(playedOrder, ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12']);
});

test('並び全体の入れ替え：スタンバイは同じ曲のまま、GOの順番は新しい並び', () => {
  const e = setup({ goMode: 'single' }, 4);
  e.go(1000);                                  // M1、スタンバイ M2
  assert.equal(e.reorder(['M3', 'M4', 'M1', 'M2']), true);
  assert.equal(e.getState(1000).standbyId, 'M2');
  e.setStandby('M3');
  assert.equal(e.go(4000).trackId, 'M3');
  assert.equal(e.getState(4000).standbyId, 'M4');
});

test('並び全体の入れ替え：曲が足りない・重複・知らない曲は受け付けない', () => {
  const e = setup({ goMode: 'single' }, 3);
  assert.equal(e.reorder(['M1', 'M2']), false);
  assert.equal(e.reorder(['M1', 'M1', 'M2']), false);
  assert.equal(e.reorder(['M1', 'M2', 'X']), false);
  assert.deepEqual(e.getState(0).order, ['M1', 'M2', 'M3']);
});

test('保存から戻す時の「済」の印', () => {
  const e = setup({ goMode: 'single' }, 3);
  assert.equal(e.markPlayed('M1'), true);
  assert.equal(e.markPlayed('X'), false);
  assert.equal(e.getState(0).played.M1, true);
});

test('マーカー：今の曲を鳴らしたまま、スタンバイ曲を出す（2回押し・連打ガードに関係なく）', () => {
  const e = setup({ goMode: 'double' });
  e.go(0); e.go(100); // M1 を出す
  const r = e.markerGo('M1', 500); // ガード中でも出る
  assert.deepEqual(r, { type: 'play', trackId: 'M2', cutTrackId: 'M1', cause: 'marker' });
  assert.equal(e.getState(500).playingId, 'M2');
  assert.equal(e.getState(500).standbyId, 'M3');
  // 前の曲の「終わった」知らせが後から来ても、何も起きない
  assert.equal(e.trackEnded('M1', 4000).type, 'ignored');
  assert.equal(e.getState(4000).playingId, 'M2');
});

test('マーカー：再生中でない曲・フェード中・スタンバイなしでは何もしない', () => {
  const e = setup({ goMode: 'single' }, 2);
  e.go(0);
  assert.equal(e.markerGo('M2', 100).type, 'ignored');
  e.fade();
  assert.equal(e.markerGo('M1', 200).reason, 'fading');
  const e2 = setup({ goMode: 'single' }, 1);
  e2.go(0);
  assert.equal(e2.markerGo('M1', 100).reason, 'no-standby');
});
