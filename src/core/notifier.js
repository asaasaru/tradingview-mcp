// TVauto와 동일한 자격증명 소스에서 Telegram 알림 전송
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

function loadSecretsEnv() {
  const paths = [
    join(homedir(), '.config', 'secrets.env'),
    join(homedir(), '.secrets.env'),
  ];
  for (const p of paths) {
    try {
      const lines = readFileSync(p, 'utf8').split('\n');
      const result = {};
      for (const line of lines) {
        const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.+)$/);
        if (m) result[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
      return result;
    } catch {}
  }
  return {};
}

function getCredentials() {
  // 1) 전용 환경변수
  let token = process.env.TV_TELEGRAM_BOT_TOKEN?.trim();
  let chatId = process.env.TV_TELEGRAM_CHAT_ID?.trim();
  if (token && chatId) return { token, chatId };

  // 2) TVauto VICBIT_BOT 환경변수
  token = token || process.env.TELEGRAM_BOT_TOKEN_VICBIT_BOT?.trim();
  chatId = chatId || process.env.TELEGRAM_ALLOWED_CHAT_IDS_VICBIT_BOT?.trim();
  if (token && chatId) return { token, chatId };

  // 3) secrets.env 파일
  const secrets = loadSecretsEnv();
  token = token || secrets.TV_TELEGRAM_BOT_TOKEN || secrets.TELEGRAM_BOT_TOKEN_VICBIT_BOT;
  chatId = chatId || secrets.TV_TELEGRAM_CHAT_ID || secrets.TELEGRAM_ALLOWED_CHAT_IDS_VICBIT_BOT;

  return token && chatId ? { token, chatId } : null;
}

export async function sendTelegram(text) {
  const creds = getCredentials();
  if (!creds) {
    process.stderr.write('[Notifier] Telegram 자격증명 없음 — 알림 건너뜀.\n');
    return false;
  }
  const { token, chatId } = creds;
  // chat_id가 콤마 구분 목록일 경우 첫 번째만 사용
  const targetChatId = chatId.split(',')[0].trim();
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: targetChatId, text, parse_mode: 'HTML' }),
    });
    const data = await resp.json();
    if (data.ok) {
      process.stderr.write('[Notifier] Telegram 알림 전송 완료.\n');
      return true;
    }
    process.stderr.write(`[Notifier] Telegram 오류: ${data.description}\n`);
    return false;
  } catch (err) {
    process.stderr.write(`[Notifier] Telegram 전송 실패: ${err.message}\n`);
    return false;
  }
}
