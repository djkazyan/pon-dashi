#!/bin/bash
# ポン出し — アプリを組み立てて「アプリケーション」フォルダに入れる（初回のインストールも、更新もこれ）
#
# ダブルクリックで実行。やること：
#   1. 部品の準備（初回だけ数分）
#   2. 動作ルールのテスト（失敗したら入れ替えない）
#   3. アプリの組み立て（.dmg も作る）
#   4. 起動中のポン出しを終了して、「アプリケーション」フォルダのポン出しを入れ替え
#   5. 新しいポン出しを起動
# 保存してあるイベント・SE・BGMは、入れ替えても消えません。

cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
APP_NAME="PonDashi"          # アプリの中の名前（英字）。画面の表示は「ポン出し」
DEST="/Applications/$APP_NAME.app"
OLD_DEST="/Applications/ポン出し.app"  # Ver. 0.6.0 の名前（起動しなかったもの）
APP_ID="jp.hksound.pondashi"
is_running() { [ "$(osascript -e "application id \"$APP_ID\" is running" 2>/dev/null)" = "true" ]; }

pause() {
  echo
  read -n 1 -s -r -p "何かキーを押すと閉じます"
  echo
}
fail() {
  echo
  echo "✖ $1"
  pause
  exit 1
}

echo "===================================="
echo " ポン出し アップデート"
echo "===================================="

# 1. Node.js があるか
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js が入っていません。"
  echo "これから開くページで「LTS」と書かれた macOS 用のインストーラ（.pkg）をダウンロードして、"
  echo "インストールしてから、もう一度このファイルをダブルクリックしてください。"
  open "https://nodejs.org/ja/download"
  pause
  exit 1
fi

VERSION=$(node -p "require('./package.json').version")
echo "組み立てる版：Ver. $VERSION"
echo

# 2. 部品の準備（package.json が変わった時も入れ直す）
DEPS=$(node -p "const p = require('./package.json'); JSON.stringify([p.dependencies, p.devDependencies])")
if [ ! -d node_modules/electron-builder ] || [ "$(cat node_modules/.pon-deps 2>/dev/null)" != "$DEPS" ]; then
  echo "▶ 部品を準備しています（初回は数分かかります。ネット接続が必要です）..."
  npm install --no-audit --no-fund || fail "部品の準備に失敗しました。ネット接続を確かめて、もう一度実行してください。"
  echo "$DEPS" > node_modules/.pon-deps
  echo
fi

# ボーカル分離のモデル（約160MB）。なければ最初の1回だけダウンロードする
MODEL="models/htdemucs_ft_vocals_fp16weights.onnx"
MODEL_URL="https://huggingface.co/StemSplitio/htdemucs-ft-vocals-onnx/resolve/2ef0d757d3e226d0da85fb8c71514f464fcabdd0/htdemucs_ft_vocals_fp16weights.onnx"
MODEL_SHA="0cbe651f535415c9d26a7bb614f7d322dd5a080fa0298f2e50f478030a994dce"
if [ ! -f "$MODEL" ] || [ "$(shasum -a 256 "$MODEL" | cut -d' ' -f1)" != "$MODEL_SHA" ]; then
  echo "▶ ボーカル分離のモデルをダウンロードしています（約160MB、最初の1回だけ）..."
  mkdir -p models
  if curl -L --fail --progress-bar -o "$MODEL.part" "$MODEL_URL" && [ "$(shasum -a 256 "$MODEL.part" | cut -d' ' -f1)" = "$MODEL_SHA" ]; then
    mv "$MODEL.part" "$MODEL"
    echo "  ダウンロードしました"
  else
    rm -f "$MODEL.part"
    echo "  注意：モデルをダウンロードできませんでした。ボーカル調整なしで組み立てます（ネットにつながる時にもう一度実行してください）"
  fi
  echo
fi

# 3. テスト
echo "▶ 動作ルールのテストをしています..."
npm test --silent >/tmp/pon-dashi-test.log 2>&1 || { cat /tmp/pon-dashi-test.log; fail "テストに失敗しました。入れ替えはしていません。この画面をClaudeに見せてください。"; }
echo "  テストに合格しました"
echo

# 4. 組み立て
echo "▶ アプリを組み立てています（1〜2分）..."
rm -rf dist
BUILD_OK=1
npm run build:mac --silent >/tmp/pon-dashi-build.log 2>&1 || BUILD_OK=0
BUILT=$(ls -d dist/mac*/"$APP_NAME.app" 2>/dev/null | head -1)
if [ ! -d "$BUILT" ] || ! codesign --verify --deep "$BUILT" >/dev/null 2>&1; then
  tail -40 /tmp/pon-dashi-build.log
  fail "組み立てに失敗しました。入れ替えはしていません。この画面をClaudeに見せてください。"
fi
if [ "$BUILD_OK" = 1 ]; then
  echo "  組み立てました"
else
  echo "  アプリは組み立てましたが、配布用の .dmg は作れませんでした（入れ替えは続けます）"
fi
echo

# 5. 起動中なら終了してもらう
if is_running; then
  echo "ポン出しが起動しています。"
  read -r -p "終了して入れ替えますか？（本番中なら n）[y/n] " ans
  if [ "$ans" != "y" ] && [ "$ans" != "Y" ]; then
    echo "入れ替えをやめました。ポン出しを終了してから、もう一度実行してください。"
    pause
    exit 0
  fi
  osascript -e "tell application id \"$APP_ID\" to quit" >/dev/null 2>&1
  for i in $(seq 1 30); do
    is_running || break
    sleep 1
  done
  is_running && fail "ポン出しが終了しませんでした。ポン出しの画面で終了してから、もう一度実行してください。"
fi

# 6. 入れ替え
echo "▶ 「アプリケーション」フォルダのポン出し（PonDashi）を入れ替えています..."
if [ -d "$DEST" ]; then
  rm -rf "$DEST" || fail "古いポン出しを消せませんでした。Finderで「アプリケーション」のポン出しをゴミ箱に入れてから、もう一度実行してください。"
fi
[ -d "$OLD_DEST" ] && rm -rf "$OLD_DEST"
ditto "$BUILT" "$DEST" || fail "コピーに失敗しました。"
xattr -cr "$DEST" 2>/dev/null
codesign --verify --deep "$DEST" >/dev/null 2>&1 || codesign --force --deep --sign - "$DEST" >/dev/null 2>&1

# 配布用の .dmg を残す（別のMacに入れる時用）
mkdir -p 配布用
rm -f 配布用/PonDashi-*.dmg
cp dist/*.dmg 配布用/ 2>/dev/null

echo
echo "✔ Ver. $VERSION に入れ替えました。ポン出しを起動します。"
open "$DEST"
sleep 2
echo "このウィンドウは閉じてかまいません。"
pause
