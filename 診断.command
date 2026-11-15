#!/bin/bash
# ポン出しが起動しない時の記録を集めて、このフォルダの「診断」フォルダに入れる（Claudeが読むため）
cd "$(dirname "$0")" || exit 1
OUT="診断"
mkdir -p "$OUT"
APP="/Applications/ポン出し.app"
EXE=$(ls "$APP/Contents/MacOS/" 2>/dev/null | head -1)

{
  echo "== 日時"; date
  echo "== macOS"; sw_vers; uname -m
  echo "== Node"; node -v 2>&1; npm -v 2>&1
  echo "== アプリの中身"; ls -la "$APP/Contents/MacOS/" "$APP/Contents/Frameworks/" 2>&1
  echo "== 署名"; codesign -dvvv "$APP" 2>&1; codesign --verify --deep --strict --verbose=2 "$APP" 2>&1
  echo "== 拡張属性"; xattr -l "$APP" 2>&1 | head -20
} > "$OUT/情報.txt" 2>&1

echo "ポン出しを直接起動して、15秒間の記録を取ります..."
"$APP/Contents/MacOS/$EXE" > "$OUT/起動の記録.txt" 2>&1 &
PID=$!
sleep 15
kill $PID 2>/dev/null

cp /tmp/pon-dashi-build.log "$OUT/組み立ての記録.txt" 2>/dev/null
REPORT=$(ls -t ~/Library/Logs/DiagnosticReports/*.ips 2>/dev/null | while read -r f; do
  if grep -q -e "ポン出し" -e "pondashi" -e "Electron" "$f" 2>/dev/null; then echo "$f"; fi
done | head -1)
[ -n "$REPORT" ] && cp "$REPORT" "$OUT/クラッシュレポート.txt"

echo
echo "記録を「診断」フォルダに入れました。Claudeに「診断した」と伝えてください。"
read -n 1 -s -r -p "何かキーを押すと閉じます"
echo
