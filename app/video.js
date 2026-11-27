/*
 * ポン出し — 映像出力ウィンドウ
 * 本体のウィンドウから BroadcastChannel で指示を受けて、外部モニターに「映像・ロゴ・黒」を出す（音は出さない）。
 * 切り替えはすべて2秒のフェード（Ver. 0.11.0）。
 *   scene { mode: 'video' | 'image' | 'black', key, pos, sentAt, image, fade }
 *          … video：曲 key の映像を pos 秒から ／ image：画像 image（保存領域のキー）を ／ black：黒
 *   sync   { key, pos, sentAt }  … 映像の再生位置のお知らせ（ずれていたら直す）
 *   prepare{ key }               … 次に出しそうな曲の映像を先に読み込んでおく
 *   images { key }               … 画像が差し替わった（読み直す）
 *   settings { delayMs }         … 映像を早める量
 */
(function () {
  'use strict';

  var ch = new BroadcastChannel('pon-video');
  var video = document.getElementById('video');
  var imgs = [document.getElementById('imgA'), document.getElementById('imgB')];
  var store = window.PonStore;
  if (/preview/.test(location.hash)) document.body.classList.add('is-preview');

  var FADE = 2;           // 切り替えの秒数
  var loadedKey = null;   // video に読み込んである曲
  var loadingKey = null;
  var loadPromise = null;
  var playingKey = null;  // いま映している（映そうとしている）曲
  var delay = 0;          // 映像を早める秒数（モニターの遅れの分）
  var urls = {};          // 曲の映像
  var imageUrls = {};     // 画像（キー → URL）
  var seekLag = 0.15;     // 飛んでから映像が出るまでにかかる時間（実測で更新）
  var seeking = false;
  var token = 0;          // 最後に受けた場面の番号（読み込み待ちの間に場面が変わったら捨てる）
  var scene = { mode: 'black' };
  var pauseTimer = null;

  function setFade(seconds) {
    FADE = seconds == null ? 2 : Math.max(0, seconds);
    [video, imgs[0], imgs[1]].forEach(function (el) { el.style.transitionDuration = FADE + 's'; });
  }
  setFade(2);

  function layerOn(el, on) { el.classList.toggle('is-on', !!on); }
  function isOn(el) { return el.classList.contains('is-on'); }

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

  function imageUrl(key) {
    if (imageUrls[key]) return Promise.resolve(imageUrls[key]);
    return store.getFile(key).then(function (file) {
      if (!file) return null;
      imageUrls[key] = URL.createObjectURL(file);
      return imageUrls[key];
    }, function () { return null; });
  }

  function target(msg) {
    return msg.pos + Math.max(0, (Date.now() - msg.sentAt) / 1000) + delay;
  }

  // 映像を消す（フェードが終わったら止める）
  function hideVideo() {
    if (!isOn(video)) { if (!playingKey) video.pause(); return; }
    layerOn(video, false);
    clearTimeout(pauseTimer);
    pauseTimer = setTimeout(function () { if (!isOn(video)) video.pause(); }, FADE * 1000 + 50);
  }

  function hideImages(except) {
    imgs.forEach(function (el) { if (el !== except) layerOn(el, false); });
  }

  function toBlack(my) {
    playingKey = null;
    hideVideo();
    hideImages(null);
  }

  function toImage(my, key) {
    playingKey = null;
    var showing = imgs.filter(function (el) { return isOn(el) && el.dataset.key === key; })[0];
    if (showing) { hideImages(showing); hideVideo(); return; }
    imageUrl(key).then(function (url) {
      if (my !== token) return;
      if (!url) { toBlack(my); return; }
      // 見えていない方の画像の層に読み込んで、フェードで入れ替える
      var el = isOn(imgs[0]) ? imgs[1] : imgs[0];
      el.onload = function () {
        el.onload = null;
        if (my !== token) return;
        el.dataset.key = key;
        layerOn(el, true);
        hideImages(el);
        hideVideo();
      };
      el.onerror = function () { el.onerror = null; if (my === token) toBlack(my); };
      el.src = url;
    });
  }

  function toVideo(my, msg) {
    playingKey = msg.key;
    load(msg.key).then(function (ok) {
      if (my !== token || playingKey !== msg.key) return;
      if (!ok || !video.videoWidth) { toBlack(my); return; } // 映像が入っていない・読めない形式
      var t = target(msg);
      if (t >= video.duration) { toBlack(my); return; }
      clearTimeout(pauseTimer);
      jump(t);
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
      layerOn(video, true);
      hideImages(null);
    });
  }

  function applyScene(msg) {
    var my = ++token;
    setFade(msg.fade);
    scene = msg;
    if (msg.mode === 'video' && msg.key) toVideo(my, msg);
    else if (msg.mode === 'image' && msg.image) toImage(my, msg.image);
    else toBlack(my);
  }

  function sync(msg) {
    if (scene.mode !== 'video' || msg.key !== playingKey) return;
    if (loadedKey !== msg.key || video.paused) {
      if (loadedKey === msg.key && video.paused && !video.ended) applyScene(Object.assign({}, scene, { pos: msg.pos, sentAt: msg.sentAt }));
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

  ch.onmessage = function (e) {
    var m = e.data || {};
    if (m.type === 'scene') applyScene(m);
    else if (m.type === 'sync') sync(m);
    else if (m.type === 'prepare') { if (!playingKey && !isOn(video) && m.key) load(m.key); } // フェード中の映像は入れ替えない
    else if (m.type === 'settings') setDelay(m.delayMs);
    else if (m.type === 'images') {
      // 画像が差し替わった：覚えている URL を捨てる。いま出している画像なら出し直す
      var k = m.key;
      if (imageUrls[k]) { URL.revokeObjectURL(imageUrls[k]); delete imageUrls[k]; }
      imgs.forEach(function (el) { if (el.dataset.key === k) el.dataset.key = ''; });
      if (scene.mode === 'image' && scene.image === k) applyScene(scene);
    }
  };

  window.__ponVideo = {
    video: video,
    state: function () {
      var img = imgs.filter(isOn)[0];
      return {
        scene: scene.mode, playingKey: playingKey, loadedKey: loadedKey, delay: delay,
        on: isOn(video), image: img ? img.dataset.key : null, fade: FADE
      };
    }
  };
  ch.postMessage({ type: 'hello' }); // 開いた時に、本体からいまの状態を送ってもらう
})();
