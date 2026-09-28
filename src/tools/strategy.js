// 전략 자동 실행 + 에러 KB + 좌표 KB 관리 도구
import { z } from 'zod';
import { jsonResult } from './_format.js';
import { runStrategy } from '../core/strategy-runner.js';
import { append as kbAppend, list as kbList } from '../core/error-kb.js';
import { listPoints, savePoint, recordResult } from '../core/coord-kb.js';

export function registerStrategyTools(server) {
  // pine_strategy_run: 소스 → 컴파일 → 결과 한 번에
  server.tool(
    'pine_strategy_run',
    'Run a Pine strategy end-to-end: ensure TV is connected, inject source, compile, open Strategy Tester, and return metrics. Auto-recovers from known failures (CDP drop, pine_new unreliable, strategy results DOM fallback).',
    {
      source: z.string().describe('Full Pine Script strategy source code to inject and run'),
    },
    async ({ source }) => {
      try { return jsonResult(await runStrategy({ source })); }
      catch (err) {
        const isButtonErr = err.name === 'CompileButtonNotFoundError';
        return jsonResult({
          success: false,
          error: err.message,
          action_required: isButtonErr,
          user_message: isButtonErr ? (err.userMessage || err.message) : undefined,
        }, true);
      }
    }
  );

  // error_kb_append: AI가 새 에러 패턴 + 해결책 학습
  server.tool(
    'error_kb_append',
    'Append a new error pattern and its fix to the self-learning KB. Call this when you resolve a novel error so future runs auto-recover without AI intervention.',
    {
      id: z.string().optional().describe('Short kebab-case slug (auto-generated from pattern if omitted)'),
      pattern: z.string().describe('Error message substring to match (case-insensitive)'),
      tool: z.string().optional().describe('Tool name this pattern applies to, or "*" for any tool'),
      fix: z.string().describe('Human-readable description of the fix'),
      auto_steps: z.array(z.string()).optional().describe(
        'Ordered auto-recovery steps: "tv_launch", "ui_open_panel", "pine_set_source", "dom_fallback", "skip_pine_new"'
      ),
    },
    async ({ id, pattern, tool, fix, auto_steps }) => {
      try {
        const entry = kbAppend({ id, pattern, tool: tool || '*', fix, auto_steps: auto_steps || [] });
        return jsonResult({ success: true, saved: entry });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // error_kb_list: 현재 KB 전체 목록
  server.tool(
    'error_kb_list',
    'List all entries in the self-learning error KB — shows known patterns, fixes, and auto-recovery steps.',
    {},
    async () => {
      try {
        const entries = kbList();
        return jsonResult({ success: true, count: entries.length, entries });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // coord_kb_list: 학습된 UI 좌표 전체 조회
  server.tool(
    'coord_kb_list',
    'List all learned UI coordinates from the self-learning coordinate KB. Shows action keys, x/y positions, reliability scores, and usage stats.',
    {},
    async () => {
      try {
        const points = listPoints();
        return jsonResult({ success: true, count: Object.keys(points).length, points });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  // coord_kb_save: 좌표 수동 저장 (사용자가 알려주는 경우)
  server.tool(
    'coord_kb_save',
    'Manually save a UI coordinate to the self-learning KB. Use when you know the exact screen position of a button or UI element.',
    {
      action_key: z.string().describe('Unique key for this UI element (e.g. "add_to_chart_button")'),
      x: z.number().describe('X screen coordinate in pixels'),
      y: z.number().describe('Y screen coordinate in pixels'),
      source: z.string().optional().describe('How this coord was learned (default: "manual")'),
    },
    async ({ action_key, x, y, source }) => {
      try {
        savePoint(action_key, x, y, { source: source || 'manual' });
        return jsonResult({ success: true, action_key, x, y });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

}
