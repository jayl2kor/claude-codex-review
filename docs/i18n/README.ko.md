[English](README.en.md) | **한국어**

---

# cmux를 위한 Claude-Codex Review 루프

`ccr.sh`는 cmux 안에서 Claude Code와 Codex를 나란히 돌리기 위한 작은 hook 기반 워크플로우를 설치합니다.

의도된 루프는 다음과 같습니다.

1. 한 에이전트가 코드를 작업합니다.
2. 그 에이전트의 stop hook이 현재 diff와 리뷰 요청을 로컬 세션 폴더에 기록합니다.
3. cmux가 반대편 에이전트에게 요청 파일 경로가 담긴 짧은 메시지를 보냅니다.
4. 반대편 에이전트는 리뷰만 수행합니다.
5. 리뷰 결과가 세션 폴더에 기록되고 원래 작업자에게 전달됩니다.
6. `PASS`가 나오거나, 의미 있는 diff가 더 이상 없거나, 같은 diff가 반복되거나, 최대 라운드 한도에 도달할 때까지 루프가 반복됩니다.

기본적으로 리뷰어는 파일을 수정할 수 없습니다.

어디서 시작할지 모르겠다면 [`docs/start-here.md`](../start-here.md)부터 보세요. 짧은 첫 실행 경로는 [`docs/quickstart.md`](../quickstart.md), 작업 중심의 명령 레시피는 [`docs/examples.md`](../examples.md)를 참고하세요.

## 설치

### npm으로 설치 (GitHub에서)

패키지를 설치하면(단일 `ccr` 명령을 노출합니다) 이후 셋업을 실행합니다.

```sh
npm i -g github:jayl2kor/claude-codex-review
ccr install
```

`ccr install`은 아래 스크립트와 동일한 머신 셋업을 수행합니다. 즉 `ccr-*` 명령 생태계를 `~/.local/bin`에 복사하고, CCR hook을 `~/.claude/settings.json`과 `~/.codex/hooks.json`에 병합하며, 슬래시 커맨드와 설정 템플릿을 설치합니다. 완료되면 `ccr help`로 명령 목록을 볼 수 있고, 개별 `ccr-*` 래퍼가 `PATH`에 올라갑니다.

> 런타임은 Bun이므로 `bun`이 설치돼 있어야 합니다(`ccr` 런처와 생성된 래퍼가 Bun 위에서 실행됩니다). `npm`은 패키지를 받아오거나 업데이트하는 용도로만 쓰입니다.

### 스크립트로 설치 (체크아웃에서)

이 디렉터리에서 실행합니다.

```sh
bash ccr.sh
```

설치 시점 요구사항:

- `bun`

`ccr-doctor`가 점검하는 런타임 워크플로우 요구사항:

- `cmux`
- `claude`
- `codex`

설치기는 `~/.local/bin`에 명령을 생성하고 hook 항목을 다음 파일에 병합합니다.

- `~/.claude/settings.json`
- `~/.codex/hooks.json`

필요하면 `~/.zshrc`의 `PATH`에 `~/.local/bin`도 추가합니다.

현재 셸에서 새 명령이 보이지 않으면 다음을 실행하세요.

```sh
source ~/.zshrc
```

## 페어 시작하기

cmux에서 대상 프로젝트를 열고, 같은 cmux 워크스페이스 안에 두 개의 터미널 surface를 만듭니다.

Claude 터미널에서:

```sh
cmux-setup-claude
```

Codex 터미널에서:

```sh
cmux-setup-codex
```

그런 다음, 두 터미널 중 어느 쪽에서든 대상 저장소 디렉터리에서:

```sh
ccr-enable
ccr-ready
ccr-status
```

Codex의 경우 `/hooks`를 한 번 열어 Codex가 리뷰를 요청하면 CCR hook을 신뢰(trust)하세요.

## 일상 사용

Claude나 Codex 중 어디서든 평소처럼 작업합니다.

작업 중인 에이전트가 파일을 변경하고 한 턴을 끝내면, CCR이 다음 위치에 리뷰 라운드를 생성합니다.

```text
<project>/.cmux/ccr/sessions/<session-id>/rounds/<round>/
```

