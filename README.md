# tradingview-mcp-aibridge

원본: https://github.com/tradesdontlie/tradingview-mcp  
설치본: https://github.com/aibridge-leo/tradingview-mcp-aibridge  
참조: https://github.com/tradesdontlie/tradingview-mcp-aibridge  
**tradingview-mcp by AI BRIDGE** — TradingView Desktop을 Claude Code에 연결하는 MCP 서버. Chrome DevTools Protocol(CDP)을 통해 실행 중인 TradingView 차트를 Claude가 직접 읽고 제어합니다.

---

## 작동 원리

### 전체 흐름

```
Claude Code  ←─ stdio ─→  MCP Server (Node.js)  ←─ CDP (localhost:9222) ─→  TradingView Desktop (Electron)
```

Claude Code와 MCP 서버는 **stdio**(표준 입출력)로 통신한다. MCP 서버는 **Chrome DevTools Protocol(CDP)** 로 TradingView 데스크탑 앱에 연결해 JS를 직접 실행한다.

### 1단계: TradingView를 CDP 모드로 실행

TradingView 데스크탑은 **Electron** 기반(Chromium 내장)이라 `--remote-debugging-port=9222` 플래그로 실행하면 CDP 디버깅 포트가 열린다.

`tv_launch` 도구 호출 시 MCP 서버가 내부적으로:

```js
spawn(tvPath, ["--remote-debugging-port=9222"], { detached: true });
```

플랫폼별 TradingView 실행 파일 경로 자동 탐지:

- **macOS**: `/Applications/TradingView.app` 등 표준 경로 순서대로 검색
- **Windows**: `Get-AppxPackage` (MSIX 스토어 설치) 또는 `%LOCALAPPDATA%` 경로
- **Linux**: `/usr/bin/tradingview` 등

수동 실행도 동일한 원리: `scripts/launch_tv_debug.bat` 이 플래그를 붙여 TV를 실행한다.

### 2단계: CDP로 TradingView 페이지에 연결

MCP 서버가 `chrome-remote-interface` 패키지로 CDP에 연결:

```
GET http://localhost:9222/json/list
→ 열린 탭(target) 목록 조회
→ URL에 tradingview.com/chart 포함된 탭 선택
→ CDP 세션 수립 (Runtime, Page, DOM 도메인 활성화)
```

### 3단계: JavaScript 직접 주입으로 차트 제어

연결 후 모든 도구는 `Runtime.evaluate()`로 TradingView 내부 JS API를 직접 호출한다.

**차트 상태 읽기** — TradingView가 전역 객체로 노출하는 내부 API 경로 직접 접근:

```js
window.TradingViewApi._activeChartWidgetWV.value(); // 현재 차트 위젯
window.TradingViewApi._replayApi; // 리플레이 API
window.TradingViewApi._alertService; // 알림 서비스
```

**Pine Script 삽입** — 에디터에 소스 코드를 주입하고 컴파일 트리거:

```
pine_set_source  →  JS로 에디터 DOM에 코드 삽입
pine_smart_compile  →  TradingView 내부 컴파일 API 호출
pine_get_errors  →  컴파일 오류 메시지 읽기
pine_get_console  →  log.info() 출력 읽기
```

**Pine 드로잉 데이터 읽기** — `line.new()`, `label.new()`, `box.new()`로 그린 객체는 일반 API로는 접근 불가. 내부 primitive 컬렉션 경로를 직접 탐색:

```js
study._graphics._primitivesCollection.dwglines.get("lines").get(false)
  ._primitivesDataById;
```

### 4단계: 컴파일 버튼 탐지 — 3회 재시도 + 키보드 폴백

Pine Script 컴파일은 단순 텍스트 검색이 아닌 **다중 폴백 전략**으로 버튼을 찾는다.

```
1순위: data-qa-id="add-script-to-chart"  (TV 내부 QA 테스트 속성 — 가장 안정적)
2순위: button.textContent 패턴 매칭      ("Add to chart" / "Update on chart")
→ 500ms 간격으로 최대 3회 반복

모두 실패 시:
3순위: Cmd+Enter (Mac) / Ctrl+Enter (Win/Linux) 키보드 단축키 직접 디스패치
```

3회 DOM 시도 + 키보드 단축키까지 모두 실패하면 `CompileButtonNotFoundError`를 발생시킨다.

### 5단계: 에러 감지 + 사용자 알림

컴파일 버튼을 찾지 못하거나 5분간 사용자 응답이 없을 경우 **Telegram 알림**을 자동 전송한다.

