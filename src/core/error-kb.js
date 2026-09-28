// TV MCP 에러 패턴 자가학습 KB — 알려진 실패 자동 복구 + 신규 패턴 동적 추가
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const KB_PATH = join(__dir, 'error-kb.json');

function load() {
  try { return JSON.parse(readFileSync(KB_PATH, 'utf8')); }
  catch { return []; }
}

function save(entries) {
  writeFileSync(KB_PATH, JSON.stringify(entries, null, 2), 'utf8');
}

export function match(errorMsg, toolName = '*') {
  const entries = load();
  const msg = String(errorMsg).toLowerCase();
  for (const e of entries) {
    const patternHit = msg.includes(e.pattern.toLowerCase());
    const toolHit = e.tool === '*' || e.tool === toolName;
    if (patternHit && toolHit) return e;
  }
  return null;
}

export function append({ id, pattern, tool = '*', fix, auto_steps = [], source = 'ai' }) {
  const entries = load();
  const slug = (id || pattern).replace(/\s+/g, '-').toLowerCase().slice(0, 50);
  const idx = entries.findIndex(e => e.id === slug || e.pattern.toLowerCase() === pattern.toLowerCase());
  const entry = {
    id: slug, pattern, tool, fix, auto_steps,
    added: new Date().toISOString().slice(0, 10), source,
  };
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  save(entries);
  return entry;
}

export function list() {
  return load();
}
