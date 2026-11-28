/*
 * ポン出し — 画面と操作
 *
 * 状態の判断はすべて cue-engine.js に任せ、ここは「表示する」「音を出す」だけを行う。
 */
(function () {
  'use strict';

  var PRELOAD_AHEAD = 2;        // スタンバイ曲の先、何曲まで先読みするか
  var FADE_SECONDS = 3;         // フェードアウトの長さ
  var HEAD_SILENCE_WARN = 0.5;  // 頭の無音がこの秒数以上なら注意を出す
  var TAIL_SILENCE_NOTE = 1.0;  // 末尾の無音がこの秒数以上なら詳細に表示する
  var WARN_SECONDS = 30;        // 残りがこの秒数以下で黄色
  var DANGER_SECONDS = 15;      // 残りがこの秒数以下で赤く点滅
  var SEEK_SMALL = 10;          // ←→ キーと「10秒」ボタンで動かす秒数
  var SEEK_LARGE = 60;          // Shift+←→ と「1分」ボタンで動かす秒数
  var ASK_OUTPUTS = '__ask';    // 出力の選択肢「ほかの出力デバイスを表示…」
  var APP_VERSION = '0.12.1'; // index.html の版と違えば、古いファイルが読み込まれている
  var AUDIO_EXT = /\.(wav|wave|mp3|m4a|aac|flac|ogg|oga|opus|aif|aiff|mp4|m4v|mov)$/i;
  var MARKER_DELAY_MAX = 10;    // マーカーから次の曲までの最大秒数
  var LOUD_TARGET = -11;       // オートゲインの目標（LUFS）
  var GAIN_ADJ_MAX = 12;       // 曲ごとの微調整の幅（±dB）
  var VIDEO_EXT = /\.(mp4|m4v|mov)$/i; // 動画ファイルは音声だけ取り出して鳴らす

  var engine = window.PonCueEngine.createEngine({ goMode: loadSetting('goMode', 'double') });
  var audio = window.PonAudioEngine.createAudioEngine();
  // BGM は本編・SE と別の出力に出せるよう、別の再生系統にする（Ver. 0.10.0）
  var bgmAudio = window.PonAudioEngine.createAudioEngine();

  var tracks = new Map();   // id -> { id, file, fileName, name, ext, status, error, info, afterAction }
  var buffers = new Map();  // id -> AudioBuffer（先読み済みの曲だけ）
  var vocalBuffers = new Map(); // id -> AudioBuffer（分離したボーカル。先読み済みの曲だけ）
  var selectedId = null;
  var current = null;       // 再生中の音 { trackId, voice }
  var seq = 0;
  var jobs = [];            // 読み込み待ちの曲ID
  var working = false;
  var inflightId = null;    // いま読み込んでいる曲ID
  var lastStandbyId = null;
  var lastGoKey = '';
  var toastTimer = null;
  var dragDepth = 0;
  var locked = false;       // 本番ロック。再生位置の移動・並べ替え・削除・設定変更を止める
  var standbyStart = null;  // スタンバイ曲を途中から再生する指定 { trackId, offset }。1回限り
  var hoverRatio = -1;      // 波形の上にあるカーソルの位置（0〜1）。なければ -1
  var goTransition = loadSetting('goTransition', 'fade'); // 再生中のGOで前の曲を 'cut'＝即カット / 'fade'＝フェードアウト
  var tails = [];           // フェードアウト中の前の曲（STOPで一緒に止める）

  // イベント（ショー）とグループ
  var store = window.PonStore;
  var storeOk = !!store;
  var show = null;          // { id, name, createdAt }
  var groups = [];          // [{ id, name, trackIds: [] }]。GOの順番はグループの並び→グループ内の並び
  var viewGroupId = null;   // いま表示しているタブ（GOの対象とは関係ない）
  var lastStandbyGroupId = null;
  var saveTimer = null;
  var pendingFiles = 0;     // 保存中の曲ファイルの数
  var saveFailed = false;
  var confirmKey = null;    // 2回押しで確定する削除ボタンの対象

  // SEパッド。バンクは「イベント」（イベントごとに保存）と「共通」（全イベントで同じ）の2つ
  var PAD_COUNT = 8;
  var PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8'];
  var seBanks = { event: emptyBank(), common: emptyBank() };
  var seBank = loadSetting('seBank', 'event') === 'common' ? 'common' : 'event';
  var seEdit = false;
  var seSelected = -1;      // 編集中のパッド番号
  var sePlaying = new Map(); // パッドID -> 再生中の音の一覧（「重ねる」設定では複数）
  var SE_MAX_LAYERS = 8;    // 「重ねる」で同時に鳴らす上限（超えたら古いものから止める）
  var seDb = clampDb(parseFloat(loadSetting('seVolumeDb', '0')));
  var seBus = null;         // SEだけの音量をまとめて動かす系統
  var seBuffers = new Map(); // パッドID -> AudioBuffer（SEは全部メモリに置く）
  var seTarget = null;      // ファイル選択で割り当てる先 { bank, index }
  var commonTimer = null;

  // BGM（全イベント共通のプレイリスト）
  var BGM_FADE_SECONDS = 3;   // 停止・本編GOでのフェードアウト
  var BGM_SWITCH_SECONDS = 2; // 再生中にプレイリストを切り替えた時のフェード
  var BGM_FADE_IN = 0.8;      // 再生開始のフェードイン
  var bgmLists = [];          // [{ id, name, trackIds: [], shuffle }]
  var bgmTracks = new Map();  // id -> { id, name, fileName, file, duration, status }
  var bgmListId = null;       // 表示・再生するプレイリスト
  var bgmView = false;        // BGMタブを表示しているか
  var bgmSelected = null;
  var bgmNow = null;          // 再生中 { listId, order, index, trackId, voice }
  var bgmFading = false;
  var bgmTails = [];          // フェードアウト中のBGM
  var bgmBuffers = new Map(); // 読み込み済み（再生中と次の曲だけ）
  var bgmToken = 0;           // 古い読み込みを無視するための番号
  var bgmBus = null;
  var bgmDb = clampBgmDb(parseFloat(loadSetting('bgmVolumeDb', '0')));
  var bgmAutoFade = loadSetting('bgmAutoFade', 'on') !== 'off';
  var bgmTimer = null;
  var bgmPaused = null;       // 一時停止中 { listId, order, index, trackId, offset }
  var confirmTimer = null;

  function $(id) { return document.getElementById(id); }
  function now() { return performance.now(); }

  // ---------- 設定の保存（押し方・出力デバイス） ----------

  function loadSetting(key, fallback) {
    try {
      var v = window.localStorage.getItem('pon.' + key);
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function saveSetting(key, value) {
    try { window.localStorage.setItem('pon.' + key, value); } catch (e) { /* 保存できなくても動作は続ける */ }
  }

  // ---------- 表示用の小道具 ----------

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtClock(sec) {
    var s = Math.max(0, Math.floor(sec));
    return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60);
  }

  function fmtShort(sec) {
    var s = Math.max(0, Math.round(sec));
    return Math.floor(s / 60) + ':' + pad2(s % 60);
  }

  function fmtSeconds(sec) {
    return (Math.round(sec * 10) / 10).toFixed(1) + '秒';
  }

  function uid(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function groupById(id) {
    for (var i = 0; i < groups.length; i++) if (groups[i].id === id) return groups[i];
    return null;
  }

  function groupOf(trackId) {
    var t = tracks.get(trackId);
    return t ? groupById(t.groupId) : null;
  }

  function viewGroup() {
    return groupById(viewGroupId) || groups[0] || null;
  }

  // 曲番号はグループごとに M1, M2 …
  function labelOf(id) {
    var g = groupOf(id);
    var index = g ? g.trackIds.indexOf(id) : -1;
    return index < 0 ? '' : 'M' + (index + 1);
  }

  function titleOf(id) {
    var t = tracks.get(id);
    return t ? labelOf(id) + ' ' + t.name : '';
  }

  function fullTitle(id) {
    var g = groupOf(id);
    return (g ? g.name + '　' : '') + titleOf(id);
  }

  function groupDuration(g) {
    var total = 0;
    var unknown = false;
    g.trackIds.forEach(function (id) {
      var t = tracks.get(id);
      if (t && t.info) { var r = rangeOf(t); total += r.end - r.start; }
      else if (t && t.status !== 'error') unknown = true;
    });
    return { total: total, unknown: unknown };
  }

  // 曲を別のグループへ（または同じグループ内で）移す。beforeId の前に入れる（なければ最後）
  function moveTrackTo(id, groupId, beforeId) {
    if (locked) { toast('本番ロック中は移せません'); return false; }
    var t = tracks.get(id);
    var to = groups.filter(function (g) { return g.id === groupId; })[0];
    if (!t || !to || id === beforeId) return false;
    // どのグループに入っていても、まず全部から外してから入れる（二重に入らないように）
    var from = null;
    groups.forEach(function (g) {
      var i;
      while ((i = g.trackIds.indexOf(id)) >= 0) { g.trackIds.splice(i, 1); from = from || g; }
    });
    var at = beforeId ? to.trackIds.indexOf(beforeId) : -1;
    if (at < 0) to.trackIds.push(id); else to.trackIds.splice(at, 0, id);
    t.groupId = to.id; // 曲の所属も書き換える（これを忘れると、戻せない・二重になる）
    syncOrder();
    if (from !== to) toast('「' + t.name + '」を「' + to.name + '」へ移しました');
    afterChange();
    return true;
  }

  // GOの順番（エンジンの並び）を、グループの並びに合わせる
  function syncOrder() {
    var flat = [];
    groups.forEach(function (g) { flat = flat.concat(g.trackIds); });
    engine.reorder(flat);
  }

  // 再生範囲（秒）。開始〜終了が0.5秒未満になる指定は無視して全体にする
  function rangeOf(t) {
    var d = t && t.info ? t.info.duration : 0;
    var start = Math.max(0, Math.min(t && t.inPoint ? t.inPoint : 0, d));
    var end = t && t.outPoint != null ? Math.max(0, Math.min(t.outPoint, d)) : d;
    if (end - start < 0.5) { start = 0; end = d; }
    return { start: start, end: end, set: !!(t && ((t.inPoint || 0) > 0 || t.outPoint != null)) };
  }

  // 残り時間の基準になる位置：終了位置の指定があればそこ、なければ実際に音が終わる位置
  function remainEndOf(t) {
    var r = rangeOf(t);
    if (t.outPoint != null) return r.end;
    var audible = t.info.allSilent ? t.info.duration : t.info.audibleEnd;
    return Math.min(r.end, audible);
  }

  function playOptions(t, offset, entry) {
    var r = rangeOf(t);
    return {
      offset: offset,
      end: r.end,
      loop: t.afterAction === 'loop',
      loopStart: r.start,
      vocal: t.vocal && vocalBuffers.has(t.id) ? { buffer: vocalBuffers.get(t.id), level: t.vocal.level } : null,
      trim: dbToGain(trackGainDb(t)),
      onEnded: function () { onVoiceEnded(entry); }
    };
  }

  // 再生中の曲の範囲・ループの変更を、鳴らしたまま反映する
  function applyRangeToCurrent(t) {
    if (!current || !t || current.trackId !== t.id || !t.info) return;
    var r = rangeOf(t);
    audio.setVoiceRange(current.voice, t.afterAction === 'loop', r.start, r.end);
  }

  // ---------- オートゲイン（本編の音量をそろえる） ----------
  // 曲ごとに統合ラウドネス（LUFS）を測り、目標に合わせて曲全体に一定のゲインをかけるだけ。
  // リミッター・コンプは一切使わない純粋なゲイン調整（上げた結果ピークを超えても抑えない）。
  var autoGainOn = true;

  function autoGainInfo(t) {
    if (!t || !t.loud || t.loud.lufs == null || !isFinite(t.loud.lufs)) return { db: 0, measured: !!(t && t.loud) };
    return { db: Math.round((LOUD_TARGET - t.loud.lufs) * 10) / 10, measured: true };
  }

  function trackGainDb(t) {
    if (!t) return 0;
    return (autoGainOn ? autoGainInfo(t).db : 0) + (t.gainAdj || 0);
  }

  function fmtDb(db) {
    var v = Math.round(db * 10) / 10;
    if (Math.abs(v) < 0.05) v = 0;
    return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1) + ' dB';
  }

  function applyGainToCurrent(t) {
    if (!current || !t || current.trackId !== t.id || !current.voice) return;
    audio.setTrim(current.voice, dbToGain(trackGainDb(t)));
  }

  // オートキュー：頭の無音（約 -60dB 以下）を、音の出だしの 0.05 秒手前まで詰める。
  // 手で開始位置を決めた曲・再生中の曲は変えない。詰めたら true
  function autoTrimHead(t) {
    if (!t || !t.info || t.info.allSilent || t.info.headSilence < 0.05) return false;
    if ((t.inPoint || 0) > 0) return false;
    if (current && current.trackId === t.id) return false;
    var a = Math.max(0, t.info.headSilence - 0.05);
    var end = t.outPoint != null ? t.outPoint : t.info.duration;
    if (end - a < 0.5 || a <= 0.01) return false;
    t.inPoint = a;
    return true;
  }

  // ---------- キー（Ver. 0.12.0） ----------
  // 手で直したキーがあればそれ、なければ解析の結果。{ key, name, label, relative, scale, conf, segments, user }
  function keyOf(t) {
    if (!t || !window.PonKey) return null;
    var info = t.keyInfo && t.keyInfo.key != null ? t.keyInfo : null;
    if (t.keyUser == null && !info) return null;
    var main = t.keyUser != null ? t.keyUser : info.key;
    var segs = info && info.segs && info.segs.length > 1 ? info.segs.map(function (x) { return { start: x[0], key: x[1] }; }) : null;
    // 手で直した時は、最初の区間（曲の頭のキー）をそのキーにする
    if (segs && t.keyUser != null) segs[0].key = t.keyUser;
    var d = window.PonKey.describe(main, info ? info.conf : 1, segs || [{ start: 0, key: main }]);
    d.user = t.keyUser != null;
    d.conf = info ? info.conf : 1;
    d.analyzed = info ? window.PonKey.keyName(info.key) : null;
    return d;
  }

  function keyShort(t) {
    var k = keyOf(t);
    if (!k) return '';
    if (k.segments.length > 1) return k.segments.map(function (sg) { return sg.name; }).join('→');
    return k.name;
  }

  function renderKey(t) {
    var k = keyOf(t);
    var sel = $('keySelect');
    if (!sel.options.length) {
      addOption(sel, '', '自動');
      for (var i = 0; i < 24; i++) addOption(sel, String(i), window.PonKey ? window.PonKey.keyLabel(i) + '（' + window.PonKey.keyName(i) + '）' : String(i));
    }
    sel.options[0].textContent = t.keyInfo && t.keyInfo.key != null ? '自動（推定：' + window.PonKey.keyName(t.keyInfo.key) + '）' : '自動';
    sel.value = t.keyUser != null ? String(t.keyUser) : '';
    sel.disabled = !t.info;
    if (!k) {
      $('keyName').textContent = t.status === 'error' || (t.keyInfo && t.keyInfo.key == null) ? '—' : (t.info ? '推定中…' : '—');
      $('keyRel').textContent = '';
      $('keyScale').textContent = '';
      $('keySegs').hidden = true;
      $('keyNote').hidden = true;
      return;
    }
    $('keyName').textContent = k.name;
    $('keyRel').textContent = k.label + '（' + k.relative + ' と同じ音）' + (k.user ? '・手で設定' : '');
    var sc = $('keyScale');
    sc.textContent = '';
    k.scale.forEach(function (n) { var e = document.createElement('span'); e.textContent = n; sc.appendChild(e); });
    var ul = $('keySegs');
    ul.textContent = '';
    if (k.segments.length > 1) {
      k.segments.forEach(function (sg, i) {
        var li = document.createElement('li');
        li.appendChild(cell('ks-time', fmtShort(sg.start) + '〜'));
        li.appendChild(cell('ks-name', window.PonKey.keyLabel(sg.key) + (i > 0 ? '（転調）' : '')));
        ul.appendChild(li);
      });
    }
    ul.hidden = k.segments.length < 2;
    var note = '';
    if (!k.user && k.conf < 0.2) note = '判定がはっきりしません。耳で確認してください';
    $('keyNote').textContent = note;
    $('keyNote').hidden = !note;
  }

  // ---------- マーカー（Ver. 0.11.0） ----------
  // 曲の中に印を打ち、そこから指定の秒数後に次の曲（スタンバイ曲）を出す。今の曲は止めずに最後まで鳴らす。
  // ループの曲では使わない。手で GO・停止・フェードしたら、その曲のマーカーは取り消し。
  function markerUsable(t) { return !!t && t.marker != null && t.afterAction !== 'loop'; }

  // 次の曲を出す位置（曲の中の秒）。終了位置より後なら、終了の少し前に出す
  function markerFireAt(t) {
    if (!markerUsable(t)) return null;
    var at = t.marker + (t.markerDelay || 0);
    var r = rangeOf(t);
    return Math.min(at, Math.max(r.start, r.end - 0.05));
  }

  function checkMarker() {
    // 止めた後でもマーカーを打てるよう、鳴らしている位置を覚えておく（フェード中は覚えない＝フェードを始めた位置）
    if (current && current.voice && !current.voice.fading) {
      var playingTrack = tracks.get(current.trackId);
      if (playingTrack) playingTrack.lastPos = audio.position(current.voice);
    }
    if (!current || current.markerDone) return;
    var t = tracks.get(current.trackId);
    var at = markerFireAt(t);
    if (at == null || !current.voice || current.voice.fading) return;
    var pos = audio.position(current.voice);
    if (pos < at - 0.005) return;
    current.markerDone = true;
    var r = engine.markerGo(t.id, now());
    if (r.type === 'play') {
      startTrack(r);
      afterChange();
    } else if (r.reason === 'not-ready') {
      toast('マーカー：次の曲を読み込み中のため、出せませんでした');
    } else if (r.reason === 'no-standby') {
      toast('マーカー：次の曲がないため、何もしませんでした');
    }
  }
  setInterval(checkMarker, 20);

  function setMarker(t, sec) {
    if (!t || locked) return;
    if (sec == null) { t.marker = null; afterChange(); return; }
    if (!t.info) return;
    var r = rangeOf(t);
    if (sec < r.start || sec > r.end) { toast('マーカーは再生範囲の中に打ってください'); render(); return; }
    t.marker = Math.round(sec * 10) / 10;
    // 再生中の曲に打ち直したら、まだ来ていない位置なら効くようにする
    if (current && current.trackId === t.id) current.markerDone = audio.position(current.voice) >= markerFireAt(t);
    afterChange();
  }

  function renderMarker(t) {
    var hasInfo = !!t.info;
    var loop = t.afterAction === 'loop';
    var input = $('markerTime');
    if (document.activeElement !== input) input.value = t.marker != null ? fmtPrecise(t.marker) : '';
    input.disabled = locked || !hasInfo || loop;
    input.classList.toggle('is-set', t.marker != null);
    var sel = $('markerDelay');
    if (!sel.options.length) for (var d = 0; d <= MARKER_DELAY_MAX; d += 0.5) addOption(sel, String(d), (d % 1 ? d.toFixed(1) : String(d)) + '秒後');
    sel.value = String(t.markerDelay || 0);
    sel.disabled = locked || loop || t.marker == null;
    var isCurrent = !!(current && current.trackId === t.id);
    var canStopPos = !isCurrent && t.lastPos != null;
    $('markerNow').textContent = isCurrent || !canStopPos ? '今の位置をマーカーに' : '止めた位置（' + fmtPrecise(t.lastPos) + '）をマーカーに';
    $('markerNow').disabled = locked || loop || !(isCurrent || canStopPos);
    $('markerClear').disabled = locked || t.marker == null;
    $('markerMinus').disabled = locked || loop || t.marker == null;
    $('markerPlus').disabled = locked || loop || t.marker == null;
    var note = $('markerNote');
    var msg = '';
    if (loop && t.marker != null) msg = 'ループの曲なので、マーカーは使いません';
    else if (t.marker != null && hasInfo) {
      var r = rangeOf(t);
      if (t.marker + (t.markerDelay || 0) > r.end) msg = '終了位置を過ぎるので、終了の直前に次の曲を出します';
    }
    note.textContent = msg;
    note.hidden = !msg;
  }

  function fmtPrecise(sec) {
    var s = Math.max(0, sec);
    var m = Math.floor(s / 60);
    var rest = s - m * 60;
    return m + ':' + (rest < 10 ? '0' : '') + rest.toFixed(1);
  }

  // 「1:23.4」「83.4」「1:23」を秒にする。読めなければ null
  function parseTime(text) {
    var v = String(text || '').trim().replace(/：/g, ':').replace(/[０-９．]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
    if (!v) return null;
    var m = v.match(/^(?:(\d+):)?(\d+(?:\.\d*)?)$/);
    if (!m) return null;
    return (m[1] ? parseInt(m[1], 10) * 60 : 0) + parseFloat(m[2]);
  }

  function tailSilence(info) {
    return Math.max(0, info.duration - info.audibleEnd);
  }

  // チェック欄に出す文言
  function checkOf(t) {
    if (t.status === 'checking') return { text: '確認中…', cls: '' };
    if (t.status === 'error') return { text: '読み込めません', cls: 'is-error' };
    if (t.info.allSilent) return { text: '注意：無音のファイル', cls: 'is-warn' };
    var r = rangeOf(t);
    var headLeft = t.info.headSilence - r.start;
    if (headLeft >= HEAD_SILENCE_WARN) {
      return { text: '注意：頭に無音' + fmtSeconds(headLeft), cls: 'is-warn' };
    }
    return { text: r.set ? 'OK（範囲指定）' : 'OK', cls: '' };
  }

  function toast(message) {
    var el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3500);
  }

  // ---------- 取り込み ----------

  function isAudioFile(file) {
    if (!file || !file.name || file.name.charAt(0) === '.') return false;
    return AUDIO_EXT.test(file.name) || (file.type && file.type.indexOf('audio/') === 0);
  }

  function addGroup(name) {
    var g = { id: uid('g'), name: name, trackIds: [] };
    groups.push(g);
    return g;
  }

  function nextGroupName() {
    var n = groups.length + 1;
    var names = groups.map(function (g) { return g.name; });
    while (names.indexOf('グループ' + n) >= 0) n++;
    return 'グループ' + n;
  }

  // 曲を1つ登録する（取り込み・保存からの復元で共通）
  function clampLevel(v) {
    var n = Number(v);
    return isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
  }

  function vocalKey(id) { return 'v' + id; }

  // ---------- きっかけメモ ----------
  var CUE_TYPES = { otosaki: '音先', itatsuki: '板付き', furi: '曲フリ', mc: 'MC', other: 'その他' };

  function normalizeCue(c) {
    if (!c) return { type: '', text: '' };
    return { type: CUE_TYPES[c.type] ? c.type : '', text: String(c.text || '').slice(0, 60) };
  }

  function hasCue(t) { return !!(t && t.cue && (t.cue.type || t.cue.text)); }

  // きっかけの表示（種類の印＋メモ）
  function cueNode(t) {
    var frag = document.createDocumentFragment();
    if (!hasCue(t)) return frag;
    if (t.cue.type) frag.appendChild(cell('cue-chip k-' + t.cue.type, CUE_TYPES[t.cue.type]));
    if (t.cue.text) frag.appendChild(cell('cue-memo', t.cue.text));
    return frag;
  }

  function cueTitle(t) {
    if (!hasCue(t)) return '';
    return (t.cue.type ? CUE_TYPES[t.cue.type] : '') + (t.cue.type && t.cue.text ? '：' : '') + (t.cue.text || '');
  }

  function registerTrack(id, g, data) {
    tracks.set(id, {
      id: id, groupId: g.id, file: data.file, fileName: data.fileName, name: data.name, ext: data.ext,
      status: 'checking', error: null, info: null,
      afterAction: data.afterAction === 'continue' || data.afterAction === 'loop' ? data.afterAction : 'stop',
      inPoint: data.inPoint > 0 ? data.inPoint : 0,
      outPoint: data.outPoint != null ? data.outPoint : null,
      cue: normalizeCue(data.cue), // きっかけメモ { type, text }
      vocal: data.vocal && data.vocalFile ? { level: clampLevel(data.vocal.level) } : null, // ボーカル調整（分離済みの時だけ）
      vocalFile: data.vocal ? data.vocalFile || null : null,
      vocalInfo: data.vocal && data.vocalInfo ? String(data.vocalInfo).slice(0, 80) : '',
      // オートゲイン：測ったラウドネスとピーク、曲ごとの微調整（dB）
      loud: data.loud && typeof data.loud === 'object' ? { lufs: data.loud.lufs == null ? null : Number(data.loud.lufs), peakDb: data.loud.peakDb == null ? null : Number(data.loud.peakDb) } : null,
      gainAdj: isFinite(Number(data.gainAdj)) ? Math.max(-GAIN_ADJ_MAX, Math.min(GAIN_ADJ_MAX, Number(data.gainAdj))) : 0,
      // オートキュー：'pending' なら、調べ終わった時に頭の無音を詰める（新しく取り込んだ曲）
      autoCue: data.autoCue === 'pending' ? 'pending' : 'done',
      // マーカー：この位置（秒）から markerDelay 秒後に、今の曲を鳴らしたまま次の曲を出す
      marker: isFinite(Number(data.marker)) && data.marker != null ? Math.max(0, Number(data.marker)) : null,
      markerDelay: isFinite(Number(data.markerDelay)) ? Math.max(0, Math.min(MARKER_DELAY_MAX, Number(data.markerDelay))) : 0,
      // キー：解析の結果 { key, conf, segs: [[秒, key]] } と、手で直したキー（0〜23、なければ null）
      keyInfo: data.keyInfo && typeof data.keyInfo === 'object' ? data.keyInfo : null,
      keyUser: Number.isInteger(data.keyUser) && data.keyUser >= 0 && data.keyUser < 24 ? data.keyUser : null
    });
    g.trackIds.push(id);
    engine.addTrack({ id: id, ready: false });
    engine.setAfterAction(id, data.afterAction);
    jobs.push(id);
  }

  // items: [{ file, path }]
  // フォルダから来た曲は、そのフォルダ名のグループへ。ファイル単体は、いま表示しているグループへ
  function importItems(items) {
    var list = items.filter(function (it) { return isAudioFile(it.file); });
    if (!list.length) {
      toast('取り込める音声ファイルがありませんでした');
      return [];
    }
    // ファイル名の番号順（01_、M1 など）に並べる
    list.sort(function (a, b) {
      return (a.path || a.file.name).localeCompare(b.path || b.file.name, 'ja', { numeric: true, sensitivity: 'base' });
    });
    var ids = [];
    var firstGroup = null;
    list.forEach(function (it) {
      var parts = String(it.path || '').split('/').filter(Boolean);
      var folder = parts.length >= 2 ? parts[parts.length - 2] : null;
      var g = null;
      if (folder) {
        groups.forEach(function (x) { if (!g && x.name === folder) g = x; });
        if (!g) g = addGroup(folder);
      } else {
        g = viewGroup() || addGroup(nextGroupName());
      }
      if (!firstGroup) firstGroup = g;
      var id = uid('t');
      registerTrack(id, g, {
        file: it.file,
        fileName: it.file.name,
        name: it.file.name.replace(/\.[^.]+$/, ''),
        ext: (it.file.name.match(/\.([^.]+)$/) || ['', ''])[1].toUpperCase(),
        afterAction: 'stop',
        autoCue: 'pending'
      });
      saveFile(id, it.file);
      ids.push(id);
    });
    syncOrder();
    // 取り込んだグループを表示する
    viewGroupId = firstGroup.id;
    selectedId = ids[0];
    afterChange();
    pump();
    return ids;
  }

  function readEntry(entry) {
    if (entry.isFile) {
      return new Promise(function (resolve) {
        entry.file(function (f) { resolve([{ file: f, path: entry.fullPath }]); }, function () { resolve([]); });
      });
    }
    if (entry.isDirectory) {
      var reader = entry.createReader();
      var children = [];
      return new Promise(function (resolve) {
        (function readBatch() {
          reader.readEntries(function (batch) {
            if (!batch.length) {
              Promise.all(children.map(readEntry)).then(function (lists) {
                resolve([].concat.apply([], lists));
              });
              return;
            }
            children = children.concat(Array.prototype.slice.call(batch));
            readBatch();
          }, function () { resolve([]); });
        })();
      });
    }
    return Promise.resolve([]);
  }

  // フォルダの中身をたどる（File System Access API）。
  // index.html を直接開いた場合（file://）は古い方式（readEntry）が失敗するため、こちらを優先する。
  async function readHandle(handle, path) {
    if (handle.kind === 'file') {
      return [{ file: await handle.getFile(), path: path }];
    }
    var found = [];
    for await (var child of handle.values()) {
      var list = await readHandle(child, path + '/' + child.name);
      found = found.concat(list);
    }
    return found;
  }

  // ドロップされた1項目（ファイルまたはフォルダ）を、ファイルの一覧にする
  async function readDroppedItem(source) {
    if (source.handlePromise) {
      try {
        var handle = await source.handlePromise;
        if (handle) return await readHandle(handle, handle.name);
      } catch (e) { /* 使えない環境では下の方式へ */ }
    }
    if (source.entry && source.entry.isDirectory) {
      var viaEntry = await readEntry(source.entry);
      if (viaEntry.length) return viaEntry;
    }
    // フォルダは getAsFile でも「ファイル」として返るが、中身は読めないので除く
    if (source.file && !(source.entry && source.entry.isDirectory)) {
      return [{ file: source.file, path: source.file.name }];
    }
    return [];
  }

  // ドロップされたファイル・フォルダを集める。
  // 各項目からの取り出しは、ドロップの処理中（この関数の同期部分）に済ませる必要がある。
  function collectDropped(dataTransfer) {
    var items = dataTransfer.items;
    if (items && items.length) {
      var sources = [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (item.kind !== 'file') continue;
        sources.push({
          handlePromise: typeof item.getAsFileSystemHandle === 'function' ? item.getAsFileSystemHandle() : null,
          entry: typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null,
          file: item.getAsFile()
        });
      }
      return Promise.all(sources.map(readDroppedItem)).then(function (lists) {
        return [].concat.apply([], lists);
      });
    }
    var files = Array.prototype.slice.call(dataTransfer.files || []);
    return Promise.resolve(files.map(function (f) { return { file: f, path: f.name }; }));
  }

  // ---------- 読み込み（再生テストと先読み） ----------

  // 読み込み待ちの中から、先読み対象（スタンバイに近い曲）を優先して1つ取り出す
  function takeNextJob() {
    var preload = engine.preloadIds(PRELOAD_AHEAD);
    for (var i = 0; i < preload.length; i++) {
      var index = jobs.indexOf(preload[i]);
      if (index >= 0) return jobs.splice(index, 1)[0];
    }
    return jobs.shift();
  }

  var autoCueCount = 0;
  var keyCount = 0; // この読み込みでキーを推定した曲の数（保存のきっかけ）

  function pump() {
    if (working) return;
    working = true;
    (function next() {
      if (!jobs.length) {
        working = false;
        if (keyCount) { keyCount = 0; saveSoon(); render(); }
        if (autoCueCount) {
          toast(autoCueCount + '曲の頭の無音を自動で詰めました（再生範囲で戻せます）');
          autoCueCount = 0;
        }
        return;
      }
      var id = takeNextJob();
      var t = tracks.get(id);
      if (!t || t.status === 'error') {
        next();
        return;
      }
      inflightId = id;
      var decoding = t.file ? audio.decodeFile(t.file) : Promise.reject(new Error('保存された曲データが見つかりません'));
      decoding.then(function (buffer) {
        if (!tracks.has(id)) return;
        if (!t.info) {
          t.info = audio.analyze(buffer);
          t.status = 'ok';
        }
        if (t.autoCue === 'pending') {
          if (autoTrimHead(t)) autoCueCount++;
          t.autoCue = 'done';
        }
        // オートゲイン用に一度だけラウドネスを測る（結果は保存するので、次からは測らない）
        var measuring = t.loud ? Promise.resolve() : audio.measureLoudness(buffer).then(function (r) {
          if (!tracks.has(id)) return;
          t.loud = {
            lufs: isFinite(r.lufs) ? Math.round(r.lufs * 100) / 100 : null,
            peakDb: isFinite(r.peakDb) ? Math.round(r.peakDb * 100) / 100 : null
          };
          applyGainToCurrent(t);
        }, function () { /* 測れなくても補正なしで鳴らす */ });
        // キーも一度だけ推定する（結果は保存する）
        var keying = t.keyInfo || !window.PonKey ? null : function () {
          return window.PonKey.analyze(buffer).then(function (r) {
            if (!tracks.has(id)) return;
            // 推定できなかった（ほぼ無音など）時も、推定し直さないよう印を残す
            t.keyInfo = r ? { key: r.key, conf: r.confidence, segs: r.segments.map(function (sg) { return [sg.start, sg.key]; }) } : { key: null };
            keyCount++;
          }, function () { /* 推定できなくても再生には関係ない */ });
        };
        if (keying) measuring = measuring.then(keying);
        return measuring.then(function () {
          if (!tracks.has(id)) return;
        // 先読み対象の曲だけメモリに残す。それ以外は必要になった時に読み直す
        if (engine.preloadIds(PRELOAD_AHEAD).indexOf(id) >= 0) {
          buffers.set(id, buffer);
          // 分離したボーカルも一緒に用意してから「準備OK」にする（読めなければ原曲のまま鳴らす）
          return loadVocalBuffer(t).then(function () {
            if (tracks.has(id) && buffers.has(id)) engine.setReady(id, true);
          });
        }
        });
      }, function (err) {
        if (!tracks.has(id)) return;
        t.status = 'error';
        t.error = VIDEO_EXT.test(t.fileName || t.name || '') ? '動画に音声が入っていないか、音声の形式に未対応です' : ((err && err.message) || '読み込みに失敗しました');
        engine.setPlayable(id, false);
      }).then(function () {
        inflightId = null;
        afterChange();
        setTimeout(next, 0);
      });
    })();
  }

  function loadVocalBuffer(t) {
    if (!t.vocal || !t.vocalFile) { vocalBuffers.delete(t.id); return Promise.resolve(); }
    if (vocalBuffers.has(t.id)) return Promise.resolve();
    return audio.decodeFile(t.vocalFile).then(function (vb) {
      if (tracks.has(t.id) && t.vocal) vocalBuffers.set(t.id, vb);
    }, function () {
      toast('「' + t.name + '」の分離したボーカルを読み込めませんでした。原曲のまま鳴らします');
    });
  }

  // 先読みの入れ替え：不要になった曲を手放し、必要な曲を読み込む
  function refreshPreload() {
    var keep = engine.preloadIds(PRELOAD_AHEAD);
    Array.from(buffers.keys()).forEach(function (id) {
      if (keep.indexOf(id) < 0) {
        buffers.delete(id);
        vocalBuffers.delete(id);
        engine.setReady(id, false);
      }
    });
    keep.forEach(function (id) {
      var t = tracks.get(id);
      if (t && t.status !== 'error' && !buffers.has(id) && jobs.indexOf(id) < 0 && id !== inflightId) jobs.push(id);
    });
    if (jobs.length) pump();
  }

  // ---------- 音を出す・止める ----------

  function startTrack(result) {
    if (bgmAutoFade && bgmNow && !bgmFading) bgmPause(BGM_FADE_SECONDS); // 本編のGOでBGMをフェードアウト（一時停止。再開で続きから）
    if (current) {
      if (result.cause === 'marker') tails.push(current.voice); // マーカー：前の曲は最後まで鳴らす（停止したら一緒に止める）
      else releasePrevious(current.voice); // 再生中の曲は、設定に従って即カットかフェードアウト
    }
    var t = tracks.get(result.trackId);
    var offset = rangeOf(t).start; // 再生範囲の開始から
    if (standbyStart && standbyStart.trackId === result.trackId) offset = standbyStart.offset;
    standbyStart = null; // 「途中から再生」は1回限り。次に同じ曲を出す時は開始位置から
    if (videoManual !== 'auto') videoManual = 'auto'; // 映像の手動の切り替えは、次の曲が始まるまで
    var entry = { trackId: result.trackId, voice: null };
    var mAt = markerFireAt(t);
    entry.markerDone = mAt != null && offset >= mAt; // マーカーより後から出した時は効かせない
    entry.voice = audio.play(buffers.get(result.trackId), playOptions(t, offset, entry));
    current = entry;
  }

  // 前の曲を手放す。フェードアウトの場合、次の曲は頭から普通の音量で出る（前の曲だけが下がっていく）
  function releasePrevious(voice) {
    if (goTransition === 'cut') {
      audio.cut(voice);
      return;
    }
    tails.push(voice);
    if (voice.fading) return; // Fで既にフェード中なら、そのまま続ける
    audio.fade(voice, FADE_SECONDS, function () {
      tails = tails.filter(function (v) { return v !== voice; });
    });
  }

  // フェードアウト中の前の曲もすべて止める
  function cutTails() {
    tails.forEach(function (v) { audio.cut(v); });
    tails = [];
  }

  // 曲が最後まで再生された
  function onVoiceEnded(entry) {
    if (current !== entry) return; // 既に別の曲へ切り替わっている
    current = null;
    var result = entry.voice.fading
      ? engine.fadeCompleted(entry.trackId)     // フェード中に曲が終わった → 停止扱い
      : engine.trackEnded(entry.trackId, now());
    if (result.type === 'play') startTrack(result); // 「続けて再生」
    afterChange();
  }

  function apply(result) {
    if (result.type === 'play') {
      startTrack(result);
    } else if (result.type === 'stop') {
      if (current) audio.cut(current.voice);
      current = null;
      cutTails();
    } else if (result.type === 'fade') {
      var entry = current;
      if (entry) {
        audio.fade(entry.voice, FADE_SECONDS, function () {
          engine.fadeCompleted(entry.trackId);
          if (current === entry) current = null;
          afterChange();
        });
      }
    } else if (result.type === 'ignored' && result.reason === 'not-ready') {
      toast('次の曲を読み込み中です。少し待ってからGOしてください');
    }
    afterChange();
    return result;
  }

  function pressGo() { return apply(engine.go(now())); }
  function pressStop() { return apply(engine.stop()); }
  function pressFade() { return apply(engine.fade()); }

  function afterChange() {
    // スタンバイ曲が変わったら、「途中から再生」の指定は捨てる（別の曲に残さない）
    if (standbyStart && standbyStart.trackId !== engine.getState(now()).standbyId) standbyStart = null;
    refreshPreload();
    render();
    saveSoon();
  }

  // ---------- 再生位置の移動（リハーサル用。本番ロック中は無効） ----------

  // いま波形に出ている曲。再生中ならその曲、止まっていればスタンバイ曲
  function waveTrack(state) {
    var id = current ? current.trackId : state.standbyId;
    var t = id && tracks.get(id);
    return t && t.info ? t : null;
  }

  function canSeek(state) {
    if (locked || !waveTrack(state)) return false;
    return current ? !state.fading : true;
  }

  // 再生中：その位置へ移動して再生を続ける
  // 停止中：スタンバイ曲を「その位置から再生」に指定する（次のGOの1回だけ）
  function seekTo(seconds) {
    if (locked) {
      toast('本番ロック中は再生位置を動かせません');
      return;
    }
    var state = engine.getState(now());
    var t = waveTrack(state);
    if (!t) return;
    var target = Math.max(0, Math.min(seconds, rangeOf(t).end - 0.25));
    if (current) {
      var buffer = buffers.get(current.trackId);
      if (state.fading || !buffer) return;
      var entry = current;
      var old = entry.voice;
      entry.voice = audio.play(buffer, playOptions(t, target, entry));
      audio.cut(old);
      // マーカーより前に戻したら、もう一度効くようにする（リハーサル用）
      var mAt = markerFireAt(t);
      entry.markerDone = mAt != null && target >= mAt;
      tick();
      return;
    }
    standbyStart = Math.abs(target - rangeOf(t).start) < 0.05 ? null : { trackId: t.id, offset: target };
    render();
  }

  function seekBy(delta) {
    var st = engine.getState(now());
    var wt = waveTrack(st);
    var base = current ? audio.position(current.voice) : (standbyStart ? standbyStart.offset : (wt ? rangeOf(wt).start : 0));
    seekTo(base + delta);
  }

  function setLocked(value) {
    locked = !!value;
    if (locked && standbyStart) {
      standbyStart = null;
      toast('本番ロックをかけたので、「途中から再生」の指定を解除しました');
    }
    hoverRatio = -1;
    $('waveHover').hidden = true;
    render();
  }

  // ---------- 画面の描画 ----------

  function render() {
    var state = engine.getState(now());
    // スタンバイが別のグループへ移ったら、そのグループのタブを表示する
    var standbyGroup = state.standbyId ? groupOf(state.standbyId) : null;
    if (standbyGroup && standbyGroup.id !== lastStandbyGroupId) {
      lastStandbyGroupId = standbyGroup.id;
      if (viewGroupId !== standbyGroup.id || bgmView) {
        viewGroupId = standbyGroup.id;
        selectedId = state.standbyId;
        bgmView = false;
      }
    }
    renderVideoBtn();
    var selT = selectedId && tracks.get(selectedId);
    $('deleteTrackBtn').disabled = !selT || bgmView || locked || selectedId === state.playingId;
    var vg = viewGroup();
    viewGroupId = vg ? vg.id : null;
    // 選択中の曲は、表示しているグループの中から
    if (vg && vg.trackIds.indexOf(selectedId) < 0) {
      selectedId = vg.trackIds.indexOf(state.standbyId) >= 0 ? state.standbyId : (vg.trackIds[0] || null);
    }
    if (!vg) selectedId = null;
    renderShow();
    renderTabs(state);
    renderSe();
    renderBgm();
    renderList(state);
    renderDetail(state);
    renderTransport(state);
    renderGo(state, true);
    if (state.standbyId !== lastStandbyId) {
      lastStandbyId = state.standbyId;
      var row = state.standbyId && document.querySelector('.cue-row[data-id="' + state.standbyId + '"]');
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    }
  }

  function cell(className, text) {
    var el = document.createElement('span');
    el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function renderShow() {
    var input = $('showName');
    if (document.activeElement !== input) input.value = show ? show.name : '';
    input.disabled = locked || !show;
    $('showsBtn').disabled = locked;
    var status = $('saveStatus');
    if (!storeOk) { status.textContent = '保存なし'; status.className = 'save-status is-error'; }
    else if (saveFailed) { status.textContent = '保存できませんでした'; status.className = 'save-status is-error'; }
    else if (saveTimer || pendingFiles) { status.textContent = '保存中…'; status.className = 'save-status'; }
    else { status.textContent = '保存済み'; status.className = 'save-status'; }
  }

  var TRACK_MIME = 'application/x-pondashi-track';
  var dragTrackId = null; // 曲リストからドラッグ中の曲

  function clearDropMarks() {
    Array.prototype.forEach.call(document.querySelectorAll('.is-drop-before, .is-drop-target'), function (el) {
      el.classList.remove('is-drop-before', 'is-drop-target');
    });
  }

  function endTrackDrag() {
    dragTrackId = null;
    clearDropMarks();
    Array.prototype.forEach.call(document.querySelectorAll('.cue-row.is-dragging'), function (el) { el.classList.remove('is-dragging'); });
  }

  function renderTabs(state) {
    var bar = $('groupTabs');
    bar.textContent = '';
    var playingGroup = state.playingId ? groupOf(state.playingId) : null;
    var standbyGroup = state.standbyId ? groupOf(state.standbyId) : null;
    groups.forEach(function (g) {
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.tabIndex = -1;
      tab.className = 'tab' + (g.id === viewGroupId && !bgmView ? ' is-active' : '');
      tab.dataset.groupId = g.id;
      if (playingGroup === g) tab.appendChild(cell('tab-dot is-playing', null));
      else if (standbyGroup === g) tab.appendChild(cell('tab-dot is-standby', null));
      tab.appendChild(cell('tab-name', g.name));
      tab.appendChild(cell('tab-count', String(g.trackIds.length)));
      tab.addEventListener('dragover', function (e) {
        if (!dragTrackId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearDropMarks();
        tab.classList.add('is-drop-target');
      });
      tab.addEventListener('drop', function (e) {
        if (!dragTrackId) return;
        e.preventDefault();
        e.stopPropagation();
        var moving = dragTrackId;
        endTrackDrag();
        if (groupOf(moving) !== g) moveTrackTo(moving, g.id, null);
      });
      tab.addEventListener('click', function () {
        viewGroupId = g.id;
        selectedId = null;
        bgmView = false;
        render();
        saveSoon();
      });
      bar.appendChild(tab);
    });
    $('addGroupBtn').disabled = locked;

    var vg = viewGroup();
    $('groupTools').hidden = !vg || bgmView;
    if (!vg || bgmView) return;
    var nameInput = $('groupName');
    if (document.activeElement !== nameInput) nameInput.value = vg.name;
    nameInput.disabled = locked;
    var index = groups.indexOf(vg);
    $('groupLeftBtn').disabled = locked || index <= 0;
    $('groupRightBtn').disabled = locked || index >= groups.length - 1;
    var hasPlaying = state.playingId && vg.trackIds.indexOf(state.playingId) >= 0;
    var del = $('groupDeleteBtn');
    del.disabled = locked || !!hasPlaying;
    del.textContent = confirmKey === 'group:' + vg.id ? '本当に削除' : 'グループを削除';
    del.classList.toggle('is-confirm', confirmKey === 'group:' + vg.id);
    var d = groupDuration(vg);
    $('groupTotal').textContent = vg.trackIds.length + '曲 ・ 合計 ' + fmtShort(d.total) + (d.unknown ? '（確認中）' : '');
  }

  // ---------- 曲名の変更（曲名をダブルクリック） ----------
  function startRename(id, cellEl) {
    var t = tracks.get(id);
    if (!t) return;
    if (locked) { toast('本番ロック中は曲名を変えられません'); return; }
    rowSelectBusy = true; // 入力中は一覧を作り直さない
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-input';
    input.value = t.name;
    input.maxLength = 120;
    input.setAttribute('aria-label', '曲名');
    cellEl.textContent = '';
    cellEl.appendChild(input);
    input.focus();
    input.select();
    var done = false;
    function finish(save) {
      if (done) return;
      done = true;
      var v = input.value.trim();
      if (save && v && v !== t.name) { t.name = v; toast('曲名を「' + v + '」にしました'); }
      rowSelectBusy = false;
      listRenderPending = false;
      afterChange();
    }
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return; // 日本語の変換中
      if (e.key === 'Enter') { e.preventDefault(); finish(true); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); input.blur(); }
    });
    input.addEventListener('blur', function () { finish(true); });
    input.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    input.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  var rowSelectBusy = false;
  var lastRowClick = { id: null, at: 0, title: false };
  var listRenderPending = false;

  // 一覧の中のプルダウン（きっかけ・終了後）
  function rowSelect(cls, options, value, onChange, label) {
    var sel = document.createElement('select');
    sel.className = 'row-select ' + cls;
    sel.setAttribute('aria-label', label);
    sel.draggable = false;
    sel.disabled = locked;
    options.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o[0];
      opt.textContent = o[1];
      if (o[0] === value) opt.selected = true;
      sel.appendChild(opt);
    });
    function release() {
      rowSelectBusy = false;
      if (listRenderPending) { listRenderPending = false; render(); }
    }
    sel.addEventListener('mousedown', function (e) { e.stopPropagation(); rowSelectBusy = true; });
    sel.addEventListener('click', function (e) { e.stopPropagation(); });
    sel.addEventListener('focus', function () { rowSelectBusy = true; });
    sel.addEventListener('blur', release);
    sel.addEventListener('change', function () {
      if (locked) return;
      onChange(sel.value);
      sel.blur(); // 選んだらすぐ外す（Space が GO に戻るように）
      rowSelectBusy = false;
      listRenderPending = false;
      afterChange();
    });
    return sel;
  }

  // ---------- キッカケと「終了後」の連動（Ver. 0.10.4） ----------
  // 次の曲のキッカケで、前の曲が終わった後の動きを決める。
  //   音先 → 続けて再生 ／ MC → 続けて再生（MCの曲自体はループ）／ 板付き・曲フリ・その他・指定なし → 停止
  // 連動するのはキッカケを選んだ時だけ。あとから手で「終了後」を変えればそちらが優先。
  // 前の曲が MC でループしている時は、ループを残す（MCの途中で次へ進まないように）
  function afterForNextCue(type) {
    return type === 'otosaki' || type === 'mc' ? 'continue' : 'stop';
  }

  function neighborIds(t) {
    var g = groupOf(t.id);
    var ids = g ? g.trackIds : [];
    var i = ids.indexOf(t.id);
    return { prev: i > 0 ? tracks.get(ids[i - 1]) : null, next: i >= 0 && i < ids.length - 1 ? tracks.get(ids[i + 1]) : null };
  }

  function keepsLoop(t) { return t.cue && t.cue.type === 'mc' && t.afterAction === 'loop'; }

  var AFTER_LABEL = { stop: '停止', continue: '続けて再生', loop: 'ループ' };

  function linkCueToAfter(t, oldType, newType) {
    if (locked || oldType === newType) return;
    var n = neighborIds(t);
    var notes = [];
    if (n.prev && !keepsLoop(n.prev)) {
      var want = afterForNextCue(newType);
      if (n.prev.afterAction !== want) {
        setAfterAction(n.prev, want);
        notes.push('前の曲「' + n.prev.name + '」の終了後を「' + AFTER_LABEL[want] + '」に');
      }
    }
    if (newType === 'mc' && t.afterAction !== 'loop') {
      setAfterAction(t, 'loop');
      notes.push('この曲を「ループ」に');
    } else if (oldType === 'mc' && newType !== 'mc' && t.afterAction === 'loop') {
      // MC をやめたら、この曲の終了後は次の曲のキッカケに合わせて戻す
      var back = afterForNextCue(n.next && n.next.cue ? n.next.cue.type : '');
      setAfterAction(t, back);
      notes.push('この曲を「' + AFTER_LABEL[back] + '」に');
    }
    if (notes.length) toast('キッカケに合わせて、' + notes.join('、') + 'しました');
  }

  // グループの全曲の「終了後」を、キッカケに合わせてそろえ直す
  function alignAfterToCues() {
    if (locked) return;
    var g = viewGroup();
    if (!g) return;
    var changed = 0;
    g.trackIds.forEach(function (id, i) {
      var t = tracks.get(id);
      if (!t) return;
      var next = tracks.get(g.trackIds[i + 1]);
      var want = t.cue && t.cue.type === 'mc' ? 'loop' : afterForNextCue(next && next.cue ? next.cue.type : '');
      if (t.afterAction !== want) { setAfterAction(t, want); changed++; }
    });
    afterChange();
    toast(changed ? '「' + g.name + '」の' + changed + '曲の終了後を、キッカケに合わせました' : '「' + g.name + '」はすでにキッカケどおりです');
  }

  function setAfterAction(t, v) {
    if (!t || locked) return;
    t.afterAction = v;
    // ループはエンジン上は「停止」（終わりで止まる扱い）。実際の繰り返しは再生側で行う
    engine.setAfterAction(t.id, v === 'continue' ? 'continue' : 'stop');
    applyRangeToCurrent(t);
  }

  function renderList(state) {
    $('bgmView').hidden = !bgmView;
    if (bgmView) {
      $('emptyState').hidden = true;
      $('cueTable').hidden = true;
      $('detail').hidden = true;
      return;
    }
    var vg = viewGroup();
    var ids = vg ? vg.trackIds : [];
    var hasTracks = ids.length > 0;
    $('emptyState').hidden = hasTracks;
    $('cueTable').hidden = !hasTracks;
    $('detail').hidden = !hasTracks;
    $('main').classList.toggle('is-empty', !hasTracks);
    $('emptyTitle').textContent = vg ? '「' + vg.name + '」には曲がありません' : '曲ファイルをここにドラッグ＆ドロップ';
    $('emptySub').textContent = vg
      ? 'ファイルを落とすとこのグループに入ります。フォルダごと落とすと、フォルダ名のグループを作ります。'
      : 'フォルダごと落とすと、フォルダ名のグループを作ります。ファイル名の番号順に並びます。';

    var rows = $('cueRows');
    // 一覧のプルダウンを開いている間は作り直さない（作り直すとプルダウンが閉じてしまう）
    if (rowSelectBusy) { listRenderPending = true; return; }
    rows.textContent = '';
    ids.forEach(function (id, index) {
      var t = tracks.get(id);
      var isPlaying = id === state.playingId;
      var isStandby = id === state.standbyId;
      var isDone = !isPlaying && !isStandby && !!state.played[id];

      var row = document.createElement('div'); // 中にプルダウンを置くので button ではなく div
      row.type = 'button';
      row.tabIndex = -1;
      row.dataset.id = id;
      row.className = 'cue-row' +
        (isPlaying ? ' is-playing' : '') +
        (isStandby ? ' is-standby' : '') +
        (isDone ? ' is-done' : '') +
        (t.status === 'error' ? ' is-error' : '') +
        (id === selectedId ? ' is-selected' : '');

      row.appendChild(cell('c-num', 'M' + (index + 1)));

      var stateCell = cell('c-state');
      var badgeText = isPlaying ? (state.fading ? 'フェード中' : '再生中')
        : isStandby ? (state.armed ? '構え中' : 'スタンバイ')
        : isDone ? '済' : '';
      if (badgeText) {
        stateCell.appendChild(cell('badge' + (isPlaying ? ' is-playing' : isStandby ? ' is-standby' : ' is-done'), badgeText));
      }
      row.appendChild(stateCell);

      var titleCell = cell('c-title', null);
      titleCell.appendChild(cell('title-text', t.name));
      if (isVideoTrack(t)) titleCell.appendChild(cell('video-tag', '映像'));
      if (t.vocal && t.vocal.level < 0.995) titleCell.appendChild(cell('vocal-tag', 'Vo ' + Math.round(t.vocal.level * 100) + '%'));
      var gdb = trackGainDb(t);
      if (t.loud && Math.abs(gdb) >= 0.5) titleCell.appendChild(cell('gain-tag', fmtDb(gdb).replace(' ', '')));
      var ks = keyShort(t);
      if (ks) titleCell.appendChild(cell('key-tag', ks));
      if (markerUsable(t)) titleCell.appendChild(cell('marker-tag', '◆' + fmtShort(t.marker) + (t.markerDelay ? '+' + t.markerDelay + 's' : '')));
      titleCell.title = locked ? '' : 'ダブルクリックで曲名を変更';

      row.appendChild(titleCell);
      var cueCell = cell('c-cue', null);
      cueCell.appendChild(rowSelect('row-cue k-' + (t.cue.type || 'none'), [['', '—'], ['otosaki', '音先'], ['itatsuki', '板付き'], ['furi', '曲フリ'], ['mc', 'MC'], ['other', 'その他']], t.cue.type || '', function (v) {
        var old = t.cue.type || '';
        t.cue.type = v;
        linkCueToAfter(t, old, v);
      }, 'きっかけ'));
      if (t.cue.text) cueCell.appendChild(cell('cue-memo', t.cue.text));
      cueCell.title = cueTitle(t);
      row.appendChild(cueCell);
      row.appendChild(cell('c-dur', t.info ? fmtShort(rangeOf(t).end - rangeOf(t).start) : '—'));
      var check = checkOf(t);
      row.appendChild(cell('c-check ' + check.cls, check.text));
      var afterCell = cell('c-after', null);
      afterCell.appendChild(rowSelect('row-after a-' + t.afterAction, [['stop', '停止'], ['continue', '続けて再生'], ['loop', 'ループ']], t.afterAction, function (v) {
        setAfterAction(t, v);
      }, 'この曲が終わったら'));
      row.appendChild(afterCell);

      // クリックは「選択」だけ。音が出るのはGOのみ
      row.dataset.id = id;
      row.addEventListener('click', function (e) {
        // 曲名を素早く2回クリック → 曲名の変更（1回目のクリックで一覧が作り直されるので、自前で判定する）
        var onTitle = !!(e.target.closest && e.target.closest('.c-title'));
        var nowMs = Date.now();
        var dbl = onTitle && lastRowClick.id === id && lastRowClick.title && nowMs - lastRowClick.at < 450;
        lastRowClick = { id: id, at: dbl ? 0 : nowMs, title: onTitle };
        selectedId = id;
        row.blur();
        render();
        if (dbl) {
          var fresh = document.querySelector('.cue-row[data-id="' + id + '"] .c-title');
          if (fresh) startRename(id, fresh);
        }
      });
      // ドラッグで並べ替え（行の上に落とすとその前へ）、タブに落とすとそのグループへ
      row.draggable = !locked;
      row.addEventListener('dragstart', function (e) {
        if (locked) { e.preventDefault(); return; }
        dragTrackId = id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(TRACK_MIME, id);
        row.classList.add('is-dragging');
      });
      row.addEventListener('dragend', function () { endTrackDrag(); });
      row.addEventListener('dragover', function (e) {
        if (!dragTrackId || dragTrackId === id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearDropMarks();
        row.classList.add('is-drop-before');
      });
      row.addEventListener('drop', function (e) {
        if (!dragTrackId) return;
        e.preventDefault();
        e.stopPropagation();
        var moving = dragTrackId;
        endTrackDrag();
        var g = groupOf(id);
        if (g && moving !== id) moveTrackTo(moving, g.id, id);
      });
      rows.appendChild(row);
    });
  }

  function addDetail(list, term, text, cls) {
    var dt = document.createElement('dt');
    dt.textContent = term;
    var dd = document.createElement('dd');
    dd.textContent = text;
    if (cls) dd.className = cls;
    list.appendChild(dt);
    list.appendChild(dd);
  }

  function renderDetail(state) {
    var t = selectedId && tracks.get(selectedId);
    if (!t) return;
    var g = groupOf(t.id);
    var index = g ? g.trackIds.indexOf(t.id) : -1;
    var count = g ? g.trackIds.length : 0;
    $('detailTitle').textContent = titleOf(t.id);

    var list = $('detailList');
    list.textContent = '';
    addDetail(list, 'ファイル', t.fileName);
    var check = checkOf(t);
    if (t.info) {
      addDetail(list, '形式', t.ext + ' ・ ' + (t.info.channels === 1 ? 'モノラル' : t.info.channels === 2 ? 'ステレオ' : t.info.channels + 'ch'));
      addDetail(list, '尺', fmtShort(t.info.duration));
      addDetail(list, '頭の無音',
        t.info.headSilence >= 0.05 ? fmtSeconds(t.info.headSilence) : 'なし',
        t.info.headSilence >= HEAD_SILENCE_WARN ? 'is-warn' : '');
      var tail = tailSilence(t.info);
      if (tail >= TAIL_SILENCE_NOTE && !t.info.allSilent) {
        addDetail(list, '音が終わる位置', fmtShort(t.info.audibleEnd) + '（末尾に無音' + fmtSeconds(tail) + '）');
      }
    }
    addDetail(list, 'チェック', t.status === 'error' ? '読み込めません（' + t.error + '）' : check.text, check.cls);

    var r = rangeOf(t);
    var hasInfo = !!t.info;
    [['rangeStart', r.start, (t.inPoint || 0) > 0], ['rangeEnd', r.end, t.outPoint != null]].forEach(function (x) {
      var input = $(x[0]);
      if (document.activeElement !== input) input.value = hasInfo ? fmtPrecise(x[1]) : '';
      input.disabled = locked || !hasInfo;
      input.classList.toggle('is-set', x[2]);
    });
    var isCurrent = !!(current && current.trackId === t.id);
    $('trimHead').disabled = locked || !hasInfo || t.info.allSilent || t.info.headSilence < 0.05;
    $('trimTail').disabled = locked || !hasInfo || t.info.allSilent || tailSilence(t.info) < 0.2;
    $('setInNow').disabled = locked || !isCurrent;
    $('setOutNow').disabled = locked || !isCurrent;
    $('rangeReset').disabled = locked || !r.set;
    $('standbyBtn').disabled = t.status === 'error' || t.id === state.standbyId;
    $('standbyBtn').textContent = t.id === state.standbyId ? 'スタンバイ中' : 'スタンバイにする';
    // 本番ロック中は、並べ替え・削除・「終わったら」の変更を止める
    $('moveUpBtn').disabled = locked || index <= 0;
    $('moveDownBtn').disabled = locked || index < 0 || index >= count - 1;
    $('removeBtn').disabled = locked || t.id === state.playingId;
    $('trimHeadAll').disabled = locked;
    $('alignAfter').disabled = locked;
    renderMarker(t);
    renderKey(t);
    renderGain(t);
    renderVocal(t, state);
    renderCueEditor(t);
    renderFolds(t);
    renderMoveGroup(t);
  }

  // ---------- 折りたたみ（再生範囲・ボーカル） ----------
  // 開くかどうか：見出しを押した時はその通り。押していなければ「使っている曲」だけ自動で開く。
  // 別の曲を選ぶと、自動に戻る
  var foldState = { range: null, gain: null, vocal: null };
  var foldTrackId = null;

  function foldAuto(name, t) {
    if (name === 'range') return rangeOf(t).set;
    if (name === 'gain') return !!t.gainAdj;
    return !!(t.vocal || (vocalJob && vocalJob.id === t.id) || vocalQueue.indexOf(t.id) >= 0);
  }

  function foldSummary(name, t) {
    if (name === 'range') {
      var r = rangeOf(t);
      return r.set ? fmtPrecise(r.start) + ' 〜 ' + fmtPrecise(r.end) : '曲の全体';
    }
    if (name === 'gain') {
      if (!t.loud) return t.status === 'error' ? '—' : '測っています…';
      return fmtDb(trackGainDb(t)) + (t.gainAdj ? '（微調整あり）' : '');
    }
    if (vocalJob && vocalJob.id === t.id) return '分けています…';
    if (vocalQueue.indexOf(t.id) >= 0) return '順番待ち';
    if (t.vocal) return t.vocal.level >= 0.995 ? '分離済み・100%' : '分離済み・' + Math.round(t.vocal.level * 100) + '%';
    return vocalAvailable() ? '未分離' : 'アプリ版のみ';
  }

  function renderFolds(t) {
    if (foldTrackId !== t.id) { foldTrackId = t.id; foldState = { range: null, gain: null, vocal: null }; }
    ['range', 'gain', 'vocal'].forEach(function (name) {
      var open = foldState[name] != null ? foldState[name] : foldAuto(name, t);
      var box = $(name + 'Group');
      box.classList.toggle('is-open', open);
      var head = box.querySelector('.fold-head');
      head.setAttribute('aria-expanded', String(open));
      head.querySelector('.fold-summary').textContent = foldSummary(name, t);
    });
  }

  function toggleFold(name) {
    var t = selectedId && tracks.get(selectedId);
    if (!t) return;
    var box = $(name + 'Group');
    foldState[name] = !box.classList.contains('is-open');
    renderFolds(t);
  }

  function renderGain(t) {
    var note = $('gainNote');
    note.textContent = '';
    var a = autoGainInfo(t);
    if (!t.loud) {
      note.textContent = t.status === 'error' ? '読み込めない曲です' : 'ラウドネスを測っています…';
    } else if (t.loud.lufs == null) {
      note.textContent = '音が入っていないため、補正しません';
    } else {
      var line = 'ラウドネス ' + t.loud.lufs.toFixed(1).replace('-', '−') + ' LUFS（ピーク ' + (t.loud.peakDb == null ? '—' : t.loud.peakDb.toFixed(1).replace('-', '−')) + ' dB）';
      note.appendChild(document.createTextNode(line));
      note.appendChild(document.createElement('br'));
      if (!autoGainOn) note.appendChild(document.createTextNode('オートゲインは切っています'));
      else note.appendChild(document.createTextNode('自動 ' + fmtDb(a.db) + '（目標 ' + String(LOUD_TARGET).replace('-', '−') + ' LUFS）'));
      var total = trackGainDb(t);
      if (t.loud.peakDb != null && t.loud.peakDb + total > 0) {
        note.appendChild(document.createElement('br'));
        var w2 = document.createElement('span');
        w2.className = 'is-warn';
        w2.textContent = 'ピークが 0 dB を超えます（クリップする可能性があります）';
        note.appendChild(w2);
      }
    }
    $('gainValue').textContent = fmtDb(trackGainDb(t));
    $('gainValue').title = '微調整 ' + fmtDb(t.gainAdj || 0);
    $('gainDown').disabled = !t.loud || (t.gainAdj || 0) <= -GAIN_ADJ_MAX;
    $('gainUp').disabled = !t.loud || (t.gainAdj || 0) >= GAIN_ADJ_MAX;
    $('gainReset').disabled = !t.gainAdj;
    var tg = $('autoGainToggle');
    tg.setAttribute('aria-pressed', String(autoGainOn));
    tg.disabled = locked;
  }

  function setGainAdj(t, db) {
    if (!t) return;
    t.gainAdj = Math.max(-GAIN_ADJ_MAX, Math.min(GAIN_ADJ_MAX, Math.round(db * 10) / 10));
    if (Math.abs(t.gainAdj) < 0.05) t.gainAdj = 0;
    applyGainToCurrent(t);
    afterChange();
  }

  function setAutoGain(on) {
    autoGainOn = !!on;
    saveSetting('autoGain', autoGainOn ? '1' : '0');
    if (current) applyGainToCurrent(tracks.get(current.trackId));
    if (bgmNow && bgmNow.voice) bgmAudio.setTrim(bgmNow.voice, dbToGain(bgmGainDb(bgmTracks.get(bgmNow.trackId))));
    render();
    toast(autoGainOn ? 'オートゲインを入れました（本編と BGM の音量をそろえます）' : 'オートゲインを切りました（元の音量で鳴らします）');
  }

  function trimHeadAll() {
    if (locked) return;
    var n = 0, waiting = 0;
    tracks.forEach(function (t) {
      if (!t.info) { if (t.status !== 'error' && !(t.inPoint > 0)) { t.autoCue = 'pending'; waiting++; } return; }
      if (autoTrimHead(t)) n++;
    });
    afterChange();
    if (n || waiting) toast((n ? n + '曲の頭の無音を詰めました' : '') + (waiting ? (n ? '。' : '') + '読み込み中の' + waiting + '曲は、読み込めたら詰めます' : ''));
    else toast('詰める曲はありませんでした（開始位置を手で決めた曲は変えません）');
  }

  function renderCueEditor(t) {
    var input = $('cueText');
    if (document.activeElement !== input) input.value = t.cue.text || '';
  }

  function renderMoveGroup(t) {
    var sel = $('moveGroupSelect');
    var g = groupOf(t.id);
    sel.textContent = '';
    groups.forEach(function (x) {
      var o = document.createElement('option');
      o.value = x.id;
      o.textContent = x.name;
      if (x === g) o.selected = true;
      sel.appendChild(o);
    });
    sel.disabled = locked || groups.length < 2;
  }

  function renderTransport(state) {
    var playing = state.playingId && tracks.get(state.playingId);
    var badge = $('nowBadge');
    var isLoop = !!(playing && playing.afterAction === 'loop');
    badge.textContent = playing ? (state.fading ? 'フェード中' : isLoop ? 'ループ中' : '再生中') : '停止中';
    badge.className = 'badge' + (playing ? (isLoop && !state.fading ? ' is-playing is-loop-now' : ' is-playing') : '');
    $('nowTitle').textContent = playing ? titleOf(playing.id) : '—';
    var playingGroup = playing ? groupOf(playing.id) : null;
    $('nowGroup').textContent = playingGroup ? playingGroup.name : '';

    var standby = state.standbyId && tracks.get(state.standbyId);
    var standbyGroup = standby ? groupOf(standby.id) : null;
    $('nextBox').classList.toggle('is-empty', !standby);
    $('nextTitle').textContent = standby ? titleOf(standby.id) : 'スタンバイなし';
    var nextCue = $('nextCue');
    nextCue.textContent = '';
    nextCue.hidden = !hasCue(standby);
    if (hasCue(standby)) nextCue.appendChild(cueNode(standby));
    // 次の曲が別のグループの時は、はっきり知らせる
    var otherGroup = !!(standbyGroup && playingGroup && standbyGroup !== playingGroup);
    $('nextGroup').textContent = standbyGroup ? standbyGroup.name : '';
    $('nextGroup').className = 'next-group' + (otherGroup ? ' is-other' : '');
    $('nextLabel').textContent = otherGroup ? 'GOで出る曲（次のグループ）' : 'GOで出る曲';
    var sub = $('nextSub');
    sub.className = 'next-sub';
    if (!standby) {
      sub.textContent = state.order.length ? 'リストの最後まで再生済み' : '曲を取り込んでください';
    } else if (!standby.info) {
      sub.textContent = standby.status === 'error' ? '読み込めません' : '確認中…';
    } else {
      var check = checkOf(standby);
      var sr = rangeOf(standby);
      sub.textContent = '尺 ' + fmtShort(sr.end - sr.start) + (sr.set ? '（範囲指定）' : '') +
        (standby.vocal && standby.vocal.level < 0.995 ? ' ・ ボーカル ' + Math.round(standby.vocal.level * 100) + '%' : '') +
        (check.cls === 'is-warn' ? ' ・ ' + check.text : '');
      if (check.cls === 'is-warn') sub.className = 'next-sub is-warn';
    }

    // 「途中から再生」が指定されている時は、はっきり表示する
    var hasOffset = !!(standby && standbyStart && standbyStart.trackId === standby.id);
    $('nextBox').classList.toggle('has-offset', hasOffset);
    $('startResetBtn').hidden = !hasOffset;
    if (hasOffset) {
      sub.textContent = '途中から再生：' + fmtShort(standbyStart.offset) + ' から';
      sub.className = 'next-sub is-warn';
    }

    $('stopSub').textContent = state.armed ? '構え解除' : 'Esc';
    $('modeSingle').setAttribute('aria-pressed', String(state.goMode === 'single'));
    $('modeDouble').setAttribute('aria-pressed', String(state.goMode === 'double'));
    $('modeSingle').disabled = locked;
    $('modeDouble').disabled = locked;
    $('transCut').setAttribute('aria-pressed', String(goTransition === 'cut'));
    $('transFade').setAttribute('aria-pressed', String(goTransition === 'fade'));
    $('transCut').disabled = locked;
    $('transFade').disabled = locked;
    $('lockBtn').setAttribute('aria-pressed', String(locked));
    $('lockLabel').textContent = locked ? '本番ロック中' : '本番ロック';
    $('seekButtons').hidden = locked;
    tick();
  }

  // GOボタン：塗りつぶし＝次の1回で音が出る／枠だけ＝構えるだけ／グレー＝何も起きない
  function renderGo(state, force) {
    var guardText = state.goState === 'guard' ? (Math.ceil(state.guardRemainingMs / 100) / 10).toFixed(1) : '';
    var key = state.goState + '|' + state.armed + '|' + guardText;
    if (!force && key === lastGoKey) return;
    lastGoKey = key;

    var btn = $('goBtn');
    var armed = state.armed && state.goState === 'will-play';
    btn.dataset.state = state.goState;
    btn.classList.toggle('is-armed', armed);

    var label = 'GO';
    var sub = 'Space';
    if (state.goState === 'guard') { label = 'ガード中'; sub = 'あと' + guardText + '秒'; }
    else if (state.goState === 'no-standby') { sub = 'スタンバイなし'; }
    else if (state.goState === 'not-ready') { label = '準備中'; sub = '読み込み中…'; }
    else if (state.goState === 'will-arm') { sub = '1回目で構え'; }
    else if (armed) { label = '構え中'; sub = 'もう一度で再生'; }
    $('goLabel').textContent = label;
    $('goSub').textContent = sub;
  }

  // ---------- 再生位置の表示（毎フレーム） ----------

  function tick() {
    var state = engine.getState(now());
    renderGo(state, false);

    var playing = current && tracks.get(current.trackId);
    var remain = $('remainTime');
    if (playing && playing.info) {
      var pos = audio.position(current.voice);
      var looping = playing.afterAction === 'loop';
      var range = rangeOf(playing);
      var end = looping ? range.end : remainEndOf(playing);
      var left = end - pos;
      // 残り時間は「終了位置」または「実際に音が終わる位置」まで
      remain.textContent = '-' + fmtClock(Math.ceil(Math.max(0, left)));
      // 残り30秒で黄色、15秒で赤く点滅。音が終わった後（末尾の無音）とループ中は点滅させない
      $('remainBox').className = 'remain' + (looping ? ' is-loop' :
        (left <= 0 ? '' : left <= DANGER_SECONDS ? ' is-danger' : left <= WARN_SECONDS ? ' is-warn' : ''));
      $('nowSub').textContent = fmtClock(pos) + ' / ' + fmtClock(playing.info.duration) +
        (looping ? '（ループ中）' : (left <= 0 && pos < range.end ? '（末尾の無音）' : ''));
      var mAt = !current.markerDone ? markerFireAt(playing) : null;
      if (mAt != null && mAt - pos <= 30 && mAt >= pos) {
        var mk = document.createElement('span');
        mk.className = 'now-marker';
        mk.textContent = '　マーカー：次の曲まで ' + Math.max(0, mAt - pos).toFixed(1) + '秒';
        $('nowSub').appendChild(mk);
      }
      waveMarker = markerUsable(playing) ? playing.marker / playing.info.duration : -1;
      drawWave(playing.info, pos / playing.info.duration, -1, range);
    } else {
      remain.textContent = '--:--';
      $('remainBox').className = 'remain';
      $('nowSub').textContent = '--:-- / --:--';
      var standby = state.standbyId && tracks.get(state.standbyId);
      var hasInfo = standby && standby.info;
      var startRatio = hasInfo && standbyStart && standbyStart.trackId === standby.id
        ? standbyStart.offset / standby.info.duration : -1;
      waveMarker = hasInfo && markerUsable(standby) ? standby.marker / standby.info.duration : -1;
      drawWave(hasInfo ? standby.info : null, -1, startRatio, hasInfo ? rangeOf(standby) : null);
    }
    $('waveWrap').classList.toggle('is-seekable', canSeek(state));
    renderBgmTime();
    sePlaying.forEach(function (voices, id) {
      var voice = voices[voices.length - 1];
      var bar = document.querySelector('.pad[data-id="' + id + '"] .pad-bar');
      if (bar && voice) bar.style.width = (Math.min(1, audio.position(voice) / voice.duration) * 100) + '%';
    });
  }

  function loop() {
    tick();
    window.requestAnimationFrame(loop);
  }

  // ---------- 波形 ----------
  // 低域＝青、中域＝オレンジ、高域＝白 の3層で描く。
  // 曲ごとに一度だけ画像を作っておき、毎フレームはそれを貼るだけにする。

  // 青系：全体の輪郭（濃い青）→ 低域（青）→ 中域（明るい青）→ 高域（白に近い水色、細め）
  var WAVE_LAYERS = [
    { band: 'peak', color: '#173a86', scale: 1 },
    { band: 0, color: '#2a6ae8', scale: 1 },
    { band: 1, color: '#5ea0ff', scale: 0.9 },
    { band: 2, color: '#cfe6ff', scale: 0.55 }
  ];
  var RULER_HEIGHT = 12;
  var waveCache = { info: null, w: 0, h: 0, ratio: 0, bright: null, dim: null };

  function buildWaveImage(info, w, h, ratio, alpha) {
    var c = document.createElement('canvas');
    c.width = Math.round(w * ratio);
    c.height = Math.round(h * ratio);
    var g = c.getContext('2d');
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    var center = (h - RULER_HEIGHT) / 2;
    var norm = info.peak > 0 ? 1 / info.peak : 1;
    var cols = Math.max(1, Math.round(w * ratio));
    var colWidth = w / cols;
    var layers = info.bands ? WAVE_LAYERS : [{ band: 'peak', color: '#2a6ae8', scale: 1 }];
    g.globalAlpha = alpha;
    for (var layer = 0; layer < layers.length; layer++) {
      var spec = layers[layer];
      var arr = spec.band === 'peak' ? info.peaks : info.bands[spec.band];
      var n = arr.length;
      g.fillStyle = spec.color;
      g.beginPath();
      for (var x = 0; x < cols; x++) {
        var from = Math.floor(x / cols * n);
        var to = Math.max(from + 1, Math.floor((x + 1) / cols * n));
        var v = 0;
        for (var k = from; k < to && k < n; k++) if (arr[k] > v) v = arr[k];
        var half = Math.min(1, v * norm) * spec.scale * (center - 1);
        if (half < 0.3) continue;
        g.rect(x * colWidth, center - half, colWidth + 0.02, half * 2);
      }
      g.fill();
    }
    g.globalAlpha = 1;

    // 時間の目盛り（30秒ごと、1分ごとに数字）
    var duration = info.duration;
    if (duration > 0) {
      var step = duration > 600 ? 60 : 30;
      var perMinute = w / duration * 60;
      var labelEvery = perMinute < 34 ? (perMinute < 18 ? 5 : 2) : 1;
      g.fillStyle = '#5b6370';
      g.fillRect(0, h - RULER_HEIGHT, w, 1);
      g.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--mono');
      g.textBaseline = 'bottom';
      for (var t = step; t < duration; t += step) {
        var px = Math.round(t / duration * w);
        var isMinute = t % 60 === 0;
        g.fillStyle = '#5b6370';
        g.fillRect(px, h - RULER_HEIGHT, 1, isMinute ? 5 : 3);
        if (isMinute && (t / 60) % labelEvery === 0 && px < w - 24) {
          g.fillStyle = '#8a93a1';
          g.fillText((t / 60) + ':00', px + 3, h);
        }
      }
    }
    return c;
  }

  // progress が 0〜1 なら再生位置（それより前は暗く）。-1 はスタンバイ曲の下見表示
  // startRatio が 0〜1 なら「ここから再生」の印を付ける
  //        range { start, end }（秒）があれば、範囲の外を暗くして開始・終了の印を付ける
  var waveMarker = -1; // 波形に出すマーカーの位置（0〜1、なければ -1）

  function drawWave(info, progress, startRatio, range) {
    var canvas = $('wave');
    var ratio = window.devicePixelRatio || 1;
    var width = canvas.clientWidth;
    var height = canvas.clientHeight;
    if (!width || !height) return;
    var W = Math.round(width * ratio);
    var H = Math.round(height * ratio);
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    var g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0c0e11';
    g.fillRect(0, 0, W, H);
    if (!info) {
      g.fillStyle = '#2e333d';
      g.fillRect(0, Math.round((H - RULER_HEIGHT * ratio) / 2), W, Math.max(1, Math.round(ratio)));
      return;
    }

    if (waveCache.info !== info || waveCache.w !== width || waveCache.h !== height || waveCache.ratio !== ratio) {
      waveCache = {
        info: info, w: width, h: height, ratio: ratio,
        bright: buildWaveImage(info, width, height, ratio, 1),
        dim: buildWaveImage(info, width, height, ratio, 0.28)
      };
    }
    function part(img, fromRatio, toRatio) {
      var sx = Math.max(0, Math.round(fromRatio * W));
      var ex = Math.min(W, Math.round(toRatio * W));
      if (ex > sx) g.drawImage(img, sx, 0, ex - sx, H, sx, 0, ex - sx, H);
    }

    if (progress >= 0) {
      part(waveCache.dim, 0, progress);
      part(waveCache.bright, progress, 1);
    } else if (startRatio >= 0) {
      part(waveCache.dim, 0, startRatio);
      part(waveCache.bright, startRatio, 1);
    } else {
      g.globalAlpha = 0.75;
      part(waveCache.bright, 0, 1);
      g.globalAlpha = 1;
    }

    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    var waveHeight = height - RULER_HEIGHT;
    // 再生範囲の外を暗くする
    if (range && range.set && info.duration > 0) {
      var rs = range.start / info.duration * width;
      var re = range.end / info.duration * width;
      g.fillStyle = 'rgba(8, 9, 12, 0.72)';
      if (rs > 0) g.fillRect(0, 0, rs, waveHeight);
      if (re < width) g.fillRect(re, 0, width - re, waveHeight);
      g.fillStyle = '#5b9bff';
      if (rs > 0) g.fillRect(Math.min(width - 2, rs), 0, 2, waveHeight);
      if (re < width) g.fillRect(Math.max(0, re - 2), 0, 2, waveHeight);
    }
    // 音が終わる位置の印
    if (!info.allSilent && tailSilence(info) >= TAIL_SILENCE_NOTE) {
      g.fillStyle = '#a3abb8';
      g.fillRect(Math.min(width - 2, (info.audibleEnd / info.duration) * width), 0, 2, waveHeight);
    }
    // マーカーの印（オレンジ）
    if (waveMarker >= 0) {
      g.fillStyle = '#ffb224';
      var mx = Math.min(width - 2, waveMarker * width);
      g.fillRect(mx, 0, 2, waveHeight);
      g.beginPath();
      g.moveTo(mx - 4, 0); g.lineTo(mx + 6, 0); g.lineTo(mx + 1, 6);
      g.fill();
    }
    // 「ここから再生」の印
    if (startRatio >= 0) {
      g.fillStyle = '#9cc4ff';
      g.fillRect(Math.min(width - 3, startRatio * width), 0, 3, height);
    }
    // 再生位置
    if (progress >= 0) {
      var x = Math.min(width - 2, progress * width);
      g.fillStyle = '#ffffff';
      g.fillRect(x - 1, 0, 2, height);
      g.beginPath();
      g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 6);
      g.fill();
    }
    // カーソル位置の線
    if (hoverRatio >= 0) {
      g.fillStyle = 'rgba(236, 238, 242, 0.7)';
      g.fillRect(Math.min(width - 1, hoverRatio * width), 0, 1, height);
    }
  }

  // ---------- 出力デバイス ----------

  function addOption(select, value, text) {
    var option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  }

  // 出力デバイスの一覧を作る。
  // ブラウザは、許可を出すまで出力デバイスの名前を教えてくれない。
  // その場合は「ほかの出力デバイスを表示…」を選択肢に出し、選ばれたら許可を求める。
  function refreshOutputs(announce) {
    return refreshMainOutput(announce).then(function (count) {
      return refreshBgmOutput().then(function () { return count; }, function () { return count; });
    });
  }

  var lastNamedOutputs = [];

  function refreshMainOutput(announce) {
    var select = $('outputSelect');
    if (!audio.canSelectOutput()) {
      select.disabled = true;
      select.title = 'この環境では出力デバイスを選べません（既定の出力を使います）';
      return Promise.resolve(0);
    }
    return audio.listOutputs().then(function (devices) {
      var wantedId = loadSetting('output', 'default');
      var wantedLabel = loadSetting('outputLabel', '');
      var named = devices.filter(function (d) {
        return d.label && d.id && d.id !== 'default' && d.id !== 'communications';
      });
      lastNamedOutputs = named;
      select.textContent = '';
      addOption(select, 'default', '既定の出力');
      named.forEach(function (d) { addOption(select, d.id, d.label); });
      if (!named.length) addOption(select, ASK_OUTPUTS, 'ほかの出力デバイスを表示…');

      // 前回選んだデバイスを探す。IDは変わることがあるので、名前でも探す
      var match = null;
      named.forEach(function (d) { if (!match && d.id === wantedId) match = d; });
      if (!match && wantedLabel) named.forEach(function (d) { if (!match && d.label === wantedLabel) match = d; });

      if (match) {
        select.value = match.id;
        return audio.setOutput(match.id).then(function () { return named.length; }, function () {
          select.value = 'default';
          toast('出力デバイス「' + match.label + '」に切り替えられませんでした。既定の出力を使います');
          return named.length;
        });
      }
      select.value = 'default';
      if (wantedId !== 'default' && wantedLabel && announce) {
        toast('いまの出力は「既定の出力」です。前回の「' + wantedLabel + '」を使うには、出力から選び直してください');
      }
      return named.length;
    }).catch(function () { return 0; /* 一覧が取れなくても既定の出力で動く */ });
  }

  // ---------- 操作の結び付け ----------

  function selectedTrack() {
    return selectedId ? tracks.get(selectedId) : null;
  }

  function moveSelection(delta) {
    var vg = viewGroup();
    var order = vg ? vg.trackIds : [];
    if (!order.length) return;
    var index = Math.max(0, Math.min(order.length - 1, order.indexOf(selectedId) + delta));
    selectedId = order[index];
    render();
    var row = document.querySelector('.cue-row[data-id="' + selectedId + '"]');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  function bind() {
    // ボタンにキーボードフォーカスを持たせない。
    // フォーカスが残ると、Spaceが「そのボタンを押す」動作になってしまうため。
    document.addEventListener('mousedown', function (e) {
      var active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'SELECT') && active !== e.target) active.blur();
      // 曲リストの行はドラッグできるように、既定の動作を止めない（フォーカスはクリック後に外す）
      if (e.target.closest && e.target.closest('button') && !(e.target.closest('.cue-row') && !locked)) e.preventDefault();
    });
    Array.prototype.forEach.call(document.querySelectorAll('button'), function (b) { b.tabIndex = -1; });

    $('goBtn').addEventListener('click', pressGo);
    $('stopBtn').addEventListener('click', pressStop);
    $('fadeBtn').addEventListener('click', pressFade);

    $('modeSingle').addEventListener('click', function () {
      if (locked) return;
      engine.setGoMode('single'); saveSetting('goMode', 'single'); render();
    });
    $('transCut').addEventListener('click', function () {
      if (locked) return;
      goTransition = 'cut'; saveSetting('goTransition', 'cut'); render();
    });
    $('transFade').addEventListener('click', function () {
      if (locked) return;
      goTransition = 'fade'; saveSetting('goTransition', 'fade'); render();
    });
    $('modeDouble').addEventListener('click', function () {
      if (locked) return;
      engine.setGoMode('double'); saveSetting('goMode', 'double'); render();
    });

    $('addFilesBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('emptyAddBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      var items = files.map(function (f) { return { file: f, path: f.name }; });
      if (bgmView) importBgm(items); else importItems(items);
      e.target.value = '';
    });

    $('standbyBtn').addEventListener('click', function () {
      var t = selectedTrack();
      if (t && engine.setStandby(t.id)) afterChange();
    });
    // 再生範囲
    function setRange(t, inPoint, outPoint) {
      if (!t || !t.info || locked) return;
      var d = t.info.duration;
      var a = inPoint == null ? 0 : Math.max(0, Math.min(inPoint, d));
      var b = outPoint == null ? null : Math.max(0, Math.min(outPoint, d));
      if ((b == null ? d : b) - a < 0.5) {
        toast('開始と終了は0.5秒以上離してください');
        render();
        return;
      }
      t.inPoint = a > 0.01 ? a : 0;
      t.outPoint = b != null && b < d - 0.01 ? b : null;
      applyRangeToCurrent(t);
      afterChange();
    }
    $('rangeStart').addEventListener('change', function (e) {
      var t = selectedTrack();
      var v = parseTime(e.target.value);
      e.target.blur();
      if (v == null) { toast('時間は「1:23.4」のように入力してください'); render(); return; }
      if (t) setRange(t, v, t.outPoint);
    });
    $('rangeEnd').addEventListener('change', function (e) {
      var t = selectedTrack();
      var v = parseTime(e.target.value);
      e.target.blur();
      if (v == null) { toast('時間は「1:23.4」のように入力してください'); render(); return; }
      if (t) setRange(t, t.inPoint, v);
    });
    ['rangeStart', 'rangeEnd'].forEach(function (id) {
      $(id).addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
      });
    });
    $('trimHead').addEventListener('click', function () {
      var t = selectedTrack();
      if (t && t.info) setRange(t, Math.max(0, t.info.headSilence - 0.05), t.outPoint);
    });
    $('trimTail').addEventListener('click', function () {
      var t = selectedTrack();
      if (t && t.info) setRange(t, t.inPoint, Math.min(t.info.duration, t.info.audibleEnd + 0.15));
    });
    $('setInNow').addEventListener('click', function () {
      var t = selectedTrack();
      if (t && current && current.trackId === t.id) setRange(t, audio.position(current.voice), t.outPoint);
    });
    $('setOutNow').addEventListener('click', function () {
      var t = selectedTrack();
      if (t && current && current.trackId === t.id) setRange(t, t.inPoint, audio.position(current.voice));
    });
    $('rangeReset').addEventListener('click', function () {
      var t = selectedTrack();
      if (t) setRange(t, 0, null);
    });
    function moveSelected(delta) {
      var g = selectedId && groupOf(selectedId);
      if (!g || locked) return;
      var i = g.trackIds.indexOf(selectedId);
      var j = i + delta;
      if (i < 0 || j < 0 || j >= g.trackIds.length) return;
      g.trackIds.splice(i, 1);
      g.trackIds.splice(j, 0, selectedId);
      syncOrder();
      afterChange();
    }
    $('moveUpBtn').addEventListener('click', function () { moveSelected(-1); });
    $('moveDownBtn').addEventListener('click', function () { moveSelected(1); });
    $('removeBtn').addEventListener('click', function () { askDelete(selectedId); });
    $('deleteTrackBtn').addEventListener('click', function () { askDelete(selectedId); });
    $('deleteCancel').addEventListener('click', closeDelete);
    $('deleteOk').addEventListener('click', confirmDelete);
    $('deleteBackdrop').addEventListener('click', function (e) { if (e.target === $('deleteBackdrop')) closeDelete(); });

    // グループ
    $('addGroupBtn').addEventListener('click', function () {
      if (locked) return;
      var g = addGroup(nextGroupName());
      viewGroupId = g.id;
      selectedId = null;
      bgmView = false;
      afterChange();
    });
    $('groupName').addEventListener('change', function (e) {
      var g = viewGroup();
      var name = e.target.value.trim();
      if (g && name && !locked) g.name = name;
      e.target.blur();
      afterChange();
    });
    $('groupLeftBtn').addEventListener('click', function () { moveGroup(-1); });
    $('groupRightBtn').addEventListener('click', function () { moveGroup(1); });
    $('groupDeleteBtn').addEventListener('click', function () {
      var g = viewGroup();
      if (!g || locked) return;
      if (!askTwice('group:' + g.id)) return;
      var index = groups.indexOf(g);
      var ids = g.trackIds.slice();
      for (var i = 0; i < ids.length; i++) {
        if (!removeTrack(ids[i])) {
          toast('再生中の曲があるグループは削除できません');
          afterChange();
          return;
        }
      }
      groups.splice(index, 1);
      var next = groups[Math.min(index, groups.length - 1)];
      viewGroupId = next ? next.id : null;
      selectedId = null;
      afterChange();
    });

    // イベント
    $('showName').addEventListener('change', function (e) {
      var name = e.target.value.trim();
      if (show && name && !locked) show.name = name;
      e.target.blur();
      afterChange();
    });
    $('showsBtn').addEventListener('click', function () { if (!locked) openShowsDialog(); });
    $('showsClose').addEventListener('click', closeShowsDialog);
    $('showsBackdrop').addEventListener('click', function (e) {
      if (e.target === e.currentTarget) closeShowsDialog();
    });
    $('rangeFoldHead').addEventListener('click', function () { toggleFold('range'); });
    $('gainFoldHead').addEventListener('click', function () { toggleFold('gain'); });
    $('vocalGpu').addEventListener('click', function (e) {
      e.currentTarget.blur();
      if (vocalJob) return;
      vocalUseGpu = !vocalUseGpu;
      saveSetting('vocalGpu', vocalUseGpu ? '1' : '0');
      render();
      toast(vocalUseGpu ? 'ボーカルの分離に GPU を使います（使えなければ CPU）' : 'ボーカルの分離は CPU だけで行います');
    });
    vocalUseGpu = loadSetting('vocalGpu', '1') !== '0';
    $('trimHeadAll').addEventListener('click', function (e) { e.currentTarget.blur(); trimHeadAll(); });
    $('markerTime').addEventListener('change', function (e) {
      var t = selectedTrack();
      var raw = e.target.value.trim();
      e.target.blur();
      if (!t) return;
      if (!raw) { setMarker(t, null); return; }
      var v = parseTime(raw);
      if (v == null) { toast('時間は「3:55.0」のように入力してください'); render(); return; }
      setMarker(t, v);
    });
    $('markerTime').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
    });
    $('markerDelay').addEventListener('change', function (e) {
      var t = selectedTrack();
      e.target.blur();
      if (!t || locked) return;
      t.markerDelay = Math.max(0, Math.min(MARKER_DELAY_MAX, Number(e.target.value) || 0));
      if (current && current.trackId === t.id) current.markerDone = audio.position(current.voice) >= markerFireAt(t);
      afterChange();
    });
    $('markerNow').addEventListener('click', function (e) {
      e.currentTarget.blur();
      var t = selectedTrack();
      if (!t) return;
      if (current && current.trackId === t.id) setMarker(t, audio.position(current.voice));
      else if (t.lastPos != null) setMarker(t, t.lastPos); // 止めた位置
    });
    function nudgeMarker(step) {
      var t = selectedTrack();
      if (!t || t.marker == null || locked) return;
      var r = rangeOf(t);
      var v = Math.round((t.marker + step) * 10) / 10;
      if (v < r.start || v > r.end) { toast('マーカーは再生範囲の中に打ってください'); return; }
      setMarker(t, v);
    }
    $('markerMinus').addEventListener('click', function (e) { e.currentTarget.blur(); nudgeMarker(-0.1); });
    $('markerPlus').addEventListener('click', function (e) { e.currentTarget.blur(); nudgeMarker(0.1); });
    $('markerClear').addEventListener('click', function (e) { e.currentTarget.blur(); setMarker(selectedTrack(), null); });
    $('keySelect').addEventListener('change', function (e) {
      var t = selectedTrack();
      e.target.blur();
      if (!t) return;
      t.keyUser = e.target.value === '' ? null : Number(e.target.value);
      afterChange();
    });
    $('alignAfter').addEventListener('click', function (e) { e.currentTarget.blur(); alignAfterToCues(); });
    $('gainDown').addEventListener('click', function (e) { e.currentTarget.blur(); var t = selectedTrack(); if (t) setGainAdj(t, (t.gainAdj || 0) - 0.5); });
    $('gainUp').addEventListener('click', function (e) { e.currentTarget.blur(); var t = selectedTrack(); if (t) setGainAdj(t, (t.gainAdj || 0) + 0.5); });
    $('gainReset').addEventListener('click', function (e) { e.currentTarget.blur(); var t = selectedTrack(); if (t) setGainAdj(t, 0); });
    $('autoGainToggle').addEventListener('click', function (e) { e.currentTarget.blur(); if (!locked) setAutoGain(!autoGainOn); });
    autoGainOn = loadSetting('autoGain', '1') !== '0';
    $('vocalFoldHead').addEventListener('click', function () { toggleFold('vocal'); });
    $('cueText').addEventListener('input', function (e) {
      var t = selectedId && tracks.get(selectedId);
      if (!t) return;
      t.cue.text = e.target.value.slice(0, 60);
      render();
      saveSoon();
    });
    $('cueText').addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return; // 日本語の変換中は何もしない
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
    });
    $('moveGroupSelect').addEventListener('change', function (e) {
      if (selectedId) moveTrackTo(selectedId, e.target.value, null);
      e.target.blur();
    });
    $('vocalSeparate').addEventListener('click', function () {
      if (current) { toast('再生中は分けられません。止まっている時に分けてください'); return; }
      if (selectedId) queueVocal([selectedId]);
    });
    $('vocalSeparateGroup').addEventListener('click', function () {
      if (current) { toast('再生中は分けられません。止まっている時に分けてください'); return; }
      var g = selectedId && groupOf(selectedId);
      if (g) queueVocal(g.trackIds.slice());
    });
    $('vocalCancel').addEventListener('click', cancelVocal);
    $('vocalLevel').addEventListener('input', function () {
      setVocalLevel(selectedId && tracks.get(selectedId), Number($('vocalLevel').value) / 100);
    });
    $('vocalLevel').addEventListener('change', function () { $('vocalLevel').blur(); });
    $('vocalLevel').addEventListener('pointerup', function () { $('vocalLevel').blur(); });
    $('vocalReset').addEventListener('click', function () { setVocalLevel(selectedId && tracks.get(selectedId), 1); });
    $('vocalRemove').addEventListener('click', function () { removeVocal(selectedId && tracks.get(selectedId)); });
    $('videoBtn').addEventListener('click', openVideoDialog);
    $('videoClose').addEventListener('click', closeVideoDialog);
    $('videoBackdrop').addEventListener('click', function (e) { if (e.target === $('videoBackdrop')) closeVideoDialog(); });
    $('videoTarget').addEventListener('change', function (e) { setVideoTarget(e.target.value); e.target.blur(); });
    $('videoDelay').addEventListener('change', function (e) { setVideoDelay(parseFloat(e.target.value)); e.target.blur(); });
    $('videoDelay').addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); });
    bindLogos();
    if (videoAvailable() && window.ponNative.video.onClosed) {
      window.ponNative.video.onClosed(function () {
        videoOut = { open: false, target: null, label: '' };
        videoSent.key = null; videoSent.sig = ''; videoSent.prepared = null;
        renderVideoDialog(); render();
        toast('映像出力のウィンドウが閉じました');
      });
    }
    $('exportShowBtn').addEventListener('click', function () { exportBackup(false); });
    $('exportAllBtn').addEventListener('click', function () { exportBackup(true); });
    $('importBtn').addEventListener('click', function () { $('importInput').value = ''; $('importInput').click(); });
    $('importInput').addEventListener('change', function () {
      var f = $('importInput').files[0];
      if (f) importBackup(f);
    });
    $('newShowBtn').addEventListener('click', function () {
      if (current) { toast('再生中はイベントを切り替えられません'); return; }
      closeShowsDialog();
      newShow();
    });
    ['showName', 'groupName'].forEach(function (id) {
      $(id).addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
      });
      $(id).addEventListener('blur', function () { render(); });
    });

    // 出力デバイス
    $('outputSelect').addEventListener('change', function (e) {
      var select = e.target;
      var value = select.value;
      select.blur();
      if (value === ASK_OUTPUTS) {
        // 一覧が取れるまでは既定の出力のまま
        select.value = 'default';
        toast('出力デバイスの名前を表示するには、ブラウザの「マイクの許可」が必要です（録音はしません）');
        audio.requestDeviceNames().then(function () {
          return refreshOutputs(false);
        }).then(function (count) {
          toast(count ? '出力デバイスを表示しました。「出力」から選んでください' : '出力デバイスが見つかりませんでした');
        }, function () {
          toast('許可されなかったため、出力デバイスを表示できませんでした');
        });
        return;
      }
      var label = value === 'default' ? '' : select.options[select.selectedIndex].textContent;
      audio.setOutput(value).then(function () {
        saveSetting('output', value);
        saveSetting('outputLabel', label);
        refreshBgmOutput(); // BGM が「本編と同じ」ならついていく
      }, function () {
        toast('出力デバイスを切り替えられませんでした');
        select.value = 'default';
      });
    });
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', function () { refreshOutputs(false); });
    }
    $('bgmOutputSelect').addEventListener('change', function (e) {
      var select = e.target;
      var value = select.value;
      select.blur();
      if (value === ASK_OUTPUTS) {
        toast('出力デバイスの名前を表示するには、ブラウザの「マイクの許可」が必要です（録音はしません）');
        audio.requestDeviceNames().then(function () { return refreshOutputs(false); }).then(null, function () {
          toast('許可されなかったため、出力デバイスを表示できませんでした');
          refreshBgmOutput();
        });
        return;
      }
      var label = value === BGM_SAME || value === 'default' ? '' : select.options[select.selectedIndex].textContent.replace(/^（見つかりません）/, '');
      saveSetting('bgmOutput', value);
      saveSetting('bgmOutputLabel', label);
      refreshBgmOutput().then(function () {
        if (!bgmOutLost) toast('BGMの出力：' + (value === BGM_SAME ? '本編と同じ' : value === 'default' ? '既定の出力' : label));
      });
    });

    // 本番ロック
    $('lockBtn').addEventListener('click', function () { setLocked(!locked); });

    // 再生位置の移動：波形のクリック、ボタン
    var canvas = $('wave');
    function ratioAt(e) {
      var rect = canvas.getBoundingClientRect();
      return rect.width ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0;
    }
    canvas.addEventListener('pointermove', function (e) {
      var state = engine.getState(now());
      var t = waveTrack(state);
      var hover = $('waveHover');
      if (!t || !canSeek(state)) {
        hoverRatio = -1;
        hover.hidden = true;
        return;
      }
      hoverRatio = ratioAt(e);
      hover.textContent = fmtShort(hoverRatio * t.info.duration);
      hover.style.left = (hoverRatio * canvas.clientWidth) + 'px';
      hover.hidden = false;
    });
    canvas.addEventListener('pointerleave', function () {
      hoverRatio = -1;
      $('waveHover').hidden = true;
    });
    canvas.addEventListener('click', function (e) {
      var t = waveTrack(engine.getState(now()));
      if (t) seekTo(ratioAt(e) * t.info.duration);
    });
    $('seekBack60').addEventListener('click', function () { seekBy(-SEEK_LARGE); });
    $('seekBack10').addEventListener('click', function () { seekBy(-SEEK_SMALL); });
    $('seekFwd10').addEventListener('click', function () { seekBy(SEEK_SMALL); });
    $('seekFwd60').addEventListener('click', function () { seekBy(SEEK_LARGE); });
    $('startResetBtn').addEventListener('click', function () {
      standbyStart = null;
      render();
    });

    // キー操作。長押しによる連続入力（repeat）は無視する
    window.addEventListener('keydown', function (e) {
      // 削除の確認中は、Enter＝削除する、Esc＝やめる。ほかのキー（Space の GO など）は効かない
      if (deleteOpen()) {
        e.preventDefault();
        if (e.repeat) return;
        if (e.key === 'Enter') confirmDelete();
        else if (e.key === 'Escape') closeDelete();
        return;
      }
      // CD取り込みの画面を開いている間も、Esc で閉じるだけ（取り込みは裏で続く）
      if (cdOpen()) {
        if (e.key === 'Escape') { e.preventDefault(); closeCdDialog(); }
        else if (e.code === 'Space' && !(e.target && e.target.tagName === 'INPUT')) e.preventDefault();
        return;
      }
      // アップデートの案内を開いている間は、Esc で閉じるだけ（Space で GO しない）
      if (updateOpen()) {
        if (e.key === 'Escape') { e.preventDefault(); closeUpdateDialog(); }
        else if (e.code === 'Space') e.preventDefault();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var tag = e.target && e.target.tagName;
      // 文字の入力欄では打鍵を優先。音量バー（range）にフォーカスがあっても、キー操作はGOなどに使う
      if ((tag === 'INPUT' && e.target.type !== 'range') || tag === 'TEXTAREA') return;
      if (tag === 'INPUT') e.target.blur();
      if ((e.code === 'Delete' || e.code === 'Backspace') && $('showsBackdrop').hidden) {
        e.preventDefault();
        if (!e.repeat) askDelete(selectedId);
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) pressGo();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        if (!e.repeat) pressStop();
      } else if (e.code === 'KeyF') {
        e.preventDefault();
        if (!e.repeat) pressFade();
      } else if (/^Digit[0-9]$/.test(e.code)) {
        // 数字キー1〜9、0でSEパッド1〜10
        e.preventDefault();
        if (!e.repeat) playPad(PAD_KEYS.indexOf(e.code.slice(5)));
      } else if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
        e.preventDefault();
        moveSelection(e.code === 'ArrowDown' ? 1 : -1);
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        // ←→ で10秒、Shift+←→ で1分。本番ロック中は効かない
        e.preventDefault();
        if (!e.repeat && !locked) {
          seekBy((e.code === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? SEEK_LARGE : SEEK_SMALL));
        }
      }
    }, true);
    window.addEventListener('keyup', function (e) {
      if (e.code === 'Space') e.preventDefault();
    }, true);

    // ドラッグ＆ドロップ。ウィンドウのどこに落としても取り込む
    window.addEventListener('dragenter', function (e) {
      e.preventDefault();
      if (dragTrackId) return;
      dragDepth++;
      $('dropOverlay').hidden = false;
    });
    function markDropTarget(target) {
      var padEl = target && target.closest ? target.closest('.pad') : null;
      var inSe = target && target.closest ? target.closest('#sePanel') : null;
      Array.prototype.forEach.call(document.querySelectorAll('.pad.is-drop'), function (el) {
        if (el !== padEl) el.classList.remove('is-drop');
      });
      if (padEl) padEl.classList.add('is-drop');
      $('sePanel').classList.toggle('is-drop', !!inSe);
      $('dropOverlay').querySelector('.drop-overlay-inner').textContent = inSe
        ? (padEl ? 'このSEパッドに割り当て' : '空いているSEパッドに割り当て')
        : 'ここにドロップして曲を取り込み';
    }
    window.addEventListener('dragover', function (e) {
      if (dragTrackId) return; // 曲の並べ替え中はファイル取り込みの表示を出さない（落とせる場所は行とタブだけ）
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      markDropTarget(e.target);
    });
    window.addEventListener('dragleave', function (e) {
      e.preventDefault();
      if (dragTrackId) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) { $('dropOverlay').hidden = true; markDropTarget(null); }
    });
    window.addEventListener('drop', function (e) {
      if (dragTrackId) { e.preventDefault(); endTrackDrag(); return; }
      e.preventDefault();
      dragDepth = 0;
      $('dropOverlay').hidden = true;
      markDropTarget(null);
      if (!e.dataTransfer) return;
      var padEl = e.target && e.target.closest ? e.target.closest('.pad') : null;
      var inSe = e.target && e.target.closest ? e.target.closest('#sePanel') : null;
      if (inSe) {
        var bankName = seBank;
        var start = padEl ? Number(padEl.dataset.index) : seBanks[bankName].indexOf(null);
        if (start < 0) { toast('空きパッドがありません'); return; }
        collectDropped(e.dataTransfer).then(function (items) { assignPads(bankName, start, items); }, function () {
          toast('ドロップされたファイルを読み取れませんでした');
        });
        return;
      }
      var toBgm = bgmView;
      collectDropped(e.dataTransfer).then(function (items) {
        if (toBgm) importBgm(items); else importItems(items);
      }, function () {
        toast('ドロップされたファイルを読み取れませんでした。「曲を追加」から選んでください');
      });
    });

    // 最前面でない時は警告（キー操作が別のアプリに取られるため）
    window.addEventListener('blur', function () { $('focusWarning').hidden = false; });
    window.addEventListener('focus', function () { $('focusWarning').hidden = true; });

    // うっかり閉じる・再読み込みするのを防ぐ
    window.addEventListener('beforeunload', function (e) {
      if (current || bgmNow || pendingFiles > 0 || saveTimer) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    window.addEventListener('resize', tick);
  }

  // ---------- 曲・グループの削除 ----------

  function removeTrack(id) {
    if (!engine.removeTrack(id)) return false; // 再生中の曲は外せない
    var g = groupOf(id);
    if (g) g.trackIds.splice(g.trackIds.indexOf(id), 1);
    tracks.delete(id);
    buffers.delete(id);
    vocalBuffers.delete(id);
    var qi = vocalQueue.indexOf(id);
    if (qi >= 0) vocalQueue.splice(qi, 1);
    var jobIndex = jobs.indexOf(id);
    if (jobIndex >= 0) jobs.splice(jobIndex, 1);
    if (storeOk) store.deleteFiles([id, vocalKey(id)]).catch(function () { /* 消し損ねても動作には影響しない */ });
    return true;
  }

  function moveGroup(delta) {
    var g = viewGroup();
    if (!g || locked) return;
    var i = groups.indexOf(g);
    var j = i + delta;
    if (j < 0 || j >= groups.length) return;
    groups.splice(i, 1);
    groups.splice(j, 0, g);
    syncOrder();
    afterChange();
  }

  // 削除などは、同じボタンを3秒以内にもう一度押した時だけ実行する
  // ---------- 曲の削除（確認してから） ----------
  var deleteId = null;

  function deleteOpen() { return !$('deleteBackdrop').hidden; }

  function askDelete(id) {
    var t = id && tracks.get(id);
    if (!t || bgmView) { if (!t) toast('削除する曲を選んでください'); return; }
    if (locked) { toast('本番ロック中は削除できません'); return; }
    if (current && current.trackId === id) { toast('再生中の曲は削除できません'); return; }
    deleteId = id;
    $('deleteName').textContent = titleOf(id);
    $('deleteBackdrop').hidden = false;
  }

  function closeDelete() {
    deleteId = null;
    $('deleteBackdrop').hidden = true;
  }

  function confirmDelete() {
    var id = deleteId;
    closeDelete();
    var g = id && groupOf(id);
    if (!g || locked) return;
    var index = g.trackIds.indexOf(id);
    var name = tracks.get(id).name;
    if (!removeTrack(id)) { toast('再生中の曲は削除できません'); return; }
    selectedId = g.trackIds.length ? g.trackIds[Math.min(index, g.trackIds.length - 1)] : null;
    toast('「' + name + '」を削除しました');
    afterChange();
  }

  function askTwice(key) {
    if (confirmKey === key) {
      confirmKey = null;
      clearTimeout(confirmTimer);
      return true;
    }
    confirmKey = key;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(function () { confirmKey = null; render(); renderShowsList(); }, 3000);
    render();
    return false;
  }

  // ---------- 保存 ----------

  function snapshot() {
    var state = engine.getState(now());
    var saved = {};
    tracks.forEach(function (t) {
      saved[t.id] = { name: t.name, fileName: t.fileName, ext: t.ext, afterAction: t.afterAction, inPoint: t.inPoint || 0, outPoint: t.outPoint };
      if (t.vocal) saved[t.id].vocal = { level: t.vocal.level };
      if (hasCue(t)) saved[t.id].cue = { type: t.cue.type, text: t.cue.text };
      if (t.loud) saved[t.id].loud = { lufs: t.loud.lufs, peakDb: t.loud.peakDb };
      if (t.gainAdj) saved[t.id].gainAdj = t.gainAdj;
      if (t.autoCue === 'pending') saved[t.id].autoCue = 'pending';
      if (t.vocal && t.vocalInfo) saved[t.id].vocalInfo = t.vocalInfo;
      if (t.marker != null) { saved[t.id].marker = t.marker; saved[t.id].markerDelay = t.markerDelay || 0; }
      if (t.keyInfo) saved[t.id].keyInfo = t.keyInfo;
      if (t.keyUser != null) saved[t.id].keyUser = t.keyUser;
    });
    return {
      id: show.id,
      name: show.name,
      createdAt: show.createdAt,
      updatedAt: Date.now(),
      groups: groups.map(function (g) { return { id: g.id, name: g.name, trackIds: g.trackIds.slice(), logo: g.logo || null }; }),
      logo: show.logo || null,
      tracks: saved,
      standbyId: state.standbyId,
      played: Object.keys(state.played).filter(function (id) { return tracks.has(id); }),
      viewGroupId: viewGroupId,
      sePads: bankToSaved(seBanks.event)
    };
  }

  function saveSoon() {
    if (!show || !storeOk) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!show || !storeOk) return Promise.resolve();
    return store.putShow(snapshot()).then(function () {
      saveFailed = false;
      saveSetting('lastShow', show.id);
      renderShow();
    }, function () {
      saveFailed = true;
      renderShow();
    });
  }

  function saveFile(id, file) {
    if (!storeOk) return;
    pendingFiles++;
    renderShow();
    store.putFile(id, file).then(function () {
      pendingFiles--;
      renderShow();
    }, function () {
      pendingFiles--;
      saveFailed = true;
      toast('曲「' + file.name + '」を保存できませんでした（空き容量を確認してください）。再生はできます');
      renderShow();
    });
  }

  // ---------- イベントの切り替え ----------

  function resetSession() {
    if (current) audio.cut(current.voice);
    current = null;
    cutTails();
    tracks.clear();
    buffers.clear();
    jobs = [];
    groups = [];
    viewGroupId = null;
    selectedId = null;
    standbyStart = null;
    lastStandbyGroupId = null;
    confirmKey = null;
    stopAllSe();
    seBanks.event.forEach(function (pad) { if (pad) seBuffers.delete(pad.id); });
    seBanks.event = emptyBank();
    seSelected = -1;
    engine = window.PonCueEngine.createEngine({ goMode: loadSetting('goMode', 'double') });
    waveCache = { info: null, w: 0, h: 0, ratio: 0, bright: null, dim: null };
  }

  function defaultShowName() {
    var d = new Date();
    return 'イベント ' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  function newShow() {
    resetSession();
    show = { id: uid('s'), name: defaultShowName(), createdAt: Date.now() };
    afterChange();
    saveNow();
  }

  function loadShow(data) {
    resetSession();
    show = { id: data.id, name: data.name, createdAt: data.createdAt, logo: data.logo || null };
    var savedTracks = data.tracks || {};
    var ids = [];
    var seen = {};
    (data.groups || []).forEach(function (sg) {
      var g = { id: sg.id, name: sg.name, trackIds: [], logo: sg.logo || null };
      groups.push(g);
      (sg.trackIds || []).forEach(function (id) {
        // 同じ曲が二重に入っていたら1つにする（Ver. 0.7.1 のグループ移動の不具合の後始末）
        if (savedTracks[id] && !seen[id]) { seen[id] = true; ids.push({ id: id, group: g, data: savedTracks[id] }); }
      });
    });
    // どのグループにも入っていない曲は「戻した曲」グループに集める（同じ不具合で外れてしまった曲）
    var orphans = Object.keys(savedTracks).filter(function (id) { return !seen[id]; });
    if (orphans.length) {
      var rg = { id: uid('g'), name: '戻した曲', trackIds: [] };
      groups.push(rg);
      orphans.forEach(function (id) { ids.push({ id: id, group: rg, data: savedTracks[id] }); });
      setTimeout(function () { toast('グループから外れていた曲 ' + orphans.length + '曲を「戻した曲」グループに戻しました'); saveSoon(); }, 600);
    }
    var getFile = storeOk
      ? function (id) { return store.getFile(id).catch(function () { return null; }); }
      : function () { return Promise.resolve(null); };
    var vocalFiles = Promise.all(ids.map(function (x) { return x.data.vocal ? getFile(vocalKey(x.id)) : null; }));
    return Promise.all([Promise.all(ids.map(function (x) { return getFile(x.id); })), vocalFiles]).then(function (both) {
      var files = both[0];
      ids.forEach(function (x, i) {
        registerTrack(x.id, x.group, {
          cue: x.data.cue,
          vocal: x.data.vocal,
          vocalFile: both[1][i],
          file: files[i] || null,
          fileName: x.data.fileName,
          name: x.data.name,
          ext: x.data.ext,
          afterAction: x.data.afterAction,
          inPoint: x.data.inPoint,
          outPoint: x.data.outPoint,
          loud: x.data.loud,
          gainAdj: x.data.gainAdj,
          autoCue: x.data.autoCue,
          vocalInfo: x.data.vocalInfo,
          marker: x.data.marker,
          markerDelay: x.data.markerDelay,
          keyInfo: x.data.keyInfo,
          keyUser: x.data.keyUser
        });
      });
      syncOrder();
      (data.played || []).forEach(function (id) { engine.markPlayed(id); });
      if (data.standbyId && tracks.has(data.standbyId)) engine.setStandby(data.standbyId);
      var standbyGroup = engine.getState(now()).standbyId ? groupOf(engine.getState(now()).standbyId) : null;
      lastStandbyGroupId = standbyGroup ? standbyGroup.id : null;
      viewGroupId = groupById(data.viewGroupId) ? data.viewGroupId : (standbyGroup ? standbyGroup.id : null);
      saveSetting('lastShow', show.id);
      afterChange();
      pump();
      var missing = files.filter(function (f) { return !f; }).length;
      if (missing) toast(missing + '曲の保存データが見つかりませんでした。取り込み直してください');
      return restoreBank('event', data.sePads);
    });
  }

  function openShow(id) {
    if (current) { toast('再生中はイベントを切り替えられません'); return Promise.resolve(); }
    var saving = saveTimer ? saveNow() : Promise.resolve();
    return saving.then(function () { return store.getShow(id); }).then(function (data) {
      if (!data) { toast('イベントが見つかりませんでした'); return null; }
      return loadShow(data);
    });
  }

  // ---------- イベント一覧 ----------

  function fmtDate(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  var showsCache = [];

  function openShowsDialog() {
    if (!storeOk) { toast('この環境では保存が使えません'); return; }
    var saving = saveTimer ? saveNow() : Promise.resolve();
    saving.then(function () { return store.listShows(); }).then(function (list) {
      showsCache = list.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
      $('showsBackdrop').hidden = false;
      renderShowsList();
    }, function () { toast('イベント一覧を読み込めませんでした'); });
  }

  function closeShowsDialog() {
    $('showsBackdrop').hidden = true;
  }

  function renderShowsList() {
    var list = $('showsList');
    if ($('showsBackdrop').hidden) return;
    list.textContent = '';
    showsCache.forEach(function (s) {
      var row = document.createElement('div');
      row.className = 'show-row' + (show && s.id === show.id ? ' is-current' : '');
      var info = document.createElement('div');
      info.className = 'show-info';
      info.appendChild(cell('show-title', s.name + (show && s.id === show.id ? '（開いています）' : '')));
      info.appendChild(cell('show-meta', s.groupCount + 'グループ ・ ' + s.trackCount + '曲 ・ 更新 ' + fmtDate(s.updatedAt)));
      row.appendChild(info);
      var isCurrent = show && s.id === show.id;
      var openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn btn-small';
      openBtn.textContent = '開く';
      openBtn.disabled = isCurrent;
      openBtn.addEventListener('click', function () {
        if (current) { toast('再生中はイベントを切り替えられません'); return; }
        closeShowsDialog();
        openShow(s.id);
      });
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn btn-small' + (confirmKey === 'show:' + s.id ? ' is-confirm' : '');
      delBtn.textContent = confirmKey === 'show:' + s.id ? '本当に削除' : '削除';
      delBtn.disabled = isCurrent;
      delBtn.title = isCurrent ? '開いているイベントは削除できません' : '';
      delBtn.addEventListener('click', function () {
        if (!askTwice('show:' + s.id)) { renderShowsList(); return; }
        store.getShow(s.id).then(function (data) {
          var keys = data && data.tracks ? Object.keys(data.tracks) : [];
          ((data && data.sePads) || []).forEach(function (pad) { if (pad) keys.push(pad.id); });
          return store.deleteShow(s.id, keys);
        }).then(function () {
          showsCache = showsCache.filter(function (x) { return x.id !== s.id; });
          renderShowsList();
          toast('「' + s.name + '」を削除しました');
        }, function () { toast('削除できませんでした'); });
      });
      row.appendChild(openBtn);
      row.appendChild(delBtn);
      list.appendChild(row);
    });
    Array.prototype.forEach.call(list.querySelectorAll('button'), function (b) { b.tabIndex = -1; });
  }

  // ---------- 映像出力（アプリ版のみ） ----------
  // 映像付きの曲（MP4 など）の映像を、外部モニターの映像出力ウィンドウに出す。音はいつもどおり本体から。
  // 本体の再生状態を 0.25 秒ごとに見て、映像出力ウィンドウ（video.js）に指示を送る

  var videoCh = ('BroadcastChannel' in window) ? new BroadcastChannel('pon-video') : null;
  var videoOut = { open: false, target: null, label: '' }; // 映像出力ウィンドウの状態
  var videoSent = { key: null, sig: '', lastSync: 0, prepared: null };
  var videoDelayMs = clampDelay(parseFloat(loadSetting('videoDelayMs', '0')));

  function clampDelay(v) { return isFinite(v) ? Math.max(-1000, Math.min(1000, Math.round(v / 10) * 10)) : 0; }
  function videoAvailable() { return !!(window.ponNative && window.ponNative.video); }
  function isVideoTrack(t) { return !!(t && VIDEO_EXT.test(t.fileName || '')); }
  function videoPost(m) { if (videoCh && videoOut.open) videoCh.postMessage(m); }

  function videoPos() {
    return current && current.voice ? audio.position(current.voice) : 0;
  }

  // ----- 映像・ロゴ・黒の出し分け（Ver. 0.11.0） -----
  // 自動：映像付きの曲 → 映像 ／ 映像なしの曲 → その曲のグループのロゴ（なければ黒）／ 何も鳴っていない → 黒
  // 手動：黒・イベントロゴ・グループロゴ（表示中のグループ）。次に曲が始まるまで（GO・続けて再生・マーカー）続く
  // 切り替えはすべて2秒のフェード
  var VIDEO_FADE = 2;
  var videoManual = 'auto';

  function logoKey(kind, id) { return 'logo-' + kind + '-' + id; }
  function eventLogoKey() { return show && show.logo ? logoKey('ev', show.id) : null; }
  function groupLogoKey(g) { return g && g.logo ? logoKey('gr', g.id) : null; }

  function videoScene() {
    if (videoManual === 'black') return { mode: 'black' };
    if (videoManual === 'event') { var ek = eventLogoKey(); return ek ? { mode: 'image', image: ek } : { mode: 'black' }; }
    if (videoManual === 'group') { var gk = groupLogoKey(viewGroup()); return gk ? { mode: 'image', image: gk } : { mode: 'black' }; }
    var t = current && tracks.get(current.trackId);
    if (!t || !current.voice || current.voice.fading) return { mode: 'black' };
    if (isVideoTrack(t)) return { mode: 'video', key: t.id };
    var k = groupLogoKey(groupOf(t.id));
    return k ? { mode: 'image', image: k } : { mode: 'black' };
  }

  function setVideoManual(mode) {
    videoManual = mode || 'auto';
    videoReconcile(false);
    render();
  }

  // 本体の再生状態に、映像出力を合わせる
  function videoReconcile(force) {
    if (!videoCh || !videoOut.open) return;
    var sc = videoScene();
    var nowMs = Date.now();
    var sig = sc.mode + '|' + (sc.key || '') + '|' + (sc.image || '') + '|' + (sc.mode === 'video' && current ? voiceId(current.voice) : '');
    if (force || sig !== videoSent.sig) {
      videoSent.sig = sig;
      videoSent.key = sc.mode === 'video' ? sc.key : null;
      videoSent.lastSync = nowMs;
      var msg = { type: 'scene', mode: sc.mode, image: sc.image || null, key: sc.key || null, fade: VIDEO_FADE };
      if (sc.mode === 'video') { msg.pos = videoPos(); msg.sentAt = nowMs; }
      videoPost(msg);
    } else if (sc.mode === 'video' && nowMs - videoSent.lastSync >= 500) {
      videoSent.lastSync = nowMs;
      videoPost({ type: 'sync', key: sc.key, pos: videoPos(), sentAt: nowMs });
    }
    // 次に出る曲が映像付きなら、先に読み込んでおいてもらう
    var st = engine.getState(now());
    var next = st.standbyId && tracks.get(st.standbyId);
    var prep = isVideoTrack(next) ? next.id : null;
    if (prep !== videoSent.prepared) {
      videoSent.prepared = prep;
      if (prep) videoPost({ type: 'prepare', key: prep });
    }
  }

  // 再生のかけ直し（位置の移動・ループ）を見分けるため、音ごとに番号を振る
  var voiceIds = typeof WeakMap === 'function' ? new WeakMap() : null;
  var voiceSeq = 0;
  function voiceId(v) {
    if (!v || !voiceIds) return '';
    if (!voiceIds.has(v)) voiceIds.set(v, ++voiceSeq);
    return voiceIds.get(v);
  }

  // ----- ロゴの画像 -----
  var logoUrls = {}; // キー → 画面に出す小さい画像の URL

  function logoUrl(key) {
    if (!key || !storeOk) return Promise.resolve(null);
    if (logoUrls[key]) return Promise.resolve(logoUrls[key]);
    return store.getFile(key).then(function (f) {
      if (!f) return null;
      logoUrls[key] = URL.createObjectURL(f);
      return logoUrls[key];
    }, function () { return null; });
  }

  function forgetLogo(key) {
    if (logoUrls[key]) { URL.revokeObjectURL(logoUrls[key]); delete logoUrls[key]; }
    if (videoCh) videoCh.postMessage({ type: 'images', key: key });
  }

  function setEventLogo(file) {
    if (!storeOk || !show) return Promise.resolve();
    var key = logoKey('ev', show.id);
    var job = file ? store.putFile(key, file) : store.deleteFiles([key]);
    return job.then(function () {
      show.logo = file ? { name: file.name || 'ロゴ' } : null;
      forgetLogo(key);
      saveSoon(); render(); renderLogos();
      toast(file ? 'イベントロゴを「' + (file.name || 'ロゴ') + '」にしました' : 'イベントロゴを外しました');
    }, function () { toast('ロゴを保存できませんでした'); });
  }

  function setGroupLogo(g, file, quiet) {
    if (!storeOk || !g) return Promise.resolve();
    var key = logoKey('gr', g.id);
    var job = file ? store.putFile(key, file) : store.deleteFiles([key]);
    return job.then(function () {
      g.logo = file ? { name: file.name || 'ロゴ' } : null;
      forgetLogo(key);
      saveSoon(); render(); renderLogos();
      if (!quiet) toast(file ? '「' + g.name + '」のロゴを「' + (file.name || 'ロゴ') + '」にしました' : '「' + g.name + '」のロゴを外しました');
    }, function () { toast('ロゴを保存できませんでした'); });
  }

  if (videoCh) {
    videoCh.onmessage = function (e) {
      if (e.data && e.data.type === 'hello') {
        // 映像出力ウィンドウが開いた（開き直した）→ いまの状態を送り直す
        videoSent.prepared = null;
        videoPost({ type: 'settings', delayMs: videoDelayMs });
        videoReconcile(true);
      }
    };
  }
  setInterval(function () { videoReconcile(false); }, 250);

  function openVideoDialog() {
    if (!videoAvailable()) { toast('映像出力はアプリ版で使えます'); return; }
    $('videoBackdrop').hidden = false;
    refreshVideoTargets();
    renderVideoDialog();
    if (!logoFolderFiles.length && loadSetting('logoFolder', '')) loadLogoFolder();
  }

  function closeVideoDialog() { $('videoBackdrop').hidden = true; }

  function refreshVideoTargets() {
    window.ponNative.video.displays().then(function (list) {
      var sel = $('videoTarget');
      sel.textContent = '';
      var opts = [['', '出さない']].concat(list.map(function (d) {
        return [String(d.id), (d.primary ? 'この画面（メイン）' : '画面 ' + d.index) + '　' + d.width + '×' + d.height];
      })).concat([['preview', '小さいウィンドウで試す']]);
      opts.forEach(function (o) {
        var op = document.createElement('option');
        op.value = o[0]; op.textContent = o[1];
        sel.appendChild(op);
      });
      sel.value = videoOut.open ? String(videoOut.target) : '';
      if (sel.value === '' && videoOut.open) sel.value = 'preview';
    });
  }

  function setVideoTarget(value) {
    var nv = window.ponNative.video;
    if (!value) {
      nv.close();
      videoOut = { open: false, target: null, label: '' };
      videoSent.key = null; videoSent.sig = ''; videoSent.prepared = null;
      renderVideoDialog(); render();
      return;
    }
    nv.open(value).then(function (info) {
      videoOut = { open: true, target: value, label: info && info.label || '' };
      renderVideoDialog(); render();
    }, function (err) {
      toast('映像出力を開けませんでした：' + ((err && err.message) || ''));
    });
  }

  function setVideoDelay(ms) {
    videoDelayMs = clampDelay(ms);
    saveSetting('videoDelayMs', String(videoDelayMs));
    videoPost({ type: 'settings', delayMs: videoDelayMs });
    videoSent.lastSync = 0; // すぐ合わせ直す
    renderVideoDialog();
  }

  function renderVideoDialog() {
    var input = $('videoDelay');
    if (document.activeElement !== input) input.value = String(videoDelayMs);
    renderLogos();
    $('videoState').textContent = videoOut.open ? '映像出力中：' + videoOut.label : '映像出力はしていません';
  }

  function renderVideoBtn() {
    var b = $('videoBtn');
    b.hidden = !videoAvailable();
    b.classList.toggle('is-on', videoOut.open);
    $('videoBtnLabel').textContent = videoOut.open ? '映像出力中' : '映像出力';
    var box = $('videoModeBox');
    box.hidden = !videoOut.open;
    box.classList.toggle('is-manual', videoManual !== 'auto');
    Array.prototype.forEach.call(box.querySelectorAll('[data-vmode]'), function (btn) {
      btn.setAttribute('aria-pressed', String(btn.dataset.vmode === videoManual));
      if (btn.dataset.vmode === 'event') btn.disabled = !eventLogoKey();
      if (btn.dataset.vmode === 'group') btn.disabled = !groupLogoKey(viewGroup());
    });
    // イベント名の横のロゴボタン
    var lb = $('eventLogoBtn');
    lb.hidden = !videoAvailable();
    var ek = eventLogoKey();
    lb.classList.toggle('has-logo', !!ek);
    lb.title = ek ? 'イベントロゴ：' + show.logo.name + '（クリックで変更）' : 'イベントロゴ（映像出力で使う画像）を選ぶ';
    if (ek) logoUrl(ek).then(function (u) { if (u && $('eventLogoBtnImg').getAttribute('src') !== u) $('eventLogoBtnImg').src = u; });
  }

  // ----- ロゴの設定（映像出力のダイアログ） -----
  var logoActiveGroup = null;   // 画像を当てはめるグループ
  var logoFolderFiles = [];     // フォルダの中の画像の名前
  var logoThumbs = {};          // 名前 → サムネイルの URL（フォルダの画像）

  function logoAvailable() { return !!(window.ponNative && window.ponNative.logos); }

  function thumbInto(el, key) {
    el.style.backgroundImage = '';
    if (key) logoUrl(key).then(function (u) { if (u) el.style.backgroundImage = 'url("' + u + '")'; });
  }

  function renderLogos() {
    if ($('videoBackdrop').hidden) return;
    var ek = eventLogoKey();
    thumbInto($('eventLogoThumb'), ek);
    $('eventLogoName').textContent = ek ? show.logo.name : 'なし';
    $('eventLogoClear').disabled = !ek;
    var ul = $('logoGroups');
    ul.textContent = '';
    if (!groups.some(function (g) { return g.id === logoActiveGroup; })) logoActiveGroup = (viewGroup() || {}).id || null;
    groups.forEach(function (g) {
      var li = document.createElement('li');
      li.className = g.id === logoActiveGroup ? 'is-active' : '';
      var th = cell('logo-thumb', null);
      thumbInto(th, groupLogoKey(g));
      li.appendChild(th);
      li.appendChild(cell('lg-name', g.name + (g.logo ? '' : '（ロゴなし）')));
      var pick = document.createElement('button');
      pick.type = 'button'; pick.className = 'btn btn-small'; pick.textContent = '画像を選ぶ';
      pick.addEventListener('click', function (e) { e.stopPropagation(); logoActiveGroup = g.id; $('groupLogoInput').value = ''; $('groupLogoInput').click(); });
      var clr = document.createElement('button');
      clr.type = 'button'; clr.className = 'btn btn-small'; clr.textContent = '外す'; clr.disabled = !g.logo;
      clr.addEventListener('click', function (e) { e.stopPropagation(); setGroupLogo(g, null); });
      li.appendChild(pick);
      li.appendChild(clr);
      li.addEventListener('click', function () { logoActiveGroup = g.id; renderLogos(); });
      ul.appendChild(li);
    });
    var dir = loadSetting('logoFolder', '');
    var parts = dir.split(/[\\/]/).filter(Boolean);
    $('logoFolderPath').textContent = dir ? (parts.length > 2 ? '…/' : '/') + parts.slice(-2).join('/') : '未指定';
    $('logoFolderPath').title = dir;
    var folderOk = logoAvailable();
    $('logoFolderPick').disabled = !folderOk;
    $('logoFolderReload').disabled = !folderOk || !dir;
    $('logoAutoMatch').disabled = !logoFolderFiles.length;
    var grid = $('logoGrid');
    grid.textContent = '';
    logoFolderFiles.forEach(function (name) {
      var c = document.createElement('button');
      c.type = 'button';
      c.className = 'logo-cell';
      c.title = name + '（クリックで、選んでいるグループのロゴに）';
      var img = document.createElement('img');
      img.alt = '';
      if (logoThumbs[name]) img.src = logoThumbs[name];
      c.appendChild(img);
      c.appendChild(cell('', name.replace(/\.[^.]+$/, '')));
      c.addEventListener('click', function () { assignFolderLogo(name); });
      grid.appendChild(c);
    });
  }

  function folderFile(name) {
    var dir = loadSetting('logoFolder', '');
    return window.ponNative.logos.read(dir, name).then(function (bytes) {
      var ext = (name.match(/\.([^.]+)$/) || ['', 'png'])[1].toLowerCase();
      var type = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
      return new File([bytes], name, { type: type });
    });
  }

  function assignFolderLogo(name) {
    var g = groupById(logoActiveGroup);
    if (!g) { toast('先にグループを選んでください'); return; }
    folderFile(name).then(function (f) { return setGroupLogo(g, f); }, function () { toast('画像を読み込めませんでした'); });
  }

  function loadLogoFolder() {
    var dir = loadSetting('logoFolder', '');
    Object.keys(logoThumbs).forEach(function (k) { URL.revokeObjectURL(logoThumbs[k]); });
    logoThumbs = {};
    logoFolderFiles = [];
    if (!dir || !logoAvailable()) { renderLogos(); return Promise.resolve(); }
    return window.ponNative.logos.list(dir).then(function (names) {
      if (names == null) { toast('ロゴのフォルダが見つかりません（USB メモリなどを確認してください）'); renderLogos(); return; }
      logoFolderFiles = names;
      renderLogos();
      // サムネイルは1枚ずつ読む
      return names.reduce(function (p, name) {
        return p.then(function () {
          return folderFile(name).then(function (f) {
            logoThumbs[name] = URL.createObjectURL(f);
            var cells = $('logoGrid').querySelectorAll('.logo-cell');
            var i = logoFolderFiles.indexOf(name);
            if (cells[i]) cells[i].querySelector('img').src = logoThumbs[name];
          }, function () {});
        });
      }, Promise.resolve());
    });
  }

  function normName(x) { return String(x || '').normalize('NFKC').toLowerCase().replace(/\.[^.]+$/, '').replace(/[\s_\-・]+/g, ''); }

  function autoMatchLogos(onlyEmpty) {
    var n = 0;
    var jobs = [];
    groups.forEach(function (g) {
      if (onlyEmpty && g.logo) return;
      var name = logoFolderFiles.filter(function (f) { return normName(f) === normName(g.name); })[0];
      if (!name) return;
      n++;
      jobs.push(folderFile(name).then(function (f) { return setGroupLogo(g, f, true); }, function () {}));
    });
    return Promise.all(jobs).then(function () {
      toast(n ? n + 'グループのロゴを、同じ名前の画像に合わせました' : 'グループ名と同じ名前の画像はありませんでした');
    });
  }

  // 0.10 までの「何もない時の静止画」は、開いているイベントのイベントロゴに引き継ぐ（1回だけ）
  function migrateStill() {
    if (!storeOk || !show || !loadSetting('videoStillName', '')) return;
    var name = loadSetting('videoStillName', '');
    store.getFile('video-still').then(function (f) {
      if (!f) { saveSetting('videoStillName', ''); return; }
      var job = show.logo ? Promise.resolve() : setEventLogo(new File([f], name, { type: f.type || 'image/png' }));
      return job.then(function () {
        saveSetting('videoStillName', '');
        return store.deleteFiles(['video-still']);
      });
    }).catch(function () {});
  }

  function bindLogos() {
    setTimeout(migrateStill, 1500);
    $('eventLogoBtn').addEventListener('click', function (e) { e.currentTarget.blur(); $('eventLogoInput').value = ''; $('eventLogoInput').click(); });
    $('eventLogoPick').addEventListener('click', function () { $('eventLogoInput').value = ''; $('eventLogoInput').click(); });
    $('eventLogoInput').addEventListener('change', function () { var f = $('eventLogoInput').files[0]; if (f) setEventLogo(f); });
    $('eventLogoClear').addEventListener('click', function () { setEventLogo(null); });
    $('groupLogoInput').addEventListener('change', function () {
      var f = $('groupLogoInput').files[0];
      var g = groupById(logoActiveGroup);
      if (f && g) setGroupLogo(g, f);
    });
    $('logoFolderPick').addEventListener('click', function () {
      window.ponNative.logos.pickFolder().then(function (dir) {
        if (!dir) return;
        saveSetting('logoFolder', dir);
        loadLogoFolder().then(function () { if (logoFolderFiles.length) autoMatchLogos(true); });
      });
    });
    $('logoFolderReload').addEventListener('click', function () { loadLogoFolder(); });
    $('logoAutoMatch').addEventListener('click', function () { autoMatchLogos(false); });
    Array.prototype.forEach.call($('videoModeBox').querySelectorAll('[data-vmode]'), function (btn) {
      btn.addEventListener('click', function () { btn.blur(); setVideoManual(btn.dataset.vmode); });
    });
  }

  // ---------- ボーカル調整（アプリ版のみ） ----------
  // AIで分けたボーカルを、再生時に逆向きで重ねて引く。分けるのは仕込みの時（1曲 1〜2分）

  var vocalQueue = [];   // 分ける順番待ちの曲
  var vocalJob = null;   // 分けている最中の曲 { id, jobId, done, total }

  function vocalAvailable() {
    return !!(window.ponNative && window.ponNative.vocalSeparation);
  }

  function vocalLabel(level) {
    var pct = Math.round(level * 100);
    if (pct >= 100) return '100%（そのまま）';
    if (pct <= 0) return '0%（ボーカルを消す）';
    return pct + '%（' + (20 * Math.log10(level)).toFixed(1) + ' dB）';
  }

  function queueVocal(ids) {
    if (!vocalAvailable()) return;
    var added = 0;
    ids.forEach(function (id) {
      var t = tracks.get(id);
      if (!t || t.vocal || t.status === 'error' || !t.file) return;
      if (vocalQueue.indexOf(id) >= 0 || (vocalJob && vocalJob.id === id)) return;
      vocalQueue.push(id);
      added++;
    });
    if (!added) { toast('分ける曲がありません（分離済み、または読み込めない曲です）'); return; }
    render();
    runVocalQueue();
  }

  function runVocalQueue() {
    if (vocalJob || !vocalQueue.length) return;
    var id = vocalQueue.shift();
    var t = tracks.get(id);
    if (!t || !t.file || t.vocal) { runVocalQueue(); return; }
    var job = { id: id, jobId: uid('j'), done: 0, total: 0 };
    vocalJob = job;
    render();
    audio.decodeFile(t.file).then(function (buffer) {
      return audio.toStereo44k(buffer);
    }).then(function (pcm) {
      return window.ponNative.separateVocals(job.jobId, pcm.left, pcm.right, function (done, total, phase) {
        job.done = done;
        job.total = total;
        job.phase = phase || '';
        renderVocalProgress();
      }, {
        device: vocalGpuSupported() && vocalUseGpu ? 'gpu' : 'cpu',
        gpuDevice: loadSetting('vocalGpuDevice', '') === '' ? null : Number(loadSetting('vocalGpuDevice', ''))
      });
    }).then(function (res) {
      var blob = audio.encodeWav16(res.left, res.right, 44100);
      var saving = storeOk ? store.putFile(vocalKey(id), blob) : Promise.resolve();
      return saving.then(function () {
        var tt = tracks.get(id);
        if (!tt) { if (storeOk) store.deleteFiles([vocalKey(id)]).catch(function () {}); return; }
        tt.vocalFile = blob;
        tt.vocal = { level: 1 };
        tt.vocalInfo = vocalStatText(res.stats);
        // 速かった GPU を覚えておく（GPU で失敗した時は、次に選び直す）
        if (res.stats && res.stats.gpuDevice != null) saveSetting('vocalGpuDevice', String(res.stats.gpuDevice));
        else if (res.stats && res.stats.fellBack) saveSetting('vocalGpuDevice', '');
        toast('「' + tt.name + '」のボーカルを分けました' + (tt.vocalInfo ? '（' + tt.vocalInfo + '）' : '') + (res.stats && res.stats.fellBack ? '。' + res.stats.fellBack : ''));
        if (buffers.has(id)) return loadVocalBuffer(tt);
      });
    }).catch(function (err) {
      var msg = (err && err.message) || '';
      if (/cancelled/.test(msg)) toast('ボーカルの分離を中止しました');
      else toast('「' + t.name + '」のボーカルを分けられませんでした：' + msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }).then(function () {
      vocalJob = null;
      afterChange();
      runVocalQueue();
    });
  }

  // GPU で分ける（Mac：CoreML、Windows：DirectML）。使えない・失敗した時は自動で CPU
  var vocalUseGpu = true;

  // GPU で分けるのは Windows だけ（Mac の CoreML は準備に5分ほどかかり、実用にならなかった）
  function vocalGpuSupported() {
    var pf = window.ponNative && window.ponNative.platform;
    return pf === 'win32';
  }

  function vocalStatText(st) {
    if (!st || !st.ms) return '';
    var sec = Math.round(st.ms / 1000);
    return st.device + 'で ' + (sec >= 60 ? Math.floor(sec / 60) + '分' + pad2(sec % 60) + '秒' : sec + '秒') + '（曲 ' + fmtShort(st.seconds || 0) + '）';
  }

  function cancelVocal() {
    vocalQueue = [];
    if (vocalJob && window.ponNative) window.ponNative.cancelVocals(vocalJob.jobId);
    render();
  }

  function setVocalLevel(t, level) {
    if (!t || !t.vocal) return;
    t.vocal.level = clampLevel(level);
    if (current && current.trackId === t.id) audio.setVocalLevel(current.voice, t.vocal.level);
    render();
    saveSoon();
  }

  function removeVocal(t) {
    if (!t || !t.vocal) return;
    if (current && current.trackId === t.id) { toast('再生中の曲は消せません'); return; }
    t.vocal = null;
    t.vocalFile = null;
    vocalBuffers.delete(t.id);
    if (storeOk) store.deleteFiles([vocalKey(t.id)]).catch(function () {});
    toast('分けたボーカルを消しました（原曲のまま鳴ります）');
    afterChange();
  }

  function renderVocalProgress() {
    if (!vocalJob || vocalJob.id !== selectedId) return;
    var pct = vocalJob.total ? Math.round(vocalJob.done / vocalJob.total * 100) : 0;
    $('vocalProgressBar').style.width = pct + '%';
    $('vocalNote').textContent = vocalJob.total ? 'ボーカルを分けています… ' + pct + '%' : vocalJob.phase === 'probe' ? 'どの GPU が速いか試しています…（最初の1回だけ）' : 'ボーカルを分ける準備をしています…';
  }

  function renderVocal(t, state) {
    var note = $('vocalNote');
    var avail = vocalAvailable();
    var g = groupOf(t.id);
    var running = !!(vocalJob && vocalJob.id === t.id);
    var queued = vocalQueue.indexOf(t.id) >= 0;
    var hasVocal = !!t.vocal;
    $('vocalSeparate').hidden = !avail || hasVocal || running || queued;
    $('vocalSeparateGroup').hidden = !avail || running || queued;
    $('vocalGpu').hidden = !avail || !vocalGpuSupported() || hasVocal;
    $('vocalGpu').setAttribute('aria-pressed', String(vocalUseGpu));
    $('vocalGpu').disabled = !!vocalJob;
    $('vocalCancel').hidden = !(vocalJob || vocalQueue.length) || !(running || queued);
    $('vocalProgress').hidden = !running;
    $('vocalSliderRow').hidden = !hasVocal;
    $('vocalAfter').hidden = !hasVocal;
    note.className = 'vocal-note';
    $('vocalSeparate').disabled = locked || t.status === 'error' || !t.info;
    var groupLeft = g ? g.trackIds.filter(function (id) { var x = tracks.get(id); return x && !x.vocal && x.status !== 'error'; }).length : 0;
    $('vocalSeparateGroup').disabled = locked || !groupLeft;
    $('vocalSeparateGroup').textContent = 'このグループをまとめて' + (groupLeft ? '（' + groupLeft + '曲）' : '');
    if (!avail) {
      note.textContent = 'ボーカル調整はアプリ版で使えます';
    } else if (running) {
      renderVocalProgress();
    } else if (queued) {
      note.textContent = '順番待ち（' + (vocalQueue.indexOf(t.id) + 1) + '番目）';
    } else if (hasVocal) {
      var input = $('vocalLevel');
      if (document.activeElement !== input) input.value = String(Math.round(t.vocal.level * 100));
      $('vocalValue').textContent = vocalLabel(t.vocal.level);
      if (t.vocal.level < 0.3) {
        note.textContent = '30%より下げると、音の劣化に気づきやすくなります（大きな音量では特に）';
        note.className = 'vocal-note is-warn';
      } else {
        note.textContent = '分離済み。被せの量を下げられます' + (t.vocalInfo ? '（' + t.vocalInfo + '）' : '');
      }
      $('vocalReset').disabled = t.vocal.level >= 0.995;
      $('vocalRemove').disabled = locked || !!(current && current.trackId === t.id);
    } else {
      note.textContent = 'AIでボーカルを分けておくと、被せの量を下げられます（1曲 1〜2分。仕込みの時に）';
    }
  }

  // ---------- 書き出し・読み込み（.ponbak） ----------

  var backupBusy = false;

  function fileStamp() {
    var d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  function safeFileName(name) {
    return String(name || 'ポン出し').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || 'ポン出し';
  }

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function fmtBytes(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'GB';
    if (n >= 1e6) return Math.round(n / 1e6) + 'MB';
    return Math.max(1, Math.round(n / 1e3)) + 'KB';
  }

  function fileKeysOfShow(data) {
    var keys = Object.keys(data.tracks || {});
    if (data.logo) keys.push(logoKey('ev', data.id));
    (data.groups || []).forEach(function (g) { if (g.logo) keys.push(logoKey('gr', g.id)); });
    keys.slice().forEach(function (id) { if (data.tracks[id].vocal) keys.push(vocalKey(id)); });
    (data.sePads || []).forEach(function (p) { if (p) keys.push(p.id); });
    return keys;
  }

  // all=false：開いているイベントだけ／all=true：全イベント＋共通SE＋BGM
  function exportBackup(all) {
    if (!storeOk) { toast('この環境では書き出しが使えません'); return; }
    if (backupBusy) return;
    backupBusy = true;
    renderBackupButtons();
    toast('書き出しの準備をしています…');
    var saving = saveTimer ? saveNow() : Promise.resolve();
    var manifest = { kind: all ? 'all' : 'event', exportedAt: Date.now(), appVersion: APP_VERSION, shows: [], banks: {} };
    saving.then(function () {
      if (!all) return store.getShow(show.id).then(function (d) { return d ? [d] : []; });
      return store.getAllShows();
    }).then(function (shows) {
      manifest.shows = shows;
      var keys = [];
      shows.forEach(function (d) { keys = keys.concat(fileKeysOfShow(d)); });
      if (!all) return keys;
      return Promise.all([store.getBank('common'), store.getBank('bgm')]).then(function (banks) {
        if (banks[0]) { manifest.banks.common = banks[0]; banks[0].pads.forEach(function (p) { if (p) keys.push(p.id); }); }
        if (banks[1]) { manifest.banks.bgm = banks[1]; keys = keys.concat(Object.keys(banks[1].tracks || {})); }
        return keys;
      });
    }).then(function (keys) {
      return Promise.all(keys.map(function (k) { return store.getFile(k).catch(function () { return null; }); })).then(function (files) {
        var list = [];
        var missing = 0;
        files.forEach(function (f, i) { if (f) list.push({ key: keys[i], file: f }); else missing++; });
        var blob = window.PonBackup.pack(manifest, list);
        var base = all ? 'ポン出し_すべて' : 'ポン出し_' + safeFileName(show.name);
        downloadBlob(blob, base + '_' + fileStamp() + window.PonBackup.EXT);
        toast((all ? manifest.shows.length + 'イベントと共通SE・BGMを' : '「' + show.name + '」を') + '書き出しました（' + fmtBytes(blob.size) + '）' +
          (missing ? '。保存データが見つからない' + missing + '個のファイルは入っていません' : ''));
      });
    }).catch(function () {
      toast('書き出せませんでした');
    }).then(function () {
      backupBusy = false;
      renderBackupButtons();
    });
  }

  function uniqueName(name, taken) {
    if (taken.indexOf(name) < 0) return name;
    var n = 2;
    while (taken.indexOf(name + ' ' + n) >= 0) n++;
    return name + ' ' + n;
  }

  // 読み込んだ中身は、新しいIDを振って追加する（同じファイルを2回読んでも上書きしない）
  function importBackup(file) {
    if (!storeOk) { toast('この環境では読み込みが使えません'); return; }
    if (locked) { toast('本番ロック中は読み込めません'); return; }
    if (backupBusy) return;
    backupBusy = true;
    renderBackupButtons();
    toast('読み込んでいます…');
    var remap = {};
    function newKey(oldKey, prefix) {
      if (!remap[oldKey]) remap[oldKey] = uid(prefix);
      return remap[oldKey];
    }
    var result = { shows: 0, se: 0, seDropped: 0, bgmLists: 0, missing: 0 };
    var data;
    window.PonBackup.unpack(file).then(function (d) {
      data = d;
      var m = d.manifest;
      return store.listShows().then(function (existing) {
        var taken = existing.map(function (s) { return s.name; });
        var shows = (m.shows || []).map(function (sd) {
          var newShowId = uid('s');
          if (sd.logo) remap[logoKey('ev', sd.id)] = logoKey('ev', newShowId);
          var tracksNew = {};
          Object.keys(sd.tracks || {}).forEach(function (id) { tracksNew[newKey(id, 't')] = sd.tracks[id]; });
          var name = uniqueName(sd.name || 'イベント', taken);
          taken.push(name);
          return {
            id: newShowId,
            name: name,
            logo: sd.logo || null,
            createdAt: sd.createdAt || Date.now(),
            updatedAt: Date.now(),
            groups: (sd.groups || []).map(function (g) {
              var ng = uid('g');
              if (g.logo) remap[logoKey('gr', g.id)] = logoKey('gr', ng);
              return { id: ng, name: g.name, logo: g.logo || null, trackIds: (g.trackIds || []).filter(function (id) { return sd.tracks && sd.tracks[id]; }).map(function (id) { return newKey(id, 't'); }) };
            }),
            tracks: tracksNew,
            standbyId: sd.standbyId && remap[sd.standbyId] ? remap[sd.standbyId] : null,
            played: (sd.played || []).filter(function (id) { return remap[id]; }).map(function (id) { return remap[id]; }),
            viewGroupId: null,
            sePads: (sd.sePads || []).map(function (p) { return p ? { id: newKey(p.id, 'p'), name: p.name, fileName: p.fileName, retap: p.retap } : null; })
          };
        });
        // ファイルを先に保存してから、イベントを登録する
        var keys = Object.keys(remap);
        (m.shows || []).forEach(function (sd) {
          Object.keys(sd.tracks || {}).forEach(function (id) {
            if (sd.tracks[id].vocal && remap[id]) { remap[vocalKey(id)] = vocalKey(remap[id]); keys.push(vocalKey(id)); }
          });
        });
        var common = m.banks && m.banks.common;
        var bgm = m.banks && m.banks.bgm;
        if (common) (common.pads || []).forEach(function (p) { if (p) keys.push(p.id); });
        if (bgm) Object.keys(bgm.tracks || {}).forEach(function (id) { keys.push(id); });
        // 1つずつ順に保存する（大きなファイルを同時に抱えない）
        return keys.reduce(function (p, oldKey) {
          return p.then(function () {
            var f = d.files[oldKey];
            if (!f) { result.missing++; return null; }
            var prefix = oldKey.charAt(0) === 'b' ? 'b' : (oldKey.charAt(0) === 'p' ? 'p' : 't');
            return store.putFile(newKey(oldKey, prefix), f);
          });
        }, Promise.resolve()).then(function () {
          return Promise.all(shows.map(function (sh) { return store.putShow(sh); }));
        }).then(function () {
          result.shows = shows.length;
          if (common) mergeCommonSe(common, remap, result);
          if (bgm) mergeBgm(bgm, remap, result);
        });
      });
    }).then(function () {
      var parts = [];
      if (result.shows) parts.push(result.shows + 'イベント');
      if (result.se) parts.push('共通SE ' + result.se + '個');
      if (result.bgmLists) parts.push('BGMのプレイリスト ' + result.bgmLists + '個');
      var msg = parts.length ? parts.join('、') + 'を読み込みました' : '読み込む内容がありませんでした';
      if (result.shows) msg += '。イベント一覧から開けます';
      if (result.seDropped) msg += '。共通SEのパッドに空きがなく、' + result.seDropped + '個は入れていません';
      if (result.missing) msg += '。ファイルが見つからない曲が' + result.missing + '個あります';
      toast(msg);
      return store.listShows().then(function (list) {
        showsCache = list.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
        renderShowsList();
      });
    }).catch(function (err) {
      toast('読み込めませんでした：' + ((err && err.message) || 'ファイルを確認してください'));
    }).then(function () {
      backupBusy = false;
      renderBackupButtons();
    });
  }

  // 共通SE：いまのパッドは残し、空いているパッドに入れる
  function mergeCommonSe(bank, remap, result) {
    var saved = bankToSaved(seBanks.common);
    (bank.pads || []).forEach(function (p) {
      if (!p || !remap[p.id]) return;
      var slot = saved.indexOf(null);
      if (slot < 0) { result.seDropped++; return; }
      saved[slot] = { id: remap[p.id], name: p.name, fileName: p.fileName, retap: p.retap };
      result.se++;
    });
    if (result.se) {
      restoreBank('common', saved).then(function () { saveBank('common'); });
    }
  }

  // BGM：プレイリストを後ろに追加する
  function mergeBgm(bank, remap, result) {
    var taken = bgmLists.map(function (l) { return l.name; });
    (bank.lists || []).forEach(function (l) {
      var ids = (l.trackIds || []).filter(function (id) { return bank.tracks && bank.tracks[id] && remap[id]; });
      if (!ids.length) return;
      var newIds = ids.map(function (id) { return remap[id]; });
      // 同じ名前の空のプレイリストがあれば、そこへ入れる（初期の「客入れ」などへ移す時）
      var same = bgmLists.filter(function (x) { return x.name === l.name && !x.trackIds.length; })[0];
      if (same) {
        same.trackIds = newIds;
        same.shuffle = !!l.shuffle;
      } else {
        var name = uniqueName(l.name, taken);
        taken.push(name);
        bgmLists.push({ id: uid('l'), name: name, trackIds: newIds, shuffle: !!l.shuffle });
      }
      ids.forEach(function (id) {
        var t = bank.tracks[id];
        bgmTracks.set(remap[id], { id: remap[id], name: t.name, fileName: t.fileName, file: null, duration: t.duration || 0, status: 'stored' });
      });
      result.bgmLists++;
    });
    if (result.bgmLists) { saveBgm(); render(); }
  }

  function renderBackupButtons() {
    ['exportShowBtn', 'exportAllBtn', 'importBtn'].forEach(function (id) {
      var b = $(id);
      if (b) b.disabled = backupBusy || (id === 'importBtn' && locked);
    });
  }

  // ---------- SEパッド ----------

  function emptyBank() {
    var bank = [];
    for (var i = 0; i < PAD_COUNT; i++) bank.push(null);
    return bank;
  }

  function bankToSaved(bank) {
    return bank.map(function (pad) {
      return pad ? { id: pad.id, name: pad.name, fileName: pad.fileName, retap: pad.retap } : null;
    });
  }

  function decodePad(pad) {
    pad.status = 'checking';
    var decoding = pad.file ? audio.decodeFile(pad.file) : Promise.reject(new Error('保存されたデータが見つかりません'));
    return decoding.then(function (buffer) {
      seBuffers.set(pad.id, buffer);
      pad.duration = buffer.duration;
      pad.status = 'ok';
    }, function () {
      pad.status = 'error';
    }).then(function () { renderSe(); });
  }

  function restoreBank(bankName, saved) {
    var list = (saved || []).slice();
    // 以前の16枠で9〜16に入っていたSEは、1〜8の空きへ移す。入りきらないものは外す
    var migrated = false;
    var dropped = [];
    if (list.length > PAD_COUNT) {
      var extra = list.slice(PAD_COUNT).filter(Boolean);
      list = list.slice(0, PAD_COUNT);
      while (list.length < PAD_COUNT) list.push(null);
      extra.forEach(function (sp) {
        var slot = list.indexOf(null);
        if (slot >= 0) list[slot] = sp; else dropped.push(sp);
      });
      migrated = true;
    }
    if (dropped.length) {
      if (storeOk) store.deleteFiles(dropped.map(function (d) { return d.id; })).catch(function () {});
      toast('SEパッドを8枠にしたため、入りきらない' + dropped.length + '個（' + dropped.map(function (d) { return d.name; }).join('、') + '）を外しました');
    }
    var getFile = storeOk
      ? function (id) { return store.getFile(id).catch(function () { return null; }); }
      : function () { return Promise.resolve(null); };
    var bank = emptyBank();
    var jobsList = [];
    for (var i = 0; i < PAD_COUNT; i++) {
      var sp = list[i];
      if (!sp) continue;
      (function (index, sp) {
        jobsList.push(getFile(sp.id).then(function (file) {
          var retap = sp.retap === 'restart' || sp.retap === 'overlap' ? sp.retap : 'stop';
          var pad = { id: sp.id, name: sp.name, fileName: sp.fileName, retap: retap, file: file, status: 'checking', duration: 0 };
          bank[index] = pad;
          return pad;
        }));
      })(i, sp);
    }
    return Promise.all(jobsList).then(function (pads) {
      seBanks[bankName] = bank;
      if (migrated) saveBank(bankName);
      render();
      return Promise.all(pads.map(decodePad));
    });
  }

  function saveBank(bankName) {
    if (bankName === 'event') { saveSoon(); return; }
    if (!storeOk) return;
    clearTimeout(commonTimer);
    commonTimer = setTimeout(function () {
      commonTimer = null;
      store.putBank({ id: 'common', pads: bankToSaved(seBanks.common) }).catch(function () {
        toast('共通のSEパッドを保存できませんでした');
      });
    }, 300);
  }

  // ファイルをパッドに割り当てる。1つ目は start の位置、2つ目以降はその後ろの空きパッドへ
  function assignPads(bankName, start, items) {
    if (locked) { toast('本番ロック中はSEパッドを変更できません'); return; }
    var list = items.filter(function (it) { return isAudioFile(it.file); });
    if (!list.length) { toast('取り込める音声ファイルがありませんでした'); return; }
    list.sort(function (a, b) {
      return (a.path || a.file.name).localeCompare(b.path || b.file.name, 'ja', { numeric: true, sensitivity: 'base' });
    });
    var bank = seBanks[bankName];
    var index = start;
    var placed = 0;
    for (var k = 0; k < list.length; k++) {
      if (k > 0) {
        index++;
        while (index < PAD_COUNT && bank[index]) index++;
      }
      if (index < 0 || index >= PAD_COUNT) break;
      var old = bank[index];
      if (old) removePadData(old);
      var file = list[k].file;
      var pad = {
        id: uid('p'), name: file.name.replace(/\.[^.]+$/, ''), fileName: file.name,
        retap: 'stop', file: file, status: 'checking', duration: 0
      };
      bank[index] = pad;
      saveFile(pad.id, file);
      decodePad(pad);
      placed++;
    }
    if (placed < list.length) toast('空きパッドが足りないため、' + (list.length - placed) + '個は割り当てられませんでした');
    seSelected = start;
    saveBank(bankName);
    render();
  }

  function removePadData(pad) {
    stopPad(pad.id);
    seBuffers.delete(pad.id);
    if (storeOk) store.deleteFiles([pad.id]).catch(function () {});
  }

  function stopPad(id) {
    (sePlaying.get(id) || []).forEach(function (voice) { audio.cut(voice); });
    sePlaying.delete(id);
  }

  function stopAllSe() {
    sePlaying.forEach(function (voices) { voices.forEach(function (voice) { audio.cut(voice); }); });
    sePlaying.clear();
    renderSe();
  }

  // ---- SEの音量（-24 〜 +12 dB） ----
  function clampDb(db) {
    return isFinite(db) ? Math.max(-24, Math.min(12, db)) : 0;
  }

  function dbToGain(db) {
    return Math.pow(10, db / 20);
  }

  function getSeBus() {
    if (!seBus) seBus = audio.createBus(dbToGain(seDb));
    return seBus;
  }

  function setSeVolume(db) {
    seDb = clampDb(db);
    if (seBus) seBus.gain.value = dbToGain(seDb);
    saveSetting('seVolumeDb', String(seDb));
    renderSeVolume();
  }

  function renderSeVolume() {
    var range = $('seVolume');
    if (document.activeElement !== range) range.value = String(seDb);
    var label = $('seVolumeValue');
    label.textContent = (seDb > 0 ? '+' : '') + seDb.toFixed(1) + ' dB';
    label.classList.toggle('is-boost', seDb > 0);
  }

  // パッドを鳴らす。曲や他のSEとは重ねて鳴る
  // もう一度押した時：止める／頭から（鳴り直す）／重ねる（前の音を残して、もう1つ鳴らす）
  function playPad(index) {
    var pad = seBanks[seBank][index];
    if (!pad) return;
    if (pad.status !== 'ok') {
      toast(pad.status === 'error' ? '「' + pad.name + '」は読み込めません' : '「' + pad.name + '」を読み込み中です');
      return;
    }
    var voices = sePlaying.get(pad.id) || [];
    if (voices.length) {
      if (pad.retap === 'stop') { stopPad(pad.id); renderSe(); return; }
      if (pad.retap === 'restart') { stopPad(pad.id); voices = []; }
      while (voices.length >= SE_MAX_LAYERS) audio.cut(voices.shift());
    }
    var voice = audio.play(seBuffers.get(pad.id), {
      output: getSeBus(),
      onEnded: function () {
        var list = sePlaying.get(pad.id);
        if (list) {
          var i = list.indexOf(voice);
          if (i >= 0) list.splice(i, 1);
          if (!list.length) sePlaying.delete(pad.id);
        }
        renderSe();
      }
    });
    voices.push(voice);
    sePlaying.set(pad.id, voices);
    renderSe();
  }

  function pickPadFile(index) {
    if (locked) { toast('本番ロック中はSEパッドを変更できません'); return; }
    seTarget = { bank: seBank, index: index };
    $('seFileInput').click();
  }

  function renderSe() {
    var bank = seBanks[seBank];
    if (locked) seEdit = false;
    $('seBankEvent').setAttribute('aria-pressed', String(seBank === 'event'));
    $('seBankCommon').setAttribute('aria-pressed', String(seBank === 'common'));
    $('seEditBtn').setAttribute('aria-pressed', String(seEdit));
    $('seEditBtn').disabled = locked;
    $('seStopAll').disabled = sePlaying.size === 0;
    renderSeVolume();

    var grid = $('seGrid');
    grid.textContent = '';
    for (var i = 0; i < PAD_COUNT; i++) {
      (function (i) {
        var pad = bank[i];
        var el = document.createElement('button');
        el.type = 'button';
        el.tabIndex = -1;
        el.dataset.index = String(i);
        if (pad) el.dataset.id = pad.id;
        el.className = 'pad' +
          (!pad ? ' is-empty' : '') +
          (pad && sePlaying.has(pad.id) ? ' is-playing' : '') +
          (pad && pad.status === 'error' ? ' is-error' : '') +
          (pad && pad.status === 'checking' ? ' is-checking' : '') +
          (seEdit && seSelected === i ? ' is-selected' : '');
        el.appendChild(cell('pad-key', PAD_KEYS[i] || ''));
        el.appendChild(cell('pad-name', pad ? (pad.status === 'error' ? '読込不可 ' : '') + pad.name : (locked ? '' : '＋')));
        el.appendChild(cell('pad-bar', null));
        el.title = pad ? pad.name + (pad.duration ? '（' + fmtShort(pad.duration) + '）' : '') : 'ファイルを割り当て';
        el.addEventListener('click', function () {
          if (seEdit) {
            seSelected = i;
            if (!bank[i]) pickPadFile(i);
            renderSe();
            return;
          }
          if (!bank[i]) { pickPadFile(i); return; }
          playPad(i);
        });
        grid.appendChild(el);
      })(i);
    }

    // 編集欄
    $('seEditor').hidden = !seEdit;
    if (!seEdit) return;
    var sel = seSelected >= 0 ? bank[seSelected] : null;
    $('seEditorEmpty').hidden = !!sel;
    $('seEditorBody').hidden = !sel;
    if (!sel) return;
    var nameInput = $('seName');
    if (document.activeElement !== nameInput) nameInput.value = sel.name;
    $('seRetapStop').setAttribute('aria-pressed', String(sel.retap === 'stop'));
    $('seRetapRestart').setAttribute('aria-pressed', String(sel.retap === 'restart'));
    $('seRetapOverlap').setAttribute('aria-pressed', String(sel.retap === 'overlap'));
    var clear = $('seClear');
    var key = 'pad:' + sel.id;
    clear.textContent = confirmKey === key ? '本当に空にする' : 'パッドを空にする';
    clear.classList.toggle('is-confirm', confirmKey === key);
    $('seFile').textContent = sel.fileName + (sel.duration ? '（' + fmtShort(sel.duration) + '）' : '') +
      (sel.status === 'error' ? ' ・ 読み込めません' : '');
  }

  function bindSe() {
    $('seBankEvent').addEventListener('click', function () { seBank = 'event'; seSelected = -1; saveSetting('seBank', 'event'); renderSe(); });
    $('seBankCommon').addEventListener('click', function () { seBank = 'common'; seSelected = -1; saveSetting('seBank', 'common'); renderSe(); });
    $('seStopAll').addEventListener('click', stopAllSe);
    $('seEditBtn').addEventListener('click', function () {
      if (locked) return;
      seEdit = !seEdit;
      if (!seEdit) seSelected = -1;
      renderSe();
    });
    $('seFileInput').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      var target = seTarget;
      seTarget = null;
      e.target.value = '';
      if (target && files.length) assignPads(target.bank, target.index, files.map(function (f) { return { file: f, path: f.name }; }));
    });
    $('seName').addEventListener('change', function (e) {
      var pad = seBanks[seBank][seSelected];
      var name = e.target.value.trim();
      if (pad && name && !locked) { pad.name = name; saveBank(seBank); }
      e.target.blur();
      render();
    });
    $('seName').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
    });
    $('seRetapStop').addEventListener('click', function () {
      var pad = seBanks[seBank][seSelected];
      if (pad && !locked) { pad.retap = 'stop'; saveBank(seBank); renderSe(); }
    });
    $('seRetapRestart').addEventListener('click', function () {
      var pad = seBanks[seBank][seSelected];
      if (pad && !locked) { pad.retap = 'restart'; saveBank(seBank); renderSe(); }
    });
    $('seRetapOverlap').addEventListener('click', function () {
      var pad = seBanks[seBank][seSelected];
      if (pad && !locked) { pad.retap = 'overlap'; saveBank(seBank); renderSe(); }
    });
    // SEの音量。本番ロック中も動かせる（現場で音量を合わせるため）
    $('seVolume').addEventListener('input', function (e) { setSeVolume(parseFloat(e.target.value)); });
    $('seVolume').addEventListener('change', function (e) { e.target.blur(); });
    $('seVolume').addEventListener('pointerup', function (e) { e.target.blur(); });
    $('seVolumeValue').addEventListener('click', function () { setSeVolume(0); });
    $('seReplace').addEventListener('click', function () {
      if (seSelected >= 0) pickPadFile(seSelected);
    });
    $('seClear').addEventListener('click', function () {
      var bank = seBanks[seBank];
      var pad = bank[seSelected];
      if (!pad || locked) return;
      if (!askTwice('pad:' + pad.id)) { renderSe(); return; }
      removePadData(pad);
      bank[seSelected] = null;
      saveBank(seBank);
      render();
    });
  }

  // ---------- BGM ----------

  // ----- BGM の出力先（Ver. 0.10.0） -----
  // 「本編と同じ」なら本編の出力についていく。別の機器を選んでいて、それが見つからない・抜けた時は
  // BGM を止めて警告を出す（本編のフェーダーに BGM が急に混ざらないように、ほかの出力には逃がさない）
  var BGM_SAME = 'same';
  var bgmOutLost = null;   // 見つからない出力の名前

  function mainOutputValue() {
    var v = $('outputSelect').value;
    return !v || v === ASK_OUTPUTS ? 'default' : v;
  }

  function refreshBgmOutput() {
    var sel = $('bgmOutputSelect');
    if (!audio.canSelectOutput()) {
      sel.textContent = '';
      addOption(sel, BGM_SAME, '本編と同じ');
      sel.disabled = true;
      sel.title = 'この環境では出力デバイスを選べません';
      return Promise.resolve();
    }
    var wanted = loadSetting('bgmOutput', BGM_SAME);
    var wantedLabel = loadSetting('bgmOutputLabel', '');
    var named = lastNamedOutputs;
    sel.textContent = '';
    addOption(sel, BGM_SAME, '本編と同じ');
    addOption(sel, 'default', '既定の出力');
    named.forEach(function (d) { addOption(sel, d.id, d.label); });
    if (!named.length) addOption(sel, ASK_OUTPUTS, 'ほかの出力デバイスを表示…');

    var target = null;
    if (wanted === BGM_SAME) target = mainOutputValue();
    else if (wanted === 'default') target = 'default';
    else {
      var match = null;
      named.forEach(function (d) { if (!match && d.id === wanted) match = d; });
      if (!match && wantedLabel) named.forEach(function (d) { if (!match && d.label === wantedLabel) match = d; });
      if (match) { target = match.id; wanted = match.id; }
    }
    if (target == null) {
      addOption(sel, wanted, '（見つかりません）' + (wantedLabel || '選んだ出力'));
      sel.value = wanted;
      setBgmOutLost(wantedLabel || '選んだ出力');
      return Promise.resolve();
    }
    sel.value = wanted;
    return bgmAudio.setOutput(target).then(function () {
      setBgmOutLost(null);
    }, function () {
      setBgmOutLost(wantedLabel || '選んだ出力');
    });
  }

  function setBgmOutLost(label) {
    var was = bgmOutLost;
    bgmOutLost = label;
    if (label && !was) {
      // 鳴っていれば止める（位置は覚えておくので「再生」で続きから）
      if (bgmNow) bgmPause(0.05);
      bgmTails.forEach(function (v) { bgmAudio.cut(v); });
      bgmTails = [];
      toast('BGMの出力「' + label + '」が見つかりません。BGMを止めました');
    } else if (!label && was) {
      toast('BGMの出力「' + was + '」がつながりました（BGMは止まったままです）');
    }
    var warn = $('bgmOutWarn');
    warn.hidden = !label;
    warn.textContent = label ? '⚠ BGMの出力「' + label + '」が見つかりません。つなぎ直すか、出力を選び直してください' : '';
    $('bgmPanel').classList.toggle('is-out-lost', !!label);
  }

  function bgmBlocked() {
    if (!bgmOutLost) return false;
    toast('BGMの出力「' + bgmOutLost + '」が見つからないため、BGMを鳴らせません');
    return true;
  }

  function clampBgmDb(db) {
    return isFinite(db) ? Math.max(-30, Math.min(12, db)) : 0;
  }

  function bgmList(id) {
    for (var i = 0; i < bgmLists.length; i++) if (bgmLists[i].id === (id || bgmListId)) return bgmLists[i];
    return null;
  }

  function getBgmBus() {
    if (!bgmBus) bgmBus = bgmAudio.createBus(Math.pow(10, bgmDb / 20));
    return bgmBus;
  }

  function saveBgm() {
    if (!storeOk) return;
    clearTimeout(bgmTimer);
    bgmTimer = setTimeout(function () {
      bgmTimer = null;
      var tracksSaved = {};
      bgmTracks.forEach(function (t) {
        tracksSaved[t.id] = { name: t.name, fileName: t.fileName, duration: t.duration || 0 };
        if (t.loud) tracksSaved[t.id].loud = { lufs: t.loud.lufs, peakDb: t.loud.peakDb };
      });
      store.putBank({
        id: 'bgm',
        lists: bgmLists.map(function (l) { return { id: l.id, name: l.name, trackIds: l.trackIds.slice(), shuffle: !!l.shuffle }; }),
        tracks: tracksSaved,
        listId: bgmListId
      }).catch(function () { toast('BGMを保存できませんでした'); });
    }, 300);
  }

  function defaultBgmLists() {
    return ['客入れ', '転換', '客出し'].map(function (name) {
      return { id: uid('l'), name: name, trackIds: [], shuffle: false };
    });
  }

  // BGMの曲ファイルは、再生する時に保存領域から取り出す（全部をメモリに置かない）
  function restoreBgm(data) {
    bgmTracks.clear();
    if (data && data.lists && data.lists.length) {
      bgmLists = data.lists.map(function (l) {
        return { id: l.id, name: l.name, trackIds: (l.trackIds || []).filter(function (id) { return data.tracks && data.tracks[id]; }), shuffle: !!l.shuffle };
      });
      Object.keys(data.tracks || {}).forEach(function (id) {
        var t = data.tracks[id];
        bgmTracks.set(id, { id: id, name: t.name, fileName: t.fileName, file: null, duration: t.duration || 0, status: 'stored', loud: t.loud || null });
      });
      bgmListId = bgmList(data.listId) ? data.listId : bgmLists[0].id;
      measureBgmSoon();
    } else {
      bgmLists = defaultBgmLists();
      bgmListId = bgmLists[0].id;
      saveBgm();
    }
    render();
  }

  function importBgm(items) {
    if (locked) { toast('本番ロック中はBGMを変更できません'); return; }
    var list = bgmList();
    if (!list) return;
    var files = items.filter(function (it) { return isAudioFile(it.file); });
    if (!files.length) { toast('取り込める音声ファイルがありませんでした'); return; }
    files.sort(function (a, b) {
      return (a.path || a.file.name).localeCompare(b.path || b.file.name, 'ja', { numeric: true, sensitivity: 'base' });
    });
    files.forEach(function (it) {
      var id = uid('b');
      bgmTracks.set(id, {
        id: id, name: it.file.name.replace(/\.[^.]+$/, ''), fileName: it.file.name,
        file: it.file, duration: 0, status: 'stored'
      });
      list.trackIds.push(id);
      saveFile(id, it.file);
    });
    bgmSelected = list.trackIds[list.trackIds.length - files.length];
    saveBgm();
    render();
    toast('「' + list.name + '」に' + files.length + '曲追加しました');
    measureBgmSoon();
  }

  // ----- BGM のオートゲイン（Ver. 0.10.4） -----
  // 本編と同じく、曲ごとのラウドネスを一度だけ測り、目標に合わせて曲全体のゲインだけを調整する
  function bgmGainDb(t) {
    if (!autoGainOn || !t || !t.loud || t.loud.lufs == null) return 0;
    return Math.round((LOUD_TARGET - t.loud.lufs) * 10) / 10;
  }

  function measureBgmBuffer(t, buffer) {
    if (t.measuring) return t.measuring;
    t.measuring = audio.measureLoudness(buffer).then(function (r) {
      t.loud = { lufs: isFinite(r.lufs) ? Math.round(r.lufs * 100) / 100 : null, peakDb: isFinite(r.peakDb) ? Math.round(r.peakDb * 100) / 100 : null };
      t.measuring = null;
      if (bgmNow && bgmNow.trackId === t.id && bgmNow.voice) bgmAudio.setTrim(bgmNow.voice, dbToGain(bgmGainDb(t)));
      saveBgm();
      renderBgm();
    }, function () { t.measuring = null; });
    return t.measuring;
  }

  // まだ測っていない BGM を、裏で1曲ずつ測る（読み込んだら手放す）
  var bgmMeasureBusy = false;
  function measureBgmSoon() {
    if (bgmMeasureBusy) return;
    var t = null;
    bgmTracks.forEach(function (x) { if (!t && !x.loud && x.status !== 'error' && !x.measuring) t = x; });
    if (!t) return;
    bgmMeasureBusy = true;
    var getting = t.file ? Promise.resolve(t.file) : (storeOk ? store.getFile(t.id) : Promise.resolve(null));
    getting.then(function (file) {
      if (!file) throw new Error('なし');
      return audio.decodeFile(file);
    }).then(function (buffer) {
      if (!t.duration) { t.duration = buffer.duration; }
      return measureBgmBuffer(t, buffer);
    }).catch(function () { t.status = 'error'; }).then(function () {
      bgmMeasureBusy = false;
      setTimeout(measureBgmSoon, 50);
    });
  }

  function loadBgmBuffer(id) {
    if (bgmBuffers.has(id)) return Promise.resolve(bgmBuffers.get(id));
    var t = bgmTracks.get(id);
    if (!t) return Promise.reject(new Error('曲がありません'));
    var getting = t.file ? Promise.resolve(t.file) : (storeOk ? store.getFile(id) : Promise.resolve(null));
    return getting.then(function (file) {
      if (!file) throw new Error('保存されたデータが見つかりません');
      t.file = file;
      return bgmAudio.decodeFile(file);
    }).then(function (buffer) {
      bgmBuffers.set(id, buffer);
      if (!t.duration || Math.abs(t.duration - buffer.duration) > 0.5) { t.duration = buffer.duration; saveBgm(); }
      if (!t.loud) measureBgmBuffer(t, buffer);
      t.status = 'ok';
      return buffer;
    }, function (err) {
      t.status = 'error';
      throw err;
    });
  }

  function shuffled(ids) {
    var a = ids.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var x = a[i]; a[i] = a[j]; a[j] = x;
    }
    return a;
  }

  function fadeOutBgmVoice(voice, seconds) {
    if (!voice) return;
    bgmTails.push(voice);
    bgmAudio.fade(voice, seconds, function () {
      bgmTails = bgmTails.filter(function (v) { return v !== voice; });
    });
  }

  // プレイリストを再生する。startId を指定するとその曲から
  function bgmPlay(listId, startId) {
    if (bgmBlocked()) return;
    var list = bgmList(listId);
    if (!list || !list.trackIds.length) { toast('プレイリストに曲がありません'); return; }
    var order = list.shuffle ? shuffled(list.trackIds) : list.trackIds.slice();
    if (startId && order.indexOf(startId) >= 0) {
      if (list.shuffle) { order.splice(order.indexOf(startId), 1); order.unshift(startId); }
    }
    var index = startId && order.indexOf(startId) >= 0 ? order.indexOf(startId) : 0;
    // 再生中なら、前の曲はフェードアウトさせて切り替える
    if (bgmNow && bgmNow.voice) fadeOutBgmVoice(bgmNow.voice, bgmFading ? 0.3 : BGM_SWITCH_SECONDS);
    bgmFading = false;
    bgmPaused = null;
    bgmNow = { listId: list.id, order: order, index: index, trackId: null, voice: null };
    bgmPlayAt(index, 0, true);
  }

  // 一時停止：フェードしてから止め、曲と位置を覚えておく
  function bgmPause(fadeSeconds) {
    var now = bgmNow;
    if (!now || bgmFading) return;
    var pos = now.voice ? bgmAudio.position(now.voice) : 0;
    bgmPaused = { listId: now.listId, order: now.order, index: now.index, trackId: now.trackId, offset: pos };
    bgmToken++;
    if (now.voice) fadeOutBgmVoice(now.voice, fadeSeconds == null ? 1.0 : fadeSeconds);
    bgmNow = null;
    render();
  }

  // 一時停止したところから再開
  function bgmResume() {
    var p = bgmPaused;
    if (!p) return;
    if (bgmBlocked()) return;
    var list = bgmList(p.listId);
    if (!list || list.trackIds.indexOf(p.trackId) < 0) { bgmPaused = null; bgmPlay(bgmListId); return; }
    bgmPaused = null;
    bgmFading = false;
    bgmNow = { listId: p.listId, order: p.order, index: p.index, trackId: null, voice: null };
    bgmPlayAt(p.index, 0, true, p.offset);
  }

  function bgmPlayAt(index, attempts, fadeIn, offset) {
    var now = bgmNow;
    if (!now) return;
    if (attempts >= now.order.length) {
      toast('BGMの曲がどれも読み込めませんでした');
      bgmNow = null;
      render();
      return;
    }
    if (index >= now.order.length) {
      // 最後まで行ったら頭に戻る（シャッフルなら並べ直す）
      var list = bgmList(now.listId);
      if (list && list.shuffle) now.order = shuffled(now.order);
      index = 0;
    }
    now.index = index;
    var id = now.order[index];
    now.trackId = id;
    now.voice = null;
    var token = ++bgmToken;
    render();
    loadBgmBuffer(id).then(function (buffer) {
      if (token !== bgmToken || bgmNow !== now) return; // 途中で止めた・切り替えた
      now.voice = bgmAudio.play(buffer, {
        output: getBgmBus(),
        trim: dbToGain(bgmGainDb(bgmTracks.get(id))),
        offset: offset && offset < buffer.duration - 0.5 ? offset : 0,
        fadeIn: fadeIn ? BGM_FADE_IN : 0,
        onEnded: function (ended) {
          if (bgmNow !== now || now.voice !== ended) return; // 切り替え済み・フェードで手放した音
          if (bgmFading) { bgmNow = null; bgmFading = false; render(); return; } // フェード中に曲が終わった
          bgmPlayAt(now.index + 1, 0, false);
        }
      });
      // 次の曲を先に読み込んでおき、それ以外は手放す
      var nextId = now.order[(index + 1) % now.order.length];
      Array.from(bgmBuffers.keys()).forEach(function (k) { if (k !== id && k !== nextId) bgmBuffers.delete(k); });
      if (nextId && nextId !== id) loadBgmBuffer(nextId).catch(function () {});
      render();
    }, function () {
      if (token !== bgmToken || bgmNow !== now) return;
      bgmPlayAt(index + 1, attempts + 1, fadeIn);
    });
  }

  // 停止。now=true ならすぐ止める。フェード中にもう一度押してもすぐ止める
  function bgmStop(now) {
    bgmPaused = null; // 停止はプレイリストの頭に戻す
    if (!bgmNow) {
      bgmTails.forEach(function (v) { bgmAudio.cut(v); });
      bgmTails = [];
      return;
    }
    var voice = bgmNow.voice;
    if (now || bgmFading || !voice) {
      bgmToken++;
      if (voice) bgmAudio.cut(voice);
      bgmTails.forEach(function (v) { bgmAudio.cut(v); });
      bgmTails = [];
      bgmNow = null;
      bgmFading = false;
      render();
      return;
    }
    bgmFading = true;
    var target = bgmNow;
    bgmAudio.fade(voice, BGM_FADE_SECONDS, function () {
      if (bgmNow === target) { bgmNow = null; bgmFading = false; render(); }
    });
    render();
  }

  function bgmNext() {
    if (!bgmNow || bgmFading) return;
    if (bgmNow.voice) fadeOutBgmVoice(bgmNow.voice, 0.6);
    bgmPlayAt(bgmNow.index + 1, 0, true);
  }

  function setBgmVolume(db) {
    bgmDb = clampBgmDb(db);
    if (bgmBus) bgmBus.gain.value = Math.pow(10, bgmDb / 20);
    saveSetting('bgmVolumeDb', String(bgmDb));
    renderBgm();
  }

  function renderBgmTime() {
    var now = bgmNow;
    var t = now && now.trackId ? bgmTracks.get(now.trackId) : null;
    if (!t || !now.voice) {
      $('bgmNowTime').textContent = '';
      $('bgmBar').style.width = '0%';
      return;
    }
    var pos = bgmAudio.position(now.voice);
    $('bgmNowTime').textContent = fmtShort(pos) + ' / ' + fmtShort(now.voice.duration);
    $('bgmBar').style.width = (Math.min(1, pos / now.voice.duration) * 100) + '%';
  }

  function renderBgm() {
    if (!bgmLists.length) return;
    // ミニプレーヤー
    var select = $('bgmListSelect');
    var html = bgmLists.map(function (l) { return l.id + '|' + l.name + '|' + l.trackIds.length; }).join('/');
    if (select.dataset.key !== html) {
      select.dataset.key = html;
      select.textContent = '';
      bgmLists.forEach(function (l) {
        var o = document.createElement('option');
        o.value = l.id;
        o.textContent = l.name + '（' + l.trackIds.length + '）';
        select.appendChild(o);
      });
    }
    select.value = bgmListId;
    var playBtn = $('bgmPlayBtn');
    playBtn.textContent = bgmNow && !bgmFading ? '❚❚ 一時停止' : bgmPaused ? '▶ 再開' : '▶ 再生';
    playBtn.className = 'btn btn-small bgm-play' + (bgmNow && !bgmFading ? ' is-playing' : bgmPaused ? ' is-paused' : '');
    playBtn.disabled = bgmFading;
    var stopBtn = $('bgmStopBtn');
    stopBtn.textContent = bgmFading ? '■ すぐ止める' : '■ 停止';
    stopBtn.className = 'btn btn-small' + (bgmFading ? ' is-fading' : '');
    stopBtn.disabled = !bgmNow && !bgmPaused;
    $('bgmNextBtn').disabled = !bgmNow || bgmFading;
    var title = $('bgmNowTitle');
    var t = bgmNow && bgmNow.trackId ? bgmTracks.get(bgmNow.trackId) : null;
    var playingList = bgmNow ? bgmList(bgmNow.listId) : null;
    if (t) {
      title.textContent = (bgmFading ? 'フェードアウト中：' : '') + (playingList ? playingList.name + '　' : '') + t.name;
      title.className = 'bgm-now-title';
    } else if (bgmPaused && bgmTracks.get(bgmPaused.trackId)) {
      var pl = bgmList(bgmPaused.listId);
      title.textContent = '一時停止中：' + (pl ? pl.name + '　' : '') + bgmTracks.get(bgmPaused.trackId).name + '（' + fmtShort(bgmPaused.offset) + '）';
      title.className = 'bgm-now-title is-idle';
    } else {
      title.textContent = bgmNow ? '読み込み中…' : '停止中';
      title.className = 'bgm-now-title is-idle';
    }
    var range = $('bgmVolume');
    if (document.activeElement !== range) range.value = String(bgmDb);
    var label = $('bgmVolumeValue');
    label.textContent = (bgmDb > 0 ? '+' : '') + bgmDb.toFixed(1) + ' dB';
    label.classList.toggle('is-boost', bgmDb > 0);
    var auto = $('bgmAutoFade');
    auto.setAttribute('aria-pressed', String(bgmAutoFade));
    auto.disabled = locked;

    // タブ
    var tab = $('bgmTab');
    tab.className = 'tab tab-bgm' + (bgmView ? ' is-active' : '');
    $('bgmTabDot').hidden = !bgmNow;
    renderTimeOnly();
    if (!bgmView) return;

    // BGMタブの中身
    var list = bgmList();
    var lists = $('bgmLists');
    lists.textContent = '';
    bgmLists.forEach(function (l) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.tabIndex = -1;
      chip.className = 'bgm-list' + (l.id === bgmListId ? ' is-active' : '');
      if (bgmNow && bgmNow.listId === l.id) chip.appendChild(cell('tab-dot is-bgm', null));
      chip.appendChild(cell('tab-name', l.name));
      chip.appendChild(cell('tab-count', String(l.trackIds.length)));
      chip.addEventListener('click', function () {
        bgmListId = l.id;
        bgmSelected = null;
        saveBgm();
        render();
      });
      lists.appendChild(chip);
    });
    $('bgmAddList').disabled = locked;
    var nameInput = $('bgmListName');
    if (document.activeElement !== nameInput) nameInput.value = list ? list.name : '';
    nameInput.disabled = locked || !list;
    $('bgmShuffle').setAttribute('aria-pressed', String(!!(list && list.shuffle)));
    $('bgmShuffle').disabled = locked || !list;
    var del = $('bgmListDelete');
    var playingHere = !!(bgmNow && list && bgmNow.listId === list.id);
    del.disabled = locked || !list || playingHere || bgmLists.length <= 1;
    del.textContent = list && confirmKey === 'bgmlist:' + list.id ? '本当に削除' : 'プレイリストを削除';
    del.classList.toggle('is-confirm', !!(list && confirmKey === 'bgmlist:' + list.id));
    var total = 0;
    var unknown = false;
    (list ? list.trackIds : []).forEach(function (id) {
      var bt = bgmTracks.get(id);
      if (bt && bt.duration) total += bt.duration; else unknown = true;
    });
    $('bgmListTotal').textContent = list ? list.trackIds.length + '曲 ・ 合計 ' + fmtShort(total) + (unknown && list.trackIds.length ? '（一部不明）' : '') : '';

    var rows = $('bgmRows');
    rows.textContent = '';
    if (list && list.trackIds.indexOf(bgmSelected) < 0) bgmSelected = list.trackIds[0] || null;
    (list ? list.trackIds : []).forEach(function (id, i) {
      var bt = bgmTracks.get(id);
      var row = document.createElement('button');
      row.type = 'button';
      row.tabIndex = -1;
      var isPlaying = !!(bgmNow && bgmNow.listId === list.id && bgmNow.trackId === id);
      row.className = 'bgm-row' + (id === bgmSelected ? ' is-selected' : '') + (isPlaying ? ' is-playing' : '') + (bt.status === 'error' ? ' is-error' : '');
      row.appendChild(cell('c-num', String(i + 1)));
      var bTitle = cell('c-title', null);
      bTitle.appendChild(cell('title-text', bt.name));
      var bdb = bgmGainDb(bt);
      if (bt.loud && Math.abs(bdb) >= 0.5) bTitle.appendChild(cell('gain-tag', fmtDb(bdb).replace(' ', '')));
      row.appendChild(bTitle);
      row.appendChild(cell('c-state', isPlaying ? (bgmFading ? 'フェード中' : '再生中') : (bt.status === 'error' ? '読込不可' : '')));
      row.appendChild(cell('c-dur', bt.duration ? fmtShort(bt.duration) : '—'));
      row.addEventListener('click', function () { bgmSelected = id; renderBgm(); });
      rows.appendChild(row);
    });
    var index = list && bgmSelected ? list.trackIds.indexOf(bgmSelected) : -1;
    $('bgmPlayFrom').disabled = index < 0;
    $('bgmUp').disabled = locked || index <= 0;
    $('bgmDown').disabled = locked || index < 0 || index >= list.trackIds.length - 1;
    var playingSel = !!(bgmNow && bgmNow.trackId === bgmSelected);
    $('bgmRemove').disabled = locked || index < 0 || playingSel;
  }

  function renderTimeOnly() { renderBgmTime(); }

  function bindBgm() {
    $('bgmTab').addEventListener('click', function () {
      bgmView = true;
      render();
    });
    $('bgmListSelect').addEventListener('change', function (e) {
      var id = e.target.value;
      e.target.blur();
      bgmListId = id;
      saveBgm();
      // 再生中に選び直したら、そのプレイリストに切り替える
      if (bgmNow && bgmNow.listId !== id) bgmPlay(id);
      render();
    });
    $('bgmPlayBtn').addEventListener('click', function () {
      if (bgmNow) bgmPause(1.0);
      else if (bgmPaused && bgmPaused.listId === bgmListId) bgmResume();
      else bgmPlay(bgmListId);
    });
    $('bgmStopBtn').addEventListener('click', function () { bgmStop(false); });
    $('bgmNextBtn').addEventListener('click', bgmNext);
    $('bgmVolume').addEventListener('input', function (e) { setBgmVolume(parseFloat(e.target.value)); });
    $('bgmVolume').addEventListener('change', function (e) { e.target.blur(); });
    $('bgmVolume').addEventListener('pointerup', function (e) { e.target.blur(); });
    $('bgmVolumeValue').addEventListener('click', function () { setBgmVolume(0); });
    $('bgmAutoFade').addEventListener('click', function () {
      if (locked) return;
      bgmAutoFade = !bgmAutoFade;
      saveSetting('bgmAutoFade', bgmAutoFade ? 'on' : 'off');
      renderBgm();
    });
    $('bgmAddList').addEventListener('click', function () {
      if (locked) return;
      var l = { id: uid('l'), name: 'プレイリスト' + (bgmLists.length + 1), trackIds: [], shuffle: false };
      bgmLists.push(l);
      bgmListId = l.id;
      saveBgm();
      render();
    });
    $('bgmListName').addEventListener('change', function (e) {
      var l = bgmList();
      var name = e.target.value.trim();
      if (l && name && !locked) { l.name = name; saveBgm(); }
      e.target.blur();
      render();
    });
    $('bgmListName').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
    });
    $('bgmShuffle').addEventListener('click', function () {
      var l = bgmList();
      if (!l || locked) return;
      l.shuffle = !l.shuffle;
      saveBgm();
      renderBgm();
    });
    $('bgmListDelete').addEventListener('click', function () {
      var l = bgmList();
      if (!l || locked || bgmLists.length <= 1) return;
      if (bgmNow && bgmNow.listId === l.id) { toast('再生中のプレイリストは削除できません'); return; }
      if (!askTwice('bgmlist:' + l.id)) return;
      var i = bgmLists.indexOf(l);
      l.trackIds.forEach(function (id) { bgmTracks.delete(id); bgmBuffers.delete(id); });
      if (storeOk) store.deleteFiles(l.trackIds.slice()).catch(function () {});
      bgmLists.splice(i, 1);
      bgmListId = bgmLists[Math.min(i, bgmLists.length - 1)].id;
      saveBgm();
      render();
    });
    $('bgmPlayFrom').addEventListener('click', function () {
      if (bgmSelected) bgmPlay(bgmListId, bgmSelected);
    });
    function moveBgm(delta) {
      var l = bgmList();
      if (!l || locked || !bgmSelected) return;
      var i = l.trackIds.indexOf(bgmSelected);
      var j = i + delta;
      if (i < 0 || j < 0 || j >= l.trackIds.length) return;
      l.trackIds.splice(i, 1);
      l.trackIds.splice(j, 0, bgmSelected);
      saveBgm();
      renderBgm();
    }
    $('bgmUp').addEventListener('click', function () { moveBgm(-1); });
    $('bgmDown').addEventListener('click', function () { moveBgm(1); });
    $('bgmRemove').addEventListener('click', function () {
      var l = bgmList();
      if (!l || locked || !bgmSelected) return;
      if (bgmNow && bgmNow.trackId === bgmSelected) { toast('再生中の曲は外せません'); return; }
      var i = l.trackIds.indexOf(bgmSelected);
      var id = bgmSelected;
      l.trackIds.splice(i, 1);
      bgmTracks.delete(id);
      bgmBuffers.delete(id);
      if (bgmNow && bgmNow.listId === l.id) {
        var k = bgmNow.order.indexOf(id);
        if (k >= 0) { bgmNow.order.splice(k, 1); if (k < bgmNow.index) bgmNow.index--; }
      }
      if (storeOk) store.deleteFiles([id]).catch(function () {});
      bgmSelected = l.trackIds[Math.min(i, l.trackIds.length - 1)] || null;
      saveBgm();
      renderBgm();
    });
  }

  // ---------- 音楽CDから取り込む（Mac のアプリ版のみ、Ver. 0.10.1） ----------
  // macOS は音楽CDを「1 曲名.aiff」というファイルとして見せるので、それを1曲ずつ読んでアプリの中にコピーする。
  // CDから直接は鳴らさない（回り出しの遅れ・読み取りエラーで本番に音が途切れないように）。
  var cdData = { cds: [], index: 0, checked: {}, state: {}, newGroup: true };
  var cdJob = null; // 取り込み中 { cancel }

  function cdAvailable() { return !!(window.ponNative && window.ponNative.cd); }
  function cdOpen() { return !$('cdBackdrop').hidden; }
  function cdTrackName(file) { return file.replace(/\.aiff?$/i, '').replace(/^\d+[ _.\-]+/, '') || file; }
  function cdTrackNo(file) { var m = file.match(/^(\d+)/); return m ? m[1] : ''; }
  function cdCurrent() { return cdData.cds[cdData.index] || null; }

  function openCdDialog() {
    $('cdBackdrop').hidden = false;
    if (!cdJob) { $('cdProgress').hidden = true; $('cdProgress').textContent = ''; }
    if (!cdJob) scanCd();
    else renderCd();
  }

  function closeCdDialog() { $('cdBackdrop').hidden = true; }

  function scanCd() {
    $('cdList').textContent = '';
    var li = document.createElement('li');
    li.textContent = 'CDを探しています…';
    $('cdList').appendChild(li);
    return window.ponNative.cd.list().then(function (cds) {
      var before = cdCurrent();
      cdData.cds = cds || [];
      cdData.index = 0;
      var same = false;
      if (before) cdData.cds.forEach(function (c, i) { if (c.dir === before.dir) { cdData.index = i; same = true; } });
      var cd = cdCurrent();
      // 同じCDなら、取り込み済みの曲は外したままにする（二重に取り込まないように）
      if (!same) { cdData.state = {}; cdData.checked = {}; }
      if (cd) cd.tracks.forEach(function (t) { cdData.checked[t.file] = cdData.state[t.file] !== 'done'; });
      renderCd();
    }, function () {
      cdData.cds = [];
      renderCd();
    });
  }

  function renderCd() {
    var cd = cdCurrent();
    var list = $('cdList');
    list.textContent = '';
    var pick = $('cdSelect');
    pick.textContent = '';
    cdData.cds.forEach(function (c, i) { addOption(pick, String(i), c.name + '（' + c.tracks.length + '曲）'); });
    pick.value = String(cdData.index);
    $('cdPick').hidden = cdData.cds.length < 2;
    $('cdTitle').textContent = cd ? 'CDから取り込む：' + cd.name : 'CDから取り込む';
    var busy = !!cdJob;
    if (!cd) {
      var li = document.createElement('li');
      li.textContent = '音楽CDが見つかりません。CDを入れて、Finder に曲が出てから「CDを探し直す」を押してください。';
      list.appendChild(li);
    } else {
      cd.tracks.forEach(function (t) {
        var item = document.createElement('li');
        var label = document.createElement('label');
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!cdData.checked[t.file];
        box.disabled = busy;
        box.addEventListener('change', function () { cdData.checked[t.file] = box.checked; renderCdCount(); });
        label.appendChild(box);
        label.appendChild(cell('cd-no', cdTrackNo(t.file)));
        label.appendChild(cell('cd-name', cdTrackName(t.file)));
        item.appendChild(label);
        // CDの音は 44.1kHz・16ビット・ステレオなので、大きさから長さがわかる
        if (t.size) item.appendChild(cell('cd-size', fmtShort(Math.max(0, t.size - 54) / 176400)));
        var st = cdData.state[t.file];
        var label2 = st === 'busy' ? '取り込み中…' : st === 'done' ? '取り込み済み' : st === 'error' ? '読めませんでした' : '';
        if (label2) item.appendChild(cell('cd-state is-' + st, label2));
        list.appendChild(item);
      });
    }
    $('cdNewGroup').setAttribute('aria-pressed', String(cdData.newGroup));
    $('cdNewGroup').textContent = '新しいグループ' + (cd ? '「' + cd.name + '」' : '（CDの名前）') + 'に入れる';
    $('cdNewGroup').disabled = busy;
    $('cdAll').disabled = busy || !cd;
    $('cdNone').disabled = busy || !cd;
    $('cdRescan').disabled = busy;
    $('cdSelect').disabled = busy;
    $('cdStart').textContent = busy ? '中止' : '取り込む';
    $('cdStart').classList.toggle('btn-primary', !busy);
    renderCdCount();
  }

  function renderCdCount() {
    var cd = cdCurrent();
    var n = cd ? cd.tracks.filter(function (t) { return cdData.checked[t.file]; }).length : 0;
    $('cdCount').textContent = cd ? n + ' / ' + cd.tracks.length + '曲を選択' : '';
    if (!cdJob) $('cdStart').disabled = !n;
  }

  function startCdImport() {
    if (cdJob) { cdJob.cancel = true; $('cdProgress').textContent = '今の曲が終わったら止めます…'; return; }
    var cd = cdCurrent();
    if (!cd) return;
    var todo = cd.tracks.filter(function (t) { return cdData.checked[t.file]; });
    if (!todo.length) return;
    var job = cdJob = { cancel: false };
    var groupName = cdData.newGroup ? cd.name : null;
    var done = 0, failed = 0, i = 0;
    $('cdProgress').hidden = false;
    renderCd();
    function next() {
      if (job.cancel || i >= todo.length) return finish();
      var t = todo[i++];
      cdData.state[t.file] = 'busy';
      $('cdProgress').textContent = '取り込み中 ' + i + ' / ' + todo.length + '：' + cdTrackName(t.file);
      if (cdOpen()) renderCd();
      window.ponNative.cd.read(cd.dir, t.file).then(function (bytes) {
        var name = cdTrackName(t.file) + '.aiff';
        var file = new File([bytes], name, { type: 'audio/aiff' });
        importItems([{ file: file, path: groupName ? '/' + groupName + '/' + name : '' }]);
        cdData.state[t.file] = 'done';
        cdData.checked[t.file] = false;
        done++;
      }, function () {
        cdData.state[t.file] = 'error';
        failed++;
      }).then(function () { setTimeout(next, 0); });
    }
    function finish() {
      cdJob = null;
      $('cdProgress').textContent = (job.cancel ? '中止しました。' : '') + done + '曲を取り込みました' + (failed ? '（' + failed + '曲は読めませんでした。CDの汚れ・傷を確認してください）' : '');
      if (cdOpen()) renderCd();
      toast('CDから' + done + '曲を取り込みました' + (failed ? '（' + failed + '曲は読めませんでした）' : ''));
    }
    next();
  }

  function bindCd() {
    if (!cdAvailable()) return;
    window.ponNative.cd.supported().then(function (ok) { $('cdBtn').hidden = !ok; });
    $('cdBtn').addEventListener('click', function (e) { e.currentTarget.blur(); openCdDialog(); });
    $('cdClose').addEventListener('click', closeCdDialog);
    $('cdBackdrop').addEventListener('click', function (e) { if (e.target === $('cdBackdrop')) closeCdDialog(); });
    $('cdRescan').addEventListener('click', function (e) { e.currentTarget.blur(); scanCd(); });
    $('cdSelect').addEventListener('change', function (e) {
      cdData.index = Number(e.target.value) || 0;
      cdData.checked = {}; cdData.state = {};
      var cd = cdCurrent();
      if (cd) cd.tracks.forEach(function (t) { cdData.checked[t.file] = true; });
      renderCd();
    });
    $('cdAll').addEventListener('click', function () { var cd = cdCurrent(); if (cd) cd.tracks.forEach(function (t) { cdData.checked[t.file] = true; }); renderCd(); });
    $('cdNone').addEventListener('click', function () { cdData.checked = {}; renderCd(); });
    $('cdNewGroup').addEventListener('click', function () { if (cdJob) return; cdData.newGroup = !cdData.newGroup; saveSetting('cdNewGroup', cdData.newGroup ? '1' : '0'); renderCd(); });
    $('cdStart').addEventListener('click', function (e) { e.currentTarget.blur(); startCdImport(); });
    cdData.newGroup = loadSetting('cdNewGroup', '1') !== '0';
  }

  // ---------- 新しい版のお知らせ（アプリ版のみ） ----------
  // 起動して少ししたら、ネットにつながっていれば GitHub の最新リリースを調べる。
  // 本番の邪魔にならないよう、勝手にダイアログは出さず、上に「新しい版があります」を出すだけ。

  var updateInfo = null;

  function updateAvailable() { return !!(window.ponNative && window.ponNative.update); }

  // '0.10.0' と '0.9.3' のように、数字ごとに比べる。a が新しければ正
  function compareVersion(a, b) {
    var pa = String(a).split(/[.\-+]/), pb = String(b).split(/[.\-+]/);
    for (var i = 0; i < 3; i++) {
      var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  function checkForUpdate(manual) {
    if (!updateAvailable()) { if (manual) toast('アップデートの確認はアプリ版で使えます'); return; }
    if (!manual && navigator.onLine === false) return;
    if (manual) toast('最新の版を確認しています…');
    window.ponNative.update.check().then(function (r) {
      if (!r || !r.ok) {
        if (manual) toast(r && r.status === 'offline' ? 'ネットにつながっていないため確認できませんでした' : '確認できませんでした。しばらくしてからもう一度お試しください');
        return;
      }
      var newer = compareVersion(r.version, APP_VERSION) > 0;
      updateInfo = newer ? r : null;
      renderUpdateBtn();
      if (!newer) { if (manual) toast('最新の版です（Ver. ' + APP_VERSION + '）'); return; }
      if (manual) { openUpdateDialog(); return; }
      if (loadSetting('updateSkip', '') === r.version) return; // 「この版は知らせない」
      toast('新しい版 Ver. ' + r.version + ' があります（左上のボタンから）');
    }, function () {
      if (manual) toast('確認できませんでした');
    });
  }

  function renderUpdateBtn() {
    var b = $('updateBtn');
    if (!b) return;
    var show = !!updateInfo && loadSetting('updateSkip', '') !== updateInfo.version;
    b.hidden = !show;
    if (show) b.textContent = '新しい版 Ver. ' + updateInfo.version;
  }

  function updateOpen() { return !$('updateBackdrop').hidden; }

  function openUpdateDialog() {
    if (!updateInfo) return;
    $('updateVer').textContent = 'Ver. ' + APP_VERSION + ' → Ver. ' + updateInfo.version + (updateInfo.publishedAt ? '（' + updateInfo.publishedAt.slice(0, 10).replace(/-/g, '/') + '）' : '');
    var notes = (updateInfo.notes || '').replace(/\r/g, '').replace(/^#+\s*/gm, '').replace(/\*\*/g, '').trim();
    $('updateNotes').textContent = notes;
    $('updateNotes').hidden = !notes;
    $('updateBackdrop').hidden = false;
  }

  function closeUpdateDialog() { $('updateBackdrop').hidden = true; }

  function bindUpdate() {
    $('updateBtn').addEventListener('click', function (e) { e.currentTarget.blur(); openUpdateDialog(); });
    $('updateClose').addEventListener('click', closeUpdateDialog);
    $('updateBackdrop').addEventListener('click', function (e) { if (e.target === $('updateBackdrop')) closeUpdateDialog(); });
    $('updateOpen').addEventListener('click', function () { window.ponNative.update.open('page'); closeUpdateDialog(); });
    $('updateSkip').addEventListener('click', function () {
      if (updateInfo) saveSetting('updateSkip', updateInfo.version);
      closeUpdateDialog(); renderUpdateBtn();
      toast('この版のお知らせを止めました（メニューの「アップデートを確認」でいつでも見られます）');
    });
    if (!updateAvailable()) return;
    window.ponNative.update.onRequest(function () { checkForUpdate(true); });
    setTimeout(function () { checkForUpdate(false); }, 4000);
  }

  // ---------- 起動 ----------

  function init() {
    var ver = $('appVersion');
    if (ver && ver.getAttribute('data-version') !== APP_VERSION) {
      ver.classList.add('is-stale');
      ver.textContent = '古いファイル：再読み込みしてください';
    }
    if (!storeOk) {
      newShowWithoutStore();
      return;
    }
    store.open().then(function () {
      store.persist();
      store.getBank('common').then(function (bank) {
        return restoreBank('common', bank && bank.pads);
      }).catch(function () { /* 共通のSEが読めなくても続ける */ });
      store.getBank('bgm').then(restoreBgm, function () { restoreBgm(null); });
      var last = loadSetting('lastShow', '');
      return last ? store.getShow(last).catch(function () { return null; }) : null;
    }).then(function (data) {
      if (data) return loadShow(data);
      newShow();
    }).catch(function () {
      storeOk = false;
      newShowWithoutStore();
    });
  }

  function newShowWithoutStore() {
    restoreBgm(null);
    show = { id: uid('s'), name: defaultShowName(), createdAt: Date.now() };
    toast('この環境では保存が使えません。閉じると曲リストは消えます');
    render();
  }

  bind();
  bindSe();
  bindBgm();
  bindUpdate();
  bindCd();
  render();
  init();
  refreshOutputs(true);
  window.requestAnimationFrame(loop);

  // 動作確認用
  window.__ponToast = function (msg) { toast(msg); };
  window.__pon = {
    get engine() { return engine; },
    groups: function () { return groups; },
    viewGroupId: function () { return viewGroupId; },
    show: function () { return show; },
    saveNow: saveNow,
    pendingFiles: function () { return pendingFiles; },
    openShow: openShow,
    newShow: newShow,
    audio: audio,
    bgmAudio: bgmAudio,
    bgmOutLost: function () { return bgmOutLost; },
    cdBusy: function () { return !!cdJob; },
    tailsInfo: function () { return tails.map(function (v) { return { playing: !v.stopped && !v.finished, fading: !!v.fading, pos: audio.position(v) }; }); },
    tracks: tracks,
    buffers: buffers,
    importItems: importItems,
    pressGo: pressGo,
    render: function () { render(); },
    pressStop: pressStop,
    pressFade: pressFade,
    seekTo: seekTo,
    seekBy: seekBy,
    setLocked: setLocked,
    isLocked: function () { return locked; },
    tails: function () { return tails; },
    seBanks: function () { return seBanks; },
    bgm: function () { return { lists: bgmLists, tracks: bgmTracks, listId: bgmListId, now: bgmNow, paused: bgmPaused, fading: bgmFading, tails: bgmTails, bus: bgmBus, view: bgmView }; },
    bgmPlay: function (listId, trackId) { return bgmPlay(listId, trackId); },
    bgmStop: function (now) { return bgmStop(now); },
    bgmNext: function () { return bgmNext(); },
    seBus: function () { return seBus; },
    setSeVolume: setSeVolume,
    sePlaying: function () { return sePlaying; },
    playPad: playPad,
    standbyStart: function () { return standbyStart; },
    current: function () { return current; }
  };
})();
