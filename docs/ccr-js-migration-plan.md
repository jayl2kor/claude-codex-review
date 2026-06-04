# CCR Bun 마이그레이션 계획 (ccr.sh → Bun 프로젝트)

이 문서는 현재 단일 설치 스크립트인 [`../ccr.sh`](../ccr.sh)와 그 안에 임베드된 Python 런타임 `ccr-hook.py`를 Bun 기반 프로젝트로 전환하기 위한 단계별 계획을 정의한다. 구조 개요는 [architecture.md](architecture.md), 검증 절차는 [validation.md](validation.md), 사용자 명령은 [commands.md](commands.md)를 함께 참고한다.

> 핵심 원칙: **비파괴(non-destructive) 마이그레이션**. parity가 검증되기 전까지 `ccr.sh`와 `README.md`는 단일 진실 공급원(source of truth)으로 절대 변경하지 않는다. `install.ts`는 컴파일/타입체크만 하며 절대 실행하지 않는다(`~/.claude`, `~/.codex`, `~/.local/bin`, `~/.zshrc`, `~/.config` 비변형). npm 런타임 의존성은 0개로 유지하고 Bun/Node 내장 모듈(`node:fs`, `node:path`, `node:os`, `node:child_process`, `Bun.*`)만 사용한다.

---

## 1. 현황 진단

`ccr.sh`는 런타임이 아니라 **설치기(installer)** 다. `bash ccr.sh`를 실행하면 heredoc으로 임베드된 파일들을 `~/.local/bin`, `~/.claude/commands`, `~/.config`(CONFIG_ROOT) 등에 펼쳐 쓴다. 즉 `ccr.sh`의 대부분은 코드가 아니라 "쓰여질 파일들의 페이로드"다.

| 항목 | 값 |
|---|---|
| `ccr.sh` 총 라인 수 | 5091 |
| `ccr.sh` 파일 크기 | 196,883 bytes |
| 임베드 Python 런타임 `ccr-hook.py` 라인 수 | 약 3757 (현재 추출본 3754) |
| `ccr.sh` 중 `ccr-hook.py`가 차지하는 비중 | 약 73% |
| `ccr-hook.py` 최상위 함수 수 | 118 |
| `ccr-hook.py` 클래스 수 | 0 (절차적, 함수 중심) |
| `ccr-hook.py` 외부 의존성 | 없음 (Python stdlib 전용) |

`ccr-hook.py`가 사용하는 stdlib: `argparse`, `calendar`, `contextlib`, `fcntl`, `hashlib`, `io`, `json`, `os`, `re`, `shutil`, `subprocess`, `sys`, `tempfile`, `time`, `zipfile`, `pathlib.Path`, `typing.Any`, `from __future__ import annotations`. 외부 패키지가 전혀 없다는 점이 마이그레이션을 단순화한다 — 모든 위험은 stdlib 동등물 매핑으로 환원된다.

### 임베드 산출물 인벤토리

`ccr.sh`는 다음 산출물을 heredoc(`cat > ... <<'EOF'` / `<<'PY'` / `<<'CCR_*_EOF'`)으로 펼친다.

| 분류 | 개수 | 내용 |
|---|---|---|
| bin 파일 | 27 | `ccr-hook.py`, `ccr-lib.sh`, `ccr-hook-claude`, `ccr-hook-codex`, `cmux-setup-claude`, `cmux-setup-codex`, `ccr-help`, 그리고 `ccr-*` 사용자 명령 래퍼들(`ccr-status`, `ccr-ready`, `ccr-request`, `ccr-report`, `ccr-doctor`, `ccr-support`, `ccr-selftest`, `ccr-uninstall`, `ccr-preview`, `ccr-prune`, `ccr-config`, `ccr-events`, `ccr-check`, `ccr-history`, `ccr-show`, `ccr-skip-next`, `ccr-cancel`, `ccr-reset`, `ccr-enable`, `ccr-disable`) |
| claude-commands | 14 | `ccr-request.md`, `ccr-status.md`, `ccr-history.md`, `ccr-events.md`, `ccr-skip-next.md`, `ccr-report.md`, `ccr-doctor.md`, `ccr-support.md`, `ccr-ready.md`, `ccr-selftest.md`, `ccr-preview.md`, `ccr-prune.md`, `ccr-config.md`, `ccr-check.md` |
| config 파일 | 3 | `dev-prompt.md`, `reviewer-prompt.md`, `codex-home/AGENTS.md` |
| **펼침 파일 합계** | **44** | (위 27 + 14 + 3) |
| 인라인 설치 시점 Python 블록 | 3 | (1) settings-merge: `~/.claude/settings.json` + `~/.codex/hooks.json` 병합(@ccr.sh:4248), (2) json-validate: 병합 후 JSON 유효성 검증(@ccr.sh:5031), (3) selftest: 설치 직후 런타임 스모크 테스트(@ccr.sh:4746) |

3개 인라인 블록은 펼쳐지지 않고 설치 과정 안에서만 실행된다. 이 중 selftest 블록은 이번 라운드에 `templates/selftest-install.py`로 추출되었다(아래 7절 참조).

---

## 2. 목표 디렉터리 구조

전환의 1차 목표는 `ccr.sh`의 monolith를 "설치 로직(TypeScript) + 템플릿(데이터)"으로 분리하는 것이다. 런타임(`ccr-hook.py`)의 Bun 포팅은 그 다음 단계다.