```
CompileButtonNotFoundError 발생
    ↓
Telegram 알림 즉시 전송 (TVauto와 동일한 자격증명 사용)
    ↓
5분 Watchdog 타이머 시작
    ↓
사용자 응답 있으면 → Watchdog 취소
사용자 응답 없으면 → 종료 알림 전송 → TradingView 강제 종료 → CDP 연결 해제
```

**Telegram 자격증명 우선순위** (TVauto `tv16_telegram.py`와 동일):
1. 환경변수: `TV_TELEGRAM_BOT_TOKEN` + `TV_TELEGRAM_CHAT_ID`
2. TVauto 전용 환경변수: `TELEGRAM_BOT_TOKEN_VICBIT_BOT` + `TELEGRAM_ALLOWED_CHAT_IDS_VICBIT_BOT`
3. `~/.config/secrets.env` 파일 (TVauto와 공유)

TradingView 강제 종료:
- **macOS**: `pkill -x TradingView`
- **Windows**: `taskkill /IM TradingView.exe /F`
- **Linux**: `pkill -x tradingview`

### 요약

| 단계          | 기술                          | 역할                                            |
| ------------- | ----------------------------- | ----------------------------------------------- |
| Claude ↔ MCP  | MCP stdio                     | 자연어 명령 → 도구 호출 변환                    |
| MCP → TV 실행 | `child_process.spawn`         | `--remote-debugging-port=9222` 플래그로 TV 시작 |
| MCP ↔ TV      | Chrome DevTools Protocol      | 브라우저 탭 연결, JS 실행 채널                  |
| 데이터 읽기   | `Runtime.evaluate()`          | TV 내부 API 객체 직접 접근                      |
| Pine 제어     | JS DOM 조작 + 내부 API        | 에디터 코드 삽입 및 컴파일 트리거               |
| 컴파일 버튼   | `data-qa-id` → 텍스트 → 키보드 | 3회 재시도 후 Cmd+Enter 폴백                    |
| 드로잉 읽기   | JS primitive 경로 탐색        | line/label/box 객체 직접 추출                   |
| 에러 알림     | Telegram Bot API              | 버튼 탐색 실패 / 5분 타임아웃 시 자동 알림      |
| 자동 종료     | `pkill` / `taskkill`          | 무응답 5분 후 TV 프로세스 종료 + 리소스 반환    |

---

### 🇰🇷 한국 트레이더 특화 버전

- ✅ **Windows MSIX 네이티브 지원** — `Get-AppxPackage` 기반 자동 경로 탐지
- ✅ **업비트/빗썸/바이낸스 심볼 기본 제공** — 한국 원화 페어 바로 사용
- ✅ **김치 프리미엄 자동 계산 도구** — `kimchi_premium` 신규 툴
- ✅ 기존 TradingView 제어 도구 전부 포함

---

## 빠른 시작 (One-Shot Setup)

Claude Code에 아래 프롬프트 한 번만 복사-붙여넣기:

```
Set up tradingview-mcp-aibridge for me.
Clone https://github.com/aibridge-leo/tradingview-mcp-aibridge.git into the current project directory.
Run npm install inside it.
Create .mcp.json in the project root with:
  {
    "mcpServers": {
      "tradingview": {
        "command": "node",
        "args": ["<ABSOLUTE_PATH_TO_CLONED_DIR>/src/server.js"]
      }
    }
  }
Tell me to: (1) launch TradingView with scripts/launch_tv_debug.bat on Windows (auto-detects MSIX install), (2) restart Claude Code, (3) run tv_health_check to verify.
```

> fork해서 본인 버전을 쓰시려면 clone URL을 본인 저장소로 바꿔주세요.

## 사전 요구 사항

- **Windows / macOS / Linux** (Windows MSIX 설치 정식 지원)
- **Node.js 18+**
- **Claude Code** (Pro 플랜 이상 권장)
- **TradingView 계정** (무료도 가능, 유료일수록 지표 등 확장 가능)

## 수동 설치

상세 절차는 [SETUP.md](./SETUP.md) 참고.

## 사용 예시

Claude Code에서 자연어로:

```
"내 차트 상태 알려줘"
→ chart_get_state, data_get_study_values 자동 호출

"BTC 4시간 봉으로 봐줘"
→ chart_set_symbol, chart_set_timeframe

"BTC 김치 프리미엄 알려줘"             ← AI BRIDGE 추가
→ kimchi_premium (UPBIT:BTCKRW, BINANCE:BTCUSDT, USD/KRW 자동 비교)

"이 Pine Script 버그 찾아 고쳐줘"
→ pine_get_source, pine_set_source, pine_smart_compile
```