CCR은 파일을 수정하는 도구(`Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `apply_patch`)나 파일을 수정하는 것으로 보이는 Bash 명령이 실행된 뒤에만 해당 턴을 리뷰 대상으로 표시합니다. `ccr-status`나 `ccr-reset` 같은 읽기 전용 명령·CCR 제어 명령은, 설령 예전 git diff가 이미 있더라도 그 자체로는 리뷰를 시작하지 않습니다. 읽기 전용 출력 리다이렉트(`2>/dev/null`, `2>&1`, `>/dev/null`)는 수정으로 간주되지 않으므로, 그런 명령만 실행한 조사용 턴은 리뷰를 발동시키지 않습니다.

주요 파일:

- `request.md`: 리뷰어를 위한 지침
- `diff.patch`: 리뷰 대상 diff
- `delta.patch`: 직전 라운드 이후의 변경분. 라운드 2부터 변경이 있을 때 제공
- `worker-followup.md`: 직전 리뷰 이후 작업자의 최신 응답. 라운드 2부터 있을 때 제공
- `review.md`: 리뷰어 응답
- `decision.json`: 파싱된 리뷰 결정

리뷰어는 (응답 상단 근처에, 독립된 한 줄로) 결정 라인을 반드시 포함해야 합니다. 다음 중 정확히 하나:

```text
REVIEW_DECISION: PASS
REVIEW_DECISION: NEEDS_CHANGES
REVIEW_DECISION: NEEDS_HUMAN
```

`NEEDS_HUMAN`은 에이전트의 안전한 범위를 벗어나는 정책·보안·비즈니스 판단을 위한 것입니다. 이 경우 작업자는 변경을 자동 적용하지 않고 리뷰를 사용자에게 보고하도록 안내받습니다. 일상적인 코드 결함은 `NEEDS_CHANGES`로 두어야 합니다.

리뷰어가 변경을 요청하면 원래 작업자가 리뷰 파일 경로를 받아 수정을 적용할 수 있습니다. 작업자는 무엇을 적용했는지, 그리고 이전 리뷰 항목 중 적용하지 않은 것이 있다면 그 이유를 간단히 밝히도록 요청받습니다. CCR은 다음에 변경된 diff에 대해 또 한 번의 리뷰 라운드를 실행합니다. 라운드 2부터는 요청에 `delta.patch`(직전 라운드 이후 변경분), `## Previous Review` 섹션, 그리고 작업자의 최신 응답과 변경 파일 요약이 담긴 `## Worker Follow-up Since Previous Review` 섹션이 함께 포함되어, 리뷰어가 새 내용에 집중하고 작업자의 주장을 검증할 수 있습니다.

라운드 카운터(`review_count`)는 활성 리뷰 요청이 없을 때에 한해 새 사용자 프롬프트에서 `0`으로 초기화됩니다. 따라서 각 사용자 요청은 진행 중인 리뷰를 훼손하지 않으면서 새로운 `CCR_MAX_ROUNDS` 한도를 받습니다. 이전에 중단된 루프(예: 최대 라운드 도달)는 다음 요청을 막지 않습니다. 진행 중인 리뷰는 건드리지 않으며, 초기화는 카운터와 동일 diff 중복 제거 해시에만 영향을 줍니다.

루프가 종료 상태(`passed`, `max_rounds`, `same_hash`, `cancelled`, `needs_human`, `invalid`)에 도달하면, CCR은 `<project>/.cmux/ccr/sessions/<session-id>/report.md`에 자체 완결적인 Markdown 요약을 기록합니다. 여기에는 2~3줄 결과 요약, 메타데이터 표, 라운드별 결정, 변경 파일(`diff.patch` 헤더에서 도출), 그리고 `review.md` 본문이 포함됩니다. 경로와 짧은 요약은 `cmux notify`, `cmux log`, `status.json.last_report`(`ccr-status`에서 확인 가능)를 통해 노출됩니다. 언제든 `ccr-report`로 보고서를 재생성하거나 출력할 수 있습니다.

## 명령어

첫 설치는 [`docs/quickstart.md`](../quickstart.md)를 보세요.
역할 기반 문서 라우팅은 [`docs/start-here.md`](../start-here.md)를 보세요.
작업 중심 예시는 [`docs/examples.md`](../examples.md)를 보세요.
자주 묻는 질문은 [`docs/faq.md`](../faq.md)를 보세요.
워크플로우별로 묶은 명령은 [`docs/commands.md`](../commands.md)를 보세요.
상태·보고서에 쓰이는 런타임 용어는 [`docs/glossary.md`](../glossary.md)를 보세요.
JSON 출력 및 CI/지원 예시는 [`docs/automation.md`](../automation.md)를 보세요.
팀 또는 다중 저장소 롤아웃은 [`docs/rollout.md`](../rollout.md)를 보세요.
저장소 소유자용 도입 점검은 [`docs/adoption-checklist.md`](../adoption-checklist.md)를 보세요.
보안·프라이버시 기본값은 [`docs/security.md`](../security.md)를 보세요.
변경 사항을 공유하거나 롤아웃하기 전 검증은 [`docs/validation.md`](../validation.md)를 보세요.
복사해서 쓰는 롤아웃·지원 템플릿은 [`docs/templates.md`](../templates.md)를 보세요.
재설치·업그레이드·롤백 절차는 [`docs/upgrade.md`](../upgrade.md)를 보세요.
유지보수자 인수인계 요약은 [`docs/release-notes.md`](../release-notes.md)를 보세요.
구현 아키텍처는 [`docs/architecture.md`](../architecture.md)를 보세요.

```sh
ccr-help
```

간결한 빠른 시작, 일상 명령 맵, 진단 진입점을 출력합니다. README를 열고 싶지 않을 때 설치 후 사용하세요. 이 저장소의 `docs/start-here.md`, `docs/quickstart.md`, `docs/examples.md`, `docs/adoption-checklist.md`, `docs/faq.md`, `docs/commands.md`, `docs/troubleshooting.md`도 함께 안내합니다.

```sh
ccr-status
```

CCR 활성화 여부, 설치기 버전 스탬프, 등록된 Claude/Codex surface, 현재 상태, 리뷰 횟수, 마지막 라운드 결과, 활성 요청 경과 시간, 대기 중인 skip 마커를 보여줍니다.

```sh
ccr-disable
```

현재 cmux 워크스페이스에 대해 CCR을 비활성화합니다.

```sh
ccr-enable
```

현재 cmux 워크스페이스와 대상 저장소에 대해 CCR을 활성화합니다.

```sh
ccr-reset
```

현재 저장소의 로컬 `.cmux/ccr` 상태를 삭제하고 다시 만듭니다. 파괴적이며 라운드 기록도 함께 지웁니다.

```sh
ccr-cancel
```

진행 중인 리뷰 요청을 소프트 취소합니다(`active_request`와 dirty 플래그를 지우되 세션 기록은 보존). 리뷰어가 끝내 응답하지 않을 때 사용하세요.

```sh
ccr-history [--limit N] [--session ID]
```

완료된 리뷰 라운드를 최신순으로 나열합니다. 기본 limit: 20.

```sh
ccr-events [--limit N] [--json]
```

dirty 마커, 건너뛴 라운드, 프롬프트 초기화, 보고서 생성 등 최근 `.cmux/ccr/events.jsonl` 런타임 이벤트를 보여줍니다. 기본 limit: 50.

```sh
ccr-show [--session ID] [--round N] [--review]
```

최신(또는 지정한) 리뷰 라운드의 파일 경로를 출력합니다. `--review`는 `review.md` 본문을 stdout으로 출력합니다.

```sh
ccr-preview [--json]
```

현재 git diff가 자동 CCR 리뷰 대상이 되는지를 설명합니다. diff 내용, 변경 라인 임계값, 동일 diff 중복 제거, 활성 요청, 대기 중인 `ccr-skip-next` 마커를 점검하되, 세션을 dirty로 표시하거나 마커를 소비하거나 라운드를 만들거나 핸드오프를 보내지 않습니다.

```sh
ccr-prune [--keep N] [--days N] [--apply] [--json]
```

오래된 `.cmux/ccr` 세션과 지원 번들을 정리하는 드라이런입니다. 기본값은 `--keep 20 --days 30`이며, 두 보존 규칙 중 하나라도 넘는 경로가 나열됩니다. 나열된 산출물을 실제로 제거하려면 `--apply`를 추가하세요.

```sh
ccr-config [--json]
```

유효한 CCR 설정을 출력합니다. 환경 값과 그것이 기본값에서 왔는지 env 오버라이드에서 왔는지, 활성 `CCR_ROOT`, 설정 경로, 생성된 명령 이름, diff 제외 규칙을 보여줍니다. 자동화나 지원 번들에는 `--json`을 사용하세요.

```sh
ccr-check [--json]
```

통합 진단 요약을 실행합니다. 설치된 런타임 self-test, `ccr-doctor` 요약, 엄격 준비도(readiness), 현재 diff 미리보기, 활성 env 오버라이드를 보여줍니다. 설치 후나 지원 이슈를 올리기 전에 사용하세요.

```sh
ccr-skip-next
```

다음 Stop hook이 리뷰를 보내지 않도록 일회성 마커를 둡니다. 커밋 전용이나 잡일 턴에 유용합니다. `CCR_MAX_ROUNDS`를 소비하지 않습니다.

이 마커는 **워크스페이스 범위**입니다(`<cwd>/.cmux/ccr/skip-next.json`에 위치). 여러 작업자 세션이 같은 워크스페이스·cwd를 공유하면, 누가 만들었든 상관없이 첫 번째로 자격이 되는 Stop이 마커를 소비합니다.

```sh
ccr-report [--session ID] [--outcome OUT] [--print]
```

최신(또는 지정한) 세션의 Markdown 보고서를 `.cmux/ccr/sessions/<sid>/report.md`에 생성(또는 재생성)하고 그 경로를 출력합니다. `--print`를 주면 본문도 stdout으로 흘려보냅니다. 루프가 종료 상태에 도달하면 CCR이 이 보고서를 자동 생성하므로, 이 명령은 주로 수동 재생성이나 파이핑용입니다.

```sh
ccr-ready [--json]
```

현재 저장소와 cmux surface에서 자동 리뷰 라우팅이 **지금 당장** 준비됐는지 확인합니다. `ccr-doctor`와 달리 이것은 엄격한 게이트입니다. 런타임 명령이 사용 가능하고, hook과 생성된 명령이 설치돼 있으며, Claude/Codex surface가 둘 다 등록됐고, 워크스페이스가 활성화됐고, cwd가 git 저장소이며, 이미 활성화된 리뷰 요청이 없을 때에만 `0`으로 종료합니다. 첫 셋업 후나 스크립트에서 사용하세요.

```sh
ccr-selftest [--json]
```

CCR을 재설치하지 않고 설치된 런타임 스모크 테스트를 실행합니다. 결정 파싱, dirty 트리거 필터링, 핸드오프 프롬프트 처리, 활성 리뷰 프롬프트 초기화 안전성, diff 절단 헬퍼, 진단 JSON 경로를 점검합니다. `ccr.sh`를 수정한 뒤, CCR을 업그레이드한 뒤, 또는 지원 번들을 공유하기 전에 사용하세요.

```sh
ccr-doctor [--json]
```

로컬 CCR 설치와 현재 워크스페이스를 진단합니다. 필수 명령, 생성된 명령 파일, Claude/Codex hook 항목, `PATH`, cmux 워크스페이스/surface 등록, `ccr-enable` 상태, git 워크트리 상태, 활성 요청, 대기 중인 skip 마커를 확인합니다. 셋업이나 핸드오프 동작이 불명확할 때 가장 먼저 사용하세요. 출력 끝에는 구체적인 다음 조치가 나옵니다. 스크립트·CI·이슈 보고용 기계 판독 진단에는 `--json`을 추가하세요.

```sh
ccr-support [--session ID] [--include-diffs] [--print]
```

`ccr-doctor --json`, 버전 정보, 현재 CCR 상태, 최근 이벤트, 최신 세션 메타데이터를 담은 `.cmux/ccr/support/ccr-support-*.zip`을 만듭니다. 기본적으로 리뷰 요청·리뷰·diff 페이로드는 제외하며, 코드/리뷰 내용을 공유해도 괜찮을 때에만 `--include-diffs`를 추가하세요. zip 내용을 보려면 `--print`를 사용하세요.

```sh
ccr-uninstall [--apply] [--purge]
```

기본은 드라이런입니다. `--apply`는 `~/.claude/settings.json`과 `~/.codex/hooks.json`에서 CCR hook 항목을 제거한 뒤, 설치된 바이너리와 슬래시 커맨드를 삭제합니다. `--purge`는 `~/.config/claude-codex-review`와 `~/.local/state/claude-codex-review`도 삭제합니다. `~/.zshrc`의 `PATH` 라인은 건드리지 않습니다.

```sh
ccr-request --type architecture_review --file ccr.sh --question "Is the state protocol robust?"
```

수동 scoped 리뷰 요청을 만들어 반대편으로 등록된 에이전트에게 보냅니다. 최신 diff와 연결되지 않은 아키텍처·설계·보안·테스트 계획 리뷰에 유용합니다.

설치 후 Claude에는 `/ccr-request` 명령도 추가됩니다. 예:

```text
/ccr-request --type design_review --file docs/architecture.md --question "Does this design fit the current codebase?"
```

Codex는 현재 내장 슬래시 커맨드만 노출하므로, Codex에서는 셸 명령 형태를 사용하세요.

```text
Run: ccr-request --type architecture_review --file ccr.sh --question "Where can this fail?"
```

지원하는 요청 타입:

- `code_review`
- `architecture_review`
- `design_review`
- `test_plan_review`
- `security_review`
- `general_review`

유용한 옵션:

- `--reviewer claude|codex`: 리뷰어를 명시적으로 선택합니다. 기본값은 반대편으로 등록된 surface입니다. 작업자 자신에게 되돌아가는 요청(같은 role이거나 리뷰어 surface가 작업자 surface와 같은 경우)은 거부되므로, 잘못 등록된 페어나 명시적 self-타겟은 리뷰를 자기에게 되돌리지 않고 즉시 실패합니다.
- `--file <path>`: 리뷰 범위에 파일을 추가합니다. 반복 가능.
- `--dir <path>`: 리뷰 범위에 디렉터리를 추가합니다. 반복 가능.
- `--question <text>`: 구체적인 리뷰 질문을 추가합니다. 반복 가능.
- `--note <text>`: 리뷰어를 위한 추가 컨텍스트를 더합니다. 반복 가능.
- `--use-diff`: 현재 git diff를 보조 컨텍스트로 포함합니다.
- `--follow-up`: 가장 최근의 직전 리뷰(그 결정, Must Fix 개수, 리뷰 파일)를 요청에 엮고, `--use-diff`와 함께 쓰면 증분 `delta.patch`도 포함합니다. 적용/미적용 설명은 `--note`에 담으세요. 리뷰어는 각 주장을 그대로 믿지 말고 diff와 대조해 검증하도록 안내받습니다.

수동 요청은 그 외에는 호출 간 상태가 없습니다(각각 고유한 `manual-<timestamp>` 세션에서 실행). 그래서 `NEEDS_CHANGES` 결과 이후 반복적인 수동 루프에는 `--follow-up`을 사용하세요. CCR 루트 어디에 있든 가장 최근에 리뷰된 라운드를 찾아냅니다.

```sh
ccr-request --type code_review --use-diff --follow-up \
  --note "Applied the null-check at parser.ts:42; skipped the rename (out of scope)."
```

Stop으로 발동되는 자동 루프는 이미 매 라운드 이 컨텍스트를 엮습니다. `--follow-up`은 그 동작을 수동 경로에도 가져옵니다.

## 설정

환경 변수:

- `CCR_MAX_ROUNDS`: 최대 자동 리뷰 라운드. 기본값: `3`.
- `CCR_ROOT`: 상태 루트를 재정의. 기본값: `<cwd>/.cmux/ccr`.
- `CCR_MAX_UNTRACKED_BYTES`: 리뷰 diff에 포함하는 untracked 텍스트 파일의 최대 크기. 기본값: `200000`.
- `CCR_MAX_DIFF_BYTES`: 리뷰어에게 보내는 결합 diff의 최대 크기. 예산을 초과하면 섹션이 끝에서부터(untracked 먼저) 잘립니다. 기본값: `300000`.
- `CCR_MIN_DIFF_LINES`: `>0`이면 diff의 `+/-` 라인이 이 값보다 적을 때 자동 리뷰를 건너뜁니다. `0`(기본)은 임계값을 비활성화합니다. 건너뛴 라운드는 `CCR_MAX_ROUNDS`를 소비하지 않습니다.
- `CCR_PROMPT_GATE`: 자동 리뷰의 프롬프트 기반 게이팅. `on`(기본)은 사용자 프롬프트가 읽기 전용으로 보이거나(질문/설명, 영어 또는 한국어) 개발자가 `CCR_REVIEW: skip`을 남겼을 때 리뷰를 억제합니다. `advisory`는 무엇을 했을지 로그만 남깁니다(`ccr-events`로). `off`는 비활성화합니다. 이 기능은 **억제 전용**입니다 — 스스로 리뷰를 시작하지 않으며(여전히 실제 diff가 필요), 명시적 `CCR_REVIEW: request` 라인(또는 프롬프트의 변경/구현 요청)은 읽기 전용 분류를 무효화합니다.

개발자 에이전트는 한 줄의 평문 — `CCR_REVIEW: request` 또는 `CCR_REVIEW: skip` — 으로 턴을 끝내 해당 턴이 자동 리뷰 대상인지 CCR에 알릴 수 있습니다. 생략하면 파일 변경 휴리스틱으로 폴백합니다. 이는 리뷰어의 `REVIEW_DECISION:` 라인과는 별개입니다.

예:

```sh
CCR_MAX_ROUNDS=5 ccr-enable
```

## 안전 규칙

CCR은 의도적으로 페이로드에 파일을 사용하고 cmux로는 파일 경로만 전송합니다. 전체 보안·프라이버시 정책 가이드는 [`docs/security.md`](../security.md)를 보세요.

diff 수집기는 다음을 포함해 흔히 민감하거나 노이즈가 많은 경로를 제외합니다.

- `.cmux/ccr/`
- `.git/`
- `.env*`
- 개인 키/인증서 접미사
- `node_modules/`
- 흔한 빌드 출력 디렉터리
- `.open-research/logs/` (open-research 플러그인이 생성하는 세션 로그)

리뷰어 전용 모드는 에이전트가 리뷰어로 동작하는 동안 지원되는 수정 도구를 차단합니다. 이는 같은 워크트리 충돌을 줄여 줍니다.

## 문제 해결

시나리오 기반 복구 절차는 [`docs/troubleshooting.md`](../troubleshooting.md)를 보세요.
흔한 셋업·라우팅 질문에 대한 짧은 답은 [`docs/faq.md`](../faq.md)를 보세요.

`ccr-status`에 surface가 빠졌다고 나오면, 각 surface에서 셋업 명령을 다시 실행하세요.

```sh
cmux-setup-claude
cmux-setup-codex
```

리뷰가 시작되지 않으면 다음을 확인하세요.

```sh
ccr-status
ccr-doctor
```

흔한 원인:

- 워크스페이스에 대해 CCR이 비활성화돼 있음.
- Claude와 Codex가 같은 cmux 워크스페이스에 있지 않음.
- 대상 디렉터리가 git 저장소가 아님.
- 마지막 턴이 git diff를 만들지 않음.
- 마지막 턴이 `ccr-status`, `ccr-reset`, 테스트 같은 비수정 명령만 실행함.
- Codex가 `/hooks`에서 새 hook을 아직 신뢰하지 않음.

`ccr-doctor`는 보통 `bash ccr.sh` 재실행이 필요한, 망가진 설치 부분에 대해 `[FAIL]` 행을, cmux 등록 누락이나 아직 `ccr-enable`을 실행하지 않은 워크스페이스 같은 워크플로우 상태에 대해 `[WARN]` 행을, 그리고 수행할 명령·점검을 담은 번호 매겨진 `Next actions` 섹션을 출력합니다.

자동화나 지원 번들에는 `ccr-doctor --json`을 사용하세요. 텍스트 모드와 동일한 종료 코드 동작을 따릅니다(하나 이상의 점검이 실패할 때만 0이 아님). JSON 출력에는 `checks`, `summary`, `next`, `actions`가 포함됩니다.

루프가 `same diff hash`로 멈추면, 작업자가 리뷰 피드백을 받은 뒤 diff를 바꾸지 않은 것입니다. 새 변경을 하거나 `ccr-reset`을 실행하세요.

루프가 `max rounds`로 멈추면, 최신 `review.md`를 살펴보고 수동으로 이어가세요.

## 제거

파일을 지우지 않고 동작만 끄려면:

```sh
ccr-disable
```

설치된 hook 항목과 바이너리를 제거하려면:

```sh
ccr-uninstall          # 드라이런: 무엇이 제거될지 출력
ccr-uninstall --apply  # 실제 제거
ccr-uninstall --apply --purge   # ~/.config 및 ~/.local/state 캐시도 제거
```

제거기는 `~/.claude/settings.json`과 `~/.codex/hooks.json`에서 CCR hook 그룹을 제거하고, `~/.local/bin`의 생성된 명령을 삭제하며, `~/.claude/commands` 아래의 슬래시 커맨드를 제거합니다. `~/.zshrc`의 `PATH` 라인은 건드리지 않습니다.
