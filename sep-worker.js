// ボーカル分離（別スレッドで動かす。画面や音を止めないため）
// モデル：HT-Demucs FT のボーカル専用モデル（ONNX、MIT）。44.1kHz・2ch・7.8秒ずつ、1/4 重ねて処理する
'use strict';
// アプリでは別のプロセス（utilityProcess）で動かす。GPU の部品が落ちても、アプリ本体は落ちないように。
// 古い呼び方（worker_threads）でも動くようにしておく
const wt = require('worker_threads');
const utilityPort = process.parentPort || null;
const workerData = wt.workerData || { modelPath: process.argv[2] };
const parentPort = utilityPort ? {
  postMessage: (msg) => utilityPort.postMessage(msg),
  on: (ev, fn) => utilityPort.on(ev, (e) => fn(e.data))
} : wt.parentPort;
const os = require('os');

const SEG = 343980;            // 7.8秒 × 44100
const OVERLAP = SEG >> 2;
const STRIDE = SEG - OVERLAP;
const VOCALS = 3;              // 出力の並び：drums, bass, other, vocals

let ort = null;
const sessions = {};           // 'cpu' / 'gpu' -> InferenceSession
const gpuBroken = { flag: false, reason: '' }; // 一度 GPU で失敗したら、この起動中は CPU だけにする
let cancelled = {};

// GPU で動かす仕組み：Mac は CoreML（GPU・Neural Engine）、Windows は DirectML（DirectX 12 のグラボ）
function gpuProvider() {
  // テスト用：GPU が使えない時の動き（CPU に戻る）を確かめる
  if (process.env.PON_FAKE_GPU) return { label: 'GPU（テスト）', providers: [{ name: process.env.PON_FAKE_GPU }, 'cpu'] };
  if (process.platform === 'darwin') {
    // 0x010 = ML Program 形式（対応する計算が多い）、0x008 = 入力の形は固定
    return { label: 'GPU（CoreML）', providers: [{ name: 'coreml', coreMlFlags: 0x010 | 0x008 }, 'cpu'] };
  }
  if (process.platform === 'win32') {
    return { label: 'GPU（DirectML）', providers: [{ name: 'dml' }, 'cpu'] };
  }
  return null;
}

async function getSession(kind) {
  if (sessions[kind]) return sessions[kind];
  ort = ort || require('onnxruntime-node');
  const threads = Math.max(1, Math.min(8, os.cpus().length - 2)); // 2コアは音と画面のために空けておく
  const opts = {
    graphOptimizationLevel: 'disabled', // 最適化をかけるとメモリを使いすぎる（8GBのMacでも落ちる）
    enableCpuMemArena: false,
    intraOpNumThreads: threads
  };
  if (kind === 'gpu') {
    const g = gpuProvider();
    opts.executionProviders = g.providers;
    opts.enableMemPattern = false;     // DirectML の決まり
    opts.executionMode = 'sequential';
  } else {
    opts.executionProviders = ['cpu'];
  }
  sessions[kind] = await ort.InferenceSession.create(workerData.modelPath, opts);
  return sessions[kind];
}

async function dropSession(kind) {
  const s = sessions[kind];
  delete sessions[kind];
  if (s && s.release) { try { await s.release(); } catch (e) { /* 手放し済み */ } }
}

// GPU の結果がおかしくないか（NaN・極端な値）
function looksBroken(data, base, len) {
  for (let i = 0; i < len; i += 97) {
    const v = data[base + i];
    if (!(v === v) || v > 64 || v < -64) return true;
  }
  return false;
}

function makeWindow() {
  const w = new Float32Array(SEG).fill(1);
  for (let i = 0; i < OVERLAP; i++) {
    const v = i / (OVERLAP - 1);
    w[i] = v;
    w[SEG - 1 - i] = v;
  }
  return w;
}

async function separate(job) {
  const left = job.left;
  const right = job.right;
  const n = left.length;
  const started = Date.now();
  let kind = job.device === 'gpu' && gpuProvider() && !gpuBroken.flag ? 'gpu' : 'cpu';
  let fellBack = job.device === 'gpu' && gpuBroken.flag ? '前に GPU を使えなかったため、CPU で分けました' : '';
  let sess = null;
  if (kind === 'gpu') {
    try {
      sess = await getSession('gpu');
    } catch (err) {
      gpuBroken.flag = true; gpuBroken.reason = String((err && err.message) || err);
      fellBack = 'GPU を使えなかったため CPU で分けました';
      await dropSession('gpu');
      kind = 'cpu';
    }
  }
  if (!sess) sess = await getSession('cpu');
  const prepMs = Date.now() - started;
  const win = makeWindow();
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const wsum = new Float32Array(n);
  const chunks = Math.max(1, Math.ceil(n / STRIDE));
  const input = new Float32Array(2 * SEG);
  for (let k = 0; k < chunks; k++) {
    if (cancelled[job.id]) throw new Error('cancelled');
    const s = k * STRIDE;
    const e = Math.min(s + SEG, n);
    const len = e - s;
    input.fill(0);
    input.set(left.subarray(s, e), 0);
    input.set(right.subarray(s, e), SEG);
    const base = VOCALS * 2 * SEG;
    let st = null;
    if (kind === 'gpu' && process.env.PON_FAKE_GPU === 'crash' && k === 1) process.exit(9); // テスト用：GPU の部品が落ちた時
    if (kind === 'gpu') {
      try {
        st = (await sess.run({ mix: new ort.Tensor('float32', input, [1, 2, SEG]) })).stems.data;
        if (looksBroken(st, base, len) || looksBroken(st, base + SEG, len)) throw new Error('GPU の計算結果が正しくありません');
      } catch (err) {
        // GPU で失敗したら、この区間から CPU に切り替えて続ける（分離は止めない）
        gpuBroken.flag = true; gpuBroken.reason = String((err && err.message) || err);
        fellBack = 'GPU で失敗したため、途中から CPU で分けました';
        await dropSession('gpu');
        kind = 'cpu';
        sess = await getSession('cpu');
        st = null;
      }
    }
    if (!st) st = (await sess.run({ mix: new ort.Tensor('float32', input, [1, 2, SEG]) })).stems.data;
    for (let i = 0; i < len; i++) {
      const w = win[i];
      outL[s + i] += st[base + i] * w;
      outR[s + i] += st[base + SEG + i] * w;
      wsum[s + i] += w;
    }
    parentPort.postMessage({ type: 'progress', id: job.id, done: k + 1, total: chunks });
  }
  for (let i = 0; i < n; i++) {
    const w = wsum[i] > 1e-8 ? wsum[i] : 1e-8;
    outL[i] /= w;
    outR[i] /= w;
  }
  const g = gpuProvider();
  return {
    left: outL, right: outR,
    stats: { device: kind === 'gpu' ? (g ? g.label : 'GPU') : 'CPU', ms: Date.now() - started, prepMs, fellBack, seconds: n / 44100 }
  };
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'cancel') {
    cancelled[msg.id] = true;
    return;
  }
  if (msg.type !== 'separate') return;
  try {
    const out = await separate(msg);
    parentPort.postMessage({ type: 'done', id: msg.id, left: out.left, right: out.right, stats: out.stats }, [out.left.buffer, out.right.buffer]);
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: cancelled[msg.id] ? 'cancelled' : String((err && err.message) || err) });
  } finally {
    delete cancelled[msg.id];
  }
});