```text
cmux/
├── ccr.sh                         # 단일 진실 공급원 (parity 검증 전까지 불변)
├── README.md                      # 불변 (전환기 진실 공급원)
├── package.json                   # type=module, engines.bun, scripts(install:ccr/test/check:sync/typecheck)
├── tsconfig.json                  # strict, bundler resolution, noEmit, allowImportingTsExtensions
├── src/
│   ├── install.ts                 # ccr.sh의 설치 로직 TypeScript 포팅 (실행 금지, 컴파일/타입체크만)
│   ├── lib/                       # (3절) 런타임 모듈 분할 — ccr-hook.py 포팅의 도착지
│   │   ├── io.ts
│   │   ├── paths.ts
│   │   ├── lock.ts
│   │   ├── git.ts
│   │   ├── cmux.ts
│   │   ├── intent.ts
│   │   ├── review.ts
│   │   ├── report.ts
│   │   └── hooks.ts
│   ├── commands/                  # ccr-* 명령별 구현 (status.ts, ready.ts, doctor.ts, ...)
│   └── cli.ts                     # argparse 대체 진입점 (util.parseArgs)
├── templates/                     # ccr.sh heredoc 페이로드를 그대로 파일화 (44개, byte-identical)
│   ├── bin/                       # 27개
│   ├── claude-commands/           # 14개
│   ├── config/                    # 3개 (dev-prompt.md, reviewer-prompt.md, codex-home/AGENTS.md)
│   └── selftest-install.py        # 설치 시점 selftest 블록 추출본
├── test/
│   ├── golden/                    # ccr.sh ↔ templates 재구성 byte parity 고정값
│   └── golden*.test.ts            # Bun 테스트(net) + drift guard
└── scripts/
    └── check-templates-sync.ts    # templates/가 ccr.sh heredoc과 byte-identical인지 단언
```

`src/`, `src/lib/`, `src/commands/`, `test/`, `scripts/`는 현 시점 아직 미생성 디렉터리이며, `package.json`은 이미 이 경로들을 가리키도록 작성되어 있다. **`ccr.sh`는 parity가 완전히 검증될 때까지 진실 공급원으로 남는다.**

---

## 3. 런타임 모듈 분할안 (ccr-hook.py의 향후 Bun 포팅)

`ccr-hook.py`의 118개 최상위 함수는 0개 클래스 위에 절차적으로 구성되어 있어, 기능 그룹별 모듈 경계가 비교적 자연스럽게 잡힌다. 아래는 함수 그룹 → 제안 모듈 매핑이다. 함수명은 현재 `ccr-hook.py`에 존재하는 대표 함수다.

| 제안 모듈 | 책임 | 대표 함수 |
|---|---|---|
| `lib/io.ts` | JSON/텍스트/JSONL 입출력, stdin 파싱, 시각·문자열 유틸 | `now`, `load_json`, `write_json`, `append_jsonl`, `read_stdin_json`, `read_text`, `sanitize`, `_truncate_text`, `_truncate_sections`, `_join_sections` |
| `lib/paths.ts` | 워크스페이스/서피스 식별, 경로 계산, 세션 디렉터리 | `workspace_id`, `surface_id`, `workspace_config_dir`, `root_for_cwd`, `session_dir`, `session_context_path`, `session_ledger_path`, `session_intent_path`, `skip_marker_path`, `workspace_enabled` |
| `lib/lock.ts` | 상태 파일 잠금·기본값·dirty 마커 | `locked_state`, `default_state`, `write_status`, `mark_dirty`, `clear_dirty`, `has_dirty`, `ensure_session` |
| `lib/git.ts` | git 호출, diff 수집·해시·변경 판정 | `git`, `inside_git`, `safe_rel_path`, `diff_pathspecs`, `read_untracked_patch`, `collect_diff`, `_diff_has_content`, `count_changed_lines`, `compute_delta_patch`, `bash_looks_mutating`, `should_mark_dirty_for_tool` |
| `lib/cmux.ts` | cmux 서피스 통신·역할·핸드오프 | `cmux`, `cmux_log`, `cmux_status`, `cmux_notify`, `send_to_surface`, `role_for_current_surface`, `surface_for_role`, `opposite`, `is_ccr_handoff_prompt` |
| `lib/intent.ts` | 세션 의도 추출·렌더링·원장 | `capture_session_context`, `load_session_context`, `extract_intent_from_message`, `load_session_intent`, `render_intent_section`, `append_ledger`, `build_iteration_table`, `load_review_instructions` |
| `lib/review.ts` | 리뷰 시작/종료/결정·요청 마크다운·재시도 회수 | `start_review`, `finish_review`, `parse_decision`, `reviewer_block_response`, `request_markdown`, `scope_request_markdown`, `build_worker_followup`, `parse_previous_review`, `reap_stale_active`, `_active_request_age_seconds`, `consume_skip_marker`, `_count_must_fix_in_text`, `_is_sentinel_must_fix` |
| `lib/report.ts` | 세션 리포트 생성·라운드 집계 | `generate_session_report`, `_try_generate_report`, `find_previous_round_dir`, `_round_must_fix_count`, `_round_files_touched`, `_files_touched_from_diff_text`, `_fenced_markdown_block`, `_format_duration`, `_latest_session_id` |
| `lib/hooks.ts` | 훅 이벤트 디스패치 | `handle_hook`, `handle_pre_tool`, `handle_user_prompt_submit`, `tool_name`, `tool_command`, `ensure_info_exclude` |
| `commands/*.ts` | 사용자 명령 1파일 1명령 | `command_enable`/`disable`/`reset`/`status`/`request`/`cancel`/`history`/`show`/`skip_next`/`report`/`doctor`/`support`/`ready`/`selftest`/`preview`/`prune`/`config`/`events`/`check`/`uninstall`, 보조: `_preview_data`, `_prune_candidates`, `_ready_checks`, `_doctor_action_items`, `_config_doc`, `_check_doc`, `_read_events`, `_run_selftest_case`, `_selftest_cases` |
| `cli.ts` | 인자 파싱·디스패치 진입점 | `main` (argparse → `util.parseArgs`로 대체) |

