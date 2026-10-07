# Gift Sniper 🎯 — снипер дешёвых NFT-подарков Telegram

Бот **@Global_mrkt_bot** переделан из Globe Market в снипер лотов: следит за 109 коллекциями
NFT-подарков Telegram через TonAPI, ловит новые лоты дешевле флора рынка и мгновенно
уведомляет подписчиков. Мини-апп — живая лента снайпов + таблица флоров.

**100% на GitHub, ноль серверов и платежей:**
- движок на GitHub Actions (эстафета 24/7, свипы ~60с, бюджет прогона 30 мин)
- сайт/Mini App на GitHub Pages (из этого же репо)
- состояние в `data/state.json`, подписчики в `data/subscribers.enc` (AES)
- флор = медиана 10% самых дешёвых чистых лотов (фильтр скам-листингов <40% медианы)

## Структура
- `engine/sniper-job.js` — движок: TonAPI-скан → детект сделок (≤85% флора) → алерты 1:1 (AIMD) → бот-поллинг → коммит данных
- `engine/collections.js` — 109 коллекций с TON-адресами
- `index.html` — тонкий bootstrap (версия через version.json, обходит кэш Telegram WebView)
- `app.html` — мини-апп: лента снайпов, флоры, инструкция
- `.github/workflows/sniper-relay.yml` — эстафета: cron каждые 10 мин = страховка, chain-dispatch = основной цикл
- `data/public.json` — публичные данные сайта (генерируется движком)

## Бот
- `/start` — включить алерты · `/stop` — выключить
- `/threshold 20` — порог скидки (5–60%)
- `/watch PlushPepe, PoolFloat` — следить только за выбранными (до 20), `/watch off` — за всеми
- `/status` — настройки

## Секреты (Actions Secrets)
- `TELEGRAM_BOT_TOKEN` — токен бота
- `CRYPT_KEY` — ключ AES для шифрования подписчиков

Старый Globe Market полностью сохранён в ветке `globe-market-backup`.

Восстановление: `git checkout globe-market-backup -- .`
