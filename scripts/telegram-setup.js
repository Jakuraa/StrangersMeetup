// scripts/telegram-setup.js - One-time bot configuration (owner runs after setting env vars).
// Usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... PUBLIC_SITE_URL=https://... node scripts/telegram-setup.js
// Prints no secrets. Safe to re-run.
import { tg } from '../lib/telegram/api.js';
import { env, siteUrl } from '../lib/config.js';
import { COMMANDS } from '../lib/telegram/bot.js';

const url = `${siteUrl()}/api/telegram/webhook`;
if (!/^https:\/\//.test(url)) {
  console.error('PUBLIC_SITE_URL must be an https URL');
  process.exit(1);
}
const secret = env('TELEGRAM_WEBHOOK_SECRET');
if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
  console.error('TELEGRAM_WEBHOOK_SECRET must be 16-256 chars of A-Z a-z 0-9 _ -');
  process.exit(1);
}

const me = await tg('getMe');
console.log(`bot: @${me.username}`);
await tg('setWebhook', {
  url,
  secret_token: secret,
  allowed_updates: ['message', 'callback_query', 'pre_checkout_query', 'chat_member', 'my_chat_member'],
  drop_pending_updates: false,
  max_connections: 20
});
console.log(`webhook: ${url}`);
await tg('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
console.log('commands: set');
await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Open', web_app: { url: siteUrl() } } });
console.log('menu button: Mini App');
const info = await tg('getWebhookInfo');
console.log(`pending updates: ${info.pending_update_count}; last error: ${info.last_error_message || 'none'}`);