포팅 순서는 의존성이 적은 leaf 모듈(`io`, `paths`)부터 상향한다(5절 Phase 2 이후 참조).

---

## 4. 위험 등록부 (Risk Register)

난이도 높은 순으로 정렬. 각 항목은 Python stdlib 의존 → Bun/Node 동등물 매핑 전략이다.

| 순위 | 위험 | 출처 | Bun/Node 전략 | 난이도 |
|---|---|---|---|---|
| 1 | **`fcntl.flock` advisory lock** — `locked_state()`가 상태 파일에 LOCK_EX/LOCK_UN을 걸어 동시 훅 갱신을 직렬화(`ccr-hook.py`: `import fcntl`, `fcntl.flock(...LOCK_EX)`/`LOCK_UN`). | `locked_state` | Bun/Node에는 POSIX advisory flock 직접 바인딩이 없다. `O_EXCL` 락파일(원자적 생성 + stale 회수)로 구현하거나, 0-의존성 제약을 완화할 경우 `proper-lockfile` 검토. 동작 의미(블로킹 vs 즉시 실패)와 stale 처리 정책을 byte-stable한 상태 갱신과 함께 보존해야 한다. | 높음 |
| 2 | **`argparse`** — 단일 flat 파서가 `--command` choices(20개 명령)로 디스패치하며, `action="append"`(`--file`/`--dir`/`--question`/`--note`), `choices=`(`--agent`/`--reviewer`/`--type`), `type=int`(`--limit`/`--round`/`--keep`/`--days`), `set_defaults`(`--use-diff`/`--no-diff` 페어) 등 약 27개 `add_argument`로 35개 수준의 플래그/선택지 표면을 구성. | `main` | `node:util`의 `parseArgs`로 골격을 잡되 append 누적, choices 검증, int 파싱, `--no-*` 부정 페어 기본값은 수작업 후처리로 보강. 미지원 의미(append, choices, set_defaults)는 parseArgs가 자동 처리하지 않으므로 명시 구현 필요. | 높음 |
| 3 | **`zipfile`** — `ccr-support` 진단 번들을 `ZIP_DEFLATED`로 압축 생성/검증(`ccr-hook.py`: `zipfile.ZipFile(... "w", ZIP_DEFLATED)`, 읽기 시 `ZipFile(bundle)`). | `command_support` | Bun/Node 내장 zip 생성기가 없다. 시스템 `zip`/`unzip` CLI를 `Bun.spawnSync`로 호출하거나, 0-의존성 유지가 어려우면 경량 zip 라이브러리 검토. 아카이브 엔트리 이름·구성(`doctor.json`, VERSION, state/status, events tail, 세션 메타)을 보존. | 중간 |
| 4 | **`re` vs JS RegExp** — 의도 추출·결정 파싱·markdown fence·sentinel 카운트 등 7개소에서 `re.search/sub/...` 사용. | `extract_intent_from_message`, `parse_decision`, `_fenced_markdown_block`, `_count_must_fix_in_text` 등 | JS RegExp로 직역하되 Python 특유의 차이(인라인 플래그 `(?i)`, `re.MULTILINE`/`re.DOTALL` 의미, `\b` 경계, 비탐욕 매칭, named group 문법, `re.sub` 콜백)를 케이스별로 검증. 결정 파싱은 fenced 예제/blockquote를 verdict로 오인하면 안 되므로 회귀 테스트 필수. | 중간 |
| 5 | **`hashlib`** — `collect_diff` 전체 텍스트의 `sha256` hexdigest로 diff 변경 판정. | `collect_diff` (`diff_hash = hashlib.sha256(...).hexdigest()`) | `node:crypto`의 `createHash("sha256")`로 직접 대응. UTF-8 인코딩만 일치시키면 동등. | 낮음 |
| 6 | **`subprocess`** — git 호출과 cmux 통신 등 11개소. | `git`, `cmux`, `send_to_surface` 등 | `Bun.spawnSync`(또는 `node:child_process`)로 대응. stdout/stderr/exit code, 입력 전달, 환경변수 처리만 정합. 동기 호출이라 매핑이 단순. | 낮음 |
| 7 | **hook stdin/stdout JSON 계약** — 훅은 stdin으로 JSON을 받고 stdout으로 JSON 응답을 낸다. Claude/Codex가 바이트 단위로 파싱하므로 **byte-stable**해야 한다. | `read_stdin_json`, `handle_hook`, `reviewer_block_response` | 키 순서·공백·이스케이프·trailing newline까지 기존 출력과 동일하도록 직렬화 형식을 고정하고, 실제 stdin→stdout을 캡처한 골든 픽스처로 회귀 검증. JS `JSON.stringify`의 기본 출력과 Python `json.dumps`의 차이(공백, non-ASCII 이스케이프)에 특히 주의. | 낮음~중간 |

추가 stdlib(`tempfile`, `shutil`, `calendar`, `contextlib`, `io`)은 `node:fs`/`node:os`/`Date` 동등물로 직역 가능하여 별도 위험으로 분류하지 않는다.

---

## 5. 단계별 계획 (Phase 0..5)

