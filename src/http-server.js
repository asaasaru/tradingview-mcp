// 모든 AI와 봇이 TradingView MCP 도구를 REST로 호출하게 하는 전역 HTTP 게이트웨이
/**
 * TVmcp HTTP REST Wrapper
 * MCP 도구를 HTTP API로 노출한다.
 *
 * 실행.
 *   node src/http-server.js --port=5300
 *
 * 환경변수.
 *   TVMCP_HTTP_HOST=127.0.0.1
 *   TVMCP_HTTP_PORT=5300
 *   TVMCP_HTTP_TOKEN=optional-token
 *   TVMCP_HTTP_ALLOWED_TOOLS=pine_strategy_run,tv_health_check
 */
import http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerHealthTools }    from './tools/health.js';
import { registerChartTools }     from './tools/chart.js';
import { registerPineTools }      from './tools/pine.js';
import { registerDataTools }      from './tools/data.js';
import { registerCaptureTools }   from './tools/capture.js';
import { registerDrawingTools }   from './tools/drawing.js';
import { registerAlertTools }     from './tools/alerts.js';
import { registerBatchTools }     from './tools/batch.js';
import { registerReplayTools }    from './tools/replay.js';
import { registerIndicatorTools } from './tools/indicators.js';
import { registerWatchlistTools } from './tools/watchlist.js';
import { registerUiTools }        from './tools/ui.js';
import { registerPaneTools }      from './tools/pane.js';
import { registerTabTools }       from './tools/tab.js';
import { registerKoreanTools }    from './tools/korean.js';
import { registerStrategyTools }  from './tools/strategy.js';

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find(a => a.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const HOST = argValue('host', process.env.TVMCP_HTTP_HOST || '127.0.0.1');
const PORT = parseInt(argValue('port', process.env.TVMCP_HTTP_PORT || '5300'), 10);
const TOKEN = process.env.TVMCP_HTTP_TOKEN || '';
const MAX_BODY_BYTES = parseInt(process.env.TVMCP_HTTP_MAX_BODY_BYTES || String(5 * 1024 * 1024), 10);
const allowedTools = new Set(
  (process.env.TVMCP_HTTP_ALLOWED_TOOLS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
);

const server = new McpServer({ name: 'tradingview-http', version: '2.1.0' }, {});
registerHealthTools(server);
registerChartTools(server);
registerPineTools(server);
registerDataTools(server);
registerCaptureTools(server);
registerDrawingTools(server);
registerAlertTools(server);
registerBatchTools(server);
registerReplayTools(server);
registerIndicatorTools(server);
registerWatchlistTools(server);
registerUiTools(server);
registerPaneTools(server);
registerTabTools(server);
registerKoreanTools(server);
registerStrategyTools(server);

let queueTail = Promise.resolve();
let pendingCalls = 0;
let activeTool = null;
let completedCalls = 0;

function getToolHandlers() {
  return server._registeredTools || server.registeredTools || {};
}

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-TV-MCP-Token',
    ...extra,
  };
}

function json(res, status, data) {
  res.writeHead(status, headers());
  res.end(JSON.stringify(data, null, 2));
}

function authorized(req) {
  if (!TOKEN) return true;
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const token = req.headers['x-tv-mcp-token'] || bearer;
  return token === TOKEN;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let data = '';
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`JSON body too large: ${size} bytes`));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function flattenMcpResult(result) {
  if (result && Array.isArray(result.content)) {
    const textContent = result.content.find(c => c.type === 'text');
    if (textContent) {
      try { return JSON.parse(textContent.text); }
      catch { return { text: textContent.text }; }
    }
  }
  return result || {};
}

async function runSerialized(toolName, task) {
  pendingCalls += 1;
  const run = queueTail.then(async () => {
    pendingCalls -= 1;
    activeTool = toolName;
    try {
      return await task();
    } finally {
      activeTool = null;
      completedCalls += 1;
    }
  });
  queueTail = run.catch(() => {});
  return run;
}

async function executeTool(toolName, args) {
  const tools = getToolHandlers();
  const entry = tools[toolName];
  if (!entry) {
    const error = new Error(`Tool '${toolName}' not found`);
    error.statusCode = 404;
    error.available = Object.keys(tools);
    throw error;
  }
  if (allowedTools.size && !allowedTools.has(toolName)) {
    const error = new Error(`Tool '${toolName}' is not allowed by TVMCP_HTTP_ALLOWED_TOOLS`);
    error.statusCode = 403;
    throw error;
  }
  const handler = entry.callback || entry.handler || entry;
  const result = await (typeof handler === 'function' ? handler(args) : handler.callback(args));
  return flattenMcpResult(result);
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers());
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    const rawCdp = parseInt(process.env.TV_CDP_PORT, 10);
    const cdpPort = (!isNaN(rawCdp) && rawCdp >= 1 && rawCdp <= 65535) ? rawCdp : 9229;
    return json(res, 200, {
      status: 'ok',
      server: 'tradingview-mcp-http',
      host: HOST,
      port: PORT,
      cdp_port: cdpPort,
      auth_required: Boolean(TOKEN),
      allowed_tools: allowedTools.size ? Array.from(allowedTools) : 'all',
      tool_count: Object.keys(getToolHandlers()).length,
      queue: { pending: pendingCalls, active: activeTool, completed: completedCalls },
    });
  }

  if (!authorized(req)) {
    return json(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'GET' && pathname === '/tools') {
    const tools = getToolHandlers();
    const list = Object.entries(tools)
      .filter(([name]) => !allowedTools.size || allowedTools.has(name))
      .map(([name, entry]) => ({
        name,
        description: entry.description || '',
        inputSchema: entry.inputSchema || {},
      }));
    return json(res, 200, { tools: list, count: list.length });
  }

  const toolMatch = pathname.match(/^\/tools\/([^/]+)$/);
  if (req.method === 'POST' && toolMatch) {
    const toolName = decodeURIComponent(toolMatch[1]);
    let args = {};
    try { args = await readBody(req); }
    catch (e) { return json(res, 400, { error: e.message }); }

    try {
      const result = await runSerialized(toolName, () => executeTool(toolName, args));
      return json(res, 200, result);
    } catch (e) {
      return json(res, e.statusCode || 500, {
        error: e.message,
        tool: toolName,
        ...(e.available ? { available: e.available } : {}),
      });
    }
  }

  json(res, 404, { error: 'Not found', endpoints: ['GET /health', 'GET /tools', 'POST /tools/:toolName'] });
});

httpServer.listen(PORT, HOST, () => {
  process.stderr.write(`[TVmcp-HTTP] Listening on http://${HOST}:${PORT}\n`);
  process.stderr.write(`[TVmcp-HTTP] Tools: GET /tools | Run: POST /tools/{name}\n`);
});

httpServer.on('error', (e) => {
  process.stderr.write(`[TVmcp-HTTP] Error: ${e.message}\n`);
  process.exit(1);
});
