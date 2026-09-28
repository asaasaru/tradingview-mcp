/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

// ── Monaco finder (injected into TV page) ──
const FIND_MONACO = `
  (function findMonacoEditor() {
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!container) return null;
    var el = container;
    var fiberKey;
    for (var i = 0; i < 20; i++) {
      if (!el) break;
      fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') {
          var editors = env.editor.getEditors();
          if (editors.length > 0) return { editor: editors[0], env: env };
        }
      }
      current = current.return;
    }
    return null;
  })()
`;

/**
 * Opens the Pine Editor panel and waits for Monaco to become available.
 * Returns true if editor is accessible, false on timeout.
 */
export async function ensurePineEditorOpen() {
  const already = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      return m !== null;
    })()
  `);
  if (already) return true;

  // 차트 탭 여부 확인 — 새 탭/홈이면 Page.navigate()로 /chart로 이동
  const onChart = await evaluate(
    `String(window.location.href).includes('/chart') || !!(window.TradingView && window.TradingView.bottomWidgetBar)`
  ).catch(() => false);

  if (!onChart) {
    process.stderr.write('[pine] 차트 탭 아님 — tradingview.com/chart 로 CDP 네비게이트\n');
    const c = await getClient();
    try {
      await c.Page.navigate({ url: 'https://www.tradingview.com/chart/' });
      // 네비게이션 후 새 컨텍스트 로드 대기
      await new Promise(r => setTimeout(r, 8000));
    } catch (e) {
      process.stderr.write(`[pine] Page.navigate 실패: ${e.message}\n`);
    }
  }

  // TV 초기화 대기 — bottomWidgetBar 존재까지 최대 45초
  for (let wait = 0; wait < 45; wait++) {
    const bwbReady = await evaluate(`!!(window.TradingView && window.TradingView.bottomWidgetBar)`).catch(() => false);
    if (bwbReady) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  await evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return;
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
    })()
  `);

  await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Pine"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (btn) btn.click();
    })()
  `);

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    const ready = await evaluate(`(function() { return ${FIND_MONACO} !== null; })()`);
    if (ready) return true;
  }
  return false;
}

// ── Pure / offline functions ──

export function analyze({ source }) {
  const lines = source.split('\n');
  const diagnostics = [];

  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array (declared with size 0)`,
          severity: 'warning',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'strategy.entry/close used but no strategy() declaration found — did you mean to use indicator()?',
          severity: 'error',
        });
        break;
      }
    }
  }

  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 5) {
      diagnostics.push({
        line: 1, column: 1,
        message: `Script uses Pine v${vMatch[1]} — consider upgrading to v6 for latest features`,
        severity: 'info',
      });
    }
  }

  return {
    success: true,
    issue_count: diagnostics.length,
    diagnostics,
    note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
  };
}

export async function check({ source }) {
  const formData = new URLSearchParams();
  formData.append('source', source);

  const response = await fetch(
    'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tradingview.com/',
      },
      body: formData,
    }
  );

  if (!response.ok) {
    throw new Error(`TradingView API returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  const errors = [];
  const warnings = [];
  const inner = result?.result;

  if (inner) {
    if (inner.errors2 && inner.errors2.length > 0) {
      for (const e of inner.errors2) {
        errors.push({
          line: e.start?.line, column: e.start?.column,
          end_line: e.end?.line, end_column: e.end?.column,
          message: e.message,
        });
      }
    }
    if (inner.warnings2 && inner.warnings2.length > 0) {
      for (const w of inner.warnings2) {
        warnings.push({ line: w.start?.line, column: w.start?.column, message: w.message });
      }
    }
  }

  if (result.error && typeof result.error === 'string') {
    errors.push({ message: result.error });
  }

  const compiled = errors.length === 0;
  return {
    success: true,
    compiled,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    note: compiled ? 'Pine Script compiled successfully.' : undefined,
  };
}

// ── Functions requiring TradingView connection ──

export async function getSource() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor or Monaco not found in React fiber tree.');

  const source = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return null;
      return m.editor.getValue();
    })()
  `);

  if (source === null || source === undefined) {
    throw new Error('Monaco editor found but getValue() returned null.');
  }

  return { success: true, source, line_count: source.split('\n').length, char_count: source.length };
}

const HISTORICAL_BANNER_CHECK = `
  (function() {
    var bodyText = document.body.innerText || '';
    return /historical version of the script/i.test(bodyText);
  })()
`;

