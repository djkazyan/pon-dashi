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

    function ensureContext() {
      if (!ctx) {
        var Ctor = root.AudioContext || root.webkitAudioContext;
        ctx = new Ctor({ latencyHint: 'interactive' });
        master = ctx.createGain();
        master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }

    // ファイルを最後まで展開する。壊れたファイル・非対応形式はここで失敗する。
    function decodeFile(file) {
      return file.arrayBuffer().then(function (data) {
        return ensureContext().decodeAudioData(data);
      });
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
      gain.connect(opts.output || master);
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
      return ensureContext().setSinkId(id);
    }

    return {
      ensureContext: ensureContext,
      decodeFile: decodeFile,
      analyze: analyze,
      play: play,
      createBus: createBus,
      setVoiceRange: setVoiceRange,
      setVocalLevel: setVocalLevel,
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
