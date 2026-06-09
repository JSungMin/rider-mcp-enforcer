# ue-log-analyzer

[English](README.md) · **한국어** · [rider-mcp-enforcer 마켓플레이스](../README.ko.md#마켓플레이스--2개-플러그인)의 일부

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-7C3AED)](https://code.claude.com/docs/en/plugins)
[![CLI](https://img.shields.io/badge/CLI-zero%20deps-1f6feb)](#claude가-사용하는-법-기본-cli)
[![release](https://img.shields.io/github/v/release/JSungMin/rider-mcp-enforcer)](https://github.com/JSungMin/rider-mcp-enforcer/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](../LICENSE)
[![Stars](https://img.shields.io/github/stars/JSungMin/rider-mcp-enforcer?style=social)](https://github.com/JSungMin/rider-mcp-enforcer/stargazers)

거대한 에디터 로그를 **토큰 효율적으로** 읽는 **Claude Code 플러그인**. Unreal `Saved/Logs/*.log`,
Unity `Editor.log`는 보통 수십 MB의 반복 스팸이라 `cat`/`grep`하면 컨텍스트가 터집니다. 이 플러그인은
대신 파싱·**중복제거(dedup)**·분류합니다. **IDE 불필요** — 순수 파일 파싱.

## 왜 빠른가 (실측)

실제 Unreal 로그 측정 (프로젝트 소스 미노출):

| 작업 | raw | 이 플러그인 | 절감 |
| --- | ---: | ---: | ---: |
| 57MB UE 로그 읽기 | ~1,250,000 tok | ~2,500 tok (dedup 요약) | **~99.8%** |
| 트레이스 태그 1개 검색 (9,226 매치) | ~690,000 tok | ~1,700 tok (콜사이트 롤업) | **~99.8% (~410×)** |
| 윈도에서 결정적 스칼라 추출 | ~35,000 tok (raw dump) | ~160 tok (`log_fields`) | **~99.5%** |

핵심: raw 로그 줄을 컨텍스트에 절대 안 넣음 — dedup 그룹, 콜사이트 롤업, 또는 답을 결정하는 스칼라
컬럼만 출력.

## 무엇을 하나

- 각 줄을 `{severity, category, file:line, message}`로 **파싱** — Unreal 런타임, 빌드/컴파일 에러,
  Unity, 범용 폴백.
- **템플릿 dedup:** 숫자/주소/GUID/경로/인스턴스ID 정규화 → 반복 스팸을 `×count` 한 그룹으로.
- **검색/필터:** `severityMin`·`category`·`file`·`query`; `groupBy:"callsite"`는 `file:line`별 롤업
  (로그를 뭐가 도배하는지 파악에 최적).
- **`log_fields`:** dense 프레임 로그용 범용 컬럼 추출 — 선택 스칼라만 (`Key`, `Key.x|.y|.z`,
  `Key.Y|.P|.R`, `ts`, `dts`, `d:Key`, `step:Key`).

## Claude가 사용하는 법 (기본 CLI)
Claude는 **skill**을 통해 `ue-log` CLI를 셸 호출합니다 — **상시 컨텍스트 비용이 없습니다**(로그가
실제로 관련될 때까지 프롬프트에 아무것도 안 올라감). "에디터 로그 확인해줘" / "뭐가 로그를 도배해?" /
"지난 실행 대비 뭐가 바뀌었어?"라고 묻거나 `/ue-log-analyzer:logs` 명령을 쓰면 됩니다. 내부 실행:

```bash
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" <command> [--flags]
```

**명령어**(`ue-log <command>`): `detect`, `summary`, `search`, `fields`, `diff`, `tail`, `learnings`,
`learnings-reset`, `setup`, `config`.

```bash
# 직접 실행도 가능 — 스크립트/CI/임의 에이전트에서 (순수 Node, 의존성 0):
node server/cli.js detect --projectPath /path/to/UEProject
node server/cli.js search --path Editor.log --severityMin Error --groupBy callsite
node server/cli.js fields --path trace.log --fields Pawn,Alpha,ts --query Tick --max 20
node server/cli.js diff   --pathA before.log --pathB after.log --severityMin Error
node server/cli.js --help
```

## 선택: MCP 서버 켜기
같은 엔진([`server/logs.js`](server/logs.js) + [`server/core.js`](server/core.js))을 MCP 서버로도
돌릴 수 있습니다(타입드 `log_*` 도구, Claude Code 내 자동 발견). **기본 비활성**입니다 — 연결된 MCP
서버는 **모든** 세션 프롬프트에 툴 스키마를 주입(상시 ~1–1.5k tok)하지만 CLI는 쓰기 전엔 0이기
때문입니다. **~99% 절감은 출력 압축이라 양쪽 동일** — 차이는 상시 오버헤드뿐.

타입드 도구/구조화 인자(셸 따옴표 불요)를 원하면 켜세요:

```bash
# 1) MCP SDK 1회 설치 (CLI는 의존성 0, MCP 서버만 필요)
cd server && npm install && cd ..
# 2) 플러그인 루트에 .mcp.json 추가 후 /reload-plugins:
#    { "mcpServers": { "ue-log": { "command": "node",
#      "args": ["${CLAUDE_PLUGIN_ROOT}/server/index.js"] } } }
```

도구: `log_detect`, `log_summary`, `log_search`, `log_fields`, `log_diff`, `log_tail`,
`log_learnings`, `log_learnings_reset`, `log_setup`, `log_config` — CLI와 byte 동일 출력.

## 사전 요구사항
- PATH에 **Node.js ≥ 18**. (Rider/Unity 설치 불필요 — 로그 파일만 읽음. 기본 CLI 경로는 **npm 의존성
  0**; 선택적 MCP 서버만 `npm install` 필요.)

## 설치
```bash
/plugin marketplace add JSungMin/rider-mcp-enforcer
/plugin install ue-log-analyzer@rider-mcp-enforcer
/reload-plugins
/ue-log-analyzer:logs                         # 또는 "에디터 로그 확인해줘"
```
빌드도, `npm install`도 없음 — CLI는 순수 Node. (`rider-mcp-enforcer`를 설치하면 이것도 자동으로 함께
설치됩니다.) 타입드 MCP 도구를 원하면 [선택: MCP 서버 켜기](#선택-mcp-서버-켜기) 참고.

## 설정
설정은 `~/.ue-log-analyzer/config.json` (우선순위: env > config > 기본값). `ue-log setup …`(예:
`node server/cli.js setup --projectPath "<dir>"`) 또는 환경변수로 설정:

| env | config 키 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `UELOG_PROJECT_PATH` | `projectPath` | — | 프로젝트 루트; UE 로그를 `<root>/Saved/Logs`(서브 1단계 포함)에서 자동탐지. |
| `UELOG_PATH` | `logPath` | — | 명시 기본 로그 파일. |
| `UELOG_MAX_BYTES` | `logMaxBytes` | `5000000` | 거대 로그는 마지막 N바이트만 읽음. |
| `UELOG_MAX_GROUPS` | `maxGroups` | `40` | `log_search` 당 최대 dedup 그룹. |
| `UELOG_MAX_LINE_CHARS` | `maxLineChars` | `200` | 표시 스니펫 최대 글자수. |

## rider-mcp-enforcer와 함께
로그 항목은 `file:line`을 담습니다. [rider-mcp-enforcer](../README.ko.md)도 설치돼 있으면 그 위치를
해당 플러그인의 `get_symbol_info`/`read_file`에 넘겨 소스로 바로 점프. [두 플러그인 함께
쓰기](../README.ko.md#두-플러그인-함께-쓰기) 참고.

## Changelog
- **0.2.0** — **기본 CLI 전용**(토큰 우선): MCP 서버 **기본 비활성**(`.mcp.json`·SessionStart 자동
  `npm install` 제거) → 상시 MCP 스키마 세금(~1–1.5k tok/세션) 제거. 새 **skill**(`skills/logs/`)이
  로그 작업을 자동 발견해 `ue-log` CLI를 Bash로 구동. 기본 경로 **npm 의존성 0**. MCP는 opt-in(*선택:
  MCP 서버 켜기* 참고). 기존 MCP 사용자: `.mcp.json` + `npm install`로 타입드 도구 유지.
- **0.1.4** — **CLI 프론트엔드**(`ue-log <command>`): MCP 서버와 같은 엔진(공유 `core.js` `runTool`),
  byte 동일 출력, 단 **상시 컨텍스트 비용 0** + Claude Code 밖(스크립트/CI/타 에이전트) 이식 가능.
- **0.1.3** — `log_diff`: 두 로그 비교 후 델타만 출력(신규/사라짐/카운트변경 그룹, 변경없는 그룹 생략)
  — 실행 간 회귀 분류를 토큰 저렴하게.
- **0.1.2** — 로컬 **learnings 원장**(`log_learnings`/`log_learnings_reset`): 파싱 커버리지·상위
  카테고리·미파싱 라인 템플릿 추적(새 파서 후보). Sanitized, 전송 안 함. 자체 eval + CI.
- **0.1.1** — 서버 의존성을 세션 시작 시 자동 설치(`${CLAUDE_PLUGIN_DATA}` + 동적 SDK 해석) — 수동
  `npm install` 불필요.
- **0.1.0** — 최초: `log_detect`/`log_search`/`log_summary`/`log_fields`/`log_tail` +
  `/ue-log-analyzer:logs`. UE/Unity/범용 파싱, 템플릿 dedup, 콜사이트 롤업, 필드 추출.

## 라이선스
MIT © 2026 JSungMin