| Phase | 목표 | 산출물 | 상태(이번 라운드) |
|---|---|---|---|
| **0** | **골든 테스트 확립** — `ccr.sh` 동작과 templates 재구성에 대한 고정값(byte parity, JSON 계약 등)을 잠근다. | `test/golden*`, `test/golden*.test.ts` | DONE / IN-PROGRESS (net + drift guard 추가됨) |
| **1** | **설치기 분해** — `ccr.sh`의 heredoc 페이로드를 `templates/`로 추출(byte-identical), 설치 로직을 `src/install.ts`로 포팅. `ccr.sh`는 불변. | `templates/`(44), `src/install.ts`, `templates/selftest-install.py` | DONE / IN-PROGRESS (templates·selftest·install.ts 완료, 컴파일 검증) |
| **2** | **순수 유틸 포팅** — 의존성 없는 leaf 모듈 우선. | `lib/pycompat.ts`, `lib/constants.ts`, `lib/{text,diff,decision,intent,tool,misc}.ts`, `lib/request.ts` | **2a DONE** (no-I/O 순수 함수 ~26개 + 기반 2개, 오라클 차등테스트 통과). **2b DONE** (`request_markdown`/`scope_request_markdown`를 `lib/request.ts`로 포팅 — 실제로는 FS 비의존 순수 빌더였음, 오라클 차등테스트 통과). |
| **3** | **락 + 상태** — advisory lock과 상태 파일 갱신을 byte-stable하게 포팅. 위험 1·5번 해소. | `lib/io.ts`, `lib/paths.ts`, `lib/lock.ts`, `lib/git.ts`(diff 해시 포함) | **DONE** (io/paths/lock/git 포팅, 상태/이벤트 파일 byte-parity + collect_diff sha256 parity를 오라클 통합테스트로 검증; 위험 1은 O_EXCL 락으로 의미 보존, 위험 5는 node:crypto sha256로 해소). |
| **4** | **리뷰 코어 + 훅** — 리뷰 시작/종료/결정 파싱과 훅 디스패치. JSON 계약(위험 7)과 정규식(위험 4) 회귀 검증. | `lib/session.ts`, `lib/review.ts`, `lib/report.ts`, `lib/cmux.ts`, `lib/hooks.ts` | **4a DONE** (FS 세션/의도/원장 + 리뷰/리포트 헬퍼: capture/load_session_context, load_session_intent, append_ledger, build_iteration_table, load_review_instructions(`session.ts`); find_previous_round_dir, parse_previous_review, build_worker_followup(`review.ts`); _latest_session_id, _round_must_fix_count, _round_files_touched(`report.ts`). 오라클 통합테스트 `test/phase4.test.ts` 통과). **4b-1 DONE** (`cmux.ts`: cmux/cmux_log/cmux_status/cmux_notify, send_to_surface, role_for_current_surface, surface_for_role, workspace_enabled; role/surface/enabled는 격리 workspace로 오라클 검증, subprocess는 충실 포팅[Bun spawnSync가 런타임 PATH override를 무시해 fake-cmux 불가 → 빈-surface 가드만 테스트]). **4b-2a DONE** (`report.ts`: generate_session_report + _try_generate_report; `review.ts`: consume_skip_marker, _active_request_age_seconds, reap_stale_active; `cmux.ts`: 명시적 PATH 해석으로 fake-cmux 대체 가능. 오라클 통합테스트 `test/phase4b2.test.ts`: report.md/status.json/events byte-parity + reaper + skip; 4b-1의 "Bun이 런타임 PATH 무시" 진단은 `bun -e` argv 미전달 결함으로 정정 — PATH는 정상 반영되어 fake-cmux로 send-success 경로도 검증 가능). **4b-2b DONE** (`review.ts`: start_review/finish_review 오케스트레이션(state in-place 변이; collectDiff/requestMarkdown/session·report 헬퍼/cmux/lock 재사용; `{n:04d}` 경로·핸드오프 메시지 문자열·active_request/last_completed 키 순서 정합); `hooks.ts`(신규): handle_pre_tool/handle_user_prompt_submit/handle_hook(lockedState 콜백 클로저로 result 캡처)/ensure_info_exclude. 오라클 통합테스트 `test/phase4b2b.test.ts`: end-to-end(UserPromptSubmit→dirty→Stop[start_review]→reviewer Stop[finish_review]) byte-parity[round files/review/decision/ledger/context/report/status/events + state·active_request 키순서], handle_pre_tool 5케이스, handle_user_prompt_submit reset/handoff, handle_hook 안전 게이트 경로(ENABLED_FILE 미변경), ensure_info_exclude 멱등성. JSON 계약(위험 7)은 라이브러리 반환 dict의 Python 키 순서로 충족; hook stdout byte-직렬화는 Phase 5 CLI로 이월). **Phase 4 완료** — 남은 것은 Phase 5(CLI + ccr-hook.py/ccr.sh 제거)뿐. |
| **5** | **CLI 명령 + ccr-hook.py 제거** — `cli.ts`(argparse 대체)와 `commands/*.ts` 완성, parity 전체 검증 후 `ccr-hook.py`(및 종국에 `ccr.sh`)를 제거하고 Bun 런타임을 진실 공급원으로 승격. | `cli.ts`, `commands/*.ts`, parity 리포트 | **5a DONE** (키스톤: hook 진입점 + 바이트 정확 stdout/위험 7. `io.ts`: pyJsonCompact[미정렬·삽입순서] + readStdinJson; `src/cli.ts`: hook 경로(--agent/--event 파싱→readStdinJson→handleHook→result≠null일 때만 pyJsonCompact+"\n", 항상 exit 0; --command은 5b–5d까지 throw). 오라클 테스트 `test/phase5a.test.ts`: ccr-hook.py와 `bun src/cli.ts`를 **동일 임시 HOME/CCR_ROOT/CMUX 환경 + fake cmux**로 서브프로세스 실행해 stdout-byte+exit 패리티 비교 — 게이트 경로 + enabled PreToolUse 차단(codex 중첩 deny / claude flat block 형태로 직렬화 키순서·중첩 검증). 서브프로세스+HOME 패리티 전략 확인). **5b DONE** (읽기 명령 7개: status/history/events/show/report/preview/config → `src/commands/*.ts` + `src/lib/args.ts`[argparse 대체: choices/append/int/store_true·false; ArgError→exit 2] + pycompat ljust/rjust. 오라클 `test/phase5b.test.ts` 18케이스: `ccr-hook.py --command X` vs `bun src/cli.ts --command X` stdout+exit 패리티[text+json, 에러 경로, stale-active hint, report]). **5c DONE** (상태변경 7개: enable/disable/reset/cancel/skip-next/prune/request → `src/commands/*.ts`. 오라클 `test/phase5c.test.ts` 11케이스: 런타임별 분리 HOME+CCR_ROOT에서 stdout+exit+산출물[state/status/ENABLED_FILE/skip-next/report] 패리티; root/home/cwd/TS/manual-<epoch>id/prune age_days 정규화). 부수 수정: phase4b2b의 report.md `duration`(now() 파생, 두 독립 실행 간 ≤1s 차이) 정규화로 풀-스위트 플레이크 해소 — 포트 버그 아님. **5e DONE** (번들 파이프라인: `scripts/build-cli.ts`가 Bun.build로 의존성 인라인 단일 `dist/ccr-cli.js` 생성[결정적·배너], `build:cli` 스크립트, `dist/` gitignore. `test/phase5e.test.ts` 6케이스로 번들 ≡ `bun src/cli.ts` 동작 동일성 검증). **5d DONE**(진단 6개 전부 포팅: `diag.ts`[which/isExecutable/jsonFileContains/installLayout], doctor/ready/check/support/selftest/uninstall. support는 zero-dep STORED zip — stdout/경로/파일목록 패리티, zip 바이트는 DEFLATE와 달라 비교 제외[문서화]. selftest는 12케이스 스모크 하니스로 TS lib 재검증→전부 PASS로 오라클과 일치. `test/phase5d.test.ts` 16케이스: 임시 HOME 가짜 설치 + 서브프로세스 패리티. 풀 스위트 933 pass/0 fail). **5f UNBLOCKED**(전 명령 포팅 완료: `bun build`→templates/bin/ccr-cli.js[+check:sync 허용], ccr.sh bin python3→bun 재결선, install.ts de-python, 오라클 테스트 재지정, ccr-hook.py 제거). 결정: 단일 번들 `ccr-cli.js`(bun build), ccr.sh 유지+bun 재결선. |

