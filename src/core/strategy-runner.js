// Pine 전략 end-to-end 자동 실행 — TV 상태 확인 → 에디터 → 컴파일 → 결과
import { evaluate, getClient } from '../connection.js';
import { launch } from './health.js';
import { ensurePineEditorOpen, setSource, smartCompile } from './pine.js';
import { getStrategyResults } from './data.js';
import { openPanel } from './ui.js';
import { match as kbMatch, append as kbAppend } from './error-kb.js';
import { startWatchdog, cancelWatchdog } from './watchdog.js';
import { sendTelegram } from './notifier.js';
import { socokBotRecover } from './socokbot-recovery.js';

async function withAutoRecovery(fn, toolName, context = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const known = kbMatch(err.message, toolName);
      if (known && attempt === 1) {
        process.stderr.write(`[KB:auto] ${toolName}: "${known.pattern}" → ${known.fix}\n`);
        if (known.auto_steps.includes('tv_launch')) {
          await launch({ kill_existing: true });
          // TV 재시작 후 차트 UI 완전 로드 대기 (CDP 준비 ≠ 차트 로드)
          process.stderr.write('[Strategy] TV 재시작 — 차트 UI 로드 대기 (12초)...\n');
          await new Promise(r => setTimeout(r, 12000));
        }
        if (known.auto_steps.includes('ui_open_panel')) {
          try { await openPanel({ panel: 'pine-editor', action: 'open' }); } catch {}
          await new Promise(r => setTimeout(r, 800));
        }
        if (known.auto_steps.includes('dismiss_dialog_retry_compile')) {
          await _dismissDialogAndRetryCompile();
          await new Promise(r => setTimeout(r, 800));
        }
        continue;
      }
      // attempt 2 실패 후 — SocokBot 자동 개입 (attempt 3으로 넘어가기 전)
      if (attempt === 2) {
        process.stderr.write('[Strategy] SocokBot 자동 개입 시작...\n');
        try {
          const recovery = await socokBotRecover({
            toolName,
            error: err.message,
            source: context.source || '',
          });
          if (recovery.success) {
            process.stderr.write(`[Strategy] SocokBot 액션: ${recovery.action}\n`);
            if (recovery.action === 'code_fixed') {
              // 코드가 이미 주입+컴파일됨 — attempt 3에서 fn()을 재실행하면 결과만 읽음
              process.stderr.write('[Strategy] SocokBot 코드 수정 완료 — 다음 attempt 진행\n');
            } else if (recovery.action === 'reload_tv' || recovery.action === 'navigate_chart') {
              await launch({ kill_existing: true });
              await new Promise(r => setTimeout(r, 15000));
            } else if (recovery.action === 'open_pine_editor') {
              try { await openPanel({ panel: 'pine-editor', action: 'open' }); } catch {}
              await new Promise(r => setTimeout(r, 1000));
            } else if (recovery.action === 'dismiss_dialog') {
              await evaluate(`
                (function() {
                  var btn = document.querySelector('[data-name="dialog-close"], .dialog-close-button, button[aria-label="Close"], button[aria-label="닫기"]');
                  if (btn) btn.click();
                })()
              `).catch(() => {});
              await new Promise(r => setTimeout(r, 500));
            }
            // 'retry', 'skip' → 그냥 다음 attempt로
          }
        } catch (socokErr) {
          process.stderr.write(`[Strategy] SocokBot 개입 실패: ${socokErr.message}\n`);
        }
        continue; // attempt 3으로
      }
      // Auto-recovery 실패 → 5분 watchdog 시작 + Telegram 알림
      startWatchdog();
      const isPineEditorErr = err.message.includes('Pine Editor');
      const actionGuide = isPineEditorErr
        ? '1. TradingView에서 하단 Pine Script 에디터 아이콘(</>) 을 직접 클릭해 에디터를 여세요.\n2. 에디터가 열리면 이 채팅에 <b>ok</b> 또는 <b>retry</b> 를 입력하세요.'
        : '조치 후 이 채팅에 <b>retry</b> 를 입력하면 자동 재시도합니다.';
      sendTelegram(
        `⚠️ <b>[TradingView MCP]</b> 자동 복구 실패\n\n` +
        `<b>도구:</b> ${toolName}\n` +
        `<b>오류:</b> ${err.message.substring(0, 200)}\n\n` +
        `<b>조치 방법:</b>\n${actionGuide}\n\n` +
        `⏱ 5분 내 미응답 시 TradingView 자동 종료됩니다.`
      ).catch(() => {});
      return {
        success: false,
        error: err.message,
        action_required: true,
        tool: toolName,
        kb_match: known || null,
        hint: known
          ? `Known pattern — auto-recovery failed. Check: ${known.fix}`
          : 'Unknown error. Diagnose and call error_kb_append with fix.',
        ...context,
      };
    }
  }
}

