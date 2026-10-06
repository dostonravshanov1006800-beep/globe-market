// Globe Market — минимальный Telegram-webhook (Supabase Edge Function, бесплатно).
// Единственная задача: отвечать на /start и любые сообщения приветствием
// с кнопкой "Открыть Globe Market" (web_app). НЕ Base44, НЕ GitHub Pages —
// отдельный бесплатный серверлес-слой Supabase, нужен только для входящих
// сообщений боту (Telegram требует живой webhook, статический сайт не может
// его принимать).
const BOT_TOKEN = "8667764468:AAHB-99kEw-ONhIVjlWSlERg3BOKhdU61Gc";
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
    // падаем на текстовое сообщение ниже
  }
  await tg("sendMessage", {
    chat_id: chatId,
    text: caption,
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");

  // Проверка секрета Telegram (устанавливается через setWebhook secret_token)
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (secret !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch (_e) {
    return new Response("ok");
  }

  const msg = update?.message;
  if (msg && msg.chat && msg.chat.id) {
    // Отвечаем приветствием на /start и на любое другое сообщение в приват-чате —
    // так кнопка "Start" в Telegram всегда даёт видимый результат.
    await sendWelcome(msg.chat.id);
  }

  return new Response("ok");
});