각 Phase는 직전 Phase의 골든/회귀 테스트가 통과해야 다음으로 진행한다. Phase 5 완료 전까지 `ccr.sh`는 절대 제거하지 않는다.

---

## 6. 이중 진실 공급원 주의사항 & 드리프트 가드

전환기에는 **같은 페이로드가 두 곳에 존재**한다 — `ccr.sh`의 heredoc과 `templates/`의 파일. 두 사본이 어긋나면(drift) 설치 결과가 갈라진다.

- **`scripts/check-templates-sync.ts`** 는 `templates/`의 44개 파일이 `ccr.sh`의 대응 heredoc 본문과 **byte-identical**한지 단언한다. `ccr.sh`의 `cat > "$BIN_ROOT/..." <<'EOF'` / `<<'PY'` / `<<'CCR_*_EOF'` 블록을 파싱해 추출본과 바이트 비교한다.
- 이 검사는 **CI와 pre-commit**에서 실행되어야 한다. `package.json`의 `check:sync` 스크립트(`bun run scripts/check-templates-sync.ts`)가 진입점이다. 어느 한쪽만 수정되면 검사가 실패하여 드리프트를 차단한다.
- **계약**: 전환기 동안 페이로드 변경은 항상 `ccr.sh`(진실 공급원)에 먼저 반영하고 `templates/`를 재추출하거나, 동시 수정 후 `check:sync`로 동기성을 보장한다. `templates/`만 단독 수정해서는 안 된다.
- **종료 상태(end-state)**: Phase 5에서 Bun 런타임 parity가 검증되면 `ccr.sh`를 `templates/` + `src/install.ts` 조합으로 **대체**한다. 그 시점에 드리프트 가드는 단일 공급원 검사로 역할이 바뀌거나 제거되며, 이중 공급원 상태는 해소된다.

---

## 7. 현재 라운드 상태 (Status of THIS round)

이번 라운드에서 완료된 작업:

- **`templates/` 추출 완료** — `ccr.sh` heredoc에서 44개 파일(bin 27 + claude-commands 14 + config 3)을 추출했다. byte-identical 재구성이 검증되었다(검증 기준값: **195,891 bytes, 44 files**). `ccr.sh`는 변경 없이 그대로다.
- **`templates/selftest-install.py` 추출** — `ccr.sh`의 설치 시점 selftest 블록(`python3 - <<'SELFTEST'`, @ccr.sh:4746)을 별도 파일로 추출했다.
- **`src/install.ts` 작성** — `ccr.sh`의 설치 로직을 TypeScript로 포팅했다. 컴파일/타입체크 대상이며 **실행하지 않는다**(`~/.claude`, `~/.codex`, `~/.local/bin`, `~/.zshrc`, `~/.config` 비변형).
- **골든 net + 드리프트 가드 추가** — `test/golden*` 픽스처와 `scripts/check-templates-sync.ts`(byte parity 단언)를 추가했다.
- **툴체인** — **Bun 1.3.11** 사용 가능. `package.json`(`type=module`, `engines.bun>=1.0.0`, scripts: `install:ccr`/`test`/`check:sync`/`typecheck`)과 strict `tsconfig.json`이 준비되어 있다.

> 비고: 이 7절은 전환 착수 시점(Phase 0/1)의 스냅샷이다. 진행 현황은 아래 Phase별 산출물 절(2a/2b/3)과 5절 단계 표가 최신 기준이다.

미생성/후속(다음 라운드 기준 — 갱신):

