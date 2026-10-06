import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pineToolsPath = path.resolve(__dirname, '../src/tools/pine.js');
const pineSource = await fs.readFile(pineToolsPath, 'utf8');

function unpackResult(result) {
  assert.ok(result, 'Result should exist');
  assert.ok(Array.isArray(result.content), 'Result should have content array');
  assert.strictEqual(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}

async function loadPineTools(fixtures = {}) {
  const watchdogCalls = { start: 0, cancel: 0 };
  const notifierCalls = { sendTelegram: 0 };

  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    Promise,
    console,
    globalThis: {},
  });

  const mod = new vm.SourceTextModule(pineSource, { context });

  await mod.link(async (specifier) => {
    if (specifier === 'zod') {
      const m = new vm.SyntheticModule(['z'], function () {
        const schema = { describe: () => schema };
        const z = {
          string: () => schema,
          enum: () => schema,
        };
        this.setExport('z', z);
      }, { context });
      await m.link(() => {});
      await m.evaluate();
      return m;
    }

    if (specifier === './_format.js') {
      const m = new vm.SyntheticModule(['jsonResult'], function () {
        this.setExport('jsonResult', (obj, isError = false) => ({
          content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
          ...(isError && { isError: true }),
        }));
      }, { context });
      await m.link(() => {});
      await m.evaluate();
      return m;
    }

    if (specifier === '../core/pine.js') {
      const exportNames = [
        'getSource',
        'setSource',
        'compile',
        'getErrors',
        'save',
        'getConsole',
        'smartCompile',
        'newScript',
        'openScript',
        'listScripts',
        'analyze',
        'check',
      ];
      const m = new vm.SyntheticModule(exportNames, function () {
        for (const name of exportNames) {
          this.setExport(name, (...args) => {
            if (typeof fixtures[name] === 'function') {
              return fixtures[name](...args);
            }
            if (name in fixtures) {
              return fixtures[name];
            }
            return { success: true };
          });
        }
      }, { context });
      await m.link(() => {});
      await m.evaluate();
      return m;
    }

    if (specifier === '../core/watchdog.js') {
      const m = new vm.SyntheticModule(['startWatchdog', 'cancelWatchdog'], function () {
        this.setExport('startWatchdog', () => {
          watchdogCalls.start++;
        });
        this.setExport('cancelWatchdog', () => {
          watchdogCalls.cancel++;
        });
      }, { context });
      await m.link(() => {});
      await m.evaluate();
      return m;
    }

    if (specifier === '../core/notifier.js') {
      const m = new vm.SyntheticModule(['sendTelegram'], function () {
        this.setExport('sendTelegram', async () => {
          notifierCalls.sendTelegram++;
          return true;
        });
      }, { context });
      await m.link(() => {});
      await m.evaluate();
      return m;
    }

    throw new Error(`Unknown specifier: ${specifier}`);
  });

  await mod.evaluate();

  const tools = new Map();
  const server = {
    tool: (name, description, schema, handler) => {
      tools.set(name, { description, schema, handler });
    },
  };

  mod.namespace.registerPineTools(server);

  return {
    tools,
    watchdogCalls,
    notifierCalls,
  };
}

test('pine_compile with CompileButtonNotFoundError preserves structured action_required error without starting watchdog or notifying', async () => {
  const { tools, watchdogCalls, notifierCalls } = await loadPineTools({
    compile: () => {
      const err = new Error('Could not find Add to Chart or Update button');
      err.name = 'CompileButtonNotFoundError';
      err.userMessage = 'Compile button not found on chart';
      throw err;
    },
  });

  const pineCompile = tools.get('pine_compile');
  assert.ok(pineCompile, 'pine_compile must be registered');

  const raw = await pineCompile.handler({});
  const data = unpackResult(raw);

  assert.strictEqual(raw.isError, true);
  assert.strictEqual(data.success, false);
  assert.strictEqual(data.action_required, true);
  assert.strictEqual(data.error, 'Could not find Add to Chart or Update button');
  assert.strictEqual(data.user_message, 'Compile button not found on chart');

  assert.strictEqual(watchdogCalls.start, 0, 'startWatchdog must not be called');
  assert.strictEqual(notifierCalls.sendTelegram, 0, 'sendTelegram must not be called');
});

