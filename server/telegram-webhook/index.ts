// Globe Market — минимальный Telegram-webhook (Supabase Edge Function, бесплатно).
// Единственная задача: отвечать на /start и любые сообщения приветствием
// с кнопкой "Открыть Globe Market" (web_app). НЕ Base44, НЕ GitHub Pages —
// отдельный бесплатный серверлес-слой Supabase, нужен только для входящих
// сообщений боту (Telegram требует живой webhook, статический сайт не может
// его принимать).
//
// ВАЖНО (v2.7.2): у web_app-кнопки добавлен ?v=<версия>. Telegram WebView
// кэширует Mini App по URL очень агрессивно — без этого параметра
// пользователи месяцами видели старую версию после каждого деплоя
// (замечено на проде: витал кэш v2.6.1, когда реальный релиз был v2.7.1).
// При каждом релизе APP_VERSION здесь нужно поднимать СИНХРОННО с
// APP_VERSION в index.html, иначе защита от кэша не работает.
const BOT_TOKEN = "8667764468:AAHB-99kEw-ONhIVjlWSlERg3BOKhdU61Gc";
const APP_VERSION = "2.7.4";
const APP_URL = `https://dostonravshanov1006800-beep.github.io/globe-market/?v=${APP_VERSION}`;
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
