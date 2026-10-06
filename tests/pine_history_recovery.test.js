/**
 * Tests for Pine Editor historical banner recovery, Monaco read-only detection,
 * verified UI menu navigation, zero-setValue safety on failure, and source verification.
 * Portable across Node.js environments via node:vm.SourceTextModule with synthetic connection stub.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pinePath = path.resolve(__dirname, '../src/core/pine.js');
const pineSource = fs.readFileSync(pinePath, 'utf8');

/**
 * Creates simulated page state for TradingView Pine Editor DOM and Monaco environment.
 */
class SimulatedTradingViewPage {
  constructor(options = {}) {
    this.bannerText = options.bannerText || '';
    this.isReadOnly = options.readOnly !== undefined ? options.readOnly : false;
    this.readOnlyOptionId = options.readOnlyOptionId || 91;
    this.source = options.initialSource || '';
    this.menuFails = !!options.menuFails;
    this.recoveryFails = !!options.recoveryFails;
    this.readOnlyAfterWrite = !!options.readOnlyAfterWrite;
    this.mutateOnSet = options.mutateOnSet || null;
    this.strategyLabel = options.strategyLabel !== undefined ? options.strategyLabel : 'Strategy⌘ K, ⌘ S';
    this.decoys = options.decoys || [];
    this.unknownReadOnly = !!options.unknownReadOnly;

    // Trackers
    this.setValueCount = 0;
    this.setValues = [];
    this.titleButtonClickCount = 0;
    this.createNewClickCount = 0;
    this.createNewHoverCount = 0;
    this.strategyClickCount = 0;
    this.restoreClickCount = 0;
    this.saveClickCount = 0;
    this.publishClickCount = 0;
    this.makeACopyClickCount = 0;
    this.dispatchedKeys = [];

    // Menu visibility state
    this.titleMenuOpen = false;
    this.submenuOpen = false;

    this.editorInstance = {
      setValue: (val) => {
        this.setValueCount++;
        this.setValues.push(val);
        this.source = this.mutateOnSet ? this.mutateOnSet(val) : val;
        if (this.readOnlyAfterWrite) {
          this.isReadOnly = true;
        }
      },
      getValue: () => this.source,
      focus: () => {}
    };

    if (!this.unknownReadOnly) {
      this.editorInstance.getOption = (optId) => {
        if (optId === this.readOnlyOptionId) {
          return this.isReadOnly;
        }
        return undefined;
      };
      this.editorInstance.getRawOptions = () => ({ readOnly: this.isReadOnly });
    }

    this.editorEnv = {
      editor: {
        getEditors: () => [this.editorInstance]
      },
      EditorOption: {
        readOnly: this.readOnlyOptionId
      }
    };
  }
}

/**
 * Builds a realistic DOM environment reflecting actual TradingView DOM selectors
 * found in editor-menu-evidence.json and editor-submenu-evidence.json.
 */