// 이전 스크립트가 "historical version" (읽기 전용 과거 버전) 상태로 남아있으면
// monaco.setValue()가 에디터 안의 텍스트는 바꾸지만, 헤더에 표시되는 스크립트
// 자체(예: 완전히 다른 이름의 예전 저장 스크립트)는 그 historical 상태에 계속
// 묶여있어 Add to chart가 새 코드를 반영하지 못하고 결과 미표시로 무한 반복되는
// 문제가 실측 확인됨 (스크린샷: 헤더 제목이 방금 setValue()로 덮어쓴 코드와 무관한
// 예전 저장 스크립트 이름 그대로였음). 키보드 단축키(Ctrl+K, Ctrl+S)로 새 빈 전략을
// 로드해보려던 첫 시도는 modifier를 Ctrl로 보내 헤더가 전혀 바뀌지 않았음 — Mac
// TradingView 데스크탑 앱에서는 Cmd(Meta)라고 사용자가 실측 확인. modifier는 고쳤지만
// 검증되지 않은 단축키보다 신뢰도 높은 경로로 아래 restore-링크 클릭을 우선한다 —
// 배너의 "restore this version" 링크를 직접 클릭하는, TradingView 자체가 제공하는
// 공식 탈출 경로를 우선 사용한다 (구 Playwright 구현의
// _handle_historical_version_banner와 동일한 접근, CLAUDE.md §22 참고).
async function resetEditorToBlank() {
  const c = await getClient();
  const isMac = process.platform === 'darwin';
  const modifiers = isMac ? 4 : 2; // Meta(Cmd)=4, Ctrl=2

  await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (m && m.editor) { try { m.editor.focus(); } catch(e) {} }
    })()
  `);
  await new Promise(r => setTimeout(r, 150));

  const hadBanner = await evaluate(HISTORICAL_BANNER_CHECK).catch(() => false);
  if (hadBanner) {
    const clicked = await evaluate(`
      (function() {
        var els = document.querySelectorAll('a, button, span, div');
        for (var i = 0; i < els.length; i++) {
          var t = (els[i].textContent || '').trim();
          if (t && /^restore this version$/i.test(t)) {
            els[i].click();
            return true;
          }
        }
        return false;
      })()
    `).catch(() => false);
    let stillBlocked = true;
    if (clicked) {
      await new Promise(r => setTimeout(r, 1500));
      stillBlocked = await evaluate(HISTORICAL_BANNER_CHECK).catch(() => true);
      process.stderr.write(`[pine] historical banner 감지 → restore 링크 클릭 → ${stillBlocked ? '배너 그대로 남음' : '배너 해제됨'}\n`);
    } else {
      process.stderr.write('[pine] historical banner 감지했으나 "restore this version" 링크를 찾지 못함\n');
    }

    // restore 링크로 안 풀리면 최후 수단으로 새 빈 전략을 로드한다. 단, 이건 매번 새
    // 스크립트 identity를 만들어서 "Add to chart"가 "Update on chart"로 이어지지 못하고
    // 매 시도마다 인디케이터가 하나씩 더 쌓이는 부작용이 있음(실측: 25개 제한에 걸려
    // TradingView가 업그레이드 유도 팝업을 띄우고 그 뒤로는 아무것도 안 먹힘) — 그래서
    // banner가 없는 정상 재시도에서는 절대 타지 않고, banner가 있고 restore로도 안 풀릴
    // 때만 예외적으로 쓴다.
    if (stillBlocked) {
      const chord = [
        { key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 },
        { key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 },
      ];
      for (const k of chord) {
        await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
        await c.Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 0, key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
        await new Promise(r => setTimeout(r, 150));
      }
      await new Promise(r => setTimeout(r, 800));

      const dismissedSaveDialog = await evaluate(`
        (function() {
          var btns = document.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) {
            var t = (btns[i].textContent || '').trim();
            if (/^don't save$/i.test(t)) { btns[i].click(); return true; }
          }
          return false;
        })()
      `).catch(() => false);
      if (dismissedSaveDialog) {
        process.stderr.write('[pine] "Save script before switching?" 다이얼로그 감지 → Don\'t save 클릭\n');
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }

  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 0, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  await new Promise(r => setTimeout(r, 150));
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 0, key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 0, key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  await new Promise(r => setTimeout(r, 300));
}

export async function setSource({ source }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  try {
    await resetEditorToBlank();
  } catch (e) {
    process.stderr.write(`[pine] resetEditorToBlank 실패 (무시하고 setValue로 계속): ${e.message}\n`);
  }

  const escaped = JSON.stringify(source);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new Error('Monaco found but setValue() failed.');
  return { success: true, lines_set: source.split('\n').length };
}

export class CompileButtonNotFoundError extends Error {
  constructor() {
    super('Compile button not found after 3 DOM attempts + keyboard shortcut.');
    this.name = 'CompileButtonNotFoundError';
    this.userMessage = [
      'Pine Editor 컴파일 버튼을 찾지 못했습니다 (DOM 3회 + 키보드 단축키 모두 실패).',
      '',
      '다음 중 하나를 해주세요:',
      '  1. "Add to chart" 또는 "Update on chart" 버튼을 직접 클릭해주세요.',
      '  2. 버튼에 표시된 정확한 텍스트를 알려주세요.',
      '  3. Pine Editor가 열려있고 스크립트가 로드된 상태인지 확인해주세요.',
      '',
      '⚠ 5분 내 응답이 없으면 TradingView가 자동으로 종료됩니다.',
    ].join('\n');
  }
}

async function clickCompileButton({ hasExistingStrategy = false } = {}) {
  const isMac = process.platform === 'darwin';
  const modifiers = isMac ? 4 : 2; // Meta(Cmd)=4, Ctrl=2
  const c = await getClient();

  // DOM 버튼 직접 클릭 — Save/unsaved 다이얼로그 없이 작동 (테스트 검증됨)
  // hasExistingStrategy=true 포함 항상 DOM 우선 — Cmd+Enter는 unsaved 다이얼로그 트리거함
  // [data-qa-id="add-script-to-chart"] 는 text가 없어도 visible하면 클릭 가능
  const FIND_COMPILE_BTN = `
    (function() {
      var qaBtn = document.querySelector('[data-qa-id="add-script-to-chart"]');
      if (qaBtn && qaBtn.offsetParent !== null) { qaBtn.click(); return 'Add to chart (qa-id)'; }
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/(Add to chart|Update on chart)/i.test(text) && !/save/i.test(text)) {
          btns[i].click(); return text;
        }
      }
      return null;
    })()
  `;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const clicked = await evaluate(FIND_COMPILE_BTN);
    if (clicked) return { label: clicked, method: 'dom' };
    if (attempt < 3) await new Promise(r => setTimeout(r, 500));
  }

  // 2순위: 키보드 단축키 폴백 (DOM 버튼 없을 때만)
  await evaluate(`
    (function() {
      var closeSelectors = [
        '[data-name="dialog-close"]', '.dialog-close-button',
        'button[aria-label="Close"]', 'button[aria-label="닫기"]',
      ];
      for (var s of closeSelectors) {
        var btn = document.querySelector(s);
        if (btn && btn.offsetParent !== null) { btn.click(); break; }
      }
      var m = ${FIND_MONACO};
      if (m && m.editor) {
        try { m.editor.focus(); } catch(e) {}
      }
    })()
  `);
  await new Promise(r => setTimeout(r, 200));
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 0, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await new Promise(r => setTimeout(r, 1000));

  // 키보드 성공 판단: Monaco 살아있고 + 차단 다이얼로그 없음
  const keyboardOk = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m || !m.editor.getModel()) return false;
      var closeSelectors = [
        '[data-name="dialog-close"]', '.dialog-close-button',
        'button[aria-label="Close"]', 'button[aria-label="닫기"]',
      ];
      for (var s of closeSelectors) {
        var btn = document.querySelector(s);
        if (btn && btn.offsetParent !== null) return false;
      }
      return true;
    })()
  `);
  if (keyboardOk) return { label: isMac ? 'Cmd+Enter' : 'Ctrl+Enter', method: 'keyboard' };

  // 3순위: 좌표 자가학습 — 오버레이 + Telegram 요청
  try {
    const { interactiveClick } = await import('./interactive-click.js');
    const coord = await interactiveClick(
      'add_to_chart_button',
      '"Add to chart" 또는 "Update on chart" 버튼을 클릭해주세요'
    );
    if (coord) return { label: `learned(${coord.x},${coord.y})`, method: 'interactive' };
  } catch (e) {
    process.stderr.write(`[Pine] interactiveClick 실패: ${e.message}\n`);
  }

  throw new CompileButtonNotFoundError();
}

