import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { normalizeStrategyMetrics } from '../src/core/data.js';

test('1. transforms real reportData.performance.all and maxStrategyDrawDownPercent', () => {
  const raw = {
    performance: {
      all: {
        netProfit: -620.74,
        netProfitPercent: -0.62074,
        totalTrades: 695,
        percentProfitable: 0.3294964,
        profitFactor: 0.644,
      },
      maxStrategyDrawDownPercent: 0.6368,
    },
  };
  const metrics = normalizeStrategyMetrics(raw);
  assert.strictEqual(metrics.net_profit, -620.74);
  assert.strictEqual(metrics.net_profit_pct, -62.074);
  assert.strictEqual(metrics.total_closed_trades, 695);
  assert.strictEqual(metrics.win_rate, 32.94964);
  assert.strictEqual(metrics.profit_factor, 0.644);
  assert.strictEqual(metrics.max_drawdown, 63.68);
});

test('2. preserves zero values and ignores NaN / non-finite values', () => {
  const raw = {
    performance: {
      all: {
        netProfit: 0,
        netProfitPercent: 0,
        totalTrades: 0,
        percentProfitable: 0,
        profitFactor: 0,
      },
      maxStrategyDrawDownPercent: 0,
    },
    invalid_metric: NaN,
    infinite_metric: Infinity,
  };
  const metrics = normalizeStrategyMetrics(raw);
  assert.deepStrictEqual(metrics, {
    net_profit: 0,
    net_profit_pct: 0,
    total_closed_trades: 0,
    win_rate: 0,
    profit_factor: 0,
    max_drawdown: 0,
  });
});

test('3. supports flat canonical metrics compatibility', () => {
  const raw = {
    net_profit: 1250.5,
    net_profit_pct: 12.5,
    total_closed_trades: 150,
    win_rate: 55.4,
    profit_factor: 1.45,
    max_drawdown: 8.2,
  };
  const metrics = normalizeStrategyMetrics(raw);
  assert.deepStrictEqual(metrics, {
    net_profit: 1250.5,
    net_profit_pct: 12.5,
    total_closed_trades: 150,
    win_rate: 55.4,
    profit_factor: 1.45,
    max_drawdown: 8.2,
  });
});

test('4. returns empty object for null, undefined, NaN, and performance: null', () => {
  assert.deepStrictEqual(normalizeStrategyMetrics(null), {});
  assert.deepStrictEqual(normalizeStrategyMetrics(undefined), {});
  assert.deepStrictEqual(normalizeStrategyMetrics(NaN), {});
  assert.deepStrictEqual(normalizeStrategyMetrics({ performance: null }), {});
  assert.deepStrictEqual(normalizeStrategyMetrics({ performance: { all: null } }), {});
  assert.deepStrictEqual(normalizeStrategyMetrics({ net_profit: NaN, win_rate: Infinity }), {});
});

test('5. does not treat raw settings and trades arrays as performance metrics', () => {
  const raw = {
    settings: [{ id: 'param1', value: 10 }, { id: 'param2', value: 20 }],
    trades: [{ id: 1, profit: 50 }, { id: 2, profit: -30 }],
    performance: null,
  };
  const metrics = normalizeStrategyMetrics(raw);
  assert.deepStrictEqual(metrics, {});
});

test('6. ignores amount-only maxDrawdown and requires percent field', () => {
  const rawAmountOnly = {
    performance: {
      all: {
        netProfit: 100,
      },
      maxDrawdown: 500,
    },
    maxDrawdown: 600,
  };
  const metrics = normalizeStrategyMetrics(rawAmountOnly);
  assert.strictEqual(metrics.net_profit, 100);
  assert.strictEqual(metrics.max_drawdown, undefined);
  assert.strictEqual('max_drawdown' in metrics, false);

  const rawWithPercent = {
    performance: {
      all: {
        netProfit: 100,
      },
      maxDrawdown: 500,
      maxStrategyDrawDownPercent: 12.5,
    },
  };
  const metricsWithPct = normalizeStrategyMetrics(rawWithPercent);
  assert.strictEqual(metricsWithPct.net_profit, 100);
  assert.strictEqual(metricsWithPct.max_drawdown, 1250);
});

test('7. handles direct performance or direct all objects with variations', () => {
  const raw = {
    all: {
      netProfit: 500,
      netProfitPercent: 5.0,
      totalTrades: 10,
      percentProfitable: 0.6,
      profitFactor: 2.1,
    },
    maxStrategyDrawDownPercent: 1.5,
  };
  const metrics = normalizeStrategyMetrics(raw);
  assert.strictEqual(metrics.net_profit, 500);
  assert.strictEqual(metrics.net_profit_pct, 500);
  assert.strictEqual(metrics.total_closed_trades, 10);
  assert.strictEqual(metrics.win_rate, 60);
  assert.strictEqual(metrics.profit_factor, 2.1);
  assert.strictEqual(metrics.max_drawdown, 1.5);
});