function createFakeDOMContext(page) {
  const titleButton = {
    getAttribute: (name) => (name === 'data-qa-id' ? 'pine-script-title-button' : null),
    textContent: 'Untitled script',
    className: '',
    offsetParent: {},
    click: () => {
      page.titleButtonClickCount++;
      if (!page.menuFails) {
        page.titleMenuOpen = true;
      }
    },
    dispatchEvent: () => true
  };

  const createNewMenuItem = {
    getAttribute: (name) => (name === 'role' ? 'menuitem' : null),
    textContent: ' Create new ',
    className: '',
    offsetParent: {},
    click: () => {
      page.createNewClickCount++;
      if (!page.menuFails) {
        page.submenuOpen = true;
      }
    },
    dispatchEvent: (ev) => {
      if (ev && (ev.type === 'mouseover' || ev.type === 'mouseenter')) {
        page.createNewHoverCount++;
        if (!page.menuFails) {
          page.submenuOpen = true;
        }
      }
      return true;
    }
  };

  const strategyMenuItem = {
    getAttribute: (name) => (name === 'role' ? 'menuitem' : null),
    textContent: page.strategyLabel,
    className: '',
    offsetParent: {},
    click: () => {
      page.strategyClickCount++;
      if (!page.recoveryFails) {
        page.bannerText = '';
        page.isReadOnly = false;
        page.titleMenuOpen = false;
        page.submenuOpen = false;
      }
    },
    dispatchEvent: () => true
  };

  // Traps for forbidden actions
  const restoreButton = {
    getAttribute: () => null,
    textContent: 'restore this version',
    className: '',
    offsetParent: {},
    click: () => { page.restoreClickCount++; },
    dispatchEvent: () => true
  };
  const saveButton = {
    getAttribute: () => null,
    textContent: 'Save script',
    className: '',
    offsetParent: {},
    click: () => { page.saveClickCount++; },
    dispatchEvent: () => true
  };
  const publishButton = {
    getAttribute: () => null,
    textContent: 'Publish script',
    className: '',
    offsetParent: {},
    click: () => { page.publishClickCount++; },
    dispatchEvent: () => true
  };
  const makeACopyButton = {
    getAttribute: () => null,
    textContent: 'Make a copy…',
    className: '',
    offsetParent: {},
    click: () => { page.makeACopyClickCount++; },
    dispatchEvent: () => true
  };

  // Monaco editor element with React Fiber
  const monacoContainer = {
    className: 'monaco-editor pine-editor-monaco',
    parentElement: null,
    offsetParent: {},
    getAttribute: (name) => (name === 'class' ? 'monaco-editor pine-editor-monaco' : null),
    __reactFiber$tvTest: {
      memoizedProps: {
        value: {
          monacoEnv: page.editorEnv
        }
      },
      return: null
    }
  };

  const fakeDocument = {
    body: {
      get innerText() { return page.bannerText; },
      set innerText(v) { page.bannerText = v; },
      get textContent() { return page.bannerText; },
      set textContent(v) { page.bannerText = v; }
    },
    querySelector: (sel) => {
      if (typeof sel !== 'string') return null;
      if (sel.includes('.monaco-editor.pine-editor-monaco') || sel === '.monaco-editor.pine-editor-monaco') {
        return monacoContainer;
      }
      if (sel.includes('pine-script-title-button')) {
        return titleButton;
      }
      if (sel.includes('pine-dialog-button') || sel.includes('aria-label="Pine"')) {
        return { click: () => {} };
      }
      return null;
    },
    querySelectorAll: (sel) => {
      const items = [
        restoreButton,
        saveButton,
        publishButton,
        makeACopyButton
      ];
      if (page.decoys && page.decoys.length > 0) {
        items.push(...page.decoys);
      }
      if (page.titleMenuOpen) {
        items.push(createNewMenuItem);
      }
      if (page.submenuOpen) {
        items.push(strategyMenuItem);
      }
      return items;
    }
  };

  const fakeWindow = {
    document: fakeDocument,
    location: { href: 'https://www.tradingview.com/chart/' },
    TradingView: { bottomWidgetBar: {} },
    MouseEvent: class MouseEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.bubbles = !!init.bubbles;
        this.cancelable = !!init.cancelable;
      }
    }
  };

  return {
    document: fakeDocument,
    window: fakeWindow,
    MouseEvent: fakeWindow.MouseEvent,
    Array,
    Object,
    String,
    RegExp,
    JSON,
    Date
  };
}

/**
 * Loads pine.js with synthetic ../connection.js stub via vm.SourceTextModule,
 * with fallback to vm context execution if experimental-vm-modules is disabled.
 */
