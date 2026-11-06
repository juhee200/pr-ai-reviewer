#!/usr/bin/env bash
# README 이미지(docs/images/*.png)를 샘플 데이터로 다시 만든다.
# - menu.png, settings.png, menubar-icons.png: 메뉴바 앱의 스냅샷 모드(REVIEW_OWL_SNAPSHOT_DIR)에 가짜 CLI를 연결해 그린다.
# - pr-review.png: src/render.ts로 만든 샘플 리뷰를 GitHub 마크다운 API로 HTML로 바꾼 뒤 Chrome으로 찍는다.
# 실제 계정·저장소·경로는 쓰지 않는다. 설치된 앱과 겹치지 않게 번들 ID를 바꾼 임시 앱으로 실행한다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/scripts/readme-images"
OUT="$ROOT/docs/images"
WORK="$(mktemp -d)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SLEEP_PID=""

cleanup() {
  [[ -n "$SLEEP_PID" ]] && kill "$SLEEP_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$OUT"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"

# 1. 메뉴바 앱 화면
swift build --package-path "$ROOT/app" -c release
BIN_DIR="$(swift build --package-path "$ROOT/app" -c release --show-bin-path)"
APP="$WORK/Review Owl Snapshot.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/ReviewOwl" "$APP/Contents/MacOS/ReviewOwl"
cp "$ROOT/app/Resources/MenuBarOwl.png" "$ROOT/app/Resources/MenuBarOwl@2x.png" "$APP/Contents/Resources/"
sed -e "s/__VERSION__/$VERSION/g" -e "s/io.github.juhee200.review-owl/io.github.juhee200.review-owl.snapshot/" \
  "$ROOT/app/Info.plist" > "$APP/Contents/Info.plist"

# 감시 프로세스 자리에 살아 있는 프로세스가 있어야 앱이 "실행 중"으로 그린다.
sleep 600 &
SLEEP_PID=$!
STATE="$WORK/state"
node "$HERE/sample-state.mjs" "$STATE" "$SLEEP_PID"

SHOTS="$WORK/shots"
mkdir -p "$SHOTS"
REVIEW_OWL_CLI="$HERE/fake-cli.mjs" \
REVIEW_OWL_SNAPSHOT_DIR="$SHOTS" \
SAMPLE_STATE_DIR="$STATE" \
SAMPLE_DAEMON_PID="$SLEEP_PID" \
  "$APP/Contents/MacOS/ReviewOwl" -NSRequiresAquaSystemAppearance YES &
APP_PID=$!
for _ in $(seq 1 120); do
  [[ -f "$SHOTS/menubar-icons.png" ]] && break
  sleep 0.5
done
sleep 1
kill "$APP_PID" 2>/dev/null || true
[[ -f "$SHOTS/menu.png" && -f "$SHOTS/settings.png" && -f "$SHOTS/menubar-icons.png" ]] || { echo "앱 스냅샷을 만들지 못했습니다." >&2; exit 1; }
cp "$SHOTS/menu.png" "$OUT/menu.png"
cp "$SHOTS/menubar-icons.png" "$OUT/menubar-icons.png"
# 스냅샷은 창 높이를 2100pt로 고정해 그리므로 내용 아래 빈 영역을 잘라낸다. 높이는 샘플 데이터 기준이다.
# sips는 cropOffset이 0 0이면 가운데를 잘라 1px 아래에서 시작한다.
sips -c "${SETTINGS_HEIGHT:-2580}" 1240 --cropOffset 1 0 "$SHOTS/settings.png" --out "$OUT/settings.png" >/dev/null

# 2. PR 리뷰 화면
node "$HERE/pr-review.ts" "$WORK/pr-review.html"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=920,"${PR_REVIEW_HEIGHT:-1390}" --screenshot="$OUT/pr-review.png" "file://$WORK/pr-review.html" 2>/dev/null

ls -l "$OUT"
