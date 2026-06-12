# rider-mcp-enforcer · gamedev-log-analyzer

[English](README.md) · **한국어**

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-7C3AED)](https://code.claude.com/docs/en/plugins)
[![MCP](https://img.shields.io/badge/MCP-server-1f6feb)](https://modelcontextprotocol.io)
[![release](https://img.shields.io/github/v/release/JSungMin/rider-mcp-enforcer)](https://github.com/JSungMin/rider-mcp-enforcer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/JSungMin/rider-mcp-enforcer/pulls)
[![Stars](https://img.shields.io/github/stars/JSungMin/rider-mcp-enforcer?style=social)](https://github.com/JSungMin/rider-mcp-enforcer/stargazers)

> 대형 Unreal C++ · Unity · .NET 프로젝트를 위한 Claude Code 플러그인 두 개. 코드베이스는 `grep`
> 대신 Rider 인덱스로 검색하고, 수십 MB짜리 에디터 로그는 대화에 통째로 쏟지 않고 읽습니다. 둘 다
> 토큰을 약 99% 적게 씁니다.

### 데모

`gamedev-log-analyzer`가 6,000줄 합성 엔진 로그를 수백 토큰으로 줄이는 모습
(`summary` / `search` / `locate` / `diff`):

![gamedev-log-analyzer 데모](demo/demo.svg)

### 실제 모습
```text
# Claude가 코드를 grep 시도 → 훅이 Rider 인덱스로 유도 (기본 warn):
$ grep -rn "AMyActor" Source/**/*.cpp
💡 [rider-mcp-enforcer] 코드 심볼 검색 감지. search_symbol / search_text (또는 code-locator
   서브에이전트) 권장.   # 하드 차단 원하면 RIDER_ENFORCE=block

▶ search_symbol "AMyActor"
  Source/Game/MyActor.h:42   class MYGAME_API AMyActor : public APawn   (+3 more)
  → ~120 토큰   (grep이면 ~14,000 덤프)

# 52MB 에디터 로그 → 파싱·dedup·분류:
▶ /gamedev-log-analyzer:logs
  41,233줄 · 에러 7 · 경고 312
  ERROR   [LogStreaming] Failed to load asset <addr>         (×128)   @ AssetManager.cpp:210
  WARNING [LogPhysics]   Penetration depth <n> exceeds limit (×4,051) @ MyComponent.cpp:88
  → ~900 토큰   (raw 로그 ≈ 1,300,000)
```
<sub>placeholder 심볼을 쓴 예시 출력.</sub>

### 이런 경험 있나요?
- 🔍 **거대 Unreal C++ repo에서 `grep`이 컨텍스트를 폭발** → Rider 인덱스로 검색, 토큰 상한 (**~99% 절감** — [벤치마크](#합산-토큰-절감-실측)).
- 🪵 **50MB 에디터 로그를 읽을 수 없음** → 파싱·dedup·분류해서 **~2,500 토큰**으로.
- 🤖 **Claude가 자꾸 코드를 `grep`** → 훅이 자동으로 **Rider 도구로 리다이렉트**.

### 목차
- [마켓플레이스 — 2개 플러그인](#마켓플레이스--2개-플러그인) · [합산 절감](#합산-토큰-절감-실측) · [두 플러그인 함께 쓰기](#두-플러그인-함께-쓰기)
- [무엇을 하나](#무엇을-하나) · [성능](#성능-실측) · [에디터 로그 분석](#에디터-로그-분석)
- [사전 요구사항](#사전-요구사항) · [설치](#설치) · [설정](#설정-명령어) · [업데이트](#새-버전으로-업데이트)
- [설정 항목](#설정-항목-env--config-키) · [문제 해결](#문제-해결) · [기여](#기여) · [Releases](https://github.com/JSungMin/rider-mcp-enforcer/releases)

---

Claude가 Bash `grep`과 텍스트 치환 대신 **JetBrains Rider의 실시간 인덱스**로 심볼 검색 · 참조(usage)
찾기 · 파일 검색 · 함수/변수 탐색 · 이름 변경(rename) 리팩터를 하도록 만들고, 참조가 폭발할 때 토큰
사용량을 상한선으로 막아주는 **Claude Code 플러그인**입니다.

이름 변경은 Rider의 `rename_refactoring`을 거칩니다. 프로젝트 전역의 모든 참조를 의미 기반으로 갱신하므로,
Claude가 심볼을 `sed`로 바꿔 부분일치에 빌드를 깨뜨리는 일이 없습니다. 라우팅 스킬의
[Refactoring](skills/rider-search/SKILL.md) 참고.

`grep`이 느리고 컨텍스트(토큰)를 잡아먹는 대형 **Unreal C++ (Rider for Unreal)** 및 **.NET/C#**
코드베이스를 위해 만들었습니다.

## 마켓플레이스 — 2개 플러그인

이 repo는 **"큰 것을 싸게 읽는다"** 는 한 아이디어를 공유하는 2개 플러그인이 든 Claude Code
**플러그인 마켓플레이스**입니다:

| 플러그인 | 기능 | 필요 |
| --- | --- | --- |
| **rider-mcp-enforcer** (이 페이지) | Rider MCP 심볼/참조/파일 검색을 grep 대신 강제, 토큰 상한 | Rider 실행 + MCP |
| **[gamedev-log-analyzer](gamedev-log-analyzer/README.ko.md)** | 거대 Unreal/Unity/Godot/MSVC-UBT-MSBuild 로그 파싱·dedup·분류·검색·diff·locate·스칼라 추출 (CLI 우선) | Node만 (IDE 불필요) |

**한 번에 설치** — `rider-mcp-enforcer`가 `gamedev-log-analyzer`를 의존성으로 선언해서 한 번 설치하면 둘
다 깔리고, 각 서버의 `npm install`은 첫 세션에 자동 실행됩니다(수동 설정 0):
```bash
/plugin marketplace add JSungMin/rider-mcp-enforcer
/plugin install rider-mcp-enforcer@rider-mcp-enforcer   # gamedev-log-analyzer도 자동 설치
/reload-plugins                                          # 첫 실행 시 둘 다 의존성 자동 설치
```
로그 분석기만 원하면 단독 설치: `/plugin install gamedev-log-analyzer@rider-mcp-enforcer`.

### 합산 토큰 절감 (실측)
| 작업 | Bash / raw | 플러그인 | 절감 |
| --- | ---: | ---: | ---: |
| UE5 repo 심볼 검색 | ~195,600 tok | ~1,700 tok | **~99%** |
| 57MB 에디터 로그 읽기 | ~1,250,000 tok | ~2,500 tok | **~99.8%** |
| 로그 트레이스 태그 1개 검색 (9,226 매치) | ~690,000 tok | ~1,700 tok | **~99.8%** |

### 두 플러그인 함께 쓰기
로그 분석기는 각 항목의 `file:line`을 출력하고, Rider 플러그인은 그 `file:line`을 실제 심볼/소스로
바꿉니다. 전형적 흐름:
1. `/gamedev-log-analyzer:logs` → 에러/경고와 그 `file:line` 찾기.
2. 그 위치를 rider-mcp-enforcer의 `get_symbol_info`/`read_file`(또는 `search_symbol`)에 넘겨 코드를
   열고 이해 — raw 로그를 grep하거나 덤프하지 않고.

반대 방향도 이어집니다. Rider의 코드 인덱스는 `Saved/`(로그·빌드 산출물)를 일부러 제외하므로, 로그를
겨냥한 검색이나 읽기는 여기서 빈 결과나 "not a directory"로 끝납니다. 프록시는 로그 경로를 향한
호출이나 로그에 있을 법한 빈 결과를 감지하면 응답 끝에 gamedev-log로 가라는 한 줄 포인터를 붙여서,
로그 분석 작업이 코드 인덱스를 상대로 헛돌지 않게 합니다.

## 무엇을 하나

Rider 2025.2+ 는 MCP 서버를 내장하고 있고, (라이브로 확인된) `search_symbol`, `search_file`,
`search_text`, `search_regex`, `find_files_by_name_keyword`, `find_files_by_glob`, `get_symbol_info`,
`rename_refactoring`, `read_file` 등 약 30개 도구를 노출합니다. 이 플러그인은 Claude가 grep 대신
그 도구들을 **실제로 쓰게 만드는** 레이어를 더합니다.

| 레이어 | 파일 | 효과 |
| --- | --- | --- |
| **강제 훅(hook)** | `hooks/block-code-grep.js` | C/C++/C# 소스를 노린 Bash `grep`/`rg`/`find -name`/`git grep`**과 내장 Grep 도구**를 가로채 Rider MCP 도구로 유도. **Bash는 기본 `warn`** — 명령은 그대로 실행되고 nudge가 모델 컨텍스트에 주입됩니다. `RIDER_ENFORCE=block`이면 하드 차단, `=0`이면 끔. **Grep 도구는 warn 전용이라 절대 차단하지 않습니다** — 방금 편집해 Rider가 아직 인덱싱 못 한 파일에선 Grep이 올바른 폴백이라, 명시적 코드 glob/type/path일 때만 살짝 nudge만 합니다(`=0`이면 침묵). MCP 검색과 Read 도구는 설계상 여전히 우회. 비코드 텍스트(로그/md/json)는 통과. |
| **`code-locator` 서브에이전트** | `agents/code-locator.md` | "X 어디 정의 / Y 호출처 / W 파일 찾기"를 컨텍스트 격리 서브에이전트에 위임 — Rider 인덱스를 내부에서 쓰고 간결한 `file:line` 테이블만 반환, raw 매치는 컨텍스트에 안 들어옴. 훅 마찰 없는 정확도+토큰 이득. |
| **라우팅 스킬** | `skills/rider-search/SKILL.md` | Karpathy 스타일 규칙: 심볼/파일/텍스트 검색은 Rider 도구 우선, grep은 최후수단. |
| **요약 프록시** | `proxy/` | Rider MCP 앞단의 MCP 서버. JSON 응답(`{items:[{filePath,startLine,lineText}],more}`)을 간결한 `path:line  text`로 변환하고 `RIDER_MAX_RESULTS`로 상한, 기본 `projectPath`를 자동 주입. 대형 코드베이스의 결과 폭발이 컨텍스트를 터뜨리는 걸 막음. |

> 범위를 분명히 하자면, 심볼/파일 검색은 Rider MCP만으로도 됩니다. 이 플러그인이 그 위에 더하는 건
> 강제, 토큰 제어, projectPath 처리입니다.

### 서브에이전트

두 플러그인 모두 작업을 통째로 넘길 수 있는 서브에이전트를 제공합니다. 서브에이전트는 자기
컨텍스트에서 raw 읽기와 검색을 하고 결과만 돌려주므로, raw 로그 줄이나 소스 매치가 메인 컨텍스트에
들어오지 않습니다. 훅처럼 게이트로 막는 게 아니라 컨텍스트 자체가 분리돼 있어 새어나갈 일이 없고,
한 가지 일만 하니 보통 더 정확합니다.

| 서브에이전트 | 용도 | 반환 |
| --- | --- | --- |
| `gamedev-log-analyzer:log-analyst` | "이 로그 분석", "에러/경고 뭐가", "뭐가 바뀌었나", "이 스칼라 추적", "코드별 경고" | 간결한 severity / dedup / 코드롤업 / `file:line` 답 (raw 로그 줄 없음) |
| `rider-mcp-enforcer:code-locator` | "X 어디 정의", "Y 호출처", "Z 전체 사용처", "W 파일 찾기" (Rider의 C#/.NET·Unreal C++) | 간결한 `kind name @ file:line` 테이블 (소스 본문 없음) |

그냥 자연스럽게 "`Editor.log` 분석해줘"나 "`AMyActor` 사용처 찾아줘"라고 하면 Claude가 description을
보고 알아서 위임합니다. namespaced 이름으로 직접 부를 수도 있습니다. 3,000줄 로그가 300토큰 정도로,
코드베이스 전역 검색이 `file:line` 수십 줄로 돌아옵니다. `code-locator`는 Rider MCP 연결이 필요하고,
`log-analyst`는 순수 CLI라 따로 필요한 게 없습니다.

### 명령어 & 도구
- `/rider-mcp-enforcer:setup` — 플러그인 설정 ([설정](#설정-명령어) 참고).
- `/rider-mcp-enforcer:savings` — 누적 토큰 절감량 표시.
- `/rider-mcp-enforcer:discover` — 로컬 Claude Code 트랜스크립트를 훑어 rider-search를 우회한 코드
  검색을 찾고, 놓친 절감량과 커버리지 비율을 집계로 보고(로컬 전용 — 경로·명령·코드는 출력에 안 담김).
  CLI: `node "<플러그인>/proxy/discover.mjs"`(프로젝트 루트에서 실행).
- MCP 도구(서버 `rider-search`): `rider_setup`, `rider_config`, `rider_detect`, `rider_savings`,
  `rider_savings_reset`, `rider_regen_project`, 요약되는 Rider 검색 도구들(`search_symbol`,
  `search_text`, …), 그리고 Rider 리팩터 도구(`rename_refactoring`, `move_type_to_namespace`,
  `reformat_file`).

> **이 Rider MCP 빌드의 실제 한계 2가지 (라이브 확인됨):**
> 1. **의미 기반 find-usages/find-references 도구가 없음.** 참조 찾기는 `search_text`/`search_regex`
>    (인덱스 문자열 매칭, 의미 기반 아님)로 대체됩니다.
> 2. **Unreal C++에서 `search_symbol`이 약할 수 있음** — 정확한 클래스 대신 파일명/경로 매칭(예:
>    `.Build.cs`)을 반환할 수 있음. 결과를 검증하고, 이상하면 `search_text`로 폴백하세요.

## 프로젝트 파일 재생성 (stale 인덱스)

디스크엔 분명히 있는 파일인데 검색이 "doesn't exist"나 빈 결과를 내놓는다면, 프로젝트 파일이 낡은
것입니다(마지막 생성 이후 소스를 추가·이동·이름변경했을 때). 그러면 Rider가 그 파일을 인덱싱하지
못합니다. 프록시는 이 상황을 감지해 재생성 단계를 안내하는데, **항상 dry-run이 먼저**라 확인하기
전까지는 아무것도 실행하지 않습니다.

- **`rider_regen_project` MCP 도구** — `confirm` 없이 호출하면 계획(해석된 `.uproject`, 엔진, 실행할
  정확한 명령)만 보여주고, `confirm:true`면 실제로 돌립니다. 빌드를 띄우는 작업이라 Claude Code가 처음
  한 번 도구 승인을 묻습니다(정상).
- **승인 프롬프트 없는 대안 — CLI**(`/rider-mcp-enforcer:regen`): 직접 실행하면 MCP 셸 승인 창이 안
  뜹니다 — `node "<플러그인>/proxy/regen.mjs"`(dry run) 후 `--confirm`. 기본값이 틀리면
  `RIDER_REGEN_CMD`/`RIDER_ENGINE_PATH`로 고정하세요. 자동 탐지는 Windows 전용입니다.

**재생성에 성공해도 Rider가 솔루션을 다시 로드**(프롬프트 수락, 또는 **File → Reload All from Disk** /
Unreal **Refresh**)해야 심볼 인덱스가 갱신되고 `search_symbol`/`rename_refactoring`이 새 파일을 찾습니다
— exit 0은 생성기가 돌았다는 뜻이지 Rider가 재인덱싱했다는 뜻이 아닙니다. (Rider엔 리로드를 거는 수단이
없어 플러그인이 대신 눌러줄 수 없습니다.) **MCP 도구**에 `verifyPath:"<없던 그 파일>"`을 넘기면, 확인
후 재생성이 끝난 뒤 Rider를 다시 찔러보고 리로드가 먹혔는지 알려줍니다(**✓** 보임 / **✗** 여전히 없음
→ 리로드하고 재시도). 검증엔 Rider 연결이 필요해서 MCP 도구 전용입니다(CLI엔 없음).

## 성능 (실측)

대형 UE5 프로젝트에서 한 클래스명(텍스트 occurrence 약 2,400개)을 Bash grep vs 이 플러그인으로 찾은
실측 A/B. 프로젝트 소스는 공개하지 않음 — 방법은 [BENCHMARK.md](BENCHMARK.md) 참고.

| | Bash grep (전체 repo) | Bash grep (게임 디렉토리) | **플러그인 (Rider MCP, 요약)** |
| --- | ---: | ---: | ---: |
| 모델로 가는 토큰 | ~195,600 | ~114,100 | **~1,700** |
| 소요 시간 | 55,006 ms | 382 ms | **~870 ms** |

- **토큰: 항상 ~98–99% 절감 (~67–115×).** 약 87%는 응답 요약, 나머지는 상한(capping).
- **시간: 전체 repo grep 대비 ~63× 빠름** (Engine 포함 스캔 시). 단, 이미 좁힌 grep보다는 약간 느림
  (MCP는 SSE 왕복 고정비용, ripgrep은 작은 범위에선 매우 빠름).

### 정확도 차이 (와 그 이유)
"누가 더 맞다"가 아니라 **정밀도(precision)/재현율(recall) 트레이드오프**입니다:
- **재현율:** 플러그인은 상위 `N`개(cap)만 반환, 2,400+ 전부가 아님. 빠진 ~98%는 대부분
  주석/include/부분문자열 노이즈. 전수가 필요하면 `RIDER_MAX_RESULTS`를 올리거나 grep 사용.
- **정밀도:** grep은 모든 부분문자열 매칭(`Foo` 검색이 `FooBar`도 매칭) → 여기선 약 100× 과다보고;
  플러그인 심볼 검색은 25개의 distinct 후보 파일 반환.
- **알려진 약점:** Unreal C++에서 `search_symbol`이 정확한 선언이 아니라 파일 1행을 가리킬 수 있음
  (Rider 인덱싱 한계). `search_text`는 실제 `file:line  코드`를 줌; 스킬이 심볼 결과가 이상하면
  `search_text`를 쓰라고 Claude에게 지시함.

> 정리: **탐색(정의 + 대표 사용처)** 용도면 플러그인이 더 정확하고 **훨씬** 저렴. **전수 감사**가
> 필요하면 cap을 올리거나 일부러 grep을 쓰세요.

### 불완전 결과 가드 (정확성 보호)
상한은 토큰엔 좋지만 "모든 참조 찾기"엔 위험합니다 — call site를 놓치면 잘못된 코드가 됩니다. 그래서
잘림(truncation)은 **절대 조용히 처리하지 않습니다**:

1. 첫 응답이 잘린 것 같으면 프록시가 더 큰 limit(`RIDER_ESCALATE_LIMIT`)으로 **1회 자동 재시도**해서
   실제 총 개수를 파악합니다.
2. 그래도 전수가 아니면 응답에 `⚠ INCOMPLETE RESULTS — showing X of Y+` 경고와 3가지 선택지를 붙임:
   **cap 올리기**, **범위 좁히기(`paths`)**, **부분 결과 허용 확인**.
3. 스킬은 Claude에게 지시: 참조/리팩터/리네임 작업이면 부분 목록으로 진행하지 말고 위 선택지를
   **유저에게 물어보라**고 함.

## 얼마나 절약했나? (토큰 절감 명령어)

요약 검색은 이득이 클 때마다 호출 끝에 `✓ Saved ~N tokens here (Rider index, summarized vs raw
response)` 한 줄을 붙여서, 절감 효과가 그 자리에서 바로 보이게 합니다(이 줄이 안 보이면 결과가 원래
작았다는 신호). 프록시는 같은 수치를 누적으로도 기록합니다. 누적 합계 확인 방법:

- **Claude Code에서:** `/rider-mcp-enforcer:savings` 실행 (또는 "플러그인이 얼마나 아꼈어?" 라고 질문).
  `rider_savings` MCP 도구를 호출합니다.
- **셸에서:** `node <플러그인경로>/proxy/stats.mjs`
- **리셋:** `rider_savings_reset` 도구 호출.

출력 예시:
```
rider-mcp-enforcer — cumulative token savings (vs forwarding Rider's raw responses)
  summarized calls : 1
  raw tokens       : ~30,398
  sent tokens      : ~362
  saved            : ~30,036 (99%)
  noise items dropped (build artifacts): 78
```
> 여기서 "saved"는 Rider의 *raw* 응답 대비입니다. **Bash grep** 대비 절감은 보통 훨씬 큽니다 —
> [BENCHMARK.md](BENCHMARK.md) 참고.

## VCS 출력 압축 (git / p4)

읽기 전용 `git status` / `git log` / `git diff`(또는 `p4 opened` / `status` / `changes` / `reconcile`)는
반복적이고 대부분 보일러플레이트인 수백 줄을 컨텍스트에 쏟곤 합니다. 훅은 그런 단일 명령을 압축 래퍼
(`proxy/vcs.mjs`)로 투명하게 우회시키는데, 래퍼는 **실제 명령을 그대로 실행한 뒤** 출력을 묶고
중복을 제거하고 상한을 겁니다 — `git status`는 변경 유형별 개수 + 상위 디렉터리로, `git log`는 커밋당
한 줄로, `git diff`는 파일별 `+추가/-삭제` diffstat으로(헌크 본문은 버림).

이건 *안전한* rewrite 부류입니다. 코드 검색은 Rider MCP를 타깃으로 해서 Bash→Bash rewrite가 불가능한
반면, `git`/`p4`는 항상 작동하는 로컬 CLI라 rewrite가 당신을 막다른 길로 몰 수 없습니다 — 명령은 그대로
실행되고, 출력만 압축돼서 돌아옵니다. 절대 차단하지 않으며,
0 아닌 종료나 빈 출력이면 실제 명령의 stdout/stderr를 그대로 통과시켜 "git repo 아님"/인증 오류가
원문대로 드러납니다.

조금이라도 애매하면 — 파이프라인, 셸 따옴표, `$`/리다이렉트, 서브커맨드 앞의 전역 플래그
(`git -C path status`), 또는 읽기 전용이 아닌 서브커맨드(`git commit`) — 입력 그대로 둡니다. 추측으로
바꾸지 않습니다. `p4 reconcile`은 읽기 전용 `-n` 미리보기 형태일 때만 압축하고(워크스페이스를 바꾸는
reconcile은 손대지 않음), 래퍼 자체도 읽기 전용이 아닌 `git`/`p4` 서브커맨드는 2차 방어선으로 거부합니다.
`git grep`은 **코드** 검색으로 남습니다(Rider 도구로 유도, 압축 안 함). 끄려면 `RIDER_COMPACT_VCS=0`,
상한은 `RIDER_VCS_MAX`(기본 60).

## 사전 요구사항

- **JetBrains Rider 2025.2+**, 실행 중, 대상 프로젝트가 열려 있을 것.
- PATH에 **Node.js ≥ 18**.
- Rider MCP 활성화: **Settings | Tools | MCP Server → Enable MCP Server**, 그다음 **Copy SSE Config**.

## 설치

```bash
# 1) 마켓플레이스 추가 + 설치 (gamedev-log-analyzer도 자동 설치)
/plugin marketplace add JSungMin/rider-mcp-enforcer
/plugin install rider-mcp-enforcer@rider-mcp-enforcer
/reload-plugins        # 첫 실행 시 서버 의존성 자동 설치 (수동 npm 불필요)

# 2) 설정 — Claude Code 안에서 그냥 실행:
/rider-mcp-enforcer:setup
#   Rider SSE 엔드포인트를 자동 탐지하고, 프로젝트 경로를 물어본 뒤 config를 기록합니다.
```

`rider-search` MCP 서버와 도구들이 보이는지, `grep src/**/*.cpp`에 Rider 도구 유도 nudge가 뜨는지
(또는 `RIDER_ENFORCE=block`이면 차단) 확인하세요. (각 플러그인 MCP 서버의 `npm install`은 세션 시작 시
`${CLAUDE_PLUGIN_DATA}`에 자동 실행됨.)

> **명령어가 안 보이면?** 대개 플러그인이 **설치 안 된 채 마켓플레이스만 add**된 상태입니다.
> `marketplace add`/`update`는 카탈로그만 갱신합니다 — 반드시 위의 `/plugin install`을 실행하세요.
> ([새 버전으로 업데이트](#새-버전으로-업데이트) 참고.)

## 설정 명령어

OS 환경변수를 직접 편집하지 않습니다. 설정은 프록시가 시작 시 읽는 config 파일
(`~/.rider-mcp-enforcer/config.json`)에 저장됩니다. 설정 방법:

- **Claude Code에서 (권장):** `/rider-mcp-enforcer:setup` — 가이드 진행: `rider_detect`로 포트 탐지,
  `projectPath` 질문, `rider_setup` 도구로 적용. 그 후 `/reload-plugins`.
- **도구 직접 호출:** Claude에게 `rider_setup { "riderSseUrl": "...", "projectPath": "..." }`,
  `rider_config`(현재 설정 표시), `rider_detect`(포트 탐지) 호출 요청.
- **셸에서:**
  ```bash
  node <플러그인경로>/proxy/setup.mjs --detect
  node <플러그인경로>/proxy/setup.mjs riderSseUrl=http://127.0.0.1:<port>/sse projectPath="G:/Path/To/Project"
  node <플러그인경로>/proxy/setup.mjs --show
  ```

설정은 프록시 시작 시 읽힘 → **변경 후 `/reload-plugins` 실행**. 우선순위:
**환경변수 > config 파일 > 기본값** (같은 이름 환경변수가 있으면 그게 이김).

## 새 버전으로 업데이트

Claude Code는 마켓플레이스 repo를 캐시하므로 새 커밋이 **자동으로 받아지지 않습니다**. 새 버전을
받으려면:

```bash
# 1) 캐시된 마켓플레이스 카탈로그 갱신
/plugin marketplace update rider-mcp-enforcer

# 2) 설치된 플러그인 업데이트 (확실히 하려면 uninstall 후 install)
/plugin update rider-mcp-enforcer
#   안 되면: /plugin uninstall rider-mcp-enforcer  그 다음  /plugin install rider-mcp-enforcer@rider-mcp-enforcer

# 3) 새 훅/명령어/MCP 서버 적용 (의존성은 세션 시작 시 자동 재설치)
/reload-plugins        # 또는 Claude Code 재시작
```

`/plugin`으로 설치 상태/버전 확인 가능. `/rider-mcp-enforcer:setup` 같은 명령이 안 보이면 설치본이
구버전 — 위 절차로 업데이트하세요.

> 유지보수 참고: `.claude-plugin/plugin.json`의 `version` 필드가 업데이트 게이트 — 클라이언트가
> 변경을 받게 하려면 버전을 올리세요. 소스 변경 시 config 키/명령어/도구 목록을 같은 커밋에서
> 갱신해야 합니다. 버전 히스토리는 [Releases](https://github.com/JSungMin/rider-mcp-enforcer/releases)에
> 있습니다(각 `v*` 태그에서 자동 생성) — README가 아님.

## 설정 항목 (env / config 키)

환경변수 이름과 config 파일 키(camelCase)는 1:1 대응됩니다.

| 환경변수 | 기본값 | 의미 |
| --- | --- | --- |
| `RIDER_MCP_SSE_URL` | — (필수) | "Copy SSE Config"의 Rider MCP SSE URL. 없으면 프록시가 설정 안내를 반환하고 Claude는 grep으로 폴백. |
| `RIDER_PROJECT_PATH` | — | 도구 호출에 `projectPath`가 없을 때 프록시가 주입할 기본 프로젝트 경로. Rider에 여러 프로젝트가 열려 있으면 설정 필요(아니면 "Unable to determine the target project" 에러). |
| `RIDER_MAX_RESULTS` | `50` | 요약 응답당 유지할 `file:line` 줄 최대 수. |
| `RIDER_ESCALATE` | `1` | `0`/`false`/`off`이면 자동 증액(아래) 비활성. |
| `RIDER_ESCALATE_LIMIT` | `500` | 결과가 잘린 것 같으면 이 큰 limit으로 1회 재요청해 실제 개수 파악. |
| `RIDER_MAX_LINE_CHARS` | `200` | 매치 코드 스니펫 한 줄 최대 글자수(거대한 생성 라인이 토큰을 터뜨리는 것 방지). |
| `RIDER_EXCLUDE` | `/intermediate/,/binaries/,/build/,/saved/,/deriveddatacache/,/.vs/,/.idea/,/node_modules/,.vcxproj,.sln,.filters` | 결과에서 제외할 경로 부분문자열(대소문자 무시) 콤마 목록 — 빌드 산출물/생성물 노이즈. |
| `RIDER_EXCLUDE_OFF` | `0` | `1`/`true`/`on`이면 제외 경로도 결과에 포함. |
| `RIDER_SUMMARIZE_TOOLS` | _(자동)_ | 선택 **제한** 필터 — 요약 허용할 도구 이름 콤마 목록. 기본은 **list 형태 응답이면 무엇이든** 요약(이름이 아니라 응답 형태로 판단) → `read_file` 같은 비-list 도구는 절대 안 건드리고 Rider 도구 rename도 설정 불필요. |
| `RIDER_STATS_FILE` | `~/.rider-mcp-enforcer/stats.json` | 누적 토큰 절감 ledger 파일 경로. |
| `RIDER_ENFORCE` | `warn` | `warn`(기본)=실행+nudge, `block`=하드 차단(**Bash 전용** — Grep 도구는 항상 warn 전용, 차단 안 됨), `0`/`off`=훅 완전 비활성(Rider MCP가 꺼져 있을 때 등). |
| `RIDER_EXCLUDE_COMMANDS` | — | 훅이 건드리지 않을 실행기(`grep`/`rg`/`ack`/`ag`/`findstr`/`find`/`git`) 콤마 목록 — 전역 `RIDER_ENFORCE=0`보다 세밀함. config.json의 `excludeCommands`(배열)로도 설정 가능. |
| `RIDER_COMPACT_VCS` | `1` | `0`/`off`이면 읽기 전용 `git`/`p4` 출력 압축 rewrite 비활성화 ([VCS 출력 압축](#vcs-출력-압축-git--p4) 참고). |
| `RIDER_VCS_MAX` | `60` | 압축된 `git`/`p4` 결과에서 유지할 최대 묶음 줄 수. |
| `RIDER_REGEN_CMD` | — | `rider_regen_project`: 자동 탐지를 건너뛰는 명시적 재생성 명령 템플릿(`{uproject}`/`{engine}` 토큰). 자동 탐지가 엉뚱한 명령을 고르거나 macOS/Linux일 때 설정. |
| `RIDER_ENGINE_PATH` | — | `rider_regen_project`: Unreal 엔진 디렉터리. 레지스트리 자동 탐지를 덮어씀. |
| `RIDER_REGEN_TIMEOUT` | `300000` | `rider_regen_project`: 재생성이 강제 종료되기까지의 최대 밀리초. |

## 강제(enforcement) 동작 방식

- **훅**은 모든 Bash 호출 전에 실행됩니다. 명령이 코드-심볼 검색(grep/rg/ack/ag/findstr, `find -name`,
  또는 추적 중인 소스 트리를 기본 검색하는 `git grep`)이고 `*.cpp/.h/.cs/...`·`src|source|engine/`를
  노리며 로그/md/json/빌드 경로가 *아니면* nudge합니다(`RIDER_ENFORCE=block`이면 0 아닌 코드로 종료).
  그 외엔 통과. 설정 전에 처음 걸리면 nudge가 `/rider-mcp-enforcer:setup`도 함께 안내합니다.
- **스킬**은 Claude가 Rider 도구를 선제적으로 쓰도록 유도합니다.
- **프록시**는 Claude가 도구를 어떻게 호출하든 토큰 상한을 보장합니다.

## Rider MCP 켜기 (제일 먼저 — 기본은 꺼져 있을 수 있음)

Rider MCP 서버는 **모든 빌드/설정에서 기본 활성은 아닙니다** — 꺼져 있어 "플러그인이 아무것도 안
한다"고 느끼는 경우가 많습니다. 켜고 위치를 확인하세요:

1. Rider → **Settings | Tools | MCP Server**.
2. **Enable MCP Server** 체크. (이 페이지가 없으면 Rider **2025.2+**로 업데이트.)
3. **Manual Client Configuration**에서 **Copy SSE Config** 클릭.
4. 복사된 설정의 SSE URL을 `/rider-mcp-enforcer:setup`(또는 `rider_setup` 도구)으로 등록.
   포트는 **인스턴스마다 다름**(보통 63342/64342 근처지만 하드코딩 말고 복사할 것).
5. `/reload-plugins` 또는 Claude Code 재시작.

### 실제로 켜졌는지 확인
```bash
# Rider가 MCP SSE 엔드포인트를 서빙 중인가? 200/SSE = 정상, connection refused = 꺼짐/잘못된 포트.
curl -i -m 3 "http://127.0.0.1:<port>/sse"
```
Claude Code에서 `rider-search` 서버가 실제 Rider 도구들(`search_symbol`, `search_text`, …)을
나열해야 합니다. `rider_status` 도구 하나만 보이면 프록시가 Rider에 **연결 못 한 것** — MCP가
꺼졌거나 URL이 틀림.

## 문제 해결

| 증상 | 원인 | 해결 |
| --- | --- | --- |
| `/rider-mcp-enforcer:setup` 명령이 자동완성에 안 뜸 | 플러그인 미설치(마켓플레이스만 add) 또는 구버전 | `/plugin install rider-mcp-enforcer@rider-mcp-enforcer` → `/reload-plugins`. `/plugin`에서 설치/버전 확인. |
| `rider-search`가 `rider_status` 도구 하나만 표시 | 프록시가 Rider에 연결 못 함(MCP 꺼짐 또는 URL 오류) | MCP 켜기, `RIDER_MCP_SSE_URL` 설정/수정, 재시작. |
| "rider-search-proxy is not connected to Rider" 반환 | `RIDER_MCP_SSE_URL` 미설정/도달불가 | Copy SSE Config로 설정; `curl`로 확인. |
| "Unable to determine the target project" 반환 | 여러 프로젝트가 열려 있고 `projectPath` 없음 | `RIDER_PROJECT_PATH`를 프로젝트 루트로 설정하거나 호출마다 `projectPath` 전달. |
| "`projectPath`=… doesn't correspond to any open project" 반환 | 그 프로젝트가 **Rider에 안 열려 있음** | Rider MCP는 IDE에 열린 프로젝트만 검색. 해당 프로젝트를 Rider에서 열고(인덱싱 완료) 재시도. |
| 원하던 grep인데 nudge가 뜸 | 훅이 Rider로 유도 중 | 기본 `warn`은 명령을 **실행함** — nudge는 따르거나 무시하면 됨. 완전히 끄려면 `RIDER_ENFORCE=0`. |
| `RIDER_ENFORCE=block`이 검색을 막는데 Rider도 불가 | 하드 차단 opt-in했는데 MCP 꺼짐 | MCP 켤 때까지 `RIDER_ENFORCE=0`(또는 `warn`). |
| 요약이 틀리거나 빔 | Rider 도구 이름이 기본값과 다르거나 응답 형식이 특이 | `RIDER_SUMMARIZE_TOOLS`를 빌드의 실제 도구 이름으로 설정; `RIDER_MAX_RESULTS` 조정. |
| SSE URL에 `curl`이 연결 거부 | Rider 미실행, MCP 꺼짐, 또는 포트 오류 | Rider 실행, MCP 활성화, SSE config 재복사. |
| `Dependency "gamedev-log-analyzer@rider-mcp-enforcer" is not found in any configured marketplace` (Plugin Errors 패널) | **마켓플레이스 캐시가 낡음** — `ue-log-analyzer`→`gamedev-log-analyzer` rename 후, 갱신된 `plugin.json`은 새 의존성 이름을 가리키는데 캐시된 카탈로그는 옛 이름만 가지고 있음 | 카탈로그 갱신 후 리로드: `/plugin marketplace update rider-mcp-enforcer` → `/reload-plugins` (패널이 계속 뜨면 Claude Code 재시작). 남은 `ue-log-analyzer` 설치본은 무해 — `claude plugin prune`으로 제거. |

> **MCP 꺼짐?** 기본값에선 함정 없음 — 훅의 기본 `warn`은 grep을 항상 실행시키므로 Rider MCP가
> 불가해도 Claude가 검색 가능. `RIDER_ENFORCE=block`만 차단함 — 그 경우 `RIDER_ENFORCE=0`(또는 `warn`).

## 상태 / 주의

- **Rider 2025.2.3에서 라이브 검증됨.** `search_text`·`search_symbol`이 실제 Unreal Engine 5
  프로젝트에서 동작 확인됨 — [벤치마크](BENCHMARK.md) 수치는 이 도구들로 측정한 것. 도구 이름은
  Rider 2025.2+ 기준이며, 빌드가 다른 이름을 쓰면 `rider-search` 도구 목록을 확인해
  `RIDER_SUMMARIZE_TOOLS`를 설정하세요.
- 요약기는 휴리스틱(`path:line` 형태 줄 유지). repo마다 `RIDER_MAX_RESULTS` 조정.
- 트랜스포트는 SSE. 빌드가 stdio만 지원하면 이슈를 올려주세요 — stdio 클라이언트 모드를 추가할 수
  있습니다.

## 권한 & 안전

전부 **로컬**에서 동작하고 아무것도 업로드하지 않습니다:

- **훅**(`PreToolUse` Bash)은 명령 문자열만 검사해 code-grep을 Rider로 리다이렉트할지 결정 — 파일
  내용을 읽거나 무언가 실행하지 않음. `RIDER_ENFORCE=0` 존중.
- **프록시**는 `localhost`의 Rider MCP SSE 엔드포인트에만 연결해 검색 응답을 전달·요약. 외부 인터넷
  연결 없음, `~/.rider-mcp-enforcer/`에 설정 + 로컬 토큰절감 ledger만 기록.
- **gamedev-log-analyzer**는 지정한 로컬 로그 파일을 읽어 요약만 출력.

[SECURITY.md](SECURITY.md), [PRIVACY.md](PRIVACY.md) 참고.

## 버전 히스토리

**[Releases](https://github.com/JSungMin/rider-mcp-enforcer/releases)** 페이지 참고 — 버전 태그마다
카테고리·PR 링크된 노트(🚀 Features / 🐛 Bug Fixes / 📝 Documentation / 🔧 Maintenance)가 자동
생성됩니다. 상단 배지는 항상 최신을 가리킵니다.

## 기여

이슈·PR 환영 — 버그 리포트, 새 로그 포맷/엔진, Rider 도구 매핑 추가, 문서 등.

이 repo는 **AI 보조 리뷰**로 유지보수됩니다. 즉 PR은 diff + 설명 + 증거로 판단되니 **작고, 명확히
설명되고, 증거가 있고, 사내정보가 없게** 올려주세요. PR 전 **[CONTRIBUTING.md](CONTRIBUTING.md)**를
읽어주세요.

**⭐ 토큰이나 디버깅 시간을 아꼈다면, star가 다른 사람들의 발견을 돕습니다.**

## 개인정보

이 플러그인들은 개인정보를 수집하지 않고 모든 처리를 로컬에서 합니다 — [PRIVACY.md](PRIVACY.md) 참고.

## 라이선스

MIT © 2026 JSungMin
