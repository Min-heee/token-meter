#!/bin/zsh
# 토큰 계량기 맥 앱 빌드 — swiftc 직접 빌드 (Xcode 프로젝트 불필요)
# 산출물: macapp/TokenMeter.app (유니버설, ad-hoc 서명)
# 시험용(test/macapp.test.mjs): TOKEN_METER_OUT=<폴더> 에 만들고, TOKEN_METER_ARCHS="arm64" 처럼 한 아키텍처만 빌드할 수 있다.
set -euo pipefail
cd "$(dirname "$0")"

# Xcode 를 새 판으로 올리고 라이선스에 아직 동의하지 않았으면 swiftc·lipo 가 모두 그 안내만 내고 멈춘다.
# 명령줄 도구(CommandLineTools)가 따로 깔려 있으면 그것으로 빌드한다 — 앱은 Xcode 없이도 빌드된다.
CLT=/Library/Developer/CommandLineTools
if [[ -z ${DEVELOPER_DIR:-} ]] && ! swiftc --version >/dev/null 2>&1 && [[ -x $CLT/usr/bin/swiftc ]]; then
  echo "(Xcode 를 쓸 수 없어 명령줄 도구로 빌드합니다: $CLT)"
  export DEVELOPER_DIR=$CLT
fi

OUT=${TOKEN_METER_OUT:-.}
ARCHS=(${=TOKEN_METER_ARCHS:-arm64 x86_64})
APP="$OUT/TokenMeter.app"
BUILD="$OUT/build"
rm -rf "$APP" "$BUILD" && mkdir -p "$BUILD"

echo "── 컴파일 (${ARCHS[*]}) ──"
for a in $ARCHS; do swiftc -O -target "$a-apple-macos13" -o "$BUILD/TokenMeter-$a" TokenMeter/main.swift; done
lipo -create -output "$BUILD/TokenMeter" "$BUILD"/TokenMeter-*

echo "── 번들 구성 ──"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/TokenMeter" "$APP/Contents/MacOS/TokenMeter"
cp TokenMeter/Info.plist "$APP/Contents/Info.plist"
cp ../collect.mjs "$APP/Contents/Resources/collect.mjs"   # 수집·gist 올리기 단일 원천
cp ../eta.mjs "$APP/Contents/Resources/eta.mjs"           # 늦어도 몇 시 (로컬 전용)
cp ../docs/board.mjs "$APP/Contents/Resources/board.mjs"   # 순위판 읽기 — 사이트(docs/)와 같은 파일
# 앱은 이 셋을 node 로 띄운다 — 문법이 깨진 파일이 번들에 들어가면 실행 때에야 알게 되니 여기서 확인
if command -v node >/dev/null; then
  for f in collect eta board; do node --check "$APP/Contents/Resources/$f.mjs"; done
fi

echo "── 서명 (ad-hoc) ──"
codesign --force --deep -s - "$APP"

echo "완료: ${APP:A}"
lipo -info "$APP/Contents/MacOS/TokenMeter"
