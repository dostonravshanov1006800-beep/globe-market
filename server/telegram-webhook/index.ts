// Globe Market — минимальный Telegram-webhook (Supabase Edge Function, бесплатно).
// Единственная задача: отвечать на /start и любые сообщения приветствием
// с кнопкой "Открыть Globe Market" (web_app). НЕ Base44, НЕ GitHub Pages —
// отдельный бесплатный серверлес-слой Supabase, нужен только для входящих
// сообщений боту (Telegram требует живой webhook, статический сайт не может
// его принимать).
//
// ВАЖНО (v2.7.6): index.html теперь ТОНКИЙ BOOTSTRAP — сам ничего не
// делает, кроме того что при каждом открытии сходит за version.json с
// cache:'no-store' (гарантированно живой запрос, минуя кэш WebView) и
// переходит на app.html?v=<версия>&t=<таймстемп>. Поэтому здесь версию
// синхронизировать больше не нужно: достаточно открыть ЛЮБОЙ URL этого
// бутстрепа (хоть с таймстемпом, хоть без) — свежесть гарантирует сам
// bootstrap, а не этот query-параметр.
// (До v2.7.6 версию приходилось поднимать тут вручную при каждом релизе —
// именно это стало причиной того, что пользователи месяцами видели
// старую версию после деплоя: Menu Button бота указывает на корневой
// index.html БЕЗ query и никогда не менялась между релизами.)
const BOT_TOKEN = "8667764468:AAHB-99kEw-ONhIVjlWSlERg3BOKhdU61Gc";
// Статический URL — ОК: сам бутстреп делает Date.now()/no-store на клиенте
// при каждом открытии, поэтому серверу поднимать таймстемп не нужно
// (и даже вредно: Deno-изолят может быть "тёплым" между вызовами,
// тогда Date.now() тут "застынет" на много запросов подряд).
const APP_URL = "https://dostonravshanov1006800-beep.github.io/globe-market/";
const BANNER_URL = "https://dostonravshanov1006800-beep.github.io/globe-market/banner.png";
const WEBHOOK_SECRET = "gm_wh_7f3k9x_2026_secret";

async function tg(method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function sendWelcome(chatId: number) {
  const keyboard = {
    inline_keyboard: [[
      { text: "🛍 Открыть Globe Market", web_app: { url: APP_URL } },
    ]],
  };
  const caption =
    "🌍 *Globe Market* — маркетплейс внутри Telegram.\n\n" +
    "Каталог, Stories, избранное и реклама для вашего бизнеса — всё в одном месте.\n\n" +
    "Нажмите кнопку ниже, чтобы открыть 👇";
  try {
    const res = await tg("sendPhoto", {
      chat_id: chatId,
      photo: BANNER_URL,
      caption,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    if (res.ok) return;
  } catch (_e) {
    // падаем в текстовый фоллбек ниже
  }
  await tg("sendMessage", {
    chat_id: chatId,
    text: caption,
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("ok", { status: 200 });
  }
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (secret !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const update = await req.json();
    const chatId =
      update?.message?.chat?.id ??
      update?.my_chat_member?.chat?.id ??
      null;
    if (chatId) {
      await sendWelcome(chatId);
    }
  } catch (_e) {
    // игнорируем битые обновления
  }
  return new Response("ok", { status: 200 });
});
