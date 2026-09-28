// TradingView 자동 종료 감시자 — 사용자 무응답 5분 후 TV 닫고 리소스 반환
import { disconnect } from '../connection.js';
import { execSync } from 'child_process';
import { sendTelegram } from './notifier.js';

const TIMEOUT_MS = 5 * 60 * 1000;

let timer = null;
let active = false;

export function startWatchdog() {
  cancelWatchdog();
  active = true;
  process.stderr.write('[Watchdog] 5분 타이머 시작 — 사용자 응답 대기 중.\n');
  timer = setTimeout(async () => {
    active = false;
    timer = null;
    process.stderr.write('[Watchdog] 5분 경과: 사용자 응답 없음. TradingView 종료 중...\n');
    await sendTelegram(
      '⚠️ <b>[TradingView MCP]</b>\n\n' +
      '5분간 응답 없음. Pine Editor 컴파일 버튼을 찾지 못한 상태에서\n' +
      '사용자 응답이 없어 TradingView를 자동 종료합니다.\n\n' +
      '재시작하려면 <code>tv_launch</code> 도구를 호출하세요.'
    );
    await shutdownTv();
    process.stderr.write('[Watchdog] 종료 완료. MCP 서버 대기 상태.\n');
  }, TIMEOUT_MS);
  if (timer.unref) timer.unref();
}

export function cancelWatchdog() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
    if (active) process.stderr.write('[Watchdog] 취소됨 — 사용자 응답 확인.\n');
    active = false;
  }
}

export function isWatchdogActive() { return active; }

async function shutdownTv() {
  try { await disconnect(); } catch {}
  try {
    const p = process.platform;
    if (p === 'darwin') {
      // pkill -x 는 메인 프로세스만 죽임 → Electron 자식(GPU/Network Helper) 좀비 창 남음
      // pkill -9 -f TradingView.app 으로 경로 기반 전체 종료
      execSync('pkill -9 -f "TradingView.app"', { timeout: 5000, stdio: 'ignore' });
    } else if (p === 'win32') {
      execSync('taskkill /IM TradingView.exe /F /T', { timeout: 5000, stdio: 'ignore' });
    } else {
      execSync('pkill -9 -f tradingview', { timeout: 5000, stdio: 'ignore' });
    }
  } catch {}
}
