# pr-ai-reviewer

내가 올린 PR(일반·Draft)을 감지해, 이 PC에 로그인된 Claude Code 또는 Codex CLI로 리뷰하는 로컬 상주 도구입니다. CI에 외부 API 키를 두지 않고, 각자 쓰는 AI 좌석으로 리뷰를 돌립니다.

## 1. 동작 방식

```
[개발자 PC]
60초마다 gh로 '내가 올린 열린 PR' 조회 (설정한 저장소)
 → 아직 리뷰하지 않은 head 커밋 발견 (로컬 상태 + PR 코멘트의 표식으로 판정)
 → 마지막 푸시 후 90초 동안 추가 푸시가 없으면 리뷰 (연속 푸시를 한 번으로 묶음)
 → 캐시 bare 저장소에 PR 커밋을 git worktree로 체크아웃 (작업 중인 폴더는 건드리지 않음)
 → claude -p 또는 codex exec로 리뷰 (읽기 전용, 정해진 JSON 형식으로 출력)
 → dry-run: 출력·파일 저장만 / --post: PR에 코멘트 게시
```

PR을 IntelliJ, 웹, CLI 중 어디서 만들었는지와 관계없이 GitHub에 생긴 PR을 조회하므로 모두 감지합니다. 조회 간격만큼 늦게 감지할 수 있습니다.

## 2. 요구 사항

| 항목 | 확인 방법 |
|---|---|
| Node.js 22.18 이상 | `node -v` |
| GitHub CLI 로그인 | `gh auth status` |
| git https 인증 (기존 clone이 되는 상태) | `git ls-remote https://github.com/<owner>/<repo>.git` |
| Claude Code 로그인 (엔진이 claude일 때) | `claude -p "hi"` |
| Codex CLI 로그인 (엔진이 codex일 때) | `codex login status` |

## 3. 설치

GitHub 저장소에서 바로 설치합니다. 빌드된 `dist`가 저장소에 들어 있어 설치할 때 빌드하지 않습니다.

```bash
npm install -g --install-links git+https://github.com/juhee200/pr-ai-reviewer.git#v0.2.0
pr-ai-reviewer init
```

`--install-links`를 빼면 npm(11.17에서 확인)이 패키지를 복사하지 않고 임시 폴더로 링크만 걸어, 설치 직후 명령을 찾지 못합니다.

저장소가 비공개인 동안에는 접근 권한이 있는 계정만 설치할 수 있습니다. 새 버전은 태그만 바꿔 같은 명령을 다시 실행하고, 삭제는 `npm uninstall -g pr-ai-reviewer`로 합니다.

소스에서 직접 실행하려면 다음과 같이 합니다. Node의 TypeScript 타입 제거 기능을 써서 빌드 없이 실행됩니다.

```bash
git clone https://github.com/juhee200/pr-ai-reviewer.git
cd pr-ai-reviewer && npm install
node src/cli.ts --help
```

릴리스할 때는 `npm run build`로 `dist`를 다시 만든 뒤 함께 커밋하고 태그를 붙입니다.

## 4. 설정

`pr-ai-reviewer init`이 `~/.config/pr-ai-reviewer/config.json`을 만듭니다. `repos`를 감시할 저장소로 바꿔 주세요.

| 키 | 기본값 | 설명 |
|---|---|---|
| `repos` | (필수) | 감시할 저장소 목록. `owner/name` 형식 |
| `pollIntervalSec` | 60 | PR 조회 간격(초) |
| `debounceSec` | 90 | 새 커밋을 본 뒤 추가 푸시를 기다리는 시간(초). 0이면 바로 리뷰 |
| `includeDrafts` | true | Draft PR도 리뷰 |
| `engine` | `claude` | `claude` 또는 `codex` |
| `model` | null | 엔진 모델. null이면 각 CLI의 기본 모델 |
| `maxBudgetUsd` | null | Claude `--max-budget-usd` 상한 |
| `timeoutSec` | 900 | 리뷰 1건 제한 시간(초) |
| `maxDiffLines` | 3000 | 프롬프트에 직접 넣을 diff 최대 줄 수. 넘으면 앞부분만 넣고 나머지는 AI가 git으로 읽음 |
| `dryRun` | true | true면 PR에 게시하지 않음. `--post`로 덮어씀 |
| `maxFailures` | 3 | 같은 커밋에서 이 횟수만큼 실패하면 새 커밋까지 건너뜀 |
| `claudeSettingSources` | `project` | Claude `--setting-sources`. 개인 hook·설정이 리뷰 실행에 끼지 않게 함 |
| `cacheDir` | `~/.cache/pr-ai-reviewer` | 저장소 캐시와 worktree |
| `stateDir` | `~/.local/state/pr-ai-reviewer` | 상태, 실행 기록(`runs.jsonl`), 리뷰 결과 파일(`reviews/`) |