export async function compile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const { label, method } = await clickCompileButton();
  await new Promise(r => setTimeout(r, 2000));
  return { success: true, button_clicked: label, method };
}

export async function getErrors() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  const realErrors = (errors || []).filter(e => e.severity >= 8);
  return {
    success: true,
    has_errors: realErrors.length > 0,
    error_count: realErrors.length,
    errors: realErrors,
  };
}

export async function save() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const c = await getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
  await new Promise(r => setTimeout(r, 800));

  // Handle "Save Script" name dialog that appears for new/unsaved scripts
  const dialogHandled = await evaluate(`
    (function() {
      var saveBtn = null;
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (text === 'Save' && btns[i].offsetParent !== null) {
          // Check if it's in a dialog (not the Pine Editor save button)
          var parent = btns[i].closest('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"]');
          if (parent) { saveBtn = btns[i]; break; }
        }
      }
      if (saveBtn) { saveBtn.click(); return true; }
      return false;
    })()
  `);

  if (dialogHandled) await new Promise(r => setTimeout(r, 500));

  return { success: true, action: dialogHandled ? 'saved_with_dialog' : 'Ctrl+S_dispatched' };
}

export async function getConsole() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const entries = await evaluate(`
    (function() {
      var results = [];
      var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
      if (rows.length === 0) {
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]')
          || document.querySelector('[class*="bottom-widgetbar-content"]');
        if (bottomArea) {
          rows = bottomArea.querySelectorAll('[class*="message"], [class*="log"], [class*="console"]');
        }
      }
      if (rows.length === 0) {
        var pinePanel = document.querySelector('.pine-editor-container')
          || document.querySelector('[class*="pine-editor"]')
          || document.querySelector('[class*="layout__area--bottom"]');
        if (pinePanel) {
          var allSpans = pinePanel.querySelectorAll('span, div');
          for (var s = 0; s < allSpans.length; s++) {
            var txt = allSpans[s].textContent.trim();
            if (/^\\d{2}:\\d{2}:\\d{2}/.test(txt) || /error|warning|info/i.test(allSpans[s].className)) {
              rows = Array.from(rows || []);
              rows.push(allSpans[s]);
            }
          }
        }
      }
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent.trim();
        if (!text) continue;
        var ts = null;
        var tsMatch = text.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}/);
        if (tsMatch) ts = tsMatch[0];
        var type = 'info';
        var cls = rows[i].className || '';
        if (/error/i.test(cls) || /error/i.test(text.substring(0, 30))) type = 'error';
        else if (/compil/i.test(text.substring(0, 40))) type = 'compile';
        else if (/warn/i.test(cls)) type = 'warning';
        results.push({ timestamp: ts, type: type, message: text });
      }
      return results;
    })()
  `);

  return { success: true, entries: entries || [], entry_count: entries?.length || 0 };
}

