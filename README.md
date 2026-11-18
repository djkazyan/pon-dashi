# ポン出し（PonDashi）

音響現場（アイドルライブなど）で、渡された曲を **間違いなく・正しい順で** 出すためのポン出しソフトです。

- 1曲ずつ止まるオートキュー。GO は「スタンバイ中の1曲」だけを出す（二度押しで次の次の曲が出ない）
- 2回押し（構え→再生）、連打ガード、残り時間の警告、本番ロック
- グループ（出演者）ごとのタブ、きっかけ（音先・板付き・曲フリ・MC）と終了後（停止・続けて再生・ループ）
- 再生範囲（頭・末尾の無音を詰める）、SEパッド、BGM（客入れ・転換・客出し）
- ボーカルの被せ調整（AIで分離。アプリ版のみ）
- イベントの保存、書き出し・読み込み（.ponbak）

**ダウンロード（配布ページ）：https://djkazyan.github.io/pon-dashi/**

## 動く環境

- M1 以降の Mac（アプリ版）。ネット接続は不要
- `app/index.html` を Google Chrome で開けば、ボーカル調整以外は Chrome でも試せます

## 組み立てとインストール（Mac）

1. Node.js（LTS）を入れる
2. `アップデート.command` をダブルクリック
   - 部品とボーカル分離のモデル（約160MB、`models/`）を初回だけダウンロード
   - テスト → 組み立て → `/Applications/PonDashi.app` に入れ替え → 起動
   - 配布用の .dmg は `配布用/` にできます

## 構成

| ファイル | 役割 |
|---|---|
| `app/cue-engine.js` | GO の動作ルール（スタンバイ・構え・連打ガード） |
| `app/audio-engine.js` | 再生エンジン（Web Audio API） |
| `app/app.js` / `app/index.html` / `app/style.css` | 画面と操作 |
| `app/store.js` / `app/backup.js` | 保存（IndexedDB）、書き出しファイル |
| `main.js` / `preload.js` / `sep-worker.js` | アプリの枠（Electron）、ボーカル分離 |
| `test/` | 自動テスト（`npm test`） |
| `使い方.md` | 使い方のくわしい説明 |
| `docs/はじめにお読みください.txt` | 配布する時に一緒に渡す説明 |

## 使っているもの

- [Electron](https://www.electronjs.org/)（MIT）
- [ONNX Runtime](https://onnxruntime.ai/)（MIT）
- ボーカル分離モデル：HT-Demucs FT（Meta、MIT）の ONNX 版 [StemSplitio/htdemucs-ft-vocals-onnx](https://huggingface.co/StemSplitio/htdemucs-ft-vocals-onnx)
