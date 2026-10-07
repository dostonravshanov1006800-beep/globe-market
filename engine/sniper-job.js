/**
 * GIFT SNIPER ENGINE v1.1 — монитор + снипер + аналитика.
 * Архитектура 100% GitHub Actions (эстафета, как в gifttracker-bot):
 *   - реле-цикл внутри прогона (~30 мин), свипы по 109 коллекциям
 *   - скан лотов через TonAPI; флор = медиана 10% самых дешёвых ЧИСТЫХ лотов
 *   - ДЕАЛ = НОВЫЙ лот ≤ SNIPER_THRESHOLD × флор → алерт 1:1 (AIMD)
 *   - АЛЕРТ ПО ЦЕНЕ: флор коллекции пробил N⭐ → сигнал (PRO)
 *   - ИСТОРИЯ ФЛОРОВ 48ч → графики/движения в мини-аппе
 *   - PRO 150⭐/мес через Telegram Stars (sendInvoice XTR, автоактивация)
 *   - состояние data/state.json, подписчики data/subscribers.enc (AES)
 *
 * Режимы: FORCE=chain → эстафета 24/7; SNIPER_DRYRUN=1 → локальный тест.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const DATA = path.join(REPO_ROOT, "data");
const STATE_FILE = path.join(DATA, "state.json");
const SUBS_FILE = path.join(DATA, "subscribers.enc");
const PUB_FILE = path.join(DATA, "public.json");
const HIST_FILE = path.join(DATA, "history.json");

const COLLECTIONS = require("./collections.js");
const OWNER_IDS = ["8396883978", "7503491071"];

// ── настройки
const DISCOUNT = Number(process.env.SNIPER_THRESHOLD || 0.85); // дефолт: ≤85% флора = сделка
const DISCOUNT_PRO = 0.95;  // PRO: порог до 5% скидки
const JUNK = 0.4;          // лоты < 40% медианы = мусор/скам
const BUDGET_MS = 1_800_000;
const SWEEP_GAP = 15_000;
const MAX_DEALS_PER_COL = 3;
const STARS_USD = 0.013;   // курс: 1⭐ ≈ $0.013 (внутренняя покупка Telegram)
const PRO_STARS = 150;    // цена PRO: 150⭐/30 дней
const DRY = process.env.SNIPER_DRYRUN === "1";
const EVENT_NAME = process.env.EVENT_NAME || "";
const FORCE = process.env.FORCE || "";
const WF_NAME = "sniper-relay.yml";
const REPO_API = process.env.REPO_API || "dostonravshanov1006800-beep/globe-market";

const TG = process.env.TELEGRAM_BOT_TOKEN || "";
const CRYPT_KEY = process.env.CRYPT_KEY || "";
const NOW = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── состояние
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
  return { enabled: true, offset: 0, seen: {}, floors: {}, deals: [], usd: 0, usd_ts: 0, rl: { cur: 25, hi: 80, last429: 0 }, sent: 0, hist_at: 0 };
}
function saveState(st) { fs.writeFileSync(STATE_FILE, JSON.stringify(st)); }

// ── история флоров (сэмпл раз в 10 мин, окно 48ч)
function loadHist() {
  try { return JSON.parse(fs.readFileSync(HIST_FILE, "utf8")); } catch {}
  return { cols: {} };
}
function saveHist(h) { fs.writeFileSync(HIST_FILE, JSON.stringify(h)); }
function sampleHist(st, hist) {
  if (NOW() - (st.hist_at || 0) < 600) return;
  st.hist_at = NOW();
  const cutoff = NOW() - 48 * 3600;
  for (const [name, f] of Object.entries(st.floors)) {
    const arr = hist.cols[name] || (hist.cols[name] = []);
    if (!arr.length || NOW() - arr[arr.length - 1][0] >= 600) arr.push([NOW(), f.floor_ton]);
    while (arr.length && arr[0][0] < cutoff) arr.shift();
  }
}

// ── подписчики (AES openssl, как в gifttracker)
function loadSubs() {
  if (!fs.existsSync(SUBS_FILE)) return [];
  try {
    const plain = execSync(
      `openssl enc -d -aes-256-cbc -pbkdf2 -pass 'pass:${CRYPT_KEY}' -in "${SUBS_FILE}"`,
      { encoding: "utf8", timeout: 30_000 }
    );
    return JSON.parse(plain);
  } catch { return []; }
}
function saveSubs(subs) {
  const plain = path.join(DATA, ".subs.tmp");
  fs.writeFileSync(plain, JSON.stringify(subs));
  try {
    execSync(`openssl enc -aes-256-cbc -pbkdf2 -salt -pass 'pass:${CRYPT_KEY}' -in "${plain}" -out "${SUBS_FILE}"`, { stdio: "pipe" });
  } finally { try { fs.unlinkSync(plain); } catch {} }
}

// ── Telegram API с AIMD
let CHAIN = Promise.resolve();
function tg(method, params) {
  const p = CHAIN.then(async () => {
    const st = loadState();
    const cur = Math.max(1, Math.min(st.rl.cur, st.rl.hi));
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${TG}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params || {}),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 429) {
          st.rl.cur = Math.max(1, cur - 3);
          st.rl.last429 = NOW();
          saveState(st);
          await sleep(3000);
          continue;
        }
        return await res.json().catch(() => null);
      } catch {}
      await sleep(2000);
    }
    return null;
  });
  CHAIN = p.catch(() => {});
  return p;
}

// ── TonAPI: лимит параллелизма 1, ретраи
let API_CHAIN = Promise.resolve();
function tonapi(url) {
  const p = API_CHAIN.then(async () => {
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(`https://tonapi.io${url}`, {
          headers: {
            ...(process.env.TONAPI_KEY ? { Authorization: `Bearer ${process.env.TONAPI_KEY}` } : {}),
            "User-Agent": "Mozilla/5.0",
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 429) { await sleep(4000); continue; }
        if (!res.ok) return null;
        return await res.json().catch(() => null);
      } catch {}
      await sleep(2500);
    }
    return null;
  });
  API_CHAIN = p.catch(() => {});
  return p;
}

// ── курс TON→USD (CoinGecko, кэш 10 мин)
async function usdRate(st) {
  if (st.usd && NOW() - st.usd_ts < 600) return st.usd;
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd",
      { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j && j["the-open-network"] && j["the-open-network"].usd) {
      st.usd = j["the-open-network"].usd; st.usd_ts = NOW();
      return st.usd;
    }
  } catch {}
  return st.usd || 1.4;
}

// ── математика флора (проверенная схема floors-job v2)
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function floorOf(pricesNano) {
  if (!pricesNano.length) return null;
  const allMed = median(pricesNano);
  const clean = pricesNano.filter((v) => v >= JUNK * allMed);
  const pool = clean.length >= 2 ? clean : pricesNano;
  const sorted = [...pool].sort((a, b) => a - b);
  const take = Math.max(3, Math.ceil(sorted.length * 0.1));
  return { floor: median(sorted.slice(0, take)), sales: pricesNano.length };
}

// ── скан одной коллекции
async function scanCollection(addr) {
  const d = await tonapi(`/v2/nfts/collections/${encodeURIComponent(addr)}/items?limit=100&offset=0`);
  const items = d && d.nft_items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const lots = [];
  for (const it of items) {
    const s = it.sale;
    if (!s || !s.price || s.price.currency_type !== "native") continue;
    const v = Number(s.price.value);
    if (!Number.isFinite(v) || v <= 0) continue;
    const meta = it.metadata || {};
    const numRaw = String(meta.number || meta.Number || "").replace(/\D/g, "");
    lots.push({
      addr: it.address,
      price: v,
      num: it.index != null ? it.index : (numRaw ? Number(numRaw) : null),
      attrs: {
        model: meta.model || meta.Model || "",
        backdrop: meta.backdrop || meta.Backdrop || "",
        symbol: meta.symbol || meta.Symbol || "",
      },
    });
  }
  return { lots };
}

// ── детект сделок: НОВЫЕ лоты дешевле DISCOUNT × флор(без лота)
function detectDeals(name, lots, st) {
  const seen = st.seen[name] || {};
  const prices = lots.map((l) => l.price);
  const f = floorOf(prices);
  if (!f || !f.floor) return { floor: null, sales: 0, deals: [] };
  const deals = [];
  for (const lot of lots) {
    if (seen[lot.addr]) continue;
    const idx = prices.indexOf(lot.price);
    const rest = idx >= 0 ? prices.slice(0, idx).concat(prices.slice(idx + 1)) : prices;
    const f2 = floorOf(rest.length >= 3 ? rest : prices);
    const base = f2 && f2.floor ? f2.floor : f.floor;
    if (base && lot.price <= DISCOUNT * base) {
      deals.push({ ...lot, floor_ton: base / 1e9, disc: 1 - lot.price / base });
      if (deals.length >= MAX_DEALS_PER_COL) break;
    }
  }
  return { floor: f.floor, sales: f.sales, deals };
}

// ── форматирование
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtTon = (x) => String(+(x / 1e9).toFixed(3)).replace(".", ",");
const fmtUsd = (x) => "$" + (Math.round(x * 100) / 100).toFixed(2);
const starsOf = (ton, usd) => ton * usd / STARS_USD;
const fmtStars = (x) => String(Math.round(x));

function dealMsg(d, usd) {
  const attrs = [];
  if (d.attrs.model) attrs.push("Model: " + d.attrs.model);
  if (d.attrs.backdrop) attrs.push("Backdrop: " + d.attrs.backdrop);
  const priceTon = d.price / 1e9;
  const lines = [
    `🎯 <b>СНАЙП</b> · ${esc(d.name)}${d.num ? " #" + d.num : ""}`,
    "",
    `💰 Цена: <b>${fmtTon(d.price)} TON</b> (~${fmtUsd(priceTon * usd)} · ≈${fmtStars(starsOf(priceTon, usd))}⭐)`,
    `📊 Флор рынка: ${fmtTon(d.floor_ton * 1e9)} TON → скидка <b>−${Math.round(d.disc * 100)}%</b>`,
  ];
  if (attrs.length) lines.push("✨ " + esc(attrs.join(" · ")));
  lines.push("", "⚡ Лот может уйти за минуты — беги:");
  return {
    text: lines.join("\n"),
    markup: {
      inline_keyboard: [
        [{ text: "💎 Открыть лот", url: `https://getgems.io/nft/${d.addr}` }],
        [{ text: "🌊 Portals", url: `https://t.me/portals/market?startapp=${encodeURIComponent(d.name)}` }],
      ],
    },
  };
}

function priceAlertMsg(name, floorTon, stars, usd) {
  return {
    text:
      `📉 <b>ЦЕНА УПАЛА</b> · ${esc(name)}\n\n` +
      `Флор пробил твой порог: <b>${fmtStars(stars)}⭐</b>\n\n` +
      `Сейчас флор: <b>${fmtTon(floorTon * 1e9)} TON</b> ≈ <b>${fmtStars(starsOf(floorTon, usd))}⭐</b> (~${fmtUsd(floorTon * usd)})\n\n` +
      `⚡ Пора смотреть лоты — самые дешёвые в мини-аппе:`,
    markup: { inline_keyboard: [[{ text: "🌊 Portals", url: `https://t.me/portals/market?startapp=${encodeURIComponent(name)}` }]] },
  };
}

// ── PRO: чек подписки
const isPro = (sub) => sub && sub.premium_until && sub.premium_until > NOW();
function proEnds(sub) {
  const d = Math.ceil((sub.premium_until - NOW()) / 86400);
  return d > 0 ? `PRO активен ещё ${d} дн.` : "";
}
function sendInvoicePro(chatId) {
  return tg("sendInvoice", {
    chat_id: chatId,
    title: "Gift Sniper PRO — 30 дней",
    description: "Снипер с порогом до −95%, алерты по цене в звёздах, неограниченный watchlist, мгновенные уведомления.",
    payload: "pro30",
    currency: "XTR",
    prices: [{ label: "PRO 30 дней", amount: PRO_STARS }],
  });
}

// ── бот-поллинг
async function botPoll(st, subs) {
  if (!TG || DRY) return subs;
  let changed = false;
  const upd = await tg("getUpdates", { offset: st.offset || 0, timeout: 0, limit: 100, allowed_updates: ["message", "callback_query", "pre_checkout_query"] });
  if (!upd || !upd.ok || !Array.isArray(upd.result)) return subs;
  for (const u of upd.result) {
    st.offset = u.update_id + 1;
    changed = true;

    // Stars: pre-checkout
    if (u.pre_checkout_query) {
      await tg("answerPreCheckoutQuery", { pre_checkout_query_id: u.pre_checkout_query.id, ok: true });
      continue;
    }
    const msg = u.message || (u.callback_query && u.callback_query.message);
    if (!msg || !msg.from) continue;
    const id = String(msg.chat ? msg.chat.id : msg.from.id);
    const uid = String(msg.from.id);
    const text = String((u.message && u.message.text) || (u.callback_query && u.callback_query.data) || "").trim();
    const low = text.toLowerCase();

    // Stars: успешная оплата → активировать PRO
    if (u.message && u.message.successful_payment) {
      let sub = subs.find((s) => s.telegram_id === uid);
      if (!sub) { sub = newSub(uid, id); subs.push(sub); }
      const base = Math.max(NOW(), sub.premium_until || 0);
      sub.premium_until = base + 30 * 86400;
      await tg("sendMessage", { chat_id: id, parse_mode: "HTML", text: `⭐ <b>PRO активирован на 30 дней!</b>\n\nТеперь доступны: порог снайпера до −95%, алерты по цене в ⭐ (<code>/alert PlushPepe 20</code>), watchlist без лимита.\nСпасибо за поддержку!` });
      continue;
    }

    const c = low.split(/\s+/)[0].replace(/@global_mrkt_bot$/, "");
    let sub = subs.find((s) => s.telegram_id === uid);
    if (!sub) { sub = newSub(uid, id); subs.push(sub); }
    const send = (t, kb) => tg("sendMessage", { chat_id: id, text: t, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(kb ? { reply_markup: kb } : {}) });

    if (c === "/start") {
      sub.active = true;
      if (low.includes("pro")) { await sendInvoicePro(id); continue; }
      const th = Math.round((1 - (sub.threshold || DISCOUNT)) * 100);
      await send(
        `🎯 <b>Gift Sniper</b> — ловлю лоты NFT-подарков дешевле рынка и слежу за ценами.\n\n` +
        `<b>Что умею бесплатно:</b>\n` +
        `⚡ Снайп: новый лот −${th}%+ от флора → мгновенный алерт с кнопкой на лот\n` +
        `📈 Аналитика рынка: лента, флоры, графики в мини-аппе (меню бота)\n\n` +
        `<b>PRO — 150⭐/30 дней:</b>\n` +
        `🎯 Снайп с порогом до −95% (<code>/threshold</code>)\n` +
        `📉 Алерты по цене: «упал ниже N⭐» (<code>/alert PlushPepe 20</code>)\n` +
        `♾ Watchlist без лимита\n\n` +
        `/pro — подключить · /help — все команды`
      );
    } else if (c === "/pro") {
      if (isPro(sub)) { await send(`⭐ ${proEnds(sub)} Продлевать можно в любой момент — дни суммируются.`); continue; }
      await send("⭐ <b>PRO — 150⭐/30 дней</b>\n\n🎯 Порог снайпера до −95%\n📉 Алерты «упал ниже N⭐»\n♾ Watchlist без лимита\n\nЖми «Оплатить» — спишутся Telegram Stars:");
      await sendInvoicePro(id);
    } else if (c === "/stop") { sub.active = false; await send("⏸ Снайпер спит. Вернуть: /start"); }
    else if (c === "/status") {
      const alerts = (sub.alerts || []).map((a, i) => `${i + 1}. ${esc(a.name)} ${a.dir === "above" ? "↑ выше" : "↓ ниже"} ${a.stars}⭐`).join("\n");
      await send(`📋 <b>Статус</b>\n\n${isPro(sub) ? "⭐ " + proEnds(sub) : "🆓 Бесплатный план (PRO: /pro)"}\n` +
        `Алерты: ${sub.active ? "✅ вкл" : "⏸ выкл"}\n` +
        `Порог снайпера: −${Math.round((1 - (sub.threshold || DISCOUNT)) * 100)}%${isPro(sub) ? "" : " (PRO: до −95%)"}\n` +
        `Коллекции: ${sub.watch && sub.watch.length ? esc(sub.watch.join(", ")) : "все (109)"}${isPro(sub) ? "" : " (макс. 5)"}\n` +
        (alerts ? `Алерты по цене:\n${alerts}` : ""));
    } else if (c === "/threshold") {
      const n = Number(low.split(/\s+/)[1]);
      const minPct = isPro(sub) ? 5 : 15;
      if (n >= minPct && n <= 95) { sub.threshold = 1 - n / 100; await send(`✅ Теперь алерты при скидке от −${n}%`); }
      else await send(isPro(sub) ? `Формат: <code>/threshold 30</code> (от 5 до 95)` : `На бесплатном плане порог от −15%. Формат: <code>/threshold 20</code>. Глубже — в PRO: /pro`);
    } else if (c === "/watch") {
      const rest = text.replace(/^\/watch/i, "").trim().toLowerCase();
      if (rest === "off" || rest === "") { sub.watch = []; await send("✅ Слежу за всеми 109 коллекциями"); }
      else {
        const list = rest.split(",").map((x) => x.trim()).filter((x) => x);
        const cap = isPro(sub) ? 50 : 5;
        if (list.length > cap) { await send(`Лимит ${cap} коллекций${isPro(sub) ? "" : " (PRO — без лимита: /pro)"}`); continue; }
        sub.watch = list;
        await send(`✅ Радар: ${esc(list.join(", "))}`);
      }
    } else if (c === "/alert") {
      if (!isPro(sub)) { await send("📉 Алерты по цене («упал ниже N⭐») — фича PRO.\n\n/pro — подключить за 150⭐/30 дней"); continue; }
      const rest = text.replace(/^\/alert/i, "").trim();
      if (!rest) {
        const list = (sub.alerts || []).map((a, i) => `${i + 1}. ${esc(a.name)} ${a.dir === "above" ? "↑" : "↓"} ${a.stars}⭐ ${a.armed ? "🎯" : "⏳"}`).join("\n");
        await send(list ? `📉 <b>Мои алерты</b>\n\n${list}\n\nУдалить: <code>/alert del 1</code>` : "Пока нет алертов. Добавь: <code>/alert PlushPepe below 20</code>");
        continue;
      }
      if (low.startsWith("/alert del")) {
        const i = Number(low.split(/\s+/)[2]) - 1;
        if (sub.alerts && sub.alerts[i]) { const rm = sub.alerts.splice(i, 1); await send(`🗑 Убрал: ${esc(rm[0].name)} ${rm[0].stars}⭐`); }
        else await send("Номер не найден: /alert");
        continue;
      }
      // /alert PlushPepe below 20  |  /alert PlushPepe 20  |  /alert PlushPepe above 30
      const parts = rest.split(/\s+/);
      let name = "", dir = "below", stars = 0;
      const name1 = parts[0] && COLLECTIONS.find((x) => x.name.toLowerCase() === parts[0].toLowerCase());
      if (name1) name = name1.name;
      if (!name) { await send(`Коллекция «${esc(parts[0] || "")}» не найдена. Имя как в мини-аппе: PlushPepe, PoolFloat…`); continue; }
      if (parts[1] === "above" || parts[1] === "below") { dir = parts[1]; stars = Number(parts[2]); }
      else stars = Number(parts[1]);
      if (!stars || stars <= 0) { await send("Формат: <code>/alert PlushPepe below 20</code> (порог в ⭐)"); continue; }
      sub.alerts = (sub.alerts || []).filter((a) => !(a.name === name && a.dir === dir && a.stars === stars));
      if (sub.alerts.length >= 10) { await send("Лимит: 10 алертов. Удали лишний: <code>/alert del N</code>"); continue; }
      sub.alerts.push({ name, dir, stars, armed: true });
      await send(`✅ Алерт: <b>${esc(name)}</b> ${dir === "above" ? "выше" : "ниже"} <b>${stars}⭐</b>\n\nСработает при пробое флора (пересчёт TON→⭐ по курсу). После срабатывания перевзводится сам.`);
    } else if (c === "/help") {
      await send(
        `🎯 <b>Gift Sniper</b> — команды\n\n` +
        `<b>Бесплатно:</b>\n` +
        `/start — включить алерты снайпера\n` +
        `/stop — выключить\n` +
        `/status — статус и настройки\n` +
        `/threshold 20 — порог скидки (15–95%)\n` +
        `/watch A,B — до 5 коллекций, /watch off — все\n\n` +
        `<b>PRO (150⭐/30 дн.):</b>\n` +
        `/pro — подключить/продлить\n` +
        `/threshold 5 — порог до −95%\n` +
        `/alert PlushPepe below 20 — упал ниже N⭐\n` +
        `/alert PlushPepe above 30 — вырос выше N⭐\n` +
        `/alert — список, /alert del 1 — удалить\n` +
        `♾ watchlist без лимита`
      );
    }
  }
  return subs;
}
function newSub(id, chatId) {
  return {
    telegram_id: String(id),
    chat_id: String(chatId || id),
    active: true,
    threshold: DISCOUNT,
    watch: [],
    alerts: [],
    premium_until: 0,
  };
}

// ── проверка алертов по цене (после обновления флоров)
function checkPriceAlerts(st, subs) {
  if (DRY || !subs.length) return;
  const usd = st.usd || 1.4;
  for (const sub of subs) {
    if (!sub.active || !Array.isArray(sub.alerts)) continue;
    for (const a of sub.alerts) {
      const f = st.floors[a.name];
      if (!f || !f.floor_ton) continue;
      const stars = starsOf(f.floor_ton, usd);
      if (a.dir !== "above") { // below
        if (a.armed && stars <= a.stars) {
          a.armed = false;
          const { text, markup } = priceAlertMsg(a.name, f.floor_ton, a.stars, usd);
          tg("sendMessage", { chat_id: sub.chat_id, text, parse_mode: "HTML", reply_markup: markup });
          st.sent = (st.sent || 0) + 1;
        } else if (!a.armed && stars > a.stars * 1.05) a.armed = true; // перевзвод
      } else { // above
        if (a.armed && stars >= a.stars) {
          a.armed = false;
          tg("sendMessage", {
            chat_id: sub.chat_id, parse_mode: "HTML",
            text: `📈 <b>ЦЕНА ВЫРОСЛА</b> · ${esc(a.name)}\n\nФлор поднялся выше твоего порога <b>${a.stars}⭐</b>:\nсейчас ≈ <b>${fmtStars(stars)}⭐</b> (${fmtTon(f.floor_ton * 1e9)} TON)`,
          });
          st.sent = (st.sent || 0) + 1;
        } else if (!a.armed && stars < a.stars * 0.95) a.armed = true;
      }
    }
  }
}

// ── публичные данные для сайта
function writePublic(st, hist) {
  const usd = st.usd || 1.4;
  const floors = Object.entries(st.floors).map(([name, f]) => {
    const d = f.pf ? Math.round((f.floor_ton - f.pf) / f.pf * 100) : null;
    return { n: name, ton: f.floor_ton, usd: +(f.floor_ton * usd).toFixed(2), stars: Math.round(starsOf(f.floor_ton, usd)), sales: f.sales, d, t: f.t };
  });
  const movers = [...floors].filter((x) => x.d !== null && x.sales >= 3).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 10);
  const totalTon = floors.reduce((a, x) => a + x.ton, 0);
  const totalSales = floors.reduce((a, x) => a + x.sales, 0);
  // история для графиков: топ-50 по объёму, прореживание до ~145 точек
  const topNames = new Set([...floors].sort((a, b) => b.sales - a.sales).slice(0, 50).map((x) => x.n));
  const charts = {};
  for (const [name, arr] of Object.entries(hist.cols)) {
    if (!topNames.has(name) || arr.length < 2) continue;
    const step = Math.max(1, Math.floor(arr.length / 60));
    charts[name] = [];
    for (let i = 0; i < arr.length; i += step) charts[name].push([arr[i][0], arr[i][1]]);
    const last = arr[arr.length - 1];
    if (charts[name][charts[name].length - 1][0] !== last[0]) charts[name].push(last);
  }
  const pub = {
    updated: new Date().toISOString(),
    updated_unix: NOW(),
    usd,
    stars_usd: STARS_USD,
    pro_stars: PRO_STARS,
    market: { collections: floors.length, totalTon: +totalTon.toFixed(1), totalSales, usd },
    movers,
    deals: (st.deals || []).slice(0, 50).map((d) => ({
      n: d.name, num: d.num || null, ton: +(d.price / 1e9).toFixed(3), usd: +(d.price / 1e9 * usd).toFixed(2),
      stars: Math.round(starsOf(d.price / 1e9, usd)),
      floor: +(d.floor_ton).toFixed(3), disc: Math.round(d.disc * 100), ts: d.ts,
      getgems: "https://getgems.io/nft/" + d.addr,
      model: d.attrs && d.attrs.model || "", backdrop: d.attrs && d.attrs.backdrop || "",
    })),
    floors,
    charts,
  };
  fs.writeFileSync(PUB_FILE, JSON.stringify(pub));
}

// ── git: коммит данных
let GIT_LOCK = false;
function gitCommit(msg) {
  if (DRY || GIT_LOCK) return;
  GIT_LOCK = true;
  try {
    try { execSync("git checkout -B main", { cwd: REPO_ROOT, stdio: "pipe", timeout: 60_000 }); } catch {}
    try { execSync("git add data/state.json data/subscribers.enc data/public.json data/history.json", { cwd: REPO_ROOT, stdio: "pipe", timeout: 30_000 }); } catch {}
    const has = (() => { try { return execSync("git status --porcelain data", { cwd: REPO_ROOT, encoding: "utf8" }).trim(); } catch { return ""; } })();
    if (!has) return;
    execSync(`git -c user.name="sniper-bot" -c user.email="sniper@users.noreply.github.com" commit -m "${msg}"`, { cwd: REPO_ROOT, stdio: "pipe", timeout: 30_000 });
    try { execSync("git pull --rebase -q", { cwd: REPO_ROOT, stdio: "pipe", timeout: 60_000 }); } catch {}
    execSync("git push -q origin main", { cwd: REPO_ROOT, stdio: "pipe", timeout: 60_000 });
    console.log("git: " + msg);
  } catch (e) { console.log("git fail:", String(e.message).slice(0, 120)); }
  finally { GIT_LOCK = false; }
}

// ── СВИП
async function sweep(st, subs, hist) {
  const usd = await usdRate(st);
  const t0 = Date.now();
  let dealsFound = 0;

  for (const col of COLLECTIONS) {
    const res = await scanCollection(col.address);
    if (!res || !res.lots.length) continue;
    const { floor, sales, deals } = detectDeals(col.name, res.lots, st);

    st.seen[col.name] = {};
    for (const l of res.lots) st.seen[col.name][l.addr] = 1;

    if (floor) {
      const prev = st.floors[col.name];
      st.floors[col.name] = { floor_ton: +(floor / 1e9).toFixed(4), sales, pf: prev ? prev.floor_ton : null, t: NOW() };
    }

    for (const d of deals) {
      dealsFound++;
      const deal = { name: col.name, num: d.num, addr: d.addr, price: d.price, floor_ton: d.floor_ton, disc: d.disc, attrs: d.attrs, ts: NOW() };
      st.deals = [deal, ...(st.deals || [])].slice(0, 100);
      if (!DRY) {
        const { text, markup } = dealMsg(deal, usd);
        for (const sub of subs) {
          if (!sub.active) continue;
          if (sub.watch && sub.watch.length && sub.watch.indexOf(col.name.toLowerCase()) < 0) continue;
          const th = sub.threshold || DISCOUNT;
          if (deal.price > th * deal.floor_ton * 1e9) continue;
          await tg("sendMessage", { chat_id: sub.chat_id, text, parse_mode: "HTML", reply_markup: markup });
          st.sent = (st.sent || 0) + 1;
        }
      } else {
        console.log("[DRY] СДЕЛКА:", col.name, fmtTon(deal.price), "floor", fmtTon(deal.floor_ton * 1e9), "−" + Math.round(deal.disc * 100) + "%");
      }
    }
  }
  // алерты по цене + история + сайт
  checkPriceAlerts(st, subs);
  sampleHist(st, hist);
  saveHist(hist);
  writePublic(st, hist);
  console.log(`sweep: ${COLLECTIONS.length} колл., сделок ${dealsFound}, ${Date.now() - t0}ms, usd ${usd}`);
  return dealsFound;
}

// ── реле-эстафета
async function relay() {
  const t0 = Date.now();
  let n = 0;
  while (true) {
    const sweepStart = Date.now();
    n++;
    const st = loadState();
    const hist = loadHist();
    let subs = loadSubs();
    subs = await botPoll(st, subs);
    await sweep(st, subs, hist);
    saveSubs(subs);
    saveState(st);
    if (DRY) return;
    gitCommit(`sweep ${n}: data`);
    if ((Date.now() - t0) + 20_000 > BUDGET_MS) break;
    await sleep(Math.max(1000, SWEEP_GAP - (Date.now() - sweepStart)));
  }
  console.log("LOOP: свипов за прогон:", n);
  try {
    const q = execSync(
      `curl -s -m 15 -H "Authorization: Bearer ${process.env.GITHUB_TOKEN}" -H "Accept: application/vnd.github+json" ` +
      `https://api.github.com/repos/${REPO_API}/actions/workflows/${WF_NAME}/runs?per_page=10`,
      { encoding: "utf8", timeout: 20_000 }
    );
    const myId = String(process.env.GITHUB_RUN_ID || "");
    const hasQueue = (JSON.parse(q).workflow_runs || [])
      .some((x) => (x.status === "queued" || x.status === "in_progress") && String(x.id) !== myId);
    if (!hasQueue) {
      const r = execSync(
        `curl -s -m 15 -w "\\nHTTP:%{http_code}" -X POST ` +
        `-H "Authorization: Bearer ${process.env.GITHUB_TOKEN}" ` +
        `-H "Accept: application/vnd.github+json" ` +
        `https://api.github.com/repos/${REPO_API}/actions/workflows/${WF_NAME}/dispatches ` +
        `-d '{"ref":"main","inputs":{"force":"chain"}}'`,
        { encoding: "utf8", timeout: 20_000 }
      ).trim();
      console.log("эстафета:", r.split("\n").pop());
    } else console.log("эстафета: очередь жива — не дублируем");
  } catch (e) { console.log("эстафета fail:", String(e.message).slice(0, 100)); }
}

(async () => {
  try {
    if (DRY) {
      const st = loadState();
      await usdRate(st);
      const hist = loadHist();
      await sweep(st, loadSubs(), hist);
      console.log("DRY RUN завершён");
      return;
    }
    if (EVENT_NAME === "schedule") {
      try {
        const q = execSync(
          `curl -s -m 15 -H "Authorization: Bearer ${process.env.GITHUB_TOKEN}" -H "Accept: application/vnd.github+json" ` +
          `https://api.github.com/repos/${REPO_API}/actions/workflows/${WF_NAME}/runs?per_page=15`,
          { encoding: "utf8", timeout: 20_000 }
        );
        const myId = String(process.env.GITHUB_RUN_ID || "");
        const alive = (JSON.parse(q).workflow_runs || [])
          .some((x) => (x.status === "queued" || x.status === "in_progress") && String(x.id) !== myId);
        if (alive) { console.log("GUARD: цепь жива, тихий выход"); process.exit(0); }
        console.log("GUARD: цепь мертва — беру эстафету");
      } catch {}
    }
    await relay();
  } catch (e) {
    console.error("FATAL:", String(e).slice(0, 300));
    process.exit(1);
  }
})();