test('pine_smart_compile with CompileButtonNotFoundError preserves structured action_required error without starting watchdog or notifying', async () => {
  const { tools, watchdogCalls, notifierCalls } = await loadPineTools({
    smartCompile: () => {
      const err = new Error('Smart compile button not found');
      err.name = 'CompileButtonNotFoundError';
      err.userMessage = 'Smart compile button missing from editor';
      throw err;
    },
  });

  const pineSmartCompile = tools.get('pine_smart_compile');
  assert.ok(pineSmartCompile, 'pine_smart_compile must be registered');

  const raw = await pineSmartCompile.handler({});
  const data = unpackResult(raw);

  assert.strictEqual(raw.isError, true);
  assert.strictEqual(data.success, false);
  assert.strictEqual(data.action_required, true);
  assert.strictEqual(data.error, 'Smart compile button not found');
  assert.strictEqual(data.user_message, 'Smart compile button missing from editor');

  assert.strictEqual(watchdogCalls.start, 0, 'startWatchdog must not be called');
  assert.strictEqual(notifierCalls.sendTelegram, 0, 'sendTelegram must not be called');
});

test('pine_compile normal success cancels previous watchdog and preserves result', async () => {
  const { tools, watchdogCalls, notifierCalls } = await loadPineTools({
    compile: () => ({ success: true, compiled: true, button_clicked: 'Add' }),
  });

  const pineCompile = tools.get('pine_compile');
  assert.ok(pineCompile, 'pine_compile must be registered');

  const raw = await pineCompile.handler({});
  const data = unpackResult(raw);

  assert.strictEqual(Boolean(raw.isError), false);
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.compiled, true);
  assert.strictEqual(data.button_clicked, 'Add');

  assert.strictEqual(watchdogCalls.cancel, 1, 'cancelWatchdog must be called on compile');
  assert.strictEqual(watchdogCalls.start, 0, 'startWatchdog must not be called on success');
  assert.strictEqual(notifierCalls.sendTelegram, 0, 'sendTelegram must not be called on success');
});

test('pine_smart_compile normal success cancels previous watchdog and preserves result', async () => {
  const { tools, watchdogCalls, notifierCalls } = await loadPineTools({
    smartCompile: () => ({ success: true, method: 'dom', button_clicked: 'Update', study_added: null }),
  });

  const pineSmartCompile = tools.get('pine_smart_compile');
  assert.ok(pineSmartCompile, 'pine_smart_compile must be registered');

  const raw = await pineSmartCompile.handler({});
  const data = unpackResult(raw);

  assert.strictEqual(Boolean(raw.isError), false);
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.method, 'dom');
  assert.strictEqual(data.button_clicked, 'Update');
  assert.strictEqual(data.study_added, null);

  assert.strictEqual(watchdogCalls.cancel, 1, 'cancelWatchdog must be called on smart compile');
  assert.strictEqual(watchdogCalls.start, 0, 'startWatchdog must not be called on success');
  assert.strictEqual(notifierCalls.sendTelegram, 0, 'sendTelegram must not be called on success');
});

test('pine_compile other errors cancel previous watchdog and preserve existing failure', async () => {
  const { tools, watchdogCalls, notifierCalls } = await loadPineTools({
    compile: () => {
      throw new Error('Pine script compilation syntax error');
    },
  });

  const pineCompile = tools.get('pine_compile');
  assert.ok(pineCompile, 'pine_compile must be registered');

  const raw = await pineCompile.handler({});
  const data = unpackResult(raw);

  assert.strictEqual(raw.isError, true);
  assert.strictEqual(data.success, false);
  assert.strictEqual(data.error, 'Pine script compilation syntax error');
  assert.strictEqual('action_required' in data, false);

  assert.strictEqual(watchdogCalls.cancel, 1, 'cancelWatchdog must be called before attempt');
  assert.strictEqual(watchdogCalls.start, 0, 'startWatchdog must not be called on generic error');
  assert.strictEqual(notifierCalls.sendTelegram, 0, 'sendTelegram must not be called on generic error');
});

test('pine_smart_compile other errors cancel previous watchdog and preserve existing failure', async () => {
  const { tools, watchdogCalls, notifierCalls } = await loadPineTools({
    smartCompile: () => {
      throw new Error('Editor element unavailable');
    },
  });

  const pineSmartCompile = tools.get('pine_smart_compile');
  assert.ok(pineSmartCompile, 'pine_smart_compile must be registered');

  const raw = await pineSmartCompile.handler({});
  const data = unpackResult(raw);

  assert.strictEqual(raw.isError, true);
  assert.strictEqual(data.success, false);
  assert.strictEqual(data.error, 'Editor element unavailable');
  assert.strictEqual('action_required' in data, false);

  assert.strictEqual(watchdogCalls.cancel, 1, 'cancelWatchdog must be called before attempt');
  assert.strictEqual(watchdogCalls.start, 0, 'startWatchdog must not be called on generic error');
  assert.strictEqual(notifierCalls.sendTelegram, 0, 'sendTelegram must not be called on generic error');
});
