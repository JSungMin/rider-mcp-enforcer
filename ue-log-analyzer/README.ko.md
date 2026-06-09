# ue-log-analyzer

[English](README.md) · **한국어** · [rider-mcp-enforcer 마켓플레이스](../README.ko.md#마켓플레이스--2개-플러그인)의 일부

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

## 명령어 & 도구
- `/ue-log-analyzer:logs` — 가이드: 탐지 → 요약 → 에러+위치.
- MCP 도구(서버 `ue-log`): `log_detect`, `log_summary`, `log_search`, `log_fields`, `log_tail`,
  `log_setup`, `log_config`.

## 사전 요구사항
- PATH에 **Node.js ≥ 18**. (Rider/Unity 설치 불필요 — 로그 파일만 읽음.)

## 설치
```bash
/plugin marketplace add JSungMin/rider-mcp-enforcer
/plugin install ue-log-analyzer@rider-mcp-enforcer
/reload-plugins                               # 첫 실행 시 의존성 자동 설치 (수동 npm 불필요)
/ue-log-analyzer:logs                         # 또는 "에디터 로그 확인해줘"
```
(`rider-mcp-enforcer`를 설치하면 이것도 자동으로 함께 설치됩니다 —
[마켓플레이스](../README.ko.md#마켓플레이스--2개-플러그인) 참고.)

## 설정
설정은 `~/.ue-log-analyzer/config.json` (우선순위: env > config > 기본값). `/ue-log-analyzer:logs`
(내부 `log_setup`) 또는 `log_setup` 도구 / 환경변수로 설정:

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
- **0.1.1** — 서버 의존성을 세션 시작 시 자동 설치(`${CLAUDE_PLUGIN_DATA}` + 동적 SDK 해석) — 수동
  `npm install` 불필요.
- **0.1.0** — 최초: `log_detect`/`log_search`/`log_summary`/`log_fields`/`log_tail` +
  `/ue-log-analyzer:logs`. UE/Unity/범용 파싱, 템플릿 dedup, 콜사이트 롤업, 필드 추출.

## 라이선스
MIT © 2026 JSungMin
