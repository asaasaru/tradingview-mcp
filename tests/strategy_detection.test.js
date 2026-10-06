import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dataJsPath = join(__dirname, '..', 'src', 'core', 'data.js');

function loadDataJs() {
  return fs.readFileSync(dataJsPath, 'utf-8');
}

function extractInjectedScript(fileContent, functionName) {
  const start = fileContent.indexOf(`export async function ${functionName}`);
  if (start === -1) throw new Error(`Function ${functionName} not found in data.js`);
  const evalIdx = fileContent.indexOf('await evaluate(`', start);
  if (evalIdx === -1) throw new Error(`evaluate call not found in ${functionName}`);
  const backtickStart = evalIdx + 'await evaluate(`'.length;
  const backtickEnd = fileContent.indexOf('`', backtickStart);
  let script = fileContent.slice(backtickStart, backtickEnd);
  // Replicate interpolation of KNOWN_PATHS and arguments in connection.js / data.js
  script = script.replace(/\$\{CHART_API\}/g, 'window.TradingViewApi._activeChartWidgetWV.value()');
  script = script.replace(/\$\{limit\}/g, '20');
  return script;
}

function createFakeWindow(sources) {
  return {
    TradingViewApi: {
      _activeChartWidgetWV: {
        value: () => ({
          _chartWidget: {
            model: () => ({
              model: () => ({
                dataSources: () => sources,
              }),
            }),
          },
        }),
      },
    },
  };
}

function runScriptInVm(script, sources) {
  const fakeWindow = createFakeWindow(sources);
  const context = vm.createContext({
    window: fakeWindow,
    document: {},
  });
  return vm.runInContext(script, context);
}

// Wrapper callers named after the public functions
function getStrategyResults(sources) {
  const code = loadDataJs();
  const script = extractInjectedScript(code, 'getStrategyResults');
  return runScriptInVm(script, sources);
}

function getTrades(sources, max_trades = 20) {
  const code = loadDataJs();
  let script = extractInjectedScript(code, 'getTrades');
  script = script.replace('20', String(max_trades));
  return runScriptInVm(script, sources);
}

function getStrategyTrades(sources, max_trades = 20) {
  return getTrades(sources, max_trades);
}

function getEquity(sources) {
  const code = loadDataJs();
  const script = extractInjectedScript(code, 'getEquity');
  return runScriptInVm(script, sources);
}

function getStrategyEquity(sources) {
  return getEquity(sources);
}