export async function smartCompile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const hasExisting = (studiesBefore !== null && studiesBefore > 0);
  const { label: buttonClicked, method: buttonMethod } = await clickCompileButton({ hasExistingStrategy: hasExisting });
  await new Promise(r => setTimeout(r, 1200));

  // "Cannot add a script with unsaved changes" 다이얼로그
  // → "Save and add to chart" 클릭 (저장 후 추가 — "No"는 작업 취소임)
  const dialogDismissed = await evaluate(`
    (function() {
      var btns = Array.from(document.querySelectorAll('button')).filter(function(b) { return b.offsetParent; });
      // 1순위: "Save and add to chart" / 한글 변형
      var saveTexts = ["Save and add to chart","저장 후 차트에 추가","Save and add","저장하고 추가"];
      for (var t of saveTexts) {
        var btn = btns.find(function(b) { return b.textContent.trim().toLowerCase().includes(t.toLowerCase()); });
        if (btn) { btn.click(); return 'save_and_add:' + btn.textContent.trim(); }
      }
      return null;
    })()
  `).catch(() => null);

  if (dialogDismissed) {
    process.stderr.write('[Pine] unsaved-changes dialog → save_and_add: ' + dialogDismissed + '\\n');
    await new Promise(r => setTimeout(r, 800));
    // "Save Script" 이름 입력 다이얼로그가 추가로 뜰 수 있음 → OK/저장 클릭
    await evaluate(`
      (function() {
        var okTexts = ["Save","저장","OK","확인"];
        var btns = Array.from(document.querySelectorAll('button')).filter(function(b) { return b.offsetParent; });
        for (var t of okTexts) {
          var btn = btns.find(function(b) {
            var txt = b.textContent.trim();
            return txt === t || txt.toLowerCase() === t.toLowerCase();
          });
          if (btn) { btn.click(); return t; }
        }
        // 입력 필드 있으면 Enter 키
        var inp = document.querySelector('input[placeholder*="name"], input[placeholder*="이름"], dialog input, [role="dialog"] input');
        if (inp && inp.offsetParent) {
          inp.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', keyCode:13, bubbles:true}));
          return 'enter_on_input';
        }
        return null;
      })()
    `).catch(() => null);
    await new Promise(r => setTimeout(r, 1200));
  } else {
    await new Promise(r => setTimeout(r, 1300));
  }

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  const studiesAfter = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  // Update 모드(hasExisting=true)에서는 study 개수 변화 없음이 정상
  // studiesAfter == studiesBefore → study_added=false 오판 방지 → null 반환
  const studyAdded = hasExisting
    ? null
    : (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null;

  const realErrors = (errors || []).filter(e => e.severity >= 8);
  return {
    success: true,
    button_clicked: buttonClicked,
    method: buttonMethod,
    has_errors: realErrors.length > 0,
    errors: realErrors,
    study_added: studyAdded,
  };
}

