/*
 * ポン出し — 再生エンジン（Web Audio API）
 *
 * ・曲はあらかじめメモリに展開しておき、GOの瞬間に音が出るようにする
 * ・原音には手を加えない（音量もそのまま）。出力デバイスのレートへの変換だけはブラウザが行う
 * ・即カットは約8ミリ秒で音量を落として止める（プチッというノイズを避けるため）
 */
(function (root) {
  'use strict';

  var CUT_SECONDS = 0.008;
  var SILENCE_THRESHOLD = 0.001; // 約 -60dBFS。これ以下を無音とみなす
  var WAVEFORM_BUCKETS = 2000;

  function createAudioEngine() {
    var ctx = null;
    var master = null;
    var pendingSink = null; // 音の系統を作る前に選ばれた出力（作った時に反映する）

    function ensureContext() {
      if (!ctx) {
        var Ctor = root.AudioContext || root.webkitAudioContext;
        ctx = new Ctor({ latencyHint: 'interactive' });
        master = ctx.createGain();
        master.connect(ctx.destination);
        if (pendingSink) { var sink = pendingSink; pendingSink = null; ctx.setSinkId(sink).catch(function () { /* 既定の出力のまま */ }); }
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }

    // ファイルを最後まで展開する。壊れたファイル・非対応形式はここで失敗する。
    function decodeFile(file) {
      return file.arrayBuffer().then(function (data) {
        // AIFF（音楽CDを Mac で開いた時の形式）はブラウザが読めないので、自前で読む
        var aiff = null;
        try { aiff = decodeAiff(data); } catch (e) { aiff = null; }
        if (aiff) return aiff;
        return ensureContext().decodeAudioData(data);
      });
    }

    // AIFF / AIFC（無圧縮）を AudioBuffer にする。AIFF でなければ null
    function decodeAiff(data) {
      if (data.byteLength < 54) return null;
      var v = new DataView(data);
      function tag(o) { return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3)); }
      if (tag(0) !== 'FORM') return null;
      var form = tag(8);
      if (form !== 'AIFF' && form !== 'AIFC') return null;
      var ch = 0, frames = 0, bits = 0, rate = 0, comp = 'NONE', dataStart = -1;
      var pos = 12;
      var end = Math.min(data.byteLength, 8 + v.getUint32(4));
      while (pos + 8 <= end) {
        var id = tag(pos);
        var size = v.getUint32(pos + 4);
        var body = pos + 8;
        if (id === 'COMM') {
          ch = v.getInt16(body);
          frames = v.getUint32(body + 2);
          bits = v.getInt16(body + 6);
          // 80ビットの浮動小数点（サンプリング周波数）
          var exp = ((v.getUint8(body + 8) & 0x7f) << 8) | v.getUint8(body + 9);
          var hi = v.getUint32(body + 10), lo = v.getUint32(body + 14);
          rate = (hi * 4294967296 + lo) * Math.pow(2, exp - 16383 - 63);
          if (form === 'AIFC' && size >= 22) comp = tag(body + 18);
        } else if (id === 'SSND') {
          dataStart = body + 8 + v.getUint32(body);
        }
        pos = body + size + (size & 1);
      }
      if (!ch || !rate || dataStart < 0) return null;
      var little = comp === 'sowt';
      var isFloat = comp === 'fl32' || comp === 'FL32';
      if (!(comp === 'NONE' || comp === 'twos' || little || isFloat)) throw new Error('この AIFF の圧縮形式（' + comp + '）には対応していません');
      if (isFloat) bits = 32;
      var bytes = bits <= 8 ? 1 : bits <= 16 ? 2 : bits <= 24 ? 3 : 4;
      var avail = Math.floor((data.byteLength - dataStart) / (bytes * ch));
      frames = Math.min(frames, avail);
      if (frames <= 0) return null;
      var buffer = ensureContext().createBuffer(ch, frames, Math.round(rate));
      var outs = [];
      for (var c = 0; c < ch; c++) outs.push(buffer.getChannelData(c));
      var o = dataStart;
      var u8 = new Uint8Array(data);
      for (var i = 0; i < frames; i++) {
        for (c = 0; c < ch; c++) {
          var x;
          if (isFloat) x = v.getFloat32(o, false);
          else if (bytes === 2) x = (little ? v.getInt16(o, true) : v.getInt16(o, false)) / 32768;
          else if (bytes === 3) {
            var n = little ? (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16)) : ((u8[o] << 16) | (u8[o + 1] << 8) | u8[o + 2]);
            if (n & 0x800000) n -= 0x1000000;
            x = n / 8388608;
          } else if (bytes === 1) x = v.getInt8(o) / 128;
          else x = (little ? v.getInt32(o, true) : v.getInt32(o, false)) / 2147483648;
          outs[c][i] = x;
          o += bytes;
        }
      }
      return buffer;
    }

    // 尺・頭と末尾の無音・波形を調べる。
    // 波形は低域（〜200Hz）・中域（200Hz〜2.5kHz）・高域（2.5kHz〜）に分けて、区間ごとの最大値を持つ。
    function analyze(buffer) {
      var length = buffer.length;
      var channels = buffer.numberOfChannels;
      var rate = buffer.sampleRate;
      var data = [];
      var first = -1;
      var last = -1;
      var c, i;

      for (c = 0; c < channels; c++) {
        var d = buffer.getChannelData(c);
        data.push(d);
        for (i = 0; i < length; i++) {
          if (d[i] > SILENCE_THRESHOLD || d[i] < -SILENCE_THRESHOLD) {
            if (first < 0 || i < first) first = i;
            break;
          }
        }
        for (i = length - 1; i >= 0; i--) {
          if (d[i] > SILENCE_THRESHOLD || d[i] < -SILENCE_THRESHOLD) {
            if (i > last) last = i;
            break;
          }
        }
      }

      var n = Math.max(1, Math.min(WAVEFORM_BUCKETS, length));
      var bucketSize = length / n;
      var peaks = new Float32Array(n);
      var low = new Float32Array(n);
      var mid = new Float32Array(n);
      var high = new Float32Array(n);
      var aLow = 1 - Math.exp(-2 * Math.PI * 200 / rate);
      var aHigh = 1 - Math.exp(-2 * Math.PI * 2500 / rate);
      // 1段だと分離が甘いので、同じフィルタを2段重ねる
      var yLow = 0, yLow2 = 0;
      var yHigh = 0, yHigh2 = 0;
      var peak = 0;
      var b = 0;
      var next = Math.floor(bucketSize);
      var mP = 0, mL = 0, mM = 0, mH = 0;
      var d0 = data[0];
      var d1 = channels > 1 ? data[1] : null;
      var inv = 1 / channels;

      for (i = 0; i < length; i++) {
        var x;
        if (channels === 1) x = d0[i];
        else if (channels === 2) x = (d0[i] + d1[i]) * 0.5;
        else { x = 0; for (c = 0; c < channels; c++) x += data[c][i]; x *= inv; }
        yLow += aLow * (x - yLow);
        yLow2 += aLow * (yLow - yLow2);
        yHigh += aHigh * (x - yHigh);
        yHigh2 += aHigh * (yHigh - yHigh2);
        var v = x < 0 ? -x : x;
        var lo = yLow2 < 0 ? -yLow2 : yLow2;
        var mi = yHigh2 - yLow2; if (mi < 0) mi = -mi;
        var hi = x - yHigh2; if (hi < 0) hi = -hi;
        if (v > mP) mP = v;
        if (lo > mL) mL = lo;
        if (mi > mM) mM = mi;
        if (hi > mH) mH = hi;
        if (i >= next - 1 || i === length - 1) {
          if (b < n) {
            peaks[b] = mP; low[b] = mL; mid[b] = mM; high[b] = mH;
            if (mP > peak) peak = mP;
          }
          b++;
          mP = mL = mM = mH = 0;
          next = Math.floor((b + 1) * bucketSize);
        }
      }

      var allSilent = first < 0;
      return {
        duration: buffer.duration,
        sampleRate: rate,
        channels: channels,
        allSilent: allSilent,
        // 頭の無音の長さ（秒）
        headSilence: allSilent ? buffer.duration : first / rate,
        // 実際に音が終わる位置（秒）。これ以降は無音
        audibleEnd: allSilent ? 0 : Math.min(buffer.duration, (last + 1) / rate),
        peak: peak,
        peaks: peaks,
        bands: [low, mid, high]
      };
    }

    // 再生開始。戻り値の voice で停止・位置取得を行う。
    function play(buffer, options) {
      var c = ensureContext();
      var opts = options || {};
      var offset = Math.max(0, Math.min(opts.offset || 0, buffer.duration));
      var source = c.createBufferSource();
      var gain = c.createGain();
      source.buffer = buffer;
      source.connect(gain);
      // 曲ごとの音量補正（オートゲイン）。フェード用の gain とは分けておく
      var trim = null;
      if (opts.trim != null && opts.trim !== 1) {
        trim = c.createGain();
        trim.gain.value = opts.trim;
        gain.connect(trim);
        trim.connect(opts.output || master);
      } else {
        gain.connect(opts.output || master);
      }
      var sources = [source];

      // ボーカル調整：分離したボーカルを、逆の向きで重ねて引く（量＝level、1でそのまま）
      var vocalGain = null;
      if (opts.vocal && opts.vocal.buffer) {
        var vsrc = c.createBufferSource();
        vocalGain = c.createGain();
        vsrc.buffer = opts.vocal.buffer;
        vocalGain.gain.value = vocalLevelToGain(opts.vocal.level);
        vsrc.connect(vocalGain);
        vocalGain.connect(gain);
        sources.push(vsrc);
      }

      // 再生範囲の終わり（end）とループ（loop: loopStart〜end を繰り返す）
      var end = opts.end != null ? Math.max(0, Math.min(opts.end, buffer.duration)) : buffer.duration;
      var voice = {
        source: source,
        sources: sources,
        vocalGain: vocalGain,
        gain: gain,
        trim: trim,
        output: opts.output || master,
        duration: buffer.duration,
        end: end,
        loop: !!opts.loop,
        loopStart: opts.loopStart || 0,
        loopEnd: end,
        offset: offset,
        startedAt: c.currentTime,
        stopped: false,   // こちらから止めた（自然終了ではない）
        finished: false
      };

      source.onended = function () {
        voice.finished = true;
        try { gain.disconnect(); } catch (e) { /* 既に切断済み */ }
        if (voice.trim) { try { voice.trim.disconnect(); } catch (e) { /* 既に切断済み */ } }
        if (voice.stopped) {
          if (voice.onStopped) voice.onStopped(voice);
        } else if (opts.onEnded) {
          opts.onEnded(voice);
        }
      };

      // 立ち上がりをなめらかにする（BGMの開始など）
      if (opts.fadeIn > 0) {
        gain.gain.setValueAtTime(0, c.currentTime);
        gain.gain.linearRampToValueAtTime(1, c.currentTime + opts.fadeIn);
      }
      sources.forEach(function (src) {
        if (voice.loop) {
          src.loop = true;
          src.loopStart = voice.loopStart;
          src.loopEnd = voice.loopEnd;
        }
        src.start(0, offset); // 同じ瞬間に始めるので、曲とボーカルの位置はぴったり揃う
        if (!voice.loop && end < buffer.duration) src.stop(c.currentTime + Math.max(0, end - offset));
      });
      if (!voice.loop && end >= buffer.duration && sources.length > 1) {
        // 曲の終わりでボーカル側も止める（長さがわずかに違っても、曲より後に鳴らない）
        sources[1].stop(c.currentTime + Math.max(0, buffer.duration - offset));
      }
      return voice;
    }

    // 音量をまとめて動かすための系統（SEなど）。全体の出力の手前に入る
    function createBus(value) {
      var c = ensureContext();
      var bus = c.createGain();
      bus.gain.value = value == null ? 1 : value;
      bus.connect(master);
      return bus;
    }

    // 即カット。
    function cut(voice) {
      if (!voice || voice.stopped || voice.finished) return;
      var c = ensureContext();
      var t = c.currentTime;
      voice.stopped = true;
      voice.gain.gain.cancelScheduledValues(t);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, t);
      voice.gain.gain.linearRampToValueAtTime(0, t + CUT_SECONDS);
      stopAll(voice, t + CUT_SECONDS + 0.002);
    }

    // フェードアウト。終わったら onDone を呼ぶ。途中で cut されたら onDone は呼ばない。
    function fade(voice, seconds, onDone) {
      if (!voice || voice.stopped || voice.finished) return;
      var c = ensureContext();
      var t = c.currentTime;
      var duration = Math.max(0.05, seconds);
      voice.fading = true;
      voice.gain.gain.cancelScheduledValues(t);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, t);
      voice.gain.gain.linearRampToValueAtTime(0, t + duration);
      voice.fadeTimer = setTimeout(function () {
        if (voice.stopped || voice.finished) return; // 途中で即カットされた、または曲が先に終わった
        voice.stopped = true;
        stopAll(voice);
        if (onDone) onDone(voice);
      }, duration * 1000);
    }

    // 再生位置（秒）。ループ中はループの範囲に折り返す
    function position(voice) {
      if (!voice || !ctx) return 0;
      var p = voice.offset + (ctx.currentTime - voice.startedAt);
      if (voice.loop && p > voice.loopEnd) {
        var len = voice.loopEnd - voice.loopStart;
        if (len > 0) p = voice.loopStart + ((p - voice.loopStart) % len);
      }
      return Math.max(0, Math.min(p, voice.duration));
    }

    // 再生中の音の範囲・ループを変える（範囲の変更やループの切替を、鳴らしたまま反映する）
    function setVoiceRange(voice, loop, start, end) {
      if (!voice || voice.stopped || voice.finished || !ctx) return;
      var pos = position(voice);
      voice.offset = pos;
      voice.startedAt = ctx.currentTime;
      voice.end = Math.min(end, voice.duration);
      voice.loopStart = start;
      voice.loopEnd = voice.end;
      voice.loop = !!loop;
      (voice.sources || [voice.source]).forEach(function (src) {
        try {
          if (voice.loop) {
            src.loopStart = start;
            src.loopEnd = voice.end;
            src.loop = true;
            src.stop(ctx.currentTime + 1e6); // 前に予約した「終わり」を取り消す
          } else {
            src.loop = false;
            src.stop(ctx.currentTime + Math.max(0, voice.end - pos));
          }
        } catch (e) { /* 既に止まっている */ }
      });
    }

    function stopAll(voice, when) {
      (voice.sources || [voice.source]).forEach(function (src) {
        try { if (when != null) src.stop(when); else src.stop(); } catch (e) { /* 既に停止 */ }
      });
    }

    // ボーカルの量（0〜1）→ 引く量。1＝何も引かない、0＝分離したボーカルを全部引く
    function vocalLevelToGain(level) {
      var l = level == null ? 1 : Math.max(0, Math.min(1, level));
      return l - 1;
    }

    // 再生中のボーカル量を変える（なめらかに）
    function setVocalLevel(voice, level) {
      if (!voice || !voice.vocalGain || !ctx) return false;
      var g = voice.vocalGain.gain;
      var t = ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(vocalLevelToGain(level), t + 0.08);
      return true;
    }

    // 再生中の曲の音量補正を変える（なめらかに）。補正なしで始めた音にも後から入れられる
    function setTrim(voice, value) {
      if (!voice || voice.stopped || voice.finished || !ctx) return false;
      var t = ctx.currentTime;
      if (!voice.trim) {
        if (value === 1) return true;
        var trim = ctx.createGain();
        trim.gain.value = 1;
        trim.connect(voice.output);
        try { voice.gain.disconnect(); } catch (e) { /* 切断済み */ }
        voice.gain.connect(trim);
        voice.trim = trim;
      }
      var g = voice.trim.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(value, t + 0.08);
      return true;
    }

    // ラウドネス（ITU-R BS.1770 / EBU R128 の統合ラウドネス、LUFS）とサンプルピークを測る。
    // K特性のフィルタ → 400ms ごと（100ms ずつずらす）の平均 → -70 LUFS と相対 -10 LU のゲート。
    // 画面が固まらないよう、少しずつ区切って計算する。
    function measureLoudness(buffer) {
      var rate = buffer.sampleRate;
      var length = buffer.length;
      var chs = Math.min(buffer.numberOfChannels, 2);
      // K特性 1段目（高域シェルフ）と2段目（ハイパス）。libebur128 と同じ式でサンプリング周波数に合わせる
      var f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
      var K = Math.tan(Math.PI * f0 / rate);
      var Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
      var a0 = 1 + K / Q + K * K;
      var pb0 = (Vh + Vb * K / Q + K * K) / a0, pb1 = 2 * (K * K - Vh) / a0, pb2 = (Vh - Vb * K / Q + K * K) / a0;
      var pa1 = 2 * (K * K - 1) / a0, pa2 = (1 - K / Q + K * K) / a0;
      f0 = 38.13547087602444; Q = 0.5003270373238773;
      K = Math.tan(Math.PI * f0 / rate);
      var ra1 = 2 * (K * K - 1) / (1 + K / Q + K * K), ra2 = (1 - K / Q + K * K) / (1 + K / Q + K * K);

      var seg = Math.max(1, Math.round(rate * 0.1)); // 100ms
      var segCount = Math.ceil(length / seg);
      var segPow = new Float64Array(segCount);
      var peak = 0;
      var CHUNK = Math.max(seg, Math.floor(1048576 / seg) * seg); // 約100万サンプルずつ

      return new Promise(function (resolve) {
        var c = 0, pos = 0;
        // 1段目：入力 x1,x2／出力 y1,y2。2段目：入力（=1段目の出力）y1,y2／出力 w1,w2
        var x1 = 0, x2 = 0, y1 = 0, y2 = 0, w1 = 0, w2 = 0;
        function step() {
          var d = buffer.getChannelData(c);
          var end = Math.min(length, pos + CHUNK);
          for (var i = pos; i < end; i++) {
            var x = d[i];
            var ax = x < 0 ? -x : x;
            if (ax > peak) peak = ax;
            var y = pb0 * x + pb1 * x1 + pb2 * x2 - pa1 * y1 - pa2 * y2;
            var w = y - 2 * y1 + y2 - ra1 * w1 - ra2 * w2; // 2段目は b = (1, -2, 1)
            x2 = x1; x1 = x; y2 = y1; y1 = y; w2 = w1; w1 = w;
            segPow[(i / seg) | 0] += w * w;
          }
          pos = end;
          if (pos >= length) {
            c++; pos = 0; x1 = x2 = y1 = y2 = w1 = w2 = 0;
            if (c >= chs) { resolve(finish()); return; }
          }
          setTimeout(step, 0);
        }
        setTimeout(step, 0);
      });

      function finish() {
        var peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
        if (segCount < 4) return { lufs: -Infinity, peakDb: peakDb };
        // モノラルは左右両方から同じ音が出るので、2チャンネル分として数える
        if (buffer.numberOfChannels === 1) for (var k = 0; k < segCount; k++) segPow[k] *= 2;
        var blocks = [];
        for (var b = 0; b + 4 <= segCount; b++) {
          var n = Math.min(4 * seg, length - b * seg);
          var p = (segPow[b] + segPow[b + 1] + segPow[b + 2] + segPow[b + 3]) / n;
          blocks.push(p);
        }
        function lufsOf(p) { return -0.691 + 10 * Math.log10(p); }
        var abs = blocks.filter(function (p) { return p > 0 && lufsOf(p) > -70; });
        if (!abs.length) return { lufs: -Infinity, peakDb: peakDb };
        var mean = abs.reduce(function (a, v) { return a + v; }, 0) / abs.length;
        var rel = lufsOf(mean) - 10;
        var gated = abs.filter(function (p) { return lufsOf(p) > rel; });
        var m2 = gated.reduce(function (a, v) { return a + v; }, 0) / gated.length;
        return { lufs: lufsOf(m2), peakDb: peakDb };
      }
    }

    // 分離に渡すため、44.1kHz・2ch に揃える
    function toStereo44k(buffer) {
      var rate = 44100;
      var length = Math.max(1, Math.round(buffer.duration * rate));
      var OfflineCtor = root.OfflineAudioContext || root.webkitOfflineAudioContext;
      var off = new OfflineCtor(2, length, rate);
      var src = off.createBufferSource();
      src.buffer = buffer;
      src.connect(off.destination); // モノラルは左右に同じ音で広がる
      src.start(0);
      return off.startRendering().then(function (out) {
        return { left: out.getChannelData(0), right: out.getChannelData(1), sampleRate: rate };
      });
    }

    // 16bit の WAV にまとめる（分離したボーカルの保存用）
    function encodeWav16(left, right, sampleRate) {
      var n = left.length;
      var buf = new ArrayBuffer(44 + n * 4);
      var v = new DataView(buf);
      function str(o, t) { for (var i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); }
      str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVE');
      str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
      v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
      str(36, 'data'); v.setUint32(40, n * 4, true);
      var o = 44;
      for (var i = 0; i < n; i++) {
        var a = Math.max(-1, Math.min(1, left[i]));
        var b = Math.max(-1, Math.min(1, right[i]));
        v.setInt16(o, a < 0 ? a * 32768 : a * 32767, true);
        v.setInt16(o + 2, b < 0 ? b * 32768 : b * 32767, true);
        o += 4;
      }
      return new Blob([buf], { type: 'audio/wav' });
    }

    // ----- 出力デバイス -----

    function canSelectOutput() {
      var Ctor = root.AudioContext || root.webkitAudioContext;
      return !!(Ctor && Ctor.prototype && typeof Ctor.prototype.setSinkId === 'function' &&
        root.navigator && root.navigator.mediaDevices && root.navigator.mediaDevices.enumerateDevices);
    }

    function listOutputs() {
      if (!canSelectOutput()) return Promise.resolve([]);
      return root.navigator.mediaDevices.enumerateDevices().then(function (devices) {
        return devices
          .filter(function (d) { return d.kind === 'audiooutput'; })
          .map(function (d) { return { id: d.deviceId, label: d.label }; });
      });
    }

    // デバイス名を表示するには、ブラウザの仕様上マイクの許可が一度必要。
    function requestDeviceNames() {
      return root.navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        stream.getTracks().forEach(function (t) { t.stop(); });
      });
    }

    function setOutput(deviceId) {
      if (!canSelectOutput()) return Promise.reject(new Error('この環境では出力デバイスを選べません'));
      var id = (!deviceId || deviceId === 'default') ? '' : deviceId;
      if (!ctx) { pendingSink = id || null; return Promise.resolve(); } // まだ鳴らしていなければ、鳴らす時に
      return ctx.setSinkId(id);
    }

    return {
      ensureContext: ensureContext,
      decodeFile: decodeFile,
      decodeAiff: decodeAiff,
      analyze: analyze,
      play: play,
      createBus: createBus,
      setVoiceRange: setVoiceRange,
      setVocalLevel: setVocalLevel,
      setTrim: setTrim,
      measureLoudness: measureLoudness,
      toStereo44k: toStereo44k,
      encodeWav16: encodeWav16,
      cut: cut,
      fade: fade,
      position: position,
      canSelectOutput: canSelectOutput,
      listOutputs: listOutputs,
      requestDeviceNames: requestDeviceNames,
      setOutput: setOutput,
      getSampleRate: function () { return ctx ? ctx.sampleRate : null; }
    };
  }

  root.PonAudioEngine = { createAudioEngine: createAudioEngine };
})(typeof self !== 'undefined' ? self : this);