describe('Strategy detection regression tests', () => {
  // Actual chart strategy on price: is_price_study=true, isTVScriptStrategy=true, reportData & performance present
  const priceOverlayStrategy = {
    metaInfo: () => ({
      isTVScriptStrategy: true,
      is_price_study: true,
      description: 'Overlay Strategy (Price)',
      shortDescription: 'PriceStrat',
    }),
    reportData: () => ({
      net_profit: 3500.5,
      net_profit_pct: '35.0%',
      win_rate: 68.2,
      total_closed_trades: 25,
    }),
    performance: () => ({
      net_profit: 3500.5,
      all_trades: 25,
    }),
    ordersData: () => [
      { id: 'trade-1', price: 101.5, qty: 10, side: 'buy' },
      { id: 'trade-2', price: 104.2, qty: 10, side: 'sell' },
    ],
    equityData: () => [
      { time: 1700000000, equity: 10000 },
      { time: 1700001000, equity: 10350 },
    ],
  };

  // Separate pane strategy: is_price_study=false, isTVScriptStrategy=true
  const paneStrategy = {
    metaInfo: () => ({
      isTVScriptStrategy: true,
      is_price_study: false,
      description: 'Subpane Strategy',
    }),
    reportData: () => ({
      net_profit: 1200,
    }),
    performance: () => ({
      net_profit: 1200,
    }),
    ordersData: () => [
      { id: 'trade-sub-1', price: 50.0, qty: 5 },
    ],
    equityData: () => [
      { time: 1700000000, equity: 10000 },
    ],
  };

  // General indicator / event overlaid on price: has performance, but NO reportData, NO isTVScriptStrategy
  const dividendsIndicator = {
    metaInfo: () => ({
      is_price_study: true,
      description: 'Dividends',
    }),
    performance: () => ({
      internal_exec_time: 12,
    }),
  };

  const earningsIndicator = {
    metaInfo: () => ({
      is_price_study: true,
      description: 'Earnings',
    }),
    performance: () => ({
      internal_exec_time: 5,
    }),
  };

  const splitsIndicator = {
    metaInfo: () => ({
      is_price_study: true,
      description: 'Splits',
    }),
  };

  describe('1. Price overlay strategy detection (is_price_study: true)', () => {
    it('getStrategyResults detects price overlay strategy and returns metrics', () => {
      const res = getStrategyResults([priceOverlayStrategy]);
      assert.equal(res.source, 'internal_api');
      assert.equal(res.error, undefined);
      assert.ok(res.metrics, 'metrics object exists');
      assert.equal(res.metrics.net_profit, 3500.5);
      assert.equal(res.metrics.win_rate, 68.2);
    });

    it('getStrategyTrades (getTrades) detects price overlay strategy and returns orders', () => {
      const res = getStrategyTrades([priceOverlayStrategy]);
      assert.equal(res.source, 'internal_api');
      assert.equal(res.error, undefined);
      assert.equal(res.trades.length, 2);
      assert.equal(res.trades[0].id, 'trade-1');
    });

    it('getStrategyEquity (getEquity) detects price overlay strategy and returns equity curve', () => {
      const res = getStrategyEquity([priceOverlayStrategy]);
      assert.equal(res.source, 'internal_api');
      assert.equal(res.error, undefined);
      assert.equal(res.data.length, 2);
      assert.equal(res.data[0].equity, 10000);
    });
  });

  describe('2. General indicators exclusion (Dividends/Splits/Earnings)', () => {
    it('getStrategyResults ignores price indicators without isTVScriptStrategy even if performance() exists', () => {
      const res = getStrategyResults([dividendsIndicator, earningsIndicator, splitsIndicator]);
      assert.equal(res.source, 'internal_api');
      assert.ok(res.error && res.error.includes('No strategy found'));
      assert.equal(Object.keys(res.metrics || {}).length, 0);
    });

    it('getStrategyTrades ignores general indicators', () => {
      const res = getStrategyTrades([dividendsIndicator, earningsIndicator]);
      assert.equal(res.source, 'internal_api');
      assert.ok(res.error && res.error.includes('No strategy found'));
      assert.equal((res.trades || []).length, 0);
    });

    it('getStrategyEquity ignores general indicators', () => {
      const res = getStrategyEquity([dividendsIndicator, earningsIndicator]);
      assert.equal(res.source, 'internal_api');
      assert.ok(res.error && res.error.includes('No strategy found'));
      assert.equal((res.data || []).length, 0);
    });
  });

  describe('3. Mixed chart sources: general indicators preceding strategy', () => {
    it('detects strategy when general indicators are placed before it in dataSources', () => {
      const sources = [dividendsIndicator, earningsIndicator, priceOverlayStrategy];
      const results = getStrategyResults(sources);
      assert.equal(results.error, undefined);
      assert.equal(results.metrics.net_profit, 3500.5);

      const trades = getStrategyTrades(sources);
      assert.equal(trades.error, undefined);
      assert.equal(trades.trades.length, 2);

      const equity = getStrategyEquity(sources);
      assert.equal(equity.error, undefined);
      assert.equal(equity.data.length, 2);
    });
  });

  describe('4. Separate pane strategy compatibility (is_price_study: false)', () => {
    it('detects subpane strategy with isTVScriptStrategy: true', () => {
      const results = getStrategyResults([paneStrategy]);
      assert.equal(results.error, undefined);
      assert.equal(results.metrics.net_profit, 1200);

      const trades = getStrategyTrades([paneStrategy]);
      assert.equal(trades.error, undefined);
      assert.equal(trades.trades.length, 1);

      const equity = getStrategyEquity([paneStrategy]);
      assert.equal(equity.error, undefined);
      assert.equal(equity.data.length, 1);
    });
  });
});
