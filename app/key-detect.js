/*
 * ポン出し — 曲のキー（調）の推定（Ver. 0.12.0）
 *
 * ・曲の中で12音（C, C♯, D …）がどれくらい鳴っているか（クロマ）を集計し、
 *   24のキー（メジャー12・マイナー12）の典型的な形と比べて一番近いものを選ぶ
 * ・8秒ずつの区間でもキーを出し、急に行ったり来たりしないようにまとめて「転調」を見つける
 * ・平行調（C と Am など）は使う7音が同じなので、取り違えてもオートチューンのスケールは同じ
 * ・画面が固まらないよう、区切って計算する
 */
(function (root) {
  'use strict';

  var TARGET_RATE = 11025;   // ここまで落としてから計算する（約5.5kHzまでの音で十分）
  var FFT_SIZE = 4096;
  var HOP = 2048;
  var MIN_HZ = 65;           // C2 あたりから
  var MAX_HZ = 2100;         // C7 あたりまで
  var WIN_SEC = 8;           // 区間ごとのキーを出す長さ
  var WIN_HOP_SEC = 4;
  var MIN_SEGMENT_SEC = 20;  // これより短いキーの区間は前後にまとめる（ブリッジの一時的な借用和音などを転調と言わないため）
  var SWITCH_PENALTY = 0.35; // キーを切り替える時の罰（大きいほど転調と言いにくい）
  var BASS_HZ = 260;         // これより低い音をベースとして見る（メジャー／マイナーの判断に使う）
  var BASS_WEIGHT = 0.6;

  // キーの典型的な形（Temperley / Kostka-Payne の値）
  var MAJOR = [0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400];
  var MINOR = [0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330];

  var SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  var FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
  // キーの名前（メジャーは C, D♭, D, E♭, E, F, F♯, G, A♭, A, B♭, B ／ マイナーは Cm, C♯m, Dm, E♭m, Em, Fm, F♯m, Gm, G♯m, Am, B♭m, Bm）
  var MAJOR_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  var MINOR_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];
  // ♭で書くキー（それ以外は♯）
  var FLAT_MAJOR = { 1: 1, 3: 1, 5: 1, 8: 1, 10: 1 };      // D♭ E♭ F A♭ B♭
  var FLAT_MINOR = { 0: 1, 2: 1, 3: 1, 5: 1, 7: 1, 10: 1 }; // Cm Dm E♭m Fm Gm B♭m

  // index：0〜11 がメジャー（C〜B）、12〜23 がマイナー（Cm〜Bm）
  function keyName(index) {
    var tonic = index % 12;
    return index < 12 ? MAJOR_NAMES[tonic] : MINOR_NAMES[tonic] + 'm';
  }

  function keyLabel(index) {
    return index < 12 ? keyName(index) + ' メジャー' : keyName(index).replace(/m$/, '') + ' マイナー';
  }

  // 同じ7音を使うキー（平行調）
  function relativeOf(index) {
    return index < 12 ? 12 + (index + 9) % 12 : (index - 12 + 3) % 12;
  }

  // スケールの7音（キーに合わせて♯か♭で書く）
  function scaleNotes(index) {
    var tonic = index % 12;
    var minor = index >= 12;
    var flat = minor ? !!FLAT_MINOR[tonic] : !!FLAT_MAJOR[tonic];
    var steps = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    var names = flat ? FLAT_NAMES : SHARP_NAMES;
    return steps.map(function (s) { return names[(tonic + s) % 12]; });
  }

  // ---- 計算の部品 ----
  function fft(re, im) {
    var n = re.length;
    for (var i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = -2 * Math.PI / len;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      for (var k = 0; k < n; k += len) {
        var cr = 1, ci = 0;
        for (var m = 0; m < len / 2; m++) {
          var a = k + m, b = a + len / 2;
          var xr = re[b] * cr - im[b] * ci;
          var xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          var ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  // モノラルにして TARGET_RATE 付近まで間引く（間引く前に平均して高い音を落とす）
  function downmix(buffer) {
    var rate = buffer.sampleRate;
    var step = Math.max(1, Math.round(rate / TARGET_RATE));
    var n = Math.floor(buffer.length / step);
    var out = new Float32Array(n);
    var chs = Math.min(2, buffer.numberOfChannels);
    for (var c = 0; c < chs; c++) {
      var d = buffer.getChannelData(c);
      for (var i = 0; i < n; i++) {
        var sum = 0, base = i * step;
        for (var k = 0; k < step; k++) sum += d[base + k] || 0;
        out[i] += sum / step / chs;
      }
    }
    return { data: out, rate: rate / step };
  }

  function correlate(chroma, profile, shift) {
    var mx = 0, my = 0, i;
    for (i = 0; i < 12; i++) { mx += chroma[i]; my += profile[i]; }
    mx /= 12; my /= 12;
    var num = 0, dx = 0, dy = 0;
    for (i = 0; i < 12; i++) {
      var x = chroma[(i + shift) % 12] - mx;
      var y = profile[i] - my;
      num += x * y; dx += x * x; dy += y * y;
    }
    return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
  }

  function keyScores(chroma) {
    var s = new Array(24);
    for (var k = 0; k < 12; k++) {
      s[k] = correlate(chroma, MAJOR, k);
      s[k + 12] = correlate(chroma, MINOR, k);
    }
    return s;
  }

  function best(scores) {
    var b = 0;
    for (var i = 1; i < scores.length; i++) if (scores[i] > scores[b]) b = i;
    return b;
  }

  // 区間ごとのキーを、切り替えに罰を付けて一番自然な並びにする（ビタビ）
  function smoothPath(winScores) {
    var n = winScores.length;
    if (!n) return [];
    var cost = winScores[0].slice();
    var back = [];
    for (var t = 1; t < n; t++) {
      var prevBest = best(cost);
      var nc = new Array(24), bk = new Array(24);
      for (var k = 0; k < 24; k++) {
        // 同じ7音のキー（平行調）への切り替えは、転調ではないので軽くする
        var stay = cost[k];
        var move = cost[prevBest] - (relativeOf(prevBest) === k ? SWITCH_PENALTY * 0.3 : SWITCH_PENALTY);
        if (stay >= move) { nc[k] = stay + winScores[t][k]; bk[k] = k; } else { nc[k] = move + winScores[t][k]; bk[k] = prevBest; }
      }
      cost = nc; back.push(bk);
    }
    var path = new Array(n);
    path[n - 1] = best(cost);
    for (t = n - 2; t >= 0; t--) path[t] = back[t][path[t + 1]];
    return path;
  }

  // 同じ7音のキー（平行調）は同じ「調号」として扱う
  function family(index) { return index < 12 ? index : relativeOf(index); }

  function segmentsFrom(path, winStarts, duration, globalKey) {
    var segs = [];
    for (var i = 0; i < path.length; i++) {
      var k = family(path[i]) === family(globalKey) ? globalKey : path[i];
      var last = segs[segs.length - 1];
      if (last && family(last.key) === family(k)) continue;
      segs.push({ start: i === 0 ? 0 : winStarts[i] + WIN_SEC / 2 - WIN_HOP_SEC / 2, key: k });
    }
    // 短すぎる区間は前（なければ後ろ）にまとめる
    var changed = true;
    while (changed && segs.length > 1) {
      changed = false;
      for (var j = 0; j < segs.length; j++) {
        var end = j + 1 < segs.length ? segs[j + 1].start : duration;
        if (end - segs[j].start < MIN_SEGMENT_SEC) {
          if (j > 0) segs.splice(j, 1); else { segs[1].start = 0; segs.splice(0, 1); }
          changed = true;
          break;
        }
      }
      // まとめた結果、隣が同じキーになったらつなぐ
      for (var q = segs.length - 1; q > 0; q--) if (family(segs[q].key) === family(segs[q - 1].key)) segs.splice(q, 1);
    }
    return segs;
  }

  // AudioBuffer（または同じ形のもの）からキーを推定する
  // 戻り値：{ key, label, name, relative, scale, confidence, segments: [{ start, key, name }] }
  function analyze(buffer, opts) {
    opts = opts || {};
    var yieldEvery = opts.sync ? Infinity : 40;
    var mono = downmix(buffer);
    var x = mono.data, rate = mono.rate;
    var frames = Math.max(0, Math.floor((x.length - FFT_SIZE) / HOP) + 1);
    // ビンごとの音名（-1 は使わない）
    var binPc = new Int8Array(FFT_SIZE / 2);
    var binW = new Float32Array(FFT_SIZE / 2);
    for (var b = 1; b < FFT_SIZE / 2; b++) {
      var f = b * rate / FFT_SIZE;
      if (f < MIN_HZ || f > MAX_HZ) { binPc[b] = -1; continue; }
      var midi = 69 + 12 * Math.log2(f / 440);
      var near = Math.round(midi);
      binPc[b] = ((near % 12) + 12) % 12;
      binW[b] = Math.max(0, 1 - Math.abs(midi - near) * 2); // 音の真ん中に近いビンほど重く
    }
    var hann = new Float32Array(FFT_SIZE);
    for (var h = 0; h < FFT_SIZE; h++) hann[h] = 0.5 - 0.5 * Math.cos(2 * Math.PI * h / (FFT_SIZE - 1));
    var frameChroma = new Array(frames);
    var re = new Float32Array(FFT_SIZE), im = new Float32Array(FFT_SIZE);

    function frame(fi) {
      var off = fi * HOP;
      for (var i = 0; i < FFT_SIZE; i++) { re[i] = x[off + i] * hann[i]; im[i] = 0; }
      fft(re, im);
      var c = new Float32Array(12);
      var bass = new Float32Array(12);
      var total = 0;
      for (var b2 = 1; b2 < FFT_SIZE / 2; b2++) {
        var pc = binPc[b2];
        if (pc < 0) continue;
        var mag = Math.sqrt(re[b2] * re[b2] + im[b2] * im[b2]);
        var v = Math.sqrt(mag) * binW[b2]; // 大きい音だけに引っ張られず、倍音にも引っ張られすぎないよう平方根で
        c[pc] += v; total += v;
        if (b2 * rate / FFT_SIZE < BASS_HZ) bass[pc] += v;
      }
      if (total > 0) for (var p = 0; p < 12; p++) { c[p] /= total; bass[p] /= total; }
      frameChroma[fi] = { c: c, bass: bass, energy: total };
    }

    function finish() {
      var duration = buffer.length / buffer.sampleRate;
      if (!frames) return null;
      // ほぼ無音のフレームは数えない
      var energies = frameChroma.map(function (fc) { return fc.energy; }).sort(function (a, b) { return a - b; });
      var floor = energies[Math.floor(energies.length * 0.1)] * 0.5;
      var whole = new Float32Array(12);
      var wholeBass = new Float32Array(12);
      var used = 0;
      frameChroma.forEach(function (fc) {
        if (fc.energy <= floor) return;
        for (var p = 0; p < 12; p++) { whole[p] += fc.c[p]; wholeBass[p] += fc.bass[p]; }
        used++;
      });
      if (!used) return null;
      var scores = keyScores(whole);
      var bassScores = keyScores(wholeBass);
      var globalKey = best(scores);
      // メジャーか、同じ7音のマイナーか：ベース（低音）がどちらの主音を支えているかで決める
      function modeOf(k) {
        var r = relativeOf(k);
        return scores[r] + BASS_WEIGHT * bassScores[r] > scores[k] + BASS_WEIGHT * bassScores[k] ? r : k;
      }
      globalKey = modeOf(globalKey);

      var sorted = scores.slice().sort(function (a, b) { return b - a; });
      // 2番目（平行調を除く）との差を、確からしさの目安にする
      var second = -1;
      for (var s = 0; s < 24; s++) if (s !== globalKey && s !== relativeOf(globalKey) && (second < 0 || scores[s] > scores[second])) second = s;
      var confidence = Math.max(0, Math.min(1, (scores[globalKey] - scores[second]) * 4));
      // 区間ごと
      var winFrames = Math.max(1, Math.round(WIN_SEC * rate / HOP));
      var hopFrames = Math.max(1, Math.round(WIN_HOP_SEC * rate / HOP));
      var winScores = [], winStarts = [];
      for (var w = 0; w + winFrames <= frames || (w === 0 && frames > 0); w += hopFrames) {
        var sum = new Float32Array(12), cnt = 0;
        for (var fi2 = w; fi2 < Math.min(frames, w + winFrames); fi2++) {
          var fc2 = frameChroma[fi2];
          if (fc2.energy <= floor) continue;
          for (var p2 = 0; p2 < 12; p2++) sum[p2] += fc2.c[p2];
          cnt++;
        }
        if (cnt < winFrames * 0.3) { // ほとんど無音の区間は、直前のキーのままとみなす
          winScores.push(winScores.length ? winScores[winScores.length - 1] : scores);
        } else {
          winScores.push(keyScores(sum));
        }
        winStarts.push(w * HOP / rate);
        if (w + winFrames > frames) break;
      }
      var path = smoothPath(winScores);
      var segs = segmentsFrom(path, winStarts, duration, globalKey);
      // 一番長い区間のキーを、曲のキーにする
      var longest = globalKey, longestLen = -1;
      segs.forEach(function (sg, i) {
        var len = (i + 1 < segs.length ? segs[i + 1].start : duration) - sg.start;
        if (len > longestLen) { longestLen = len; longest = sg.key; }
      });
      if (family(longest) !== family(globalKey)) globalKey = modeOf(longest);
      segs.forEach(function (sg) { if (family(sg.key) === family(globalKey)) sg.key = globalKey; });
      return describe(globalKey, confidence, segs.map(function (sg) { return { start: Math.round(sg.start * 10) / 10, key: sg.key }; }));
    }

    return new Promise(function (resolve, reject) {
      var fi = 0;
      function step() {
        try {
          var stop = Math.min(frames, fi + yieldEvery);
          for (; fi < stop; fi++) frame(fi);
          if (fi < frames) { setTimeout(step, 0); return; }
          resolve(finish());
        } catch (err) { reject(err); }
      }
      if (opts.sync) step(); else setTimeout(step, 0);
    });
  }

  function describe(key, confidence, segments) {
    return {
      key: key,
      name: keyName(key),
      label: keyLabel(key),
      relative: keyName(relativeOf(key)),
      scale: scaleNotes(key),
      confidence: Math.round((confidence == null ? 1 : confidence) * 100) / 100,
      segments: (segments || [{ start: 0, key: key }]).map(function (s) { return { start: s.start, key: s.key, name: keyName(s.key) }; })
    };
  }

  var api = {
    analyze: analyze,
    describe: describe,
    keyName: keyName,
    keyLabel: keyLabel,
    relativeOf: relativeOf,
    scaleNotes: scaleNotes
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PonKey = api;
})(typeof self !== 'undefined' ? self : this);
