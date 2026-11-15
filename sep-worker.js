// ボーカル分離（別スレッドで動かす。画面や音を止めないため）
// モデル：HT-Demucs FT のボーカル専用モデル（ONNX、MIT）。44.1kHz・2ch・7.8秒ずつ、1/4 重ねて処理する
'use strict';
const { parentPort, workerData } = require('worker_threads');
const os = require('os');

const SEG = 343980;            // 7.8秒 × 44100
const OVERLAP = SEG >> 2;
const STRIDE = SEG - OVERLAP;
const VOCALS = 3;              // 出力の並び：drums, bass, other, vocals

let ort = null;
let session = null;
let cancelled = {};

async function getSession() {
  if (session) return session;
  ort = ort || require('onnxruntime-node');
  const threads = Math.max(1, Math.min(8, os.cpus().length - 2)); // 2コアは音と画面のために空けておく
  session = await ort.InferenceSession.create(workerData.modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'disabled', // 最適化をかけるとメモリを使いすぎる（8GBのMacでも落ちる）
    enableCpuMemArena: false,
    intraOpNumThreads: threads
  });
  return session;
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
  const sess = await getSession();
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
    const result = await sess.run({ mix: new ort.Tensor('float32', input, [1, 2, SEG]) });
    const st = result.stems.data;
    const base = VOCALS * 2 * SEG;
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
  return { left: outL, right: outR };
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'cancel') {
    cancelled[msg.id] = true;
    return;
  }
  if (msg.type !== 'separate') return;
  try {
    const out = await separate(msg);
    parentPort.postMessage({ type: 'done', id: msg.id, left: out.left, right: out.right }, [out.left.buffer, out.right.buffer]);
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: cancelled[msg.id] ? 'cancelled' : String((err && err.message) || err) });
  } finally {
    delete cancelled[msg.id];
  }
});