## 주요 기능

| 카테고리         | 도구 예시                                                                 |
| ---------------- | ------------------------------------------------------------------------- |
| **차트 읽기**    | `chart_get_state`, `data_get_study_values`, `quote_get`, `data_get_ohlcv` |
| **차트 조작**    | `chart_set_symbol`, `chart_set_timeframe`, `chart_manage_indicator`       |
| **Pine Script**  | `pine_set_source`, `pine_smart_compile`, `pine_get_errors`                |
| **드로잉**       | `draw_shape`, `draw_list`, `draw_clear`                                   |
| **Replay**       | `replay_start`, `replay_step`, `replay_trade`, `replay_status`            |
| **알림**         | `alert_create`, `alert_list`, `alert_delete`                              |
| **배치**         | `batch_run` (여러 심볼 × 타임프레임 일괄)                                 |
| **🇰🇷 한국 특화** | `kimchi_premium` (김치 프리미엄 계산)                                     |

전체 목록 및 도구 선택 가이드는 [CLAUDE.md](./CLAUDE.md) 참고.

## 한국 트레이더 기본 설정

### 심볼 표기

| 자산     | 업비트         | 빗썸             | 바이낸스          |
| -------- | -------------- | ---------------- | ----------------- |
| 비트코인 | `UPBIT:BTCKRW` | `BITHUMB:BTCKRW` | `BINANCE:BTCUSDT` |
| 이더리움 | `UPBIT:ETHKRW` | `BITHUMB:ETHKRW` | `BINANCE:ETHUSDT` |
| 솔라나   | `UPBIT:SOLKRW` | `BITHUMB:SOLKRW` | `BINANCE:SOLUSDT` |

## 프로젝트 구조

```
tradingview-mcp-aibridge/
├── src/
│   ├── server.js            # MCP 서버 엔트리
│   ├── core/                # CDP 클라이언트 + 도구 로직
│   │   └── korean.js        # 🇰🇷 김치 프리미엄 계산
│   ├── tools/               # MCP 도구 래퍼
│   │   └── korean.js        # 🇰🇷 kimchi_premium 툴
│   └── cli/                 # `tv` CLI
├── scripts/
│   ├── launch_tv_debug.bat  # Windows MSIX 자동 탐지 런처
│   └── launch_tv_debug.ps1  # 런처 로직 (PowerShell)
├── agents/                  # Claude Code 서브 에이전트
├── skills/                  # 워크플로 스킬
├── CLAUDE.md                # 도구 선택 가이드 (Claude가 자동 로드)
├── SETUP.md                 # 상세 설치 가이드
├── package.json
├── LICENSE
└── README.md                # 이 파일
```

## 주의 사항

- 본 프로젝트는 **비공식 도구**로, TradingView Inc. 및 Anthropic PBC와 제휴 관계가 없습니다.
- CDP 기반 데스크탑 자동화는 TradingView 약관에 명시적으로 허용되지 않은 영역입니다. 주 계정보다 **테스트 계정 사용을 권장**합니다.
- 실거래 자동화(웹훅 등) 연결 전 반드시 **소액으로 검증**하세요.
- 사용자는 본인의 사용이 TradingView 약관 및 관련 법규를 준수하는지 확인할 책임이 있습니다.

## Credits

이 프로젝트는 아래 오픈소스 프로젝트 위에 쌓아 올렸습니다.

- 원본: [tradesdontlie/tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp) — TradingView Desktop ↔ Claude Code 연결의 기초를 만든 프로젝트
- 바로 앞 fork: [LewisWJackson/tradingview-mcp-jackson](https://github.com/LewisWJackson/tradingview-mcp-jackson) — one-shot setup 구조 추가

AI BRIDGE fork가 추가한 것:

- Windows MSIX 환경 네이티브 지원 (`Get-AppxPackage` 기반 런처)
- `kimchi_premium` 툴 (업비트 ↔ 바이낸스 ↔ USD/KRW 자동 계산)
- 한국어 문서화

## 라이선스

MIT License. 자세한 내용은 [LICENSE](./LICENSE) 참고.

- Copyright (c) 2026 tradesdontlie (원본 저작자)
- Copyright (c) 2026 AI BRIDGE (본 fork의 수정분)

## 기여

이슈/PR 환영합니다. 버그 리포트 시 Windows 버전, TradingView Desktop 버전, Node.js 버전을 포함해 주세요.