- `src/lib/*`는 Phase 2a/2b/3에서 생성되었다(`pycompat`/`constants`/`text`/`diff`/`decision`/`intent`/`tool`/`misc`/`request`/`io`/`paths`/`lock`/`git`). `src/commands/*`와 `src/cli.ts`는 아직 미생성이며 Phase 5 대상이다.
- `ccr-hook.py`의 Bun 포팅은 Phase 2a~3까지 진행되었고(순수 유틸 + I/O/락/git 계층), 리뷰 코어·훅 디스패치(Phase 4)와 CLI(Phase 5)가 남아 있다. parity 전체 검증 후 Phase 5에서 제거 대상이다.

> 비고: `ccr-hook.py`는 현재 추출본 기준 3754 라인이며, 인벤토리상 명목 수치는 3757 라인이다(추출/정규화에 따른 미세 차이). 위 byte parity 기준값(195,891)은 이번 라운드의 검증 산출물 수치를 그대로 기록한 것이다.

### Phase 2a 산출물 (런타임 순수 함수 포팅)

- **기반 2개** (`src/lib/pycompat.ts`, `src/lib/constants.ts`): Python 문자열/경로 의미(`splitlines`, `strip/lstrip/rstrip`, `utf8ByteLength`, `cpLength/cpSlice`, `cpCompare`, `splitWhitespace`, `posixParts/posixName`)와 정규식·상수를 단일 출처로 포팅. Python 오라클과 직접 검증.
- **leaf 모듈 6개**: `text.ts`(sanitize, opposite, joinSections, truncateSections, truncateText, fencedMarkdownBlock, formatDuration), `diff.ts`(diffHasContent, countChangedLines, filesTouchedFromDiffText, safeRelPath, diffPathspecs), `decision.ts`(parseDecision, isSentinelMustFix, countMustFixInText), `intent.ts`(extractIntentFromMessage, renderIntentSection, isCcrHandoffPrompt), `tool.ts`(toolName, toolCommand, bashLooksMutating, shouldMarkDirtyForTool), `misc.ts`(defaultState, reviewerBlockResponse, doctorNextMessage, doctorActionItems).
- **차등 테스트** `test/differential.test.ts`: 함수별 풍부한 엣지케이스 코퍼스를 **Python 프로브(오라클) ↔ TS** 로 deepEqual 비교(기대값을 오라클에서 런타임 취득 → 치팅 불가). 전체 스위트 **683 pass / 0 fail**.
- 적대적 모듈 리뷰에서 발견된 분기 중 현실적·저비용 항목(코드포인트 정렬, `str.split()` 공백 집합)은 `pycompat`에 `cpCompare`/`splitWhitespace`를 추가해 **수정**, 오라클로 재검증함.

### Phase 2b 산출물 (리뷰 요청 마크다운 빌더 포팅)

- **`src/lib/request.ts`**: `request_markdown`(자동 라운드 요청)과 `scope_request_markdown`(수동 스코프 요청)을 포팅. 계획 초안은 이들을 "FS 의존"으로 분류했으나, 실제 소스를 보면 `diff_file`/`delta_file`/`scope_file` 등 `Path` 인자를 **f-string으로 문자열 보간만** 할 뿐 읽기/쓰기가 없는 **순수 빌더**다. 따라서 별도 FS 오라클 없이 기존 차등 하니스로 검증 가능했다(모델링 주의사항은 아래 D7 참조). 큰 리뷰어 지시문 블록은 `ccr-hook.py`에서 그대로 전사했다.
- 기존 leaf 모듈을 재사용: `renderIntentSection`(intent.ts), `truncateText`/`fencedMarkdownBlock`(text.ts), `strip`(pycompat). 신규 보조: `pyGet`(dict.get 시맨틱), `pyStr`(None/True/False 포함 Python str() 보간), `pyTruthyObj`(빈 dict는 falsy인 Python `if d:` 시맨틱).
- **차등 테스트**: `request_markdown` 24케이스 + `scope_request_markdown` 22케이스를 추가(부분 인자배열로 positional 기본값까지 점진 검증). 다국어/이모지/백틱 펜스 에스컬레이션/12000+ 코드포인트 절단/빈 dict 등 엣지를 포함. 전체 스위트 **699 pass / 0 fail**(차등 단독), 전체 **736 pass / 0 fail**.
- 오라클이 잡아낸 분기 2건(`previous_review`/`worker_followup`가 빈 dict일 때 JS에서는 truthy라 섹션을 잘못 방출)은 **포팅 버그**였고 `pyTruthyObj`로 **수정**했다 — 수용된 분기가 아니라 정정된 결함이다.
- **리뷰 프로세스 프롬프트 업데이트**: `request_markdown`/`scope_request_markdown`의 "Review process" 블록을 기존 "6 subagents/6 렌즈"에서 **parallel-code-review 스타일 8렌즈(A1–A8) 독립 병렬 리뷰**(루트원인 중복 클러스터링, 로컬 증거 검증, 희귀 단독 발견 보존)로 교체했다. **결정 계약은 불변**(`REVIEW_DECISION:` + `## Must Fix`/`## Should Consider`/`## Verdict` 그대로 — `parse_decision`/`_count_must_fix_in_text` 무영향). 세 진실원(`ccr.sh` 히어독 ↔ `templates/bin/ccr-hook.py` byte-identical via check:sync ↔ `src/lib/request.ts` via 차등테스트)에 동일 적용·재검증했다.

### Phase 3 산출물 (I/O + 락 + git/diff 수집 포팅)

