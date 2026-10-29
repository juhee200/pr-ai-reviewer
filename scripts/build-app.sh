#!/usr/bin/env bash
# 메뉴바 앱 번들(PR AI Reviewer.app)과 배포용 zip을 build/에 만든다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="PR AI Reviewer"
BUILD_DIR="$ROOT/build"
APP="$BUILD_DIR/$APP_NAME.app"
VERSION="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$ROOT/package.json")"

cd "$ROOT"
npm run build

# Apple Silicon과 Intel Mac에서 모두 실행되도록 유니버설 바이너리로 만든다.
SWIFT_FLAGS=(--package-path app -c release --arch arm64 --arch x86_64)
swift build "${SWIFT_FLAGS[@]}"
BIN_DIR="$(swift build "${SWIFT_FLAGS[@]}" --show-bin-path)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/cli"
cp "$BIN_DIR/PRAIReviewer" "$APP/Contents/MacOS/PRAIReviewer"
sed "s/__VERSION__/$VERSION/g" app/Info.plist > "$APP/Contents/Info.plist"
# CLI는 dist와 package.json만 넣는다. package.json의 "type": "module"이 있어야 node가 ESM으로 읽는다.
cp -R dist "$APP/Contents/Resources/cli/dist"
cp package.json "$APP/Contents/Resources/cli/package.json"

# 아이콘은 저장소에 이미지 파일을 두지 않고 빌드할 때 그린다.
rm -rf "$BUILD_DIR/AppIcon.iconset"
swift app/make-icon.swift "$BUILD_DIR/AppIcon.iconset"
iconutil -c icns "$BUILD_DIR/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

# 개발자 인증서 없이 배포하므로 ad-hoc 서명한다. Homebrew cask가 설치할 때 quarantine 속성을 지운다.
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --strict "$APP"

ZIP="$BUILD_DIR/pr-ai-reviewer-$VERSION.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
echo "앱: $APP"
echo "zip: $ZIP"
shasum -a 256 "$ZIP"