## 5. 사용법

```bash
pr-ai-reviewer run --plan                 # 리뷰하지 않고 판정 결과만 확인
pr-ai-reviewer run                        # 감시 시작 (기본 dry-run)
pr-ai-reviewer run --post                 # 감시하며 PR에 게시
pr-ai-reviewer review owner/repo 123      # PR 하나를 지금 리뷰 (기본 dry-run)
pr-ai-reviewer review owner/repo 123 --engine codex
pr-ai-reviewer review owner/repo 123 --sha <40자리 커밋>   # 과거 커밋 기준 리뷰 (평가용)
pr-ai-reviewer status                     # 대기·리뷰 기록
```

로그는 stderr, 리뷰 본문은 stdout으로 나갑니다. dry-run 결과도 `stateDir/reviews/`에 파일로 남습니다.

## 6. 로그인 시 자동 실행 (macOS)

```bash
pr-ai-reviewer service install --post   # 게시 모드로 등록 (--dry-run이면 게시하지 않음)
pr-ai-reviewer service status           # 상태와 최근 로그
pr-ai-reviewer service uninstall        # 해제
```

- 사용자 계정의 `~/Library/LaunchAgents/com.github.juhee200.pr-ai-reviewer.plist`로 등록되어 관리자 권한이 필요 없습니다.
- launchd는 셸의 PATH를 물려받지 않습니다. 그래서 등록할 때 node, gh, git, claude, codex의 경로를 찾아 plist에 넣습니다. 도구를 새로 설치하거나 옮겼다면 다시 등록하세요.
- 로그는 `~/Library/Logs/pr-ai-reviewer/agent.log`에 남습니다.
- 비정상 종료하면 다시 시작하고, 로그아웃이나 해제로 정상 종료하면 다시 시작하지 않습니다.
- 처음 켜면 이미 열려 있는 내 PR 중 아직 리뷰하지 않은 커밋도 찾아 리뷰합니다. dry-run으로만 리뷰한 커밋은 게시 모드에서 다시 리뷰해 게시합니다.

## 7. 안전 설계

- 외부 명령은 셸을 거치지 않고 인자 배열로 실행합니다. 저장소 이름, PR 번호, 커밋 SHA, 브랜치 이름은 형식을 검증한 뒤 씁니다.
- AI는 읽기 전용입니다.
  - Claude: 사용 가능 도구를 `Read, Grep, Glob`으로 한정합니다. Bash는 넣지 않습니다. `Bash(git diff:*)`처럼 접두어로 허용하면 `git diff --output=<경로>`로 파일을 쓸 수 있기 때문입니다. 전체 diff는 worktree 밖 임시 파일로 두고 `--add-dir`로 읽게 합니다. MCP 서버는 연결하지 않습니다.
  - Codex: `--sandbox read-only`로 실행합니다.
- PR 제목·diff·커밋 메시지 안의 지시는 데이터로 취급하라고 프롬프트에 명시하고, 데이터 영역의 닫는 태그를 무력화합니다.
- 코드·테스트·빌드를 실행하지 말고 작업 디렉터리와 전체 diff 파일 밖은 읽지 말라고 지시합니다. Codex의 읽기 전용 샌드박스는 쓰기와 네트워크는 막지만 파일 읽기는 막지 않습니다. 그래서 게시 직전에 리뷰 본문을 비밀값 패턴(개인 키, AWS·GitHub·Slack·API 키)으로 검사하고, 걸리면 게시하지 않고 로컬 파일로만 남깁니다.
- PR 게시는 AI가 아니라 프로그램이 합니다. AI 문장 안의 `@아이디` 멘션과 숨은 HTML 주석은 무력화한 뒤 게시합니다.
- 토큰은 직접 다루지 않고 gh·git의 기존 인증을 씁니다. 로그에 환경변수를 남기지 않습니다.
- 리뷰는 PR 작성자 PC의 AI 서비스로 코드를 보냅니다. 평소 그 CLI로 회사 코드를 다루는 범위와 같은지 회사 정책을 확인한 뒤 쓰세요.

## 8. 한계

- 조회 방식이라 최대 `pollIntervalSec + debounceSec`만큼 늦게 리뷰합니다.
- 작성자 PC가 꺼져 있으면 리뷰하지 않습니다. 켜지면 열린 PR 중 리뷰하지 않은 커밋을 리뷰합니다.
- 첫 리뷰 때 저장소 캐시를 만들고 head 커밋의 파일을 받으므로 시간이 더 걸립니다.