- **`src/lib/io.ts`**: `now`/`loadJson`/`writeJson`/`appendJsonl`/`readText`. 핵심은 **바이트 안정 직렬화**다 — `writeJson`은 `JSON.stringify(data, null, 2)+"\n"`가 Python `json.dumps(ensure_ascii=False, indent=2)`와 정확히 일치함을 활용하고, `appendJsonl`은 그렇지 않으므로(`JSON.stringify`는 공백 없는 구분자에 키 정렬 없음) `pyJsonCompactSorted`가 Python의 `", "`/`": "` 구분자 + 재귀 키 정렬(`sort_keys=True`)을 재현한다. `getOrNull`은 `dict.get(k)`의 None 기본값을 모사(`undefined`→`null`)해 `JSON.stringify`가 키를 누락하지 않게 한다.
- **`src/lib/paths.ts`**: `workspaceId`/`surfaceId`/`rootForCwd`/`sessionDir`/`sessionContextPath`/`sessionLedgerPath`.
- **`src/lib/lock.ts`**: `lockedState`(higher-order — Python contextmanager의 `with` 본문을 콜백으로 치환)/`writeStatus`/`markDirty`/`clearDirty`/`hasDirty`/`ensureSession`. 모든 상태 객체는 Python dict와 **동일한 키 삽입 순서**로 구성해 indent 출력이 바이트 일치한다.
- **`src/lib/git.ts`**: `git`/`insideGit`/`readUntrackedPatch`/`collectDiff`/`computeDeltaPatch`. Phase 2a의 순수 diff 헬퍼(diff.ts)를 재사용하고 I/O 셸만 추가. `collectDiff`의 `diff_hash`는 잘리지 않은 전체 텍스트의 `node:crypto` sha256이라, 한 바이트라도 어긋나면 해시가 달라진다.
- **`pycompat.ts`**: `splitlinesKeepends`(Python `str.splitlines(keepends=True)`) 추가 — `readUntrackedPatch`가 사용.
- **보안 하드닝(리뷰 반영, py↔ts 동일 적용)**: (1) `sanitize`가 all-dots 세그먼트(`.`/`..`)를 언더스코어로 remap해 `sessionDir` 경로 이탈 차단. (2) `read_untracked_patch`가 심링크-해석된 repo-상대 경로에 `safe_rel_path`를 재실행해 in-tree 심링크의 민감파일 유출 차단. (3) `collect_diff`의 `git diff`에 `--no-ext-diff --no-textconv` 부여(저장소 설정 diff 헬퍼 실행 방지). (4) 모든 파일 쓰기 경로가 예측 불가 랜덤명 + `O_EXCL` no-follow 생성 후 `rename`으로 원자 교체(`write_json`/`computeDeltaPatch`의 TS 공용 `writeFileAtomic`, py는 `tempfile.mkstemp`+`os.replace`)하고, append 경로(`append_jsonl`)는 `O_NOFOLLOW`로 열어 적대적 심링크 클로버를 차단. (5) 락을 **디렉터리 락**(`state.lock.d`, 원자적 `mkdir` acquire + `<dir>/owner` 토큰을 full-write 후 `readOwner===myToken` 재검증 + 원자적 `rename` 회수)으로 전환해 파일+reaper 설계의 반복된 reaper 경쟁을 reaper 제거로 근본 해소(D8). 각 항목 회귀 테스트 추가(동시 dead-lock 회수 경쟁, 무-사전락 순수 경합, owner-less/empty/corrupt owner 회수, Python-오라클 적대적 심링크, append_jsonl/computeDeltaPatch 심링크, writeJson 직렬화·rename 실패 시 temp 정리 포함).
- **통합 테스트** `test/phase3.test.ts` + `test/phase3-probe.py` + `test/phase3-lock-runner.ts`: 순수함수가 아니므로(FS/subprocess) Python 런타임과 TS를 **병렬 임시 디렉터리/공유 임시 git repo**에 실행하고 산출물을 바이트 비교한다 — state/status/dirty/session.json, events.jsonl(타임스탬프만 `<TS>`로 정규화), 그리고 `collectDiff` 전체 튜플(특히 sha256 `diff_hash`). 부패 상태 fallback, `last_report` 보존, `created_at` 보존(비-타임스탬프 sentinel로 검증), 민감/바이너리/대용량/혼합개행 untracked 파일 제외·인코딩, **심볼릭 링크 외부유출 차단(realpath 정규화) 및 in-tree 심링크 패리티**, **별도 프로세스로 구동하는 락 회귀(live-holder는 절대 steal 안 됨, dead-PID 다중 경쟁자 reclaim에서 lost-update 없음)**까지 커버한다. 모든 케이스가 통과하며 전체 스위트도 green(절대 통과 수치는 라운드마다 바뀌므로 기록하지 않는다).

---

## 8. 알려진 분기 레지스트리 (Known divergences — accepted)

아래는 Python `re`/런타임과 JS 사이의 **의도적·수용된** 동작 차이다. 모두 **CCR의 실제 입력(리뷰 마크다운, git diff, bash 명령, hook JSON)에서는 발생하지 않는 비현실적·적대적 입력**에서만 나타나며, 차등 테스트의 현실 입력 공간(683 케이스)은 완전 일치한다. Phase 5 parity 검증 시 이 목록을 재확인한다.

