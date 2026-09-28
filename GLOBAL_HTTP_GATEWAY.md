# TVmcp 전역 HTTP 게이트웨이

`src/http-server.js`는 Claude Code stdio MCP와 별도로 모든 AI, 봇, 프로젝트가 REST로 TradingView MCP 도구를 호출하게 하는 전역 인터페이스다.

## 표준 주소

```bash
http://127.0.0.1:5300
```

## 실행

```bash
cd /Users/vicmac/DevMac/connector/TVmcpResearch/tradingview-mcp-aibridge
npm run http
```

## 호출 예시

```bash
curl http://127.0.0.1:5300/health
curl http://127.0.0.1:5300/tools
curl -X POST http://127.0.0.1:5300/tools/pine_strategy_run \
  -H 'Content-Type: application/json' \
  -d '{"source":"//@version=5\nstrategy(\"x\")"}'
```

Python.

```python
import requests

result = requests.post(
    "http://127.0.0.1:5300/tools/pine_strategy_run",
    json={"source": pine_code},
    timeout=600,
).json()
```

## 운영 옵션

```bash
TVMCP_HTTP_HOST=127.0.0.1
TVMCP_HTTP_PORT=5300
TVMCP_HTTP_TOKEN=optional-token
TVMCP_HTTP_ALLOWED_TOOLS=pine_strategy_run,tv_health_check
```

토큰을 설정하면 호출 시 `X-TV-MCP-Token` 헤더 또는 `Authorization: Bearer` 헤더를 보내야 한다.

## 동시성

TradingView Desktop은 단일 UI 리소스라서 HTTP 서버는 도구 호출을 직렬 큐로 처리한다. 여러 봇이 동시에 호출해도 한 번에 하나씩 실행된다.