export async function newScript({ type }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const typeMap = { indicator: 'indicator', strategy: 'strategy', library: 'library' };
  const templates = {
    indicator: '//@version=6\nindicator("My script")\nplot(close)',
    strategy: '//@version=6\nstrategy("My strategy", overlay=true)\n',
    library: '//@version=6\n// @description TODO: add library description here\nlibrary("MyLibrary")\n',
  };

  const template = templates[type] || templates.indicator;

  // Simply set the source to a new template — this is the most reliable approach
  const escaped = JSON.stringify(template);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new Error('Monaco editor not found. Ensure Pine Editor is open.');

  return { success: true, type, action: 'new_script_created', template: typeMap[type] };
}

export async function openScript({ name }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const escapedName = JSON.stringify(name.toLowerCase());

  const result = await evaluateAsync(`
    (function() {
      var target = ${escapedName};
      return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(scripts) {
          if (!Array.isArray(scripts)) return {error: 'pine-facade returned unexpected data'};
          var match = null;
          for (var i = 0; i < scripts.length; i++) {
            var sn = (scripts[i].scriptName || '').toLowerCase();
            var st = (scripts[i].scriptTitle || '').toLowerCase();
            if (sn === target || st === target) { match = scripts[i]; break; }
          }
          if (!match) {
            for (var j = 0; j < scripts.length; j++) {
              var sn2 = (scripts[j].scriptName || '').toLowerCase();
              var st2 = (scripts[j].scriptTitle || '').toLowerCase();
              if (sn2.indexOf(target) !== -1 || st2.indexOf(target) !== -1) { match = scripts[j]; break; }
            }
          }
          if (!match) return {error: 'Script "' + target + '" not found. Use pine_list_scripts to see available scripts.'};

          var id = match.scriptIdPart;
          var ver = match.version || 1;
          return fetch('https://pine-facade.tradingview.com/pine-facade/get/' + id + '/' + ver, { credentials: 'include' })
            .then(function(r2) { return r2.json(); })
            .then(function(data) {
              var source = data.source || '';
              if (!source) return {error: 'Script source is empty', name: match.scriptName || match.scriptTitle};
              var m = ${FIND_MONACO};
              if (m) {
                m.editor.setValue(source);
                return {success: true, name: match.scriptName || match.scriptTitle, id: id, lines: source.split('\\n').length};
              }
              return {error: 'Monaco editor not found to inject source', name: match.scriptName || match.scriptTitle};
            });
        })
        .catch(function(e) { return {error: e.message}; });
    })()
  `);

  if (result?.error) {
    throw new Error(result.error);
  }

  return { success: true, name: result.name, script_id: result.id, lines: result.lines, source: 'internal_api', opened: true };
}

export async function listScripts() {
  const scripts = await evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return {scripts: [], error: 'Unexpected response from pine-facade'};
        return {
          scripts: data.map(function(s) {
            return {
              id: s.scriptIdPart || null,
              name: s.scriptName || s.scriptTitle || 'Untitled',
              title: s.scriptTitle || null,
              version: s.version || null,
              modified: s.modified || null,
            };
          })
        };
      })
      .catch(function(e) { return {scripts: [], error: e.message}; })
  `);

  return {
    success: true,
    scripts: scripts?.scripts || [],
    count: scripts?.scripts?.length || 0,
    source: 'internal_api',
    error: scripts?.error,
  };
}
