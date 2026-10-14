# 토큰 계량기

Claude Code · Codex · Gemini CLI 를 얼마나 썼는지 토큰 수로 세고, 참가한 사람끼리 순위를 매깁니다.
서버가 없습니다. 각자 자기 GitHub gist 에 숫자만 올리고, 순위판이 그걸 모아 봅니다.

**순위판**: https://min-heee.github.io/token-meter/

## 참가하기

1. GitHub CLI 를 설치하고 로그인합니다. `brew install gh` → `gh auth login`
2. 수집기를 받아 내 숫자를 올립니다.
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Min-heee/token-meter/main/collect.mjs -o collect.mjs && node collect.mjs --publish
   ```
   내 계정에 공개 gist(`token-meter.json`) 하나가 생깁니다. 다시 돌리면 같은 gist 를 고칩니다.
3. 마지막에 나오는 **참가 링크**를 열어 이슈를 제출합니다. 봇이 그 gist 가 내 것인지 확인하고 명단에 넣습니다.

올리기 전에 무엇이 나가는지 보고 싶으면 `node collect.mjs` 만 돌리세요(아무것도 올리지 않습니다).

## 무엇이 올라가나

토큰 수, 날짜별 합계, 모델 이름, 시간대뿐입니다. 이름·프로젝트·경로·대화 내용은 올라가지 않습니다.
**gist 는 지난 수정 기록까지 공개로 남습니다.** 자세한 항목은 [개인정보 처리방침](https://min-heee.github.io/token-meter/privacy.html)에 있습니다.

## 맥 메뉴바 앱

내 사용량, 순위, 지금 돌고 있는 Claude Code 워크플로의 **늦어도 몇 시**를 메뉴바에서 봅니다.
고른 간격(10분~6시간)마다, 숫자가 바뀌었을 때만 gist 에 올립니다. 지금은 소스에서 빌드합니다: `macapp/build.sh`

## 그만두기

[탈퇴 이슈](https://github.com/Min-heee/token-meter/issues/new?template=leave.yml&title=leave)를 열고, 내 gist 를 지우세요(`gh gist delete <id>`).

## 어떻게 돌아가나

- 각자의 gist → 저장소의 `docs/members.json`(아이디 + gist id) → 순위판(사이트·앱)이 **직접** 모아서 계산
- GitHub Actions 는 참가·탈퇴 이슈 처리에만 씁니다. 예약 실행은 쓰지 않습니다(공개 저장소에서는 몇 시간씩 밀립니다).

## 알아 둘 것

- 숫자는 각자 올린 것이라 확인할 길이 없습니다. 재미로 보는 순위입니다.
- 같은 계정으로 컴퓨터 두 대에서 올리면 마지막에 올린 쪽 숫자만 남습니다.
- gist 원본은 GitHub 가 5분쯤 캐시해서, 올린 뒤 순위판에 보이기까지 몇 분 걸릴 수 있습니다.

## 개발

`npm test` (Node 20+). 기여·문의는 이슈로.

MIT License
