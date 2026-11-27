/*
 * ポン出し — GOの動作エンジン
 *
 * 画面や音声から切り離した、状態管理だけの部品。
 * 「次の次の曲を出してしまう」事故を防ぐためのルールをここに集約する。
 *
 *  1. GOは「スタンバイ中の1曲」だけを出す。相対的な「次へ」は存在しない。
 *  2. スタンバイが次へ進むのは、曲を実際に出した瞬間だけ。
 *     曲が自然に終わっただけでは、スタンバイは動かない。
 *  3. 曲を出した直後は一定時間GOを受け付けない（連打ガード）。
 *     「続けて再生」で自動的に出た直後も同じ。
 *  4. 2回押しモードでは、1回目は「構え」になるだけで音は出ない。
 *  5. 再生中のGOは、今の曲を止めてスタンバイ曲を出す（即カット）。
 *
 * 時刻はすべて呼び出し側から渡す（ミリ秒）。テストしやすくするため。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PonCueEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    goMode: 'double', // 'single' = 1回押し / 'double' = 2回押し（構え→再生）
    guardMs: 2000,    // 曲を出した直後にGOを受け付けない時間
    bounceMs: 40      // キーのチャタリング対策。人には押せない短さの連続入力だけ無視
  };

  function createEngine(options) {
    var settings = Object.assign({}, DEFAULTS, options || {});

    var order = [];        // 曲IDの並び（キューリストの順）
    var tracks = {};       // id -> { id, afterAction, playable, ready }
    var played = {};       // id -> true（一度でも出した曲）
    var playingId = null;
    var standbyId = null;
    var armed = false;     // 2回押しモードの「構え」
    var fading = false;
    var guardUntil = 0;
    var lastGoPressAt = -Infinity;

    function has(id) {
      return Object.prototype.hasOwnProperty.call(tracks, id);
    }

    function isPlayable(id) {
      return has(id) && tracks[id].playable !== false;
    }

    // id の次にある「再生できる曲」。なければ null。
    function nextPlayableAfter(id) {
      var index = order.indexOf(id);
      for (var i = index + 1; i < order.length; i++) {
        if (isPlayable(order[i])) return order[i];
      }
      return null;
    }

    function firstPlayableFrom(startIndex) {
      for (var i = Math.max(0, startIndex); i < order.length; i++) {
        if (isPlayable(order[i])) return order[i];
      }
      return null;
    }

    function ignored(reason, extra) {
      return Object.assign({ type: 'ignored', reason: reason }, extra || {});
    }

    // スタンバイ曲を実際に出す。スタンバイが進むのはここだけ。
    function fire(now, cause) {
      var cutId = playingId;
      var id = standbyId;
      if (cutId) played[cutId] = true;
      playingId = id;
      fading = false;
      armed = false;
      standbyId = nextPlayableAfter(id);
      guardUntil = now + settings.guardMs;
      return { type: 'play', trackId: id, cutTrackId: cutId, cause: cause };
    }

    var api = {
      // ----- 曲リストの編集 -----

      addTrack: function (track) {
        if (!track || track.id == null || has(track.id)) return false;
        tracks[track.id] = {
          id: track.id,
          afterAction: track.afterAction === 'continue' ? 'continue' : 'stop',
          playable: track.playable !== false,
          ready: track.ready === true
        };
        order.push(track.id);
        if (standbyId === null && isPlayable(track.id)) standbyId = track.id;
        return true;
      },

      removeTrack: function (id) {
        if (!has(id)) return false;
        if (id === playingId) return false; // 再生中の曲は外せない
        if (id === standbyId) {
          standbyId = nextPlayableAfter(id);
          armed = false;
        }
        order.splice(order.indexOf(id), 1);
        delete tracks[id];
        delete played[id];
        return true;
      },

      // 並べ替え。スタンバイは「曲そのもの」に付いているので動かない。
      moveTrack: function (id, toIndex) {
        var from = order.indexOf(id);
        if (from < 0) return false;
        var to = Math.max(0, Math.min(order.length - 1, toIndex));
        if (to === from) return false;
        order.splice(from, 1);
        order.splice(to, 0, id);
        return true;
      },

      // 並び全体を入れ替える（グループの並べ替えなど）。スタンバイは同じ曲のまま。
      reorder: function (ids) {
        if (!Array.isArray(ids) || ids.length !== order.length) return false;
        var seen = {};
        for (var i = 0; i < ids.length; i++) {
          if (!has(ids[i]) || seen[ids[i]]) return false;
          seen[ids[i]] = true;
        }
        order = ids.slice();
        return true;
      },

      // 保存した状態から戻す時に、「済」の印を付け直す
      markPlayed: function (id) {
        if (!has(id)) return false;
        played[id] = true;
        return true;
      },

      setAfterAction: function (id, action) {
        if (!has(id)) return false;
        tracks[id].afterAction = action === 'continue' ? 'continue' : 'stop';
        return true;
      },

      // 読み込めないファイルなどを「再生できない曲」にする。
      setPlayable: function (id, playable) {
        if (!has(id)) return false;
        tracks[id].playable = !!playable;
        if (!playable && id === standbyId) {
          standbyId = nextPlayableAfter(id);
          armed = false;
        }
        if (playable && standbyId === null && id !== playingId && !played[id]) {
          // スタンバイが空の時に再生可能になったら、先頭の未再生曲を選び直す
          var playingIndex = playingId ? order.indexOf(playingId) : -1;
          standbyId = firstPlayableFrom(playingIndex + 1);
        }
        return true;
      },

      // 頭出しの準備（音声の読み込み）ができているか。
      setReady: function (id, ready) {
        if (!has(id)) return false;
        tracks[id].ready = !!ready;
        return true;
      },

      // ----- 設定 -----

      setGoMode: function (mode) {
        settings.goMode = mode === 'single' ? 'single' : 'double';
        armed = false;
      },

      setGuardMs: function (ms) {
        settings.guardMs = Math.max(0, Number(ms) || 0);
      },

      // ----- 本番の操作 -----

      // スタンバイ曲を明示的に変える。構えは解除する。
      setStandby: function (id) {
        if (!isPlayable(id)) return false;
        if (id !== standbyId) {
          standbyId = id;
          armed = false;
        }
        return true;
      },

      go: function (now) {
        if (now - lastGoPressAt < settings.bounceMs) return ignored('bounce');
        if (now < guardUntil) return ignored('guard', { remainingMs: guardUntil - now });
        if (standbyId === null) return ignored('no-standby');
        if (!tracks[standbyId].ready) return ignored('not-ready', { trackId: standbyId });
        lastGoPressAt = now;
        if (settings.goMode === 'double' && !armed) {
          armed = true;
          return { type: 'armed', trackId: standbyId };
        }
        return fire(now, 'manual');
      },

      // STOP / Esc。構え中は構えの解除だけを行い、再生中の曲は止めない。
      stop: function () {
        if (armed) {
          armed = false;
          return { type: 'disarmed' };
        }
        if (playingId === null) return ignored('not-playing');
        var id = playingId;
        played[id] = true;
        playingId = null;
        fading = false;
        return { type: 'stop', trackId: id };
      },

      // フェードアウト開始。構えには触れない。
      fade: function () {
        if (playingId === null) return ignored('not-playing');
        if (fading) return ignored('already-fading');
        fading = true;
        return { type: 'fade', trackId: playingId };
      },

      // フェードアウトが終わった時に呼ぶ。
      fadeCompleted: function (id) {
        if (id !== playingId || !fading) return ignored('stale');
        played[id] = true;
        playingId = null;
        fading = false;
        return { type: 'stopped', trackId: id };
      },

      // 曲が最後まで再生されて自然に終わった時に呼ぶ。
      // 「続けて再生」ならスタンバイ曲を自動で出す。その直後も連打ガードが働く。
      trackEnded: function (id, now) {
        if (id !== playingId) return ignored('stale');
        var after = tracks[id].afterAction;
        played[id] = true;
        playingId = null;
        fading = false;
        if (after === 'continue' && standbyId !== null && tracks[standbyId].ready) {
          return fire(now, 'auto');
        }
        return { type: 'ended', trackId: id };
      },

      // マーカー：再生中の曲 id のマーカーに来た時に呼ぶ。今の曲は鳴らしたまま、スタンバイ曲を出す。
      // 押し方（2回押し）・連打ガードは関係ない（人の操作ではないため）
      markerGo: function (id, now) {
        if (id !== playingId) return ignored('stale');
        if (fading) return ignored('fading');
        if (standbyId === null) return ignored('no-standby');
        if (!tracks[standbyId].ready) return ignored('not-ready', { trackId: standbyId });
        return fire(now, 'marker');
      },

      disarm: function () {
        var was = armed;
        armed = false;
        return was;
      },

      // ----- 状態の参照 -----

      getState: function (now) {
        var guardRemainingMs = Math.max(0, guardUntil - (now == null ? 0 : now));
        var standbyReady = standbyId !== null && tracks[standbyId].ready;
        var goState;
        if (guardRemainingMs > 0) goState = 'guard';
        else if (standbyId === null) goState = 'no-standby';
        else if (!standbyReady) goState = 'not-ready';
        else if (settings.goMode === 'double' && !armed) goState = 'will-arm';
        else goState = 'will-play';
        return {
          order: order.slice(),
          playingId: playingId,
          standbyId: standbyId,
          armed: armed,
          fading: fading,
          goMode: settings.goMode,
          guardMs: settings.guardMs,
          guardRemainingMs: guardRemainingMs,
          standbyReady: standbyReady,
          // will-play: 次の1回で音が出る / will-arm: 次の1回は構えるだけ
          // guard: 連打ガード中 / not-ready: 準備中 / no-standby: 出す曲がない
          goState: goState,
          played: Object.assign({}, played)
        };
      },

      getTrack: function (id) {
        return has(id) ? Object.assign({}, tracks[id]) : null;
      },

      // 先読みしておく曲（再生中・スタンバイ・その先 count 曲）。
      preloadIds: function (count) {
        var ids = [];
        if (playingId) ids.push(playingId);
        var id = standbyId;
        var n = (count == null ? 2 : count) + 1;
        while (id !== null && n > 0) {
          if (ids.indexOf(id) < 0) ids.push(id);
          id = nextPlayableAfter(id);
          n--;
        }
        return ids;
      }
    };

    return api;
  }

  return { createEngine: createEngine, DEFAULTS: DEFAULTS };
});
