// TV MCP 좌표 자가학습 KB — tv11_interactive_clicker.py 포팅
// 학습된 UI 좌표를 저장/조회/신뢰도 관리
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const KB_PATH = join(__dir, 'coord-kb.json');

function now() {
  return new Date().toISOString();
}

function load() {
  try { return JSON.parse(readFileSync(KB_PATH, 'utf8')); }
  catch { return {}; }
}

function save(data) {
  writeFileSync(KB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function normalize(entry) {
  if (!entry || typeof entry.x !== 'number' || typeof entry.y !== 'number') return null;
  const attempts = (entry.attempts || 0);
  const successes = (entry.successes || 0);
  return {
    x: entry.x,
    y: entry.y,
    attempts,
    successes,
    failures: entry.failures || 0,
    reliability: attempts > 0 ? successes / attempts : 1.0,
    disabled: !!entry.disabled,
    source: entry.source || 'manual',
    viewport: entry.viewport || null,
    last_used_at: entry.last_used_at || null,
    last_success_at: entry.last_success_at || null,
    last_failure_at: entry.last_failure_at || null,
    last_updated_at: entry.last_updated_at || null,
  };
}

/**
 * 저장된 좌표 조회. 신뢰도 낮으면 null 반환 → 재학습 트리거.
 * @param {string} actionKey
 * @param {{ minReliability?: number, minAttempts?: number }} opts
 * @returns {{ x: number, y: number } | null}
 */
export function getPoint(actionKey, { minReliability = 0.15, minAttempts = 3 } = {}) {
  const data = load();
  const p = normalize(data[actionKey]);
  if (!p) return null;
  if (p.disabled) {
    process.stderr.write(`[CoordKB] '${actionKey}' disabled — re-learning\n`);
    return null;
  }
  if (p.attempts >= minAttempts && p.reliability < minReliability) {
    process.stderr.write(`[CoordKB] '${actionKey}' low reliability (${p.reliability.toFixed(2)}) — re-learning\n`);
    return null;
  }
  return { x: p.x, y: p.y };
}

/**
 * 좌표 저장 (신규 또는 덮어쓰기). 통계는 유지.
 */
export function savePoint(actionKey, x, y, { source = 'manual', viewport = null } = {}) {
  const data = load();
  const old = normalize(data[actionKey]);
  data[actionKey] = {
    x: parseFloat(x),
    y: parseFloat(y),
    attempts: old ? old.attempts : 0,
    successes: old ? old.successes : 0,
    failures: old ? old.failures : 0,
    reliability: old ? old.reliability : 1.0,
    disabled: false,
    source,
    viewport: viewport || (old ? old.viewport : null),
    last_used_at: old ? old.last_used_at : null,
    last_success_at: old ? old.last_success_at : null,
    last_failure_at: old ? old.last_failure_at : null,
    last_updated_at: now(),
  };
  save(data);
  process.stderr.write(`[CoordKB] Learned '${actionKey}' → (${x}, ${y}) [${source}]\n`);
}

/**
 * 사용 결과 기록 → 신뢰도 갱신. 성공+좌표 제공 시 EMA 보정.
 */
export function recordResult(actionKey, success, usedPoint = null) {
  const data = load();
  const entry = normalize(data[actionKey]);
  if (!entry) return;

  entry.attempts += 1;
  entry.last_used_at = now();
  if (success) {
    entry.successes += 1;
    entry.last_success_at = now();
    entry.disabled = false;
    // EMA 좌표 보정 (alpha=0.35)
    if (usedPoint) {
      const alpha = 0.35;
      entry.x = entry.x * (1 - alpha) + parseFloat(usedPoint.x) * alpha;
      entry.y = entry.y * (1 - alpha) + parseFloat(usedPoint.y) * alpha;
    }
  } else {
    entry.failures += 1;
    entry.last_failure_at = now();
    if (entry.attempts >= 5 && entry.failures >= 3 && entry.reliability < 0.35) {
      entry.disabled = true;
      process.stderr.write(`[CoordKB] '${actionKey}' auto-disabled (too many failures)\n`);
    }
  }
  entry.reliability = entry.successes / Math.max(1, entry.attempts);
  data[actionKey] = entry;
  save(data);
}

/**
 * 전체 좌표 KB 조회
 */
export function listPoints() {
  return load();
}