test('8. getStrategyResults via node:vm sandbox returns honest failure with success: false on empty metrics', async () => {
  const dataJsPath = fileURLToPath(new URL('../src/core/data.js', import.meta.url));
  const dataJsCode = fs.readFileSync(dataJsPath, 'utf8');

  // Extract getStrategyResults function definition
  const marker = 'async function getStrategyResults';
  const startIdx = dataJsCode.indexOf(marker);
  assert.ok(startIdx !== -1, 'getStrategyResults function should exist in src/core/data.js');
  const openBrace = dataJsCode.indexOf('{', startIdx);
  let depth = 1;
  let endIdx = openBrace + 1;
  while (depth > 0 && endIdx < dataJsCode.length) {
    if (dataJsCode[endIdx] === '{') depth++;
    else if (dataJsCode[endIdx] === '}') depth--;
    endIdx++;
  }
  const fnSnippet = dataJsCode.slice(startIdx, endIdx);

  const sandboxContext = {
    evaluate: async () => ({ metrics: {}, source: 'internal_api' }),
    CHART_API: 'mock_chart_api',
    DOM_LABEL_VALUE_SCRAPE: 'mock_lv',
    DOM_STRATEGY_SCRAPE: 'mock_dom',
    parseLabelValuePairs: () => ({}),
    parseStrategyDom: () => ({}),
    normalizeStrategyMetrics,
  };

  const context = vm.createContext(sandboxContext);
  const runner = vm.runInContext(`(${fnSnippet})`, context);
  const res = await runner();

  assert.strictEqual(res.success, false);
  assert.strictEqual(res.metric_count, 0);
  assert.strictEqual(Object.keys(res.metrics).length, 0);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(res.metrics)), {});
  assert.ok(typeof res.error === 'string' && res.error.length > 0);
});

test('9. regression: exact monetary consistency netProfit/1000*100, zero preservation, and legacy canonical no-double-scaling', () => {
  // 1) Actual guided strategy with initial_capital = 1000 (in_23 = 1000)
  const initialCapital = 1000;
  const rawStrategy = {
    reportData: {
      performance: {
        all: {
          netProfit: -929.0842947768008,
          netProfitPercent: -0.9290842947768008,
          totalTrades: 42,
          percentProfitable: 0.38095238,
          profitFactor: 0.75,
        },
        maxStrategyDrawDown: 929.0842947768008,
        maxStrategyDrawDownPercent: 0.9290842947768008,
      },
    },
  };

  const metrics = normalizeStrategyMetrics(rawStrategy);
  assert.strictEqual(metrics.net_profit, -929.0842947768008);
  const expectedNetProfitPct = Math.round((-929.0842947768008 / initialCapital * 100) * 1e8) / 1e8;
  const expectedMaxDrawdown = Math.round((929.0842947768008 / initialCapital * 100) * 1e8) / 1e8;
  assert.strictEqual(metrics.net_profit_pct, expectedNetProfitPct);
  assert.strictEqual(metrics.net_profit_pct, -92.90842948);
  assert.strictEqual(metrics.max_drawdown, expectedMaxDrawdown);
  assert.strictEqual(metrics.max_drawdown, 92.90842948);
  assert.strictEqual(metrics.total_closed_trades, 42);
  assert.strictEqual(metrics.win_rate, 38.095238);
  assert.strictEqual(metrics.profit_factor, 0.75);

  // 2) Zero preservation (including -0 avoidance)
  const zeroMetrics = normalizeStrategyMetrics({
    reportData: {
      performance: {
        all: {
          netProfit: 0,
          netProfitPercent: 0,
          percentProfitable: 0,
        },
        maxStrategyDrawDownPercent: 0,
      },
    },
  });
  assert.strictEqual(zeroMetrics.net_profit, 0);
  assert.strictEqual(zeroMetrics.net_profit_pct, 0);
  assert.strictEqual(zeroMetrics.win_rate, 0);
  assert.strictEqual(zeroMetrics.max_drawdown, 0);
  assert.strictEqual(Object.is(zeroMetrics.net_profit_pct, 0), true);

  // 3) Legacy canonical no-double-scaling
  const flatCanonical = {
    net_profit: -929.08,
    net_profit_pct: -92.91,
    max_drawdown: 92.91,
    win_rate: 38.1,
  };
  const normalizedFlat = normalizeStrategyMetrics(flatCanonical);
  assert.strictEqual(normalizedFlat.net_profit_pct, -92.91);
  assert.strictEqual(normalizedFlat.max_drawdown, 92.91);
  assert.strictEqual(normalizedFlat.win_rate, 38.1);
});