| # | 위치 | 분기 | 트리거(비현실적) | 결정 |
|---|---|---|---|---|
| D1 | `tool.ts` `toolName`/`toolCommand` | `tool`/`tool_input`이 present-but-non-dict면 Python은 `AttributeError`로 크래시, TS는 `""` 반환 | `{tool:null}`, `{tool:"x"}`, `{tool:{input:null}}` | TS의 방어적 동작 유지. hook 핸들러에서 크래시 복제는 부적절하며 실제 페이로드는 항상 객체. 코드 주석에 명시. |
| D2 | `constants.ts` 정규식의 `\s` | Python `re`의 `\s`는 U+001C–U+001F·U+0085를 포함, JS는 미포함(대신 U+FEFF 포함) | 명령/리뷰 텍스트에 C0 제어문자·NEL·BOM이 키워드 인접 | 수용. `\s` 전부를 명시 클래스로 치환하면 가독성·신규버그 위험. DECISION_RE/INTENT_*/MUTATING_BASH_PATTERNS에 해당. |
| D3 | `constants.ts` 정규식의 `\b` | Python `\b`는 유니코드 단어경계, JS는 ASCII 전용 | 키워드 직후 악센트 문자(`git addé`, `requesté`) | 수용. JS는 유니코드 `\b` 미지원(우회는 lookbehind 곡예). 실제 명령/헤더엔 미발생. |
| D4 | `tool.ts` 비문자열 강제변환 | Python `str(True)`→`"True"`, JS `String(true)`→`"true"` (None/null 동일) | `tool_name`/`command`가 bool/number | 수용. 실제 페이로드는 문자열. D1과 동일 근거. |
| D5 | `misc.ts` `doctorActionItems` | `row.get(k,"")`는 키 부재 시만 `""`; 값이 명시적 `null`이면 Python은 `None`, TS는 `?? ""`로 `""` | row 필드값이 명시적 `null` | 수용. row는 내부 코드가 항상 문자열로 채움. |
| D6 | `pycompat.ts` `posixParts` | `PurePosixPath('//a')`는 POSIX 특례로 root가 `'//'`, 포팅은 `'/'` | 선행 `//` 경로 | 무해. `safe_rel_path`의 `startsWith('/')` 가드가 선행 슬래시를 먼저 거부. |
| D7 | `request.ts` `Path` 인자(`diff_file`/`delta_file`/`scope_file`) | 런타임은 `Path` 객체를 넘기고 f-string이 `str(Path)`로 정규화(`Path('a//b')`→`'a/b'`)하지만, 차등 테스트는 동일 문자열을 양쪽에 직접 전달하므로 정규화가 발생하지 않음 | 비정규 경로 문자열(`a//b`, 후행 `/`)을 인자로 전달 | 수용(테스트 모델링 한정). 빌더는 보간만 하므로 양쪽이 동일 입력을 받으면 출력도 동일. 실제 호출자는 항상 정규화된 `Path`를 넘기며, 경로 정규화는 `safe_rel_path`/`posixParts`(D6)에서 이미 별도 검증됨. |
| D8 | `lock.ts` `lockedState` 락 메커니즘 | Python은 `fcntl.flock(LOCK_EX)`(블로킹, 커널이 fd close/프로세스 종료 시 자동 해제). 포팅은 **디렉터리 락** `<root>/state.lock.d`: acquire=원자적 `mkdirSync` 후 `pid:nonce` owner 토큰을 **원자 발행**(dir 내부 private temp를 full-write→`linkSync`로 `owner` 생성, link 성공 즉시 HELD 기록)하여 owner가 부분/빈 상태로 노출되지 않고 발행 실패 시 owner-less dir만 남아 자가복구; 살아있는 홀더(`process.kill(pid,0)`)는 block; 죽은/owner-less(grace 1s) 홀더는 **회수를 mkdir reclaim-lock으로 직렬화**하고 그 lock 아래에서 owner를 재확인한 뒤 디렉터리를 원자적 `renameSync`+`rmSync`로 제거(reclaim-lock은 마이크로초 보유라 age로 stale 회수) | 동시 훅이 동일 `root`에 경합하거나 홀더가 락 보유 중/발행 중 크래시 | 수용(위험 1에서 예고). **상호배제 의미만** 보존 — 결과 `state.json` 바이트 동일. `lockDir` 존재가 신규 `mkdir`를 막으므로, reclaim-lock 아래 owner 재확인→rename 사이에 owner가 live가 될 수 없어 살아있는 락을 옮기지 않는다(R9에서 늦은 reclaimer가 갓 재획득된 live dir을 rename하던 경쟁을 해소). 파일+reaper 설계의 반복 경쟁(R1~R3)은 reaper 제거로 해소. |
| D9 | `lock.ts` `lockedState` 호출 형태 / 재진입 | Python은 `with locked_state(root) as state:` contextmanager(yield 후 본문 실행→쓰기). 포팅은 `lockedState(root, (state) => {...})` 고차함수(콜백이 `with` 본문 역할) | — (API 형태 차이); 동일 `root`에 **중첩** 호출 | 수용. JS에 contextmanager 동치가 없어 콜백으로 치환. load→lock→mutate→write→unlock 순서·부작용 동일. 동일 root 재진입은 **즉시 throw**(블로킹=데드락, 회수=상호배제 붕괴이므로 fail-fast — Python flock도 이 경우 데드락). 프로세스 내 보유 토큰(`HELD_TOKENS`)을 추적해 자기 라이브 락은 회수하지 않는다(R2). 또한 `realpathSync(root)`로 락 정체성을 **정규화**해 심링크/상대경로 별칭이 가드를 우회하지 못하게 한다(R3). |
| D10 | `lock.ts` 크로스런타임 락 상호운용 | Python `fcntl.flock` ↔ Bun 락파일은 상호배제하지 못함 — flock 보유 상태는 파일 내용에 드러나지 않고(Python은 빈 비잠금 `state.lock`를 남김), 0-dep로 이식 가능한 flock 바인딩도 없음 | Python 훅과 Bun 포트가 동일 `root`에 **동시** 실행되는 가상 시나리오 | 수용(R1 리뷰 반영). 콘텐츠 기반 스킴으로는 flock 보유를 감지할 수 없는 **본질적 한계**. Phase 5에서 Python 런타임을 통째로 대체하므로 두 런타임은 동시 실행되지 않는다 → Bun 락은 **Bun 홀더 간** 상호배제만 보장(토큰 `pid:nonce`로 강화). |
