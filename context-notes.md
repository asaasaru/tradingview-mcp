# Context Notes

2026-05-31.

- 목표는 Claude Code 전용 stdio MCP를 유지하면서, 모든 AI와 봇이 공통으로 쓰는 REST 인터페이스를 `TVmcpResearch`에 고정하는 것이다.
- `src/http-server.js`가 이미 있었으므로 새 서버를 만들지 않고 운영용으로 보강했다.
- TradingView Desktop은 단일 UI이므로 HTTP 도구 호출은 직렬 큐로 처리한다.
- `TVauto`의 파이프라인은 `MCPClient` 인터페이스를 많이 사용하므로 호출부를 바꾸지 않고 `MCPClient`가 기본적으로 HTTP 게이트웨이를 쓰게 했다.
- legacy stdio transport는 `mcp.transport: "stdio"`로 되돌릴 수 있게 보존했다.

2026-05-31 path move.

- TVmcpResearch 루트를 기존 Biz 하위 경로에서 `/Users/vicmac/DevMac/connector/TVmcpResearch`로 이동했다.
- TVauto, stockAll, LaunchAgent, `.mcp.json`, 전역 HTTP 게이트웨이 문서의 절대경로 참조를 새 경로로 갱신했다.
- `com.vicmac.tvmcp-http` LaunchAgent는 새 경로의 `src/http-server.js`를 실행한다.
