#!/bin/bash
# ポン出しを独立したアプリとして起動する。
# 初回だけ、必要な部品（Electron）をダウンロードするので数分かかる。

cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

pause() {
  echo
  read -n 1 -s -r -p "何かキーを押すと閉じます"
  echo
}

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js が見つかりません。"
  echo "https://nodejs.org/ から LTS 版をインストールしてから、もう一度このファイルを開いてください。"
  pause
  exit 1
fi

if [ ! -d node_modules/electron ]; then
  echo "初回の準備をしています（数分かかります）..."
  if ! npm install; then
    echo "準備に失敗しました。ネット接続を確認して、もう一度開いてください。"
    pause
    exit 1
  fi
fi

echo "ポン出しを起動します。このウィンドウは開いたままにしてください。"
npm start