async function loadPineModule({ evaluate, evaluateAsync, getClient }) {
  if (typeof vm.SourceTextModule === 'function' && typeof vm.SyntheticModule === 'function') {
    const context = vm.createContext({
      console,
      setTimeout,
      clearTimeout,
      Date,
      JSON,
      String,
      Array,
      Object,
      RegExp,
      Error,
      Promise,
      process,
      URLSearchParams,
      fetch,
      MouseEvent: class MouseEvent {
        constructor(type, init = {}) {
          this.type = type;
          this.bubbles = !!init.bubbles;
          this.cancelable = !!init.cancelable;
        }
      }
    });

    const connectionModule = new vm.SyntheticModule(
      ['evaluate', 'evaluateAsync', 'getClient'],
      function() {
        this.setExport('evaluate', evaluate);
        this.setExport('evaluateAsync', evaluateAsync || evaluate);
        this.setExport('getClient', getClient || (async () => ({})));
      },
      { context }
    );

    const pineModule = new vm.SourceTextModule(pineSource, {
      context,
      initializeImportMeta(meta) {
        meta.url = `file://${pinePath}`;
      }
    });

    await pineModule.link(async (specifier) => {
      if (specifier === '../connection.js') {
        return connectionModule;
      }
      throw new Error(`Unexpected import specifier: ${specifier}`);
    });

    await pineModule.evaluate();
    return pineModule.namespace;
  } else {
    // Portable fallback for environments where --experimental-vm-modules is not set
    const context = vm.createContext({
      console,
      setTimeout,
      clearTimeout,
      Date,
      JSON,
      String,
      Array,
      Object,
      RegExp,
      Error,
      Promise,
      process,
      URLSearchParams,
      fetch,
      __syntheticConnection: {
        evaluate,
        evaluateAsync: evaluateAsync || evaluate,
        getClient: getClient || (async () => ({}))
      },
      exports: {}
    });

    let transformed = pineSource
      .replace(
        /import\s*\{\s*evaluate\s*,\s*evaluateAsync\s*,\s*getClient\s*\}\s*from\s*['"]\.\.\/connection\.js['"];?/,
        'const { evaluate, evaluateAsync, getClient } = __syntheticConnection;'
      )
      .replace(/export\s+(async\s+function|function|class)\s+([a-zA-Z0-9_$]+)/g, '$1 $2')
      .replace(/export\s+const\s+([a-zA-Z0-9_$]+)/g, 'const $1');

    transformed += `
      exports.ensurePineEditorOpen = ensurePineEditorOpen;
      exports.analyze = analyze;
      exports.check = check;
      exports.getSource = getSource;
      exports.HISTORICAL_BANNER_REGEX = HISTORICAL_BANNER_REGEX;
      exports.getEditorStatus = getEditorStatus;
      exports.resetEditorToBlank = resetEditorToBlank;
      exports.setSource = setSource;
      exports.CompileButtonNotFoundError = CompileButtonNotFoundError;
      exports.compile = compile;
      exports.getErrors = getErrors;
      exports.save = save;
      exports.getConsole = getConsole;
      exports.smartCompile = smartCompile;
      exports.newScript = newScript;
      exports.openScript = openScript;
      exports.listScripts = listScripts;
    `;

    vm.runInContext(transformed, context);
    return context.exports;
  }
}

/**
 * Sets up evaluate and getClient stubs connected to SimulatedTradingViewPage.
 */
function createStubs(page) {
  const domContext = createFakeDOMContext(page);
  const vmContext = vm.createContext(domContext);

  const evaluate = async (code) => {
    return vm.runInContext(code, vmContext);
  };

  const getClient = async () => ({
    Input: {
      dispatchKeyEvent: async (event) => {
        page.dispatchedKeys.push(event);
      }
    }
  });

  return { evaluate, getClient };
}

// ── Test Suites ──

test('1. HISTORICAL_BANNER_REGEX matches all actual current and old banner variations', async () => {
  const { HISTORICAL_BANNER_REGEX } = await loadPineModule({
    evaluate: async () => {},
    getClient: async () => ({})
  });

  const matchingBanners = [
    'Historical version cannot be published',
    "Historical version can't be published",
    'Historical version can’t be published',
    'Historical version cant be published',
    'Historical version cannot be published. To edit its code, restore this version.',
    'historical version of the script',
    'To edit its code, restore this version',
    'To edit its code restore this version',
    'Notice: historical version of the script is currently opened in editor'
  ];

  for (const text of matchingBanners) {
    assert.equal(
      HISTORICAL_BANNER_REGEX.test(text),
      true,
      `Expected banner regex to match: "${text}"`
    );
  }

  const nonMatchingTexts = [
    '//@version=6\nstrategy("My Strategy", overlay=true)',
    'Script compiled successfully without errors',
    'Saved script "Breakout Strategy"'
  ];

  for (const text of nonMatchingTexts) {
    assert.equal(
      HISTORICAL_BANNER_REGEX.test(text),
      false,
      `Expected banner regex to NOT match: "${text}"`
    );
  }
});

test('2. Current banner triggers fresh strategy recovery and succeeds without Restore/Save', async () => {
  const page = new SimulatedTradingViewPage({
    bannerText: "Historical version can't be published. To edit its code, restore this version.",
    readOnly: true
  });
  const stubs = createStubs(page);
  const { setSource } = await loadPineModule(stubs);

  const testSource = '//@version=6\nstrategy("FreshStrategy", overlay=true)\nplot(close)';
  const result = await setSource({ source: testSource });

  assert.equal(result.success, true);
  assert.equal(page.setValueCount, 1);
  assert.equal(page.source, testSource);
  assert.equal(page.isReadOnly, false);
  assert.equal(page.bannerText, '');

  // Strict verification of forbidden and required actions
  assert.equal(page.restoreClickCount, 0, 'Restore link must NEVER be clicked');
  assert.equal(page.saveClickCount, 0, 'Save must NEVER be clicked');
  assert.equal(page.publishClickCount, 0, 'Publish must NEVER be clicked');
  assert.equal(page.makeACopyClickCount, 0, 'Make a copy must NEVER be clicked');

  assert.equal(page.titleButtonClickCount, 1, 'Script title button must be clicked to open menu');
  assert.equal(page.createNewClickCount, 1, 'Create new menu item must be clicked');
  assert.equal(page.strategyClickCount, 1, 'Strategy submenu item must be clicked');

  // Verify no Ctrl+A/Delete dispatched before setValue
  const hasCtrlADelete = page.dispatchedKeys.some(k => k.key === 'a' || k.key === 'Delete');
  assert.equal(hasCtrlADelete, false, 'Ctrl+A/Delete must NOT be dispatched before setValue');
});

test('3. Banner variation "Historical version cannot be published" triggers recovery', async () => {
  const page = new SimulatedTradingViewPage({
    bannerText: 'Historical version cannot be published',
    readOnly: true
  });
  const stubs = createStubs(page);
  const { setSource } = await loadPineModule(stubs);

  const testSource = '//@version=6\nstrategy("CannotVariant", overlay=true)';
  const result = await setSource({ source: testSource });

  assert.equal(result.success, true);
  assert.equal(page.setValueCount, 1);
  assert.equal(page.restoreClickCount, 0);
  assert.equal(page.source, testSource);
});

test('4. Old banner "historical version of the script" triggers recovery without Restore/Save', async () => {
  const page = new SimulatedTradingViewPage({
    bannerText: 'This is a historical version of the script. To edit its code, restore this version.',
    readOnly: true
  });
  const stubs = createStubs(page);
  const { setSource } = await loadPineModule(stubs);

  const testSource = '//@version=6\nstrategy("OldBannerRecovery", overlay=true)';
  const result = await setSource({ source: testSource });

  assert.equal(result.success, true);
  assert.equal(page.setValueCount, 1);
  assert.equal(page.restoreClickCount, 0);
  assert.equal(page.saveClickCount, 0);
  assert.equal(page.source, testSource);
});

test('5. Recovery failure results in ZERO setValue calls (exceptions not ignored)', async () => {
  // Scenario 5A: Menu navigation fails
  const pageA = new SimulatedTradingViewPage({
    bannerText: "Historical version can't be published",
    readOnly: true,
    menuFails: true
  });
  const stubsA = createStubs(pageA);
  const { setSource: setSourceA } = await loadPineModule(stubsA);

  await assert.rejects(
    async () => {
      await setSourceA({ source: '//@version=6\nstrategy("ShouldFail", overlay=true)' });
    },
    /Failed to create fresh strategy via menu/i
  );
  assert.equal(pageA.setValueCount, 0, 'setValue must NOT be called when menu navigation fails');

  // Scenario 5B: Menu clicked but banner/readOnly persists after recovery
  const pageB = new SimulatedTradingViewPage({
    bannerText: "Historical version can't be published",
    readOnly: true,
    recoveryFails: true
  });
  const stubsB = createStubs(pageB);
  const { setSource: setSourceB } = await loadPineModule(stubsB);

  await assert.rejects(
    async () => {
      await setSourceB({ source: '//@version=6\nstrategy("ShouldFail", overlay=true)' });
    },
    /Editor remained read-only or historical after recovery/i
  );
  assert.equal(pageB.setValueCount, 0, 'setValue must NOT be called when editor remains read-only or historical');
});

test('6. Readonly editor with no banner is detected and recovered, or blocked on failure', async () => {
  // Scenario 6A: Readonly without banner recovers successfully
  const pageA = new SimulatedTradingViewPage({
    bannerText: '', // No banner!
    readOnly: true
  });
  const stubsA = createStubs(pageA);
  const { setSource: setSourceA } = await loadPineModule(stubsA);

  const resultA = await setSourceA({ source: '//@version=6\nstrategy("ReadOnlyRecovered", overlay=true)' });
  assert.equal(resultA.success, true);
  assert.equal(pageA.setValueCount, 1);
  assert.equal(pageA.isReadOnly, false);
  assert.equal(pageA.strategyClickCount, 1);

  // Scenario 6B: Readonly without banner where recovery fails is blocked with zero setValue
  const pageB = new SimulatedTradingViewPage({
    bannerText: '',
    readOnly: true,
    recoveryFails: true
  });
  const stubsB = createStubs(pageB);
  const { setSource: setSourceB } = await loadPineModule(stubsB);

  await assert.rejects(
    async () => {
      await setSourceB({ source: '//@version=6\nstrategy("Blocked", overlay=true)' });
    },
    /Editor remained read-only or historical/i
  );
  assert.equal(pageB.setValueCount, 0, 'setValue must be zero when read-only cannot be cleared');
});

test('7. Source mismatch is rejected with error, while CRLF differences are normalized', async () => {
  // Scenario 7A: Source mismatch rejected
  const pageA = new SimulatedTradingViewPage({
    bannerText: '',
    readOnly: false,
    mutateOnSet: (val) => val.slice(0, 15) // simulates truncated write
  });
  const stubsA = createStubs(pageA);
  const { setSource: setSourceA } = await loadPineModule(stubsA);

  await assert.rejects(
    async () => {
      await setSourceA({ source: '//@version=6\nstrategy("FullSourceLengthExceeds15Chars", overlay=true)' });
    },
    /Injected source mismatch/i
  );

  // Scenario 7B: CRLF vs LF normalization passes
  const pageB = new SimulatedTradingViewPage({
    bannerText: '',
    readOnly: false,
    mutateOnSet: (val) => val.replace(/\r\n/g, '\n') // returns LF when input had CRLF
  });
  const stubsB = createStubs(pageB);
  const { setSource: setSourceB } = await loadPineModule(stubsB);

  const crlfSource = '//@version=6\r\nstrategy("CRLF", overlay=true)\r\nplot(close)';
  const resultB = await setSourceB({ source: crlfSource });
  assert.equal(resultB.success, true);
});

test('8. Normal editable source succeeds without reset / menu interaction', async () => {
  const page = new SimulatedTradingViewPage({
    bannerText: '',
    readOnly: false
  });
  const stubs = createStubs(page);
  const { setSource } = await loadPineModule(stubs);

  const normalSource = '//@version=6\nstrategy("NormalEdit", overlay=true)\nplot(open)';
  const result = await setSource({ source: normalSource });

  assert.equal(result.success, true);
  assert.equal(page.setValueCount, 1);
  assert.equal(page.source, normalSource);

  // Ensure menu was NOT triggered unnecessarily
  assert.equal(page.titleButtonClickCount, 0, 'Normal editable editor must not trigger menu sequence');
  assert.equal(page.createNewClickCount, 0);
  assert.equal(page.strategyClickCount, 0);

  // Ensure no Ctrl+A / Delete
  const hasCtrlADelete = page.dispatchedKeys.some(k => k.key === 'a' || k.key === 'Delete');
  assert.equal(hasCtrlADelete, false);
});

test('9. Editor becoming read-only after write is rejected', async () => {
  const page = new SimulatedTradingViewPage({
    bannerText: '',
    readOnly: false,
    readOnlyAfterWrite: true
  });
  const stubs = createStubs(page);
  const { setSource } = await loadPineModule(stubs);

  await assert.rejects(
    async () => {
      await setSource({ source: '//@version=6\nstrategy("ReadOnlyAfterWrite", overlay=true)' });
    },
    /Editor is read-only after write/i
  );
});

test('10. Strategy space shortcut label and parent div decoys are handled correctly', async () => {
  let parentCreateNewDecoyClicked = false;
  let parentStrategyDecoyClicked = false;
  let unrelatedStrategyItemClicked = false;

  const parentCreateNewDecoy = {
    getAttribute: () => null, // div without role=menuitem
    textContent: 'Create new Strategy Indicator Library',
    className: 'menu-parent-container',
    offsetParent: {},
    click: () => { parentCreateNewDecoyClicked = true; },
    dispatchEvent: () => true
  };

  const parentStrategyDecoy = {
    getAttribute: () => null, // div without role=menuitem
    textContent: 'Strategy Tester and Analysis',
    className: 'submenu-parent-container',
    offsetParent: {},
    click: () => { parentStrategyDecoyClicked = true; },
    dispatchEvent: () => true
  };

  const unrelatedStrategyItem = {
    getAttribute: (name) => (name === 'role' ? 'menuitem' : null),
    textContent: 'Strategy Tester', // has role=menuitem but unrelated Strategy text
    className: '',
    offsetParent: {},
    click: () => { unrelatedStrategyItemClicked = true; },
    dispatchEvent: () => true
  };

  const page = new SimulatedTradingViewPage({
    bannerText: "Historical version can't be published. To edit its code, restore this version.",
    readOnly: true,
    strategyLabel: 'Strategy ⌘ K, ⌘ S', // Space between Strategy and shortcut
    decoys: [parentCreateNewDecoy, parentStrategyDecoy, unrelatedStrategyItem]
  });

  const stubs = createStubs(page);
  const { setSource } = await loadPineModule(stubs);

  const testSource = '//@version=6\nstrategy("DecoyAndSpaceShortcutTest", overlay=true)\nplot(close)';
  const result = await setSource({ source: testSource });

  assert.equal(result.success, true);
  assert.equal(page.setValueCount, 1);
  assert.equal(page.source, testSource);
  assert.equal(page.isReadOnly, false);
  assert.equal(page.strategyClickCount, 1);
  assert.equal(page.createNewClickCount, 1);

  // Decoys must NEVER be clicked
  assert.equal(parentCreateNewDecoyClicked, false, 'Parent Create new decoy div must not be clicked');
  assert.equal(parentStrategyDecoyClicked, false, 'Parent Strategy decoy div must not be clicked');
  assert.equal(unrelatedStrategyItemClicked, false, 'Unrelated Strategy menuitem must not be clicked');

  // Forbidden buttons must NEVER be clicked
  assert.equal(page.restoreClickCount, 0);
  assert.equal(page.saveClickCount, 0);
  assert.equal(page.publishClickCount, 0);
  assert.equal(page.makeACopyClickCount, 0);
});

test('11. ReadOnly unknown fails closed when neither getOption nor getRawOptions exists', async () => {
  // Scenario 11A: Direct getEditorStatus reports readOnly=true and isBlocked=true
  const pageA = new SimulatedTradingViewPage({
    bannerText: '',
    readOnly: false,
    unknownReadOnly: true
  });
  const stubsA = createStubs(pageA);
  const { getEditorStatus: getEditorStatusA, setSource: setSourceA } = await loadPineModule(stubsA);

  const statusA = await getEditorStatusA();
  assert.equal(statusA.monacoReady, true);
  assert.equal(statusA.readOnly, true, 'readOnly must be true (fail closed) when neither getOption nor getRawOptions exists');
  assert.equal(statusA.isBlocked, true, 'isBlocked must be true when readOnly cannot be determined');

  // Scenario 11B: setSource rejects and does not write when readOnly is unknown and recovery cannot clear it
  await assert.rejects(
    async () => {
      await setSourceA({ source: '//@version=6\nstrategy("FailClosed", overlay=true)' });
    },
    /Editor remained read-only or historical after recovery/i
  );
  assert.equal(pageA.setValueCount, 0, 'setValue must NOT be called when editor readOnly status is unknown');
});

test('12. Real getEditorStatus verifies banner, readOnly and blocked statuses', async () => {
  // Clean editable
  const pageA = new SimulatedTradingViewPage({ bannerText: '', readOnly: false });
  const { getEditorStatus: getEditorStatusA } = await loadPineModule(createStubs(pageA));
  const statusA = await getEditorStatusA();
  assert.equal(statusA.hasBanner, false);
  assert.equal(statusA.monacoReady, true);
  assert.equal(statusA.readOnly, false);
  assert.equal(statusA.isBlocked, false);

  // Banner present, read-only
  const pageB = new SimulatedTradingViewPage({
    bannerText: 'Historical version cannot be published',
    readOnly: true
  });
  const { getEditorStatus: getEditorStatusB } = await loadPineModule(createStubs(pageB));
  const statusB = await getEditorStatusB();
  assert.equal(statusB.hasBanner, true);
  assert.equal(statusB.monacoReady, true);
  assert.equal(statusB.readOnly, true);
  assert.equal(statusB.isBlocked, true);

  // Banner absent, but read-only
  const pageC = new SimulatedTradingViewPage({ bannerText: '', readOnly: true });
  const { getEditorStatus: getEditorStatusC } = await loadPineModule(createStubs(pageC));
  const statusC = await getEditorStatusC();
  assert.equal(statusC.hasBanner, false);
  assert.equal(statusC.monacoReady, true);
  assert.equal(statusC.readOnly, true);
  assert.equal(statusC.isBlocked, true);
});
