/*
 * ポン出し — 映像出力ウィンドウ
 * 本体のウィンドウから BroadcastChannel で指示を受けて、映像付きの曲の映像だけを出す（音は出さない）。
 * 音は本体が鳴らしているので、本体から届く再生位置に映像を合わせ続ける。
 *   play   { key, pos, sentAt }  … この曲の映像を pos 秒から出す
 *   sync   { key, pos, sentAt }  … 再生位置のお知らせ（ずれていたら直す）
 *   fade   { seconds }           … だんだん暗くして止める
 *   stop   {}                    … すぐ止めて、静止画（なければ黒）に戻す
 *   prepare{ key }               … 次に出しそうな曲の映像を先に読み込んでおく
 *   settings { delayMs }         … 映像を早める量
 *   still  {}                    … 静止画が変わった
 */
(function () {
  'use strict';

  var ch = new BroadcastChannel('pon-video');
  var video = document.getElementById('video');
  var still = document.getElementById('still');
  var store = window.PonStore;
  if (/preview/.test(location.hash)) document.body.classList.add('is-preview');

  var loadedKey = null;   // video に読み込んである曲
  var loadingKey = null;
  var loadPromise = null;
  var playingKey = null;  // いま映している曲
  var delay = 0;          // 映像を早める秒数（モニターの遅れの分）
  var fadeTimer = null;
  var urls = {};
  var seekLag = 0.15;     // 飛んでから映像が出るまでにかかる時間（実測で更新）
  var seeking = false;

  // 指定の位置へ飛ぶ。飛ぶのにかかる時間の分だけ先へ飛んでおく
  function jump(t) {
    var started = performance.now();
    seeking = true;
    video.playbackRate = 1;
    video.currentTime = Math.max(0, t + seekLag);
    video.addEventListener('seeked', function once() {
      video.removeEventListener('seeked', once);
      seeking = false;
      var took = (performance.now() - started) / 1000;
      seekLag = Math.max(0.03, Math.min(0.6, seekLag * 0.5 + took * 0.5));
    });
  }

  function setDelay(ms) {
    var n = Number(ms);
    delay = isFinite(n) ? n / 1000 : 0;
  }
  try { setDelay(localStorage.getItem('pon.videoDelayMs') || 0); } catch (e) { /* 既定 0 */ }

  function load(key) {
    if (loadedKey === key && !loadingKey) return Promise.resolve(true);
    if (loadingKey === key && loadPromise) return loadPromise;
    loadingKey = key;
    loadPromise = store.getFile(key).then(function (file) {
      if (loadingKey !== key) return false;
      if (!file) { loadingKey = null; return false; }
      Object.keys(urls).forEach(function (k) { if (k !== key) { URL.revokeObjectURL(urls[k]); delete urls[k]; } });
      urls[key] = urls[key] || URL.createObjectURL(file);
      return new Promise(function (resolve) {
        function done(ok) {
          video.removeEventListener('loadeddata', onOk);
          video.removeEventListener('error', onErr);
          if (loadingKey === key) { loadingKey = null; loadedKey = ok ? key : null; }
          resolve(ok);
        }
        function onOk() { done(true); }
        function onErr() { done(false); }
        video.addEventListener('loadeddata', onOk);
        video.addEventListener('error', onErr);
        video.src = urls[key];
        video.load();
      });
    }, function () { loadingKey = null; return false; });
    return loadPromise;
  }

  function target(msg) {
    return msg.pos + Math.max(0, (Date.now() - msg.sentAt) / 1000) + delay;
  }

  function showVideo(on) {
    clearTimeout(fadeTimer);
    video.style.transition = 'none';
    video.classList.toggle('is-on', on);
    still.style.display = on || !still.getAttribute('src') ? 'none' : 'block';
  }

  function play(msg) {
    playingKey = msg.key;
    load(msg.key).then(function (ok) {
      if (playingKey !== msg.key) return;
      if (!ok || !video.videoWidth) { stop(); return; } // 映像が入っていない・読めない形式
      var t = target(msg);
      if (t >= video.duration) { stop(); return; }
      jump(t);
      showVideo(true);
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    });
  }

  function sync(msg) {
    if (msg.key !== playingKey || loadedKey !== msg.key || video.paused) {
      if (msg.key !== playingKey || (loadedKey === msg.key && video.paused)) play(msg);
      return;
    }
    if (seeking) return;
    var t = target(msg);
    var drift = video.currentTime - t;
    if (Math.abs(drift) > 0.25) {
      jump(t); // 大きくずれた（再生位置の移動・ループ）→ 飛ぶ
    } else if (Math.abs(drift) > 0.03) {
      video.playbackRate = Math.max(0.9, Math.min(1.1, 1 - drift)); // 少しずれた → 速さで寄せる
    } else {
      video.playbackRate = 1;
    }
  }

  function stop() {
    playingKey = null;
    video.pause();
    showVideo(false);
  }

  function fade(seconds) {
    if (!playingKey) return;
    clearTimeout(fadeTimer);
    video.style.transition = 'opacity ' + seconds + 's linear';
    video.classList.remove('is-on');
    fadeTimer = setTimeout(stop, seconds * 1000);
  }

  function loadStill() {
    store.getFile('video-still').then(function (file) {
      if (still.dataset.url) URL.revokeObjectURL(still.dataset.url);
      if (file) {
        var u = URL.createObjectURL(file);
        still.dataset.url = u;
        still.setAttribute('src', u);
      } else {
        still.removeAttribute('src');
        delete still.dataset.url;
      }
      if (!playingKey) showVideo(false);
    }, function () {});
  }

  ch.onmessage = function (e) {
    var m = e.data || {};
    if (m.type === 'play') play(m);
    else if (m.type === 'sync') sync(m);
    else if (m.type === 'stop') stop();
    else if (m.type === 'fade') fade(m.seconds || 3);
    else if (m.type === 'prepare') { if (!playingKey && m.key) load(m.key); }
    else if (m.type === 'settings') setDelay(m.delayMs);
    else if (m.type === 'still') loadStill();
  };

  window.__ponVideo = { video: video, state: function () { return { playingKey: playingKey, loadedKey: loadedKey, delay: delay, on: video.classList.contains('is-on') }; } };
  loadStill();
  ch.postMessage({ type: 'hello' }); // 開いた時に、本体からいまの状態を送ってもらう
})();
