// TV MCP 좌표 자가학습 클릭 — tv11_interactive_clicker.py 포팅
// DOM 실패 시: 오버레이 주입 → 사용자 클릭 캡처 OR Telegram 좌표 응답
import { evaluate, getClient } from '../connection.js';
import { getPoint, savePoint, recordResult } from './coord-kb.js';
import { sendTelegram } from './notifier.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// tv_watchdog 호환 파일 기반 응답 채널
const TVAUTO_ROOT = process.env.TVAUTO_PROJECT_ROOT || process.cwd();
const REQUEST_FILE = join(TVAUTO_ROOT, 'output', 'user_action_request.json');

function writeRequest(module, actionName, message) {
  try {
    mkdirSync(join(TVAUTO_ROOT, 'output'), { recursive: true });
    writeFileSync(REQUEST_FILE, JSON.stringify({
      status: 'waiting',
      requested_at: new Date().toISOString(),
      module,
      action_name: actionName,
      message,
      response: null,
    }, null, 2), 'utf8');
  } catch {}
}

function clearRequest() {
  try { if (existsSync(REQUEST_FILE)) writeFileSync(REQUEST_FILE, JSON.stringify({ status: 'cleared' })); } catch {}
}

async function pollFileResponse(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const data = JSON.parse(readFileSync(REQUEST_FILE, 'utf8'));
      if (data.status === 'responded' && data.response) {
        clearRequest();
        return data.response;
      }
    } catch {}
  }
  clearRequest();
  return null;
}

// 빨간 오버레이 주입 — tv11 동일 JS
async function injectOverlay(msg) {
  const safeMsg = (msg || '버튼을 직접 클릭해주세요').replace(/`/g, "'");
  await evaluate(`
    (function() {
      if (window.__interactiveCaptureInstalled) return;
      window.__interactiveCaptureInstalled = true;
      window.__interactiveCaptureResult = null;

      var box = document.createElement('div');
      box.id = '__interactive_capture_overlay';
      box.style.cssText = 'position:fixed;left:50%;top:10%;transform:translate(-50%,-50%);z-index:2147483647;padding:15px 25px;background:rgba(255,0,0,0.85);color:#fff;font:bold 18px sans-serif;border:2px solid white;border-radius:8px;pointer-events:none;box-shadow:0 4px 6px rgba(0,0,0,0.3);text-align:center;';
      box.innerHTML = \`STOPPED — <b>클릭 필요</b><br>${safeMsg}\`;
      document.body.appendChild(box);

      window.__interactiveSetMsg = function(m) { box.innerHTML = m; };

      var handler = function(e) {
        window.__interactiveCaptureResult = { x: e.clientX, y: e.clientY };
        box.style.background = 'rgba(0,200,0,0.95)';
        box.style.border = '3px solid #00FF00';
        box.innerHTML = 'OK — 좌표 학습 완료! (' + e.clientX + ', ' + e.clientY + ')';
        setTimeout(function() {
          if (box.parentNode) box.parentNode.removeChild(box);
          window.__interactiveCaptureInstalled = false;
        }, 3000);
        window.removeEventListener('click', handler, true);
      };
      window.__interactiveClickHandler = handler;
      window.addEventListener('click', handler, true);
    })()
  `);
}

async function clearOverlay() {
  await evaluate(`
    (function() {
      var b = document.getElementById('__interactive_capture_overlay');
      if (b) b.remove();
      if (window.__interactiveClickHandler) {
        window.removeEventListener('click', window.__interactiveClickHandler, true);
        window.__interactiveClickHandler = null;
      }
      window.__interactiveCaptureInstalled = false;
      window.__interactiveCaptureResult = null;
    })()
  `).catch(() => {});
}

// CDP 좌표 클릭
async function cdpClick(x, y) {
  const c = await getClient();
  await c.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left' });
}

// 오버레이 클릭 결과 폴링 (페이지 내 클릭)
async function pollOverlayClick(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 800));
    const result = await evaluate(`window.__interactiveCaptureResult`).catch(() => null);
    if (result && typeof result.x === 'number') return result;
  }
  return null;
}

