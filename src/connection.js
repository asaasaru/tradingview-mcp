import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
let targetVerified = false; // 바운드 타깃이 차트 페이지임을 1회 확인했는지
const CDP_HOST = 'localhost';
const CDP_PORT = process.env.TV_CDP_PORT ? parseInt(process.env.TV_CDP_PORT, 10) : 9229;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
    } catch {
      // 연결이 죽음 → 재연결
      client = null;
      targetInfo = null;
      targetVerified = false;
      return connect();
    }
    // 이미 차트 페이지로 확인된 타깃이면 추가 검사 없이 재사용.
    if (targetVerified) return client;
    // 최초 1회: 바운드 타깃이 실제 차트 페이지인지 확인.
    const onChart = await client.Runtime.evaluate({
      expression: 'String(location.href).includes("/chart") || !!(window.TradingView && window.TradingView.bottomWidgetBar)',
      returnByValue: true,
    }).then(r => r.result && r.result.value === true).catch(() => false);
    if (onChart) { targetVerified = true; return client; }
    // 차트 탭 아님 → 차트 탭으로 재바인딩 (findChartTarget이 90초 내 폴링).
    process.stderr.write('[connection] 비차트 탭 감지 — 차트 탭 재탐색 중...\n');
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
    targetVerified = false;
    return connect();
  }
  return connect();
}

// 지금 떠 있는 차트 탭만 (블로킹 없이) 즉시 반환. 없으면 null.
async function findExistingChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url)) || null;
}

export async function connect() {
  // Fast-fail: if CDP port is not accepting connections at all, skip retries entirely.
  try {
    await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
  } catch {
    throw new Error(`TradingView is not running with CDP enabled (port ${CDP_PORT} not open). Use the tv_launch tool to start it.`);
  }

  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget();
      if (!target) {
        throw new Error('No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      targetVerified = /tradingview\.com\/chart/i.test(target.url || '');
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

async function findChartTarget() {
  // TV 앱은 시작 후 60초 내외에 tradingview.com/chart 탭을 자체 로드한다.
  // new-tab/window 같은 내부 file:// 탭에 잘못 바인딩하지 않도록
  // 차트 탭이 나타날 때까지 최대 90초 폴링한다.
  const POLL_MS = 3000;
  const DEADLINE = Date.now() + 90000;
  while (Date.now() < DEADLINE) {
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
    const targets = await resp.json();
    const chart = targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
    if (chart) return chart;
    process.stderr.write('[connection] tradingview.com/chart 탭 대기 중...\n');
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  // 90초 후에도 없으면 null — 상위에서 에러 처리
  return null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
    targetVerified = false;
    }
}

/**
 * 캐시된 타깃/클라이언트를 강제 무효화한다.
 * action_required(예: Pine Editor 못 엶) 후 사용자 수동 조치 뒤 재시도 시 호출하면
 * 다음 getClient()가 차트 탭을 새로 탐색·바인딩한다.
 */
export async function resetTarget() {
  if (client) {
    try { await client.close(); } catch {}
  }
  client = null;
  targetInfo = null;
  targetVerified = false;
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
