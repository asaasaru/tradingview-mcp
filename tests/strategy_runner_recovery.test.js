import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const strategyRunnerPath = path.resolve(__dirname, '../src/core/strategy-runner.js');
const runnerSource = await fs.readFile(strategyRunnerPath, 'utf8');

async function loadRunner(fixtures = {}) {
  const context = vm.createContext({
    setTimeout: (fn) => {
      if (typeof fn === 'function') fn();
      return 0;
    },
    clearTimeout: () => {},
    Promise,
    console,
    globalThis: {},
  });

  const mod = new vm.SourceTextModule(runnerSource, {
    context,
    importModuleDynamically: async (specifier) => {
      if (specifier === './capture.js') {
        const dep = new vm.SyntheticModule(['captureScreenshot'], function () {
          this.setExport('captureScreenshot', async () => ({ file_path: null }));
        }, { context });
        await dep.link(() => {});
        await dep.evaluate();
        return dep;
      }
      throw new Error(`Unknown dynamic import: ${specifier}`);
    },
  });

  await mod.link(async (specifier) => {
    if (specifier === '../connection.js') {
      const m = new vm.SyntheticModule(['evaluate', 'getClient'], function () {
        this.setExport('evaluate', async (code) => {
          if (typeof fixtures.evaluate === 'function') return fixtures.evaluate(code);
          return fixtures.evaluate ?? true;
        });
        this.setExport('getClient', async () => ({}));
      }, { context });
      await m.link(() => {});
      await m.evaluate();
      return m;
    }
    if (specifier === './pine.js') {
      const m = new vm.SyntheticModule(['setSource', 'smartCompile'], function () {
        this.setExport('setSource', async () => ({ success: true }));
        this.setExport('smartCompile', async () => {
          if (typeof fixtures.smartCompile === 'function') return fixtures.smartCompile();
          return fixtures.compileFixture || { button_clicked: 'Add', method: 'dom', has_errors: false, study_added: true };
        });
      }, { context });
      await m.link(() => {});
      await m.evaluate();
      return m;
    }
    if (specifier === './data.js') {
      const m = new vm.SyntheticModule(['getStrategyResults'], function () {
        this.setExport('getStrategyResults', async () => {
          if (typeof fixtures.getStrategyResults === 'function') return fixtures.getStrategyResults();
          return fixtures.resultsFixture || { success: true, metric_count: 6, metrics: { total_closed_trades: 43 } };
        });
      }, { context });
      await m.link(() => {});
      await m.evaluate();
      return m;
    }
    if (specifier === './ui.js') {
      const m = new vm.SyntheticModule(['openPanel'], function () {
        this.setExport('openPanel', async () => ({ success: true }));
      }, { context });
      await m.link(() => {});
      await m.evaluate();
      return m;
    }
    if (specifier === './watchdog.js') {
      const m = new vm.SyntheticModule(['cancelWatchdog', 'startWatchdog'], function () {
        this.setExport('cancelWatchdog', () => {});
        this.setExport('startWatchdog', () => {
          if (fixtures.allowStartWatchdog) return;
          throw new Error('Do not arm watchdog in tests');
        });
      }, { context });
      await m.link(() => {});
      await m.evaluate();
      return m;
    }
    throw new Error(`Unknown specifier: ${specifier}`);
  });

  await mod.evaluate();
  return mod.namespace;
}

test('smartCompile study_added false must return success false with error containing not added to chart and compile evidence', async () => {
  const runner = await loadRunner({
    compileFixture: { button_clicked: 'Add', method: 'dom', has_errors: false, study_added: false },
  });
  const res = await runner.runStrategy({ source: '// test source' });
  assert.strictEqual(res.success, false);
  assert.ok(res.error, 'error field must be present');
  assert.match(res.error, /not added to chart/i, 'error should indicate script not added to chart');
  assert.ok(res.compile, 'compile evidence must be present');
  assert.strictEqual(res.compile.study_added, false);
});

test('compile.has_errors propagated as before', async () => {
  const runner = await loadRunner({
    compileFixture: { button_clicked: 'Add', method: 'dom', has_errors: true, errors: [{ message: 'Syntax error' }] },
  });
  const res = await runner.runStrategy({ source: '// test source' });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error, 'Compilation failed');
  assert.strictEqual(res.has_errors, true);
  assert.deepStrictEqual(res.errors, [{ message: 'Syntax error' }]);
  assert.strictEqual(res.action_required, false);
});

test('zero metrics must never success true (no_metrics error and preserves blocking_state)', async () => {
  const runner = await loadRunner({
    compileFixture: { button_clicked: 'Add', method: 'dom', has_errors: false, study_added: true },
    resultsFixture: { success: true, metric_count: 0, metrics: {} },
  });
  const res = await runner.runStrategy({ source: '// test source' });
  assert.strictEqual(res.success, false);
  assert.match(res.error, /no_metrics/i, 'error must indicate no_metrics');
  assert.strictEqual(res.metric_count, 0);
  assert.ok('blocking_state' in res, 'blocking_state field should be preserved');
});

test('positive six metrics succeeds', async () => {
  const runner = await loadRunner({
    compileFixture: { button_clicked: 'Add', method: 'dom', has_errors: false, study_added: true },
    resultsFixture: { success: true, metric_count: 6, metrics: { total_closed_trades: 43 } },
  });
  const res = await runner.runStrategy({ source: '// test source' });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.metric_count, 6);
  assert.strictEqual(res.metrics?.total_closed_trades, 43);
  assert.strictEqual(res.compile?.study_added, true);
});

test('preserve compile.study_added field when null (update mode)', async () => {
  const runner = await loadRunner({
    compileFixture: { button_clicked: 'Update', method: 'dom', has_errors: false, study_added: null },
    resultsFixture: { success: true, metric_count: 6, metrics: { total_closed_trades: 43 } },
  });
  const res = await runner.runStrategy({ source: '// test source' });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.metric_count, 6);
  assert.ok('study_added' in res.compile, 'study_added field should exist in compile object');
  assert.strictEqual(res.compile.study_added, null);
  assert.strictEqual(res.compile.button_clicked, 'Update');
});

test('resultsResult.success false must never success true', async () => {
  const runner = await loadRunner({
    compileFixture: { button_clicked: 'Add', method: 'dom', has_errors: false, study_added: true },
    resultsFixture: { success: false, metric_count: 6, metrics: { total_closed_trades: 43 } },
  });
  const res = await runner.runStrategy({ source: '// test source' });
  assert.strictEqual(res.success, false);
  assert.match(res.error, /no_metrics/i);
});

test('smartCompile UI error returns action_required failure and does not arm startWatchdog', async () => {
  const runner = await loadRunner({
    smartCompile: () => {
      const err = new Error('Pine editor UI blocked');
      err.userMessage = 'Check chart layout';
      throw err;
    },
  });
  const res = await runner.runStrategy({ source: '// test source' });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.action_required, true);
  assert.strictEqual(res.error, 'Pine editor UI blocked');
  assert.strictEqual(res.user_message, 'Check chart layout');
});
