import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pine.js';
import { startWatchdog, cancelWatchdog } from '../core/watchdog.js';
import { sendTelegram } from '../core/notifier.js';

export function registerPineTools(server) {
  server.tool('pine_get_source', 'Get current Pine Script source code from the editor', {}, async () => {
    try { return jsonResult(await core.getSource()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_set_source', 'Set Pine Script source code in the editor', {
    source: z.string().describe('Pine Script source code to inject'),
  }, async ({ source }) => {
    try { return jsonResult(await core.setSource({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_compile', 'Compile / add the current Pine Script to the chart', {}, async () => {
    try {
      cancelWatchdog();
      return jsonResult(await core.compile());
    } catch (err) {
      if (err.name === 'CompileButtonNotFoundError') {
        startWatchdog();
        sendTelegram(
          '⚠️ <b>[TradingView MCP]</b> 컴파일 버튼 탐색 실패\n\n' +
          '3회 DOM 시도 + 키보드 단축키 모두 실패했습니다.\n\n' +
          '다음 중 하나를 해주세요:\n' +
          '  1. "Add to chart" 또는 "Update on chart" 버튼을 직접 클릭\n' +
          '  2. 버튼에 표시된 정확한 텍스트를 알려주세요\n\n' +
          '⏱ 5분 내 응답 없으면 TradingView 자동 종료됩니다.'
        ).catch(() => {});
        return jsonResult({ success: false, error: err.message, user_message: err.userMessage, action_required: true }, true);
      }
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('pine_get_errors', 'Get Pine Script compilation errors from Monaco markers', {}, async () => {
    try { return jsonResult(await core.getErrors()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_save', 'Save the current Pine Script (Ctrl+S)', {}, async () => {
    try { return jsonResult(await core.save()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_console', 'Read Pine Script console/log output (compile messages, log.info(), errors)', {}, async () => {
    try { return jsonResult(await core.getConsole()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_smart_compile', 'Intelligent compile: detects button, compiles, checks errors, reports study changes', {}, async () => {
    try {
      cancelWatchdog();
      return jsonResult(await core.smartCompile());
    } catch (err) {
      if (err.name === 'CompileButtonNotFoundError') {
        startWatchdog();
        sendTelegram(
          '⚠️ <b>[TradingView MCP]</b> 컴파일 버튼 탐색 실패\n\n' +
          '3회 DOM 시도 + 키보드 단축키 모두 실패했습니다.\n\n' +
          '다음 중 하나를 해주세요:\n' +
          '  1. "Add to chart" 또는 "Update on chart" 버튼을 직접 클릭\n' +
          '  2. 버튼에 표시된 정확한 텍스트를 알려주세요\n\n' +
          '⏱ 5분 내 응답 없으면 TradingView 자동 종료됩니다.'
        ).catch(() => {});
        return jsonResult({ success: false, error: err.message, user_message: err.userMessage, action_required: true }, true);
      }
      return jsonResult({ success: false, error: err.message }, true);
    }
  });

  server.tool('pine_new', 'Create a new blank Pine Script', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Type of script to create'),
  }, async ({ type }) => {
    try { return jsonResult(await core.newScript({ type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_open', 'Open a saved Pine Script by name', {
    name: z.string().describe('Name of the saved script to open (case-insensitive match)'),
  }, async ({ name }) => {
    try { return jsonResult(await core.openScript({ name })); }
    catch (err) { return jsonResult({ success: false, source: 'internal_api', error: err.message }, true); }
  });

  server.tool('pine_list_scripts', 'List saved Pine Scripts', {}, async () => {
    try { return jsonResult(await core.listScripts()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_analyze', 'Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit bool casts. Works offline, no TradingView connection needed.', {
    source: z.string().describe('Pine Script source code to analyze'),
  }, async ({ source }) => {
    try { return jsonResult(core.analyze({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_check', 'Compile Pine Script via TradingView\'s server API without needing the chart open. Returns compilation errors/warnings. Useful for validating code before injecting into the chart.', {
    source: z.string().describe('Pine Script source code to compile/validate'),
  }, async ({ source }) => {
    try { return jsonResult(await core.check({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
