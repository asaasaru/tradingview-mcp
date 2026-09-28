// Pine 전략 end-to-end 자동 실행 — 에디터 열기 → 소스 주입 → Add to chart → 결과
import { evaluate, getClient } from '../connection.js';
import { setSource, smartCompile } from './pine.js';
import { getStrategyResults } from './data.js';
import { openPanel } from './ui.js';
import { cancelWatchdog, startWatchdog } from './watchdog.js';

export async function runStrategy({ source }) {
  cancelWatchdog();

  // Step 1: CDP 연결 확인
  await getClient();

  // Step 2: Pine Editor 열기 (1회) — setSource/smartCompile 내부 ensurePineEditorOpen은 no-op
  try { await openPanel({ panel: 'pine-editor', action: 'open' }); } catch {}

  // Step 3: 소스 주입 (monaco.setValue = 기존 코드 전체 교체)
  await setSource({ source });

  // Step 4: Add to chart DOM 버튼 클릭 + unsaved 다이얼로그 처리 + 에러 확인
  let compileResult;
  try {
    compileResult = await smartCompile();
  } catch (uiErr) {
    startWatchdog();
    return { success: false, error: uiErr.message, action_required: true, user_message: uiErr.userMessage };
  }

  if (compileResult?.has_errors) {
    return {
      success: false,
      error: 'Compilation failed',
      errors: compileResult.errors,
      has_errors: true,
      action_required: false,
    };
  }

  // Step 5: Strategy Tester — DOM 렌더링 polling 후 결과 읽기
  try { await openPanel({ panel: 'strategy-tester', action: 'open' }); } catch {}

  for (let i = 0; i < 20; i++) {
    const ready = await evaluate(`
      (function() {
        var area = document.querySelector('[class*="reportContainer"],[data-name="strategy-tester"],[class*="StrategyTester"]');
        if (!area) return false;
        return area.querySelectorAll('[class*="value"],[class*="Cell"]').length > 0;
      })()
    `).catch(() => false);
    if (ready) break;
    await new Promise(r => setTimeout(r, 500));
  }

  let resultsResult;
  for (let retry = 0; retry < 3; retry++) {
    resultsResult = await getStrategyResults();
    if ((resultsResult?.metric_count || 0) > 0) break;
    if (retry < 2) await new Promise(r => setTimeout(r, 1000));
  }
  if ((resultsResult?.metric_count || 0) === 0) {
    try { await openPanel({ panel: 'strategy-tester', action: 'open' }); } catch {}
    await new Promise(r => setTimeout(r, 2000));
    const fallback = await getStrategyResults();
    if (fallback && !fallback.action_required) resultsResult = fallback;
  }

  // 결과가 계속 0이면 "0 trades 전략"인지 "add-to-chart가 실제로 안 먹힌 UI 문제"인지
  // 구분되지 않은 채 Python 쪽이 곧장 Hermes에 "코드를 고쳐라"라고 보내던 문제가 있었음
  // (코드는 멀쩡한데 매번 새로 고쳐 쓰게 시킴). 여기서 알려진 차단 상태(예: historical
  // version 배너)를 먼저 진단해서 반환값에 실어 보낸다 — Python이 그걸 보고 코드를
  // 고칠지, 에디터만 다시 리셋할지 구분할 수 있게.
  let blockingState = null;
  if ((resultsResult?.metric_count || 0) === 0) {
    blockingState = await evaluate(`
      (function() {
        var restoreText = null;
        var els = document.querySelectorAll('a, button, span, div');
        for (var i = 0; i < els.length; i++) {
          var t = (els[i].textContent || '').trim();
          if (t && /restore this version/i.test(t) && t.length < 80) { restoreText = t; break; }
        }
        var bodyText = document.body.innerText || '';
        return {
          historical_version_banner: !!restoreText || /historical version of the script/i.test(bodyText),
          restore_link_text: restoreText,
        };
      })()
    `).catch(() => null);

    if (blockingState?.historical_version_banner) {
      try {
        const { captureScreenshot } = await import('./capture.js');
        const shot = await captureScreenshot({ region: 'chart', filename: 'no_metrics_blocking' });
        blockingState.screenshot_path = shot?.file_path || null;
      } catch (e) {
        blockingState.screenshot_error = e.message;
      }
    }
  }

  // Step 6: Pine Editor 복귀
  try { await openPanel({ panel: 'pine-editor', action: 'open' }); } catch {}

  cancelWatchdog();
  return {
    success: true,
    compile: {
      button_clicked: compileResult.button_clicked,
      method: compileResult.method,
      has_errors: false,
    },
    metric_count: resultsResult?.metric_count || 0,
    source: resultsResult?.source,
    metrics: resultsResult?.metrics,
    blocking_state: blockingState,
  };
}