// Telegram 응답에서 좌표 파싱: "x=1450 y=750"
function parseCoordFromText(text) {
  const m = String(text || '').match(/x\s*=\s*(\d+(?:\.\d+)?)\s+y\s*=\s*(\d+(?:\.\d+)?)/i);
  if (m) return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  return null;
}

/**
 * MCP 좌표 자가학습 클릭
 *
 * 1. coord-kb에 저장 좌표 있으면 CDP 클릭 → 성공/실패 기록
 * 2. 없거나 실패: TV 페이지에 오버레이 주입 + Telegram 알림
 * 3. 오버레이 클릭(120s) 또는 Telegram 좌표 응답(180s) 중 먼저 오는 것 사용
 * 4. 좌표 학습 저장 → 다음 실행 자동 사용
 *
 * @param {string} actionKey  학습 키 (예: 'add_to_chart_button')
 * @param {string} promptMsg  사용자에게 보여줄 메시지
 * @returns {Promise<{x:number,y:number}|null>}
 */
export async function interactiveClick(actionKey, promptMsg) {
  const msg = promptMsg || `'${actionKey}' 버튼을 클릭해주세요`;

  // 1. 저장 좌표 시도
  const saved = getPoint(actionKey);
  if (saved) {
    process.stderr.write(`[InteractiveClick] '${actionKey}' 저장 좌표 시도: (${saved.x}, ${saved.y})\n`);
    try {
      await cdpClick(saved.x, saved.y);
      await new Promise(r => setTimeout(r, 800));
      recordResult(actionKey, true, saved);
      return saved;
    } catch (e) {
      process.stderr.write(`[InteractiveClick] 저장 좌표 클릭 실패: ${e.message}\n`);
      recordResult(actionKey, false);
    }
  }

  // 2. 오버레이 + Telegram 병행 대기
  process.stderr.write(`[InteractiveClick] '${actionKey}' 좌표 미학습 — 오버레이 + Telegram 요청\n`);
  await clearOverlay();
  await injectOverlay(msg);

  writeRequest('tv_mcp_interactive_click', actionKey, msg);
  await sendTelegram(
    `⚠️ <b>[TradingView MCP] 수동 클릭 필요</b>\n\n` +
    `<b>작업:</b> ${actionKey}\n` +
    `<b>내용:</b> ${msg}\n\n` +
    `<b>방법 1:</b> TradingView 화면에서 해당 버튼을 직접 클릭\n` +
    `<b>방법 2:</b> 좌표를 이 채팅에 입력: <code>x=1450 y=750</code>\n\n` +
    `⏱ 5분 내 미응답 시 자동 종료됩니다.`
  ).catch(() => {});

  // 3. 오버레이 클릭(120s) vs Telegram 응답(300s) 경쟁
  let coord = null;

  const overlayRace = pollOverlayClick(120_000).then(r => r ? { src: 'overlay', coord: r } : null);
  const telegramRace = pollFileResponse(300_000).then(r => {
    if (!r) return null;
    const parsed = parseCoordFromText(r.text || '');
    return parsed ? { src: 'telegram', coord: parsed } : { src: 'telegram_ack', coord: null };
  });

  const winner = await Promise.race([overlayRace, telegramRace]);

  await clearOverlay();
  clearRequest();

  if (winner?.coord) {
    coord = winner.coord;
    savePoint(actionKey, coord.x, coord.y, { source: winner.src });
    process.stderr.write(`[InteractiveClick] '${actionKey}' 학습 완료 (${winner.src}): (${coord.x}, ${coord.y})\n`);

    if (winner.src === 'telegram') {
      await cdpClick(coord.x, coord.y);
      await new Promise(r => setTimeout(r, 800));
    }
    return coord;
  }

  process.stderr.write(`[InteractiveClick] '${actionKey}' 타임아웃 — 좌표 학습 실패\n`);
  return null;
}

/**
 * 저장된 좌표만으로 클릭 (오버레이 없음). 학습 데이터 없으면 false.
 */
export async function clickIfKnown(actionKey) {
  const saved = getPoint(actionKey);
  if (!saved) return false;
  try {
    await cdpClick(saved.x, saved.y);
    await new Promise(r => setTimeout(r, 500));
    recordResult(actionKey, true, saved);
    return true;
  } catch {
    recordResult(actionKey, false);
    return false;
  }
}