// 다이얼로그 닫기 + "Add to chart" DOM 직접 클릭 시도
async function _dismissDialogAndRetryCompile() {
  // 다이얼로그 닫기 (Don't save 포함)
  await evaluate(`
    (function() {
      var closeTexts = ["Don't save","저장 안 함","Discard"];
      var closeSelectors = [
        '[data-name="dialog-close"]',
        '.dialog-close-button',
        'button[aria-label="Close"]',
        'button[aria-label="닫기"]',
        '.close-button',
      ];
      var btns = Array.from(document.querySelectorAll('button'));
      for (var c of closeTexts) {
        var btn = btns.find(function(b) { return b.textContent.trim() === c && b.offsetParent; });
        if (btn) { btn.click(); return; }
      }
      for (var s of closeSelectors) {
        var el = document.querySelector(s);
        if (el && el.offsetParent !== null) { el.click(); return; }
      }
    })()
  `);
  await new Promise(r => setTimeout(r, 500));

  // "Add to chart" / "Update on chart" 클릭 — data-qa-id, 영문, 한글 모두 시도
  return await evaluate(`
    (function() {
      var qaBtn = document.querySelector('[data-qa-id="add-script-to-chart"]');
      if (qaBtn && qaBtn.offsetParent !== null) { qaBtn.click(); return 'add-to-chart-qa'; }
      var addTexts = ["Add to chart","차트에 추가","Update on chart","차트 업데이트","Add","추가"];
      var btns = Array.from(document.querySelectorAll('button')).filter(function(b) { return b.offsetParent; });
      for (var c of addTexts) {
        var btn = btns.find(function(b) { return b.textContent.trim().includes(c) && !/save|저장/i.test(b.textContent); });
        if (btn) { btn.click(); return 'clicked: ' + btn.textContent.trim(); }
      }
      return null;
    })()
  `);
}

export async function runStrategy({ source }) {
  cancelWatchdog();
  // Step 1: ensure CDP connected
  const conn = await withAutoRecovery(() => getClient(), '*');
  if (conn?.action_required) return conn;

  // Step 2: open Pine editor (skip pine_new — KB: unreliable)
  try { await openPanel({ panel: 'pine-editor', action: 'open' }); } catch {}

  // Step 3: inject source
  const setResult = await withAutoRecovery(() => setSource({ source }), 'pine_set_source');
  if (setResult?.action_required) return setResult;

  // Step 4: compile
  const compileResult = await withAutoRecovery(() => smartCompile(), 'pine_smart_compile');
  if (compileResult?.action_required) return compileResult;
  if (compileResult?.has_errors) {
    return {
      success: false,
      error: 'Compilation failed',
      errors: compileResult.errors,
      action_required: false,
    };
  }

  // study_added === false: Cmd+Enter 전송됐으나 차트에 추가 안 됨
  // "Save" 다이얼로그 차단 또는 버튼 상태 오류 → 자동 복구 시도
  if (compileResult?.study_added === false) {
    process.stderr.write('[Strategy] study_added=false — 다이얼로그 닫기 + Add to chart 재시도...\n');
    const recovered = await _dismissDialogAndRetryCompile();
    if (recovered) {
      process.stderr.write(`[Strategy] 자동 복구 성공: ${recovered}\n`);
      // KB에 자가학습 등록 (이미 있으면 덮어쓰기)
      kbAppend({
        id: 'study-not-added-save-dialog',
        pattern: 'study not added to chart',
        tool: 'pine_smart_compile',
        fix: 'Save 다이얼로그 닫기 후 Add to chart DOM 버튼 직접 클릭',
        auto_steps: ['dismiss_dialog_retry_compile'],
        source: 'auto',
      });
      await new Promise(r => setTimeout(r, 1500));
      // 복구 후 바로 Step 5로 진행
    } else {
      // 복구 실패 → KB 등록 + Telegram 알림 + action_required
      kbAppend({
        id: 'study-not-added-save-dialog',
        pattern: 'study not added to chart',
        tool: 'pine_smart_compile',
        fix: 'Save 다이얼로그 닫기 후 Add to chart DOM 버튼 직접 클릭. 자동 복구 실패 시 사용자 수동 클릭 필요.',
        auto_steps: ['dismiss_dialog_retry_compile'],
        source: 'auto',
      });
      startWatchdog();
      sendTelegram(
        `⚠️ <b>[TradingView MCP]</b> 차트 추가 실패\n\n` +
        `<b>원인:</b> Compile 후 전략이 차트에 추가되지 않음 (자동 복구도 실패)\n` +
        `<b>조치:</b> "Save" 다이얼로그가 있으면 닫고 "Add to chart" 버튼을 직접 클릭해주세요.\n\n` +
        `⏱ 5분 내 미응답 시 TradingView 자동 종료됩니다.`
      ).catch(() => {});
      return {
        success: false,
        error: 'Strategy not added to chart — Save dialog may be blocking or button state is incorrect.',
        action_required: true,
        user_message: '"Add to chart" 버튼이 보이면 직접 클릭해주세요. "Save" 다이얼로그가 있으면 먼저 닫아주세요.',
      };
    }
  }

  // Step 5: strategy-tester 탭 전환 → 결과 읽기 → pine-editor 복귀
  // strategy-tester 탭 열어야 DOM에 메트릭 렌더링됨 (reportData() 폴백도 안정화)
  // 읽기 후 pine-editor 복귀 → 다음 반복에서 에디터 재오픈 불필요
  try { await openPanel({ panel: 'strategy-tester', action: 'open' }); } catch {}
  await new Promise(r => setTimeout(r, 2000));

  const resultsResult = await withAutoRecovery(() => getStrategyResults(), 'data_get_strategy_results');
  if (resultsResult?.action_required) return resultsResult;

  // pine-editor 탭 복귀 — 다음 runStrategy 호출 시 Step 2 openPanel 중복 방지
  try { await openPanel({ panel: 'pine-editor', action: 'open' }); } catch {}

  cancelWatchdog();
  return {
    success: true,
    compile: {
      button_clicked: compileResult.button_clicked,
      method: compileResult.method,
      has_errors: compileResult.has_errors,
    },
    metric_count: resultsResult.metric_count,
    source: resultsResult.source,
    metrics: resultsResult.metrics,
  };
}
