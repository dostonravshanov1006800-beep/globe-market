# telegram-webhook (Supabase Edge Function)

Единственный живой "сервер" проекта — не Base44, не GitHub Pages.
Нужен только потому, что Telegram требует работающий webhook, чтобы отвечать
на /start и любые сообщения боту (статический сайт не может принимать вебхуки).

Деплой: Supabase Management API, slug `telegram-webhook`, verify_jwt=false.
Токен бота хранится прямо в коде (осознанное решение владельца).
Секрет вебхука (`gm_wh_7f3k9x_2026_secret`) задан через Telegram setWebhook
secret_token и проверяется в заголовке x-telegram-bot-api-secret-token.

Делает одно: шлёт приветственное фото-баннер с кнопкой
"🛍 Открыть Globe Market" (web_app) на любое сообщение/команду /start.
