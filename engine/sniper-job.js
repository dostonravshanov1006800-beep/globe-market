/**
 * GIFT SNIPER ENGINE v1.0 — снипер дешёвых NFT-подарков Telegram.
 * Архитектура 100% GitHub Actions (эстафета, как в gifttracker-bot):
 *   - реле-цикл внутри прогона (~30 мин), свипы каждые ~60с
 *   - скан лотов через TonAPI (страница 1 каждой коллекции)
 *   - флор = медиана 10% самых дешёвых ЧИСТЫХ лотов (фильтр мусора <40% медианы)
 *   - ДЕАЛ = НОВЫЙ лот с ценой ≤ SNIPER_THRESHOLD × флор (без этого лота)
 *   - алерт 1:1 каждому подписчику (AIMD ≤30/сек), бот-поллинг на борту
 *   - состояние в data/state.json, подписчики в data/subscribers.enc (AES openssl)
 *   - публичные данные сайта: data/public.json (лента сделок + флоры)
 *
 * Режимы: FORCE=chain → эстафета 24/7; иначе одиночный свип.
 * SNIPER_DRYRUN=1 → без git и без отправки (локальный тест).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const crypto = require("crypto");

const REPO_ROOT = path.resolve(__dirname, "..");
const DATA = path.join(REPO_ROOT, "data");
const STATE_FILE = path.join(DATA, "state.json");
const SUBS_FILE = path.join(DATA, "subscribers.enc");
const PUB_FILE = path.join(DATA, "public.json");

const COLLECTIONS = require("./collections.js");
const OWNER_IDS = ["8396883978", "7503491071"];

// ── настройки
const DISCOUNT = Number(process.env.SNIPER_THRESHOLD || 0.85); // ≤85% флора = сделка
const JUNK = 0.4;             // лоты < 40% медианы = мусор/скам
const BUDGET_MS = 1_800_000;  // 30 мин на прогон
const SWEEP_GAP = 15_000;     // пауза между свипами
const MAX_DEALS_PER_COL = 3;  // шторм-защита
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
  return { enabled: true, offset: 0, seen: {}, floors: {}, deals: [], usd: 0, usd_ts: 0, rl: { cur: 25, hi: 80, last429: 0 }, sent: 0 };
}
function saveState(st) { fs.writeFileSync(STATE_FILE, JSON.stringify(st)); }

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
          await sleep(3000);
          continue;
        }
        const j = await res.json().catch(() => null);
        return j;
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
async function scanCollection(name, addr) {
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
    lots.push({
      addr: it.address,
      price: v,
      num: it.index != null ? it.index : (metadataNum(meta) ? Number(metadataNum(meta)) : null),
      attrs: {
        model: meta.model || meta.Model || "",
        backdrop: meta.backdrop || meta.Backdrop || "",
        pattern: meta.pattern || meta.Pattern || "",
        symbol: meta.symbol || meta.Symbol || "",
      },
      owner: (it.owner && it.owner.address) || "",
    });
  }
  return { lots };
}
function metadataNum(meta) {
  const raw = String(meta.number || meta.Number || "").replace(/\D/g, "");
  return raw || null;
}

// ── детект сделок: НОВЫЕ лоты дешевле DISCOUNT × флор(без лота)
function detectDeals(prev, lots, st) {
  const seen = st.seen[prev.name] || {};
  const prices = lots.map((l) => l.price);
  const f = floorOf(prices);
  if (!f || !f.floor) return { floor: null, sales: 0, deals: [] };
  const deals = [];
  for (const lot of lots) {
    if (seen[lot.addr]) continue; // уже видели
    // флор без этого лота (убираем ОДНО вхождение по индексу)
    const idx = prices.indexOf(lot.price);
    const rest = idx >= 0 ? prices.slice(0, idx).concat(prices.slice(idx + 1)) : prices;
    const f2 = floorOf(rest.length >= 3 ? rest : prices);
    const base = f2 && f2.floor ? f2.floor : f.floor;
    if (base && lot.price <= DISCOUNT * base) {
      const disc = 1 - lot.price / base;
      deals.push({ ...lot, floor_ton: base / 1e9, disc: disc });
      if (deals.length >= MAX_DEALS_PER_COL) break;
    }
  }
  return { floor: f.floor, sales: f.sales, deals };
}

// ── формат сообщения о сделке
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtTon = (x) => String(+(x / 1e9).toFixed(3)).replace(".", ",");
const fmtUsd = (x) => "$" + (Math.round(x * 100) / 100).toFixed(2);

function dealMsg(d, usd) {
  const attrs = [];
  if (d.attrs.model) attrs.push("Model: " + d.attrs.model);
  if (d.attrs.backdrop) attrs.push("Backdrop: " + d.attrs.backdrop);
  const priceTon = d.price / 1e9;
  const priceUsd = priceTon * usd;
  const lines = [
    `🎯 <b>СНАЙП</b> · ${esc(d.name)}${d.num ? " #" + d.num : ""}`,
    "",
    `💰 Цена: <b>${fmtTon(d.price)} TON</b> (~${fmtUsd(priceUsd)})`,
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

// ── бот-поллинг (команды) — упрощённая версия бота gifttracker
async function botPoll(st, subs) {
  if (!TG || DRY) return subs;
  let changed = false;
  const upd = await tg("getUpdates", { offset: st.offset || 0, timeout: 0, limit: 100, allowed_updates: ["message", "callback_query"] });
  if (!upd || !upd.ok || !Array.isArray(upd.result)) return subs;
  for (const u of upd.result) {
    st.offset = u.update_id + 1;
    changed = true;
    const msg = u.message || (u.callback_query && u.callback_query.message);
    if (!msg || !msg.from) continue;
    const id = String(msg.chat ? msg.chat.id : msg.from.id);
    const uid = String(msg.from.id);
    const text = String((u.message && u.message.text) || (u.callback_query && u.callback_query.data) || "").trim();
    const c = text.split(/\s+/)[0].toLowerCase();
    let sub = subs.find((s) => s.telegram_id === uid);
    if (!sub) { sub = { telegram_id: uid, chat_id: id, active: true, threshold: DISCOUNT, watch: [], night_mode: false }; subs.push(sub); }
    const send = (t, kb) => tg("sendMessage", { chat_id: id, text: t, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...(kb ? { reply_markup: kb } : {}) });
    if (c === "/start") {
      sub.active = true;
      await send(
        `🎯 <b>Gift Sniper</b> — ловлю лоты NFT-подарков Telegram дешевле рынка.\n\n` +
        `Как работает: слежу за лотами 109 коллекций. Как только новый лот появляется на <b>−${Math.round((1 - sub.threshold) * 100)}%+</b> ниже флора — сразу пишу тебе с кнопкой на лот.\n\n` +
        `⚙️ Настройки:\n` +
        `<code>/threshold 20</code> — алерты при скидке 20%+ (по умолчанию ${Math.round((1 - DISCOUNT) * 100)}%)\n` +
        `<code>/watch PlushPepe, PoolFloat</code> — следить только за этими\n` +
        `<code>/watch off</code> — за всеми\n` +
        `<code>/status</code> — мой статус\n` +
        `<code>/stop</code> — выключить алерты`
      );
    } else if (c === "/stop") { sub.active = false; await send("⏸ Снайпер спит. Вернуть: /start"); }
    else if (c === "/status") {
      await send(`📋 <b>Статус</b>\n\nАлерты: ${sub.active ? "✅ вкл" : "⏸ выкл"}\nПорог скидки: −${Math.round((1 - sub.threshold) * 100)}%\n` +
        `Коллекции: ${sub.watch && sub.watch.length ? esc(sub.watch.join(", ")) : "все (109)"}`);
    } else if (c === "/threshold") {
      const n = Number(text.split(/\s+/)[1]);
      if (n >= 5 && n <= 60) { sub.threshold = 1 - n / 100; await send(`✅ Теперь алерты при скидке от −${n}%`); }
      else await send("Формат: <code>/threshold 20</code> (от 5 до 60)");
    } else if (c === "/watch") {
      const rest = text.replace(/^\/watch/i, "").trim().toLowerCase();
      if (rest === "off" || rest === "") { sub.watch = []; await send("✅ Слежу за всеми 109 коллекциями"); }
      else {
        sub.watch = rest.split(",").map((x) => x.trim()).filter((x) => x).slice(0, 20);
        await send(`✅ Радар: ${esc(sub.watch.join(", "))}`);
      }
    } else if (c === "/help") {
      await send(`🎯 Gift Sniper\n\n/start — включить алерты\n/stop — выключить\n/status — статус\n/threshold N — порог скидки в %\n/watch A,B — список коллекций\n/watch off — все коллекции`);
    } else if (c === "/ping") { await send("🏓 pong"); }
  }
  return subs;
}

// ── публичные данные для сайта
function writePublic(st) {
  const usd = st.usd || 1.4;
  const pub = {
    updated: new Date().toISOString(),
    updated_unix: NOW(),
    usd,
    deals: (st.deals || []).slice(0, 50).map((d) => ({
      n: d.name, num: d.num || null, ton: +(d.price / 1e9).toFixed(3), usd: +(d.price / 1e9 * usd).toFixed(2),
      floor: +(d.floor_ton).toFixed(3), disc: Math.round(d.disc * 100), ts: d.ts,
      getgems: "https://getgems.io/nft/" + d.addr,
      model: d.attrs && d.attrs.model || "", backdrop: d.attrs && d.attrs.backdrop || "",
    })),
    floors: Object.entries(st.floors || {}).map(([name, f]) => ({
      n: name, ton: f.floor_ton, usd: +(f.floor_ton * usd).toFixed(2), sales: f.sales, t: f.t,
    })).sort((a, b) => a.ton - b.ton),
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
    try { execSync("git add data/state.json data/subscribers.enc data/public.json", { cwd: REPO_ROOT, stdio: "pipe", timeout: 30_000 }); } catch {}
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
async function sweep(st, subs) {
  const usd = await usdRate(st);
  const t0 = Date.now();
  let dealsFound = 0;

  for (const col of COLLECTIONS) {
    const res = await scanCollection(col.name, col.address);
    if (!res || !res.lots.length) { continue; }
    const { floor, sales, deals } = detectDeals(col, res.lots, st);

    // обновляем seen (текущая страница = актуальный срез)
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
      // алерты 1:1
      if (!DRY) {
        const { text, markup } = dealMsg(deal, usd);
        for (const sub of subs) {
          if (!sub.active) continue;
          if (sub.watch && sub.watch.length && sub.watch.indexOf(col.name.toLowerCase()) < 0) continue;
          if (sub.threshold && deal.price > sub.threshold * deal.floor_ton * 1e9) continue;
          await tg("sendMessage", { chat_id: sub.chat_id, text, parse_mode: "HTML", reply_markup: markup });
          st.sent = (st.sent || 0) + 1;
        }
      } else {
        console.log("[DRY] СДЕЛКА:", col.name, fmtTon(deal.price), "floor", fmtTon(deal.floor_ton * 1e9), "−" + Math.round(deal.disc * 100) + "%");
      }
    }
  }
  console.log(`sweep: ${COLLECTIONS.length} колл., сделок ${dealsFound}, ${Date.now() - t0}ms, usd ${usd}`);
  return dealsFound;
}

// ── реле-эстафета (как full-job)
async function relay() {
  const t0 = Date.now();
  let n = 0;
  while (true) {
    const sweepStart = Date.now();
    n++;
    const st = loadState();
    let subs = loadSubs();
    subs = await botPoll(st, subs);
    await sweep(st, subs);
    saveSubs(subs);
    saveState(st);
    writePublic(st);
    if (DRY) return;
    gitCommit(`sweep ${n}: data`);
    if ((Date.now() - t0) + 20_000 > BUDGET_MS) break;
    await sleep(Math.max(1000, SWEEP_GAP - (Date.now() - sweepStart)));
  }
  console.log("LOOP: свипов за прогон:", n);
  // эстафета: запускаем следующий прогон
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
    if (!DRY && FORCE !== "chain" && EVENT_NAME !== "schedule") {
      // одиночный прогон (ручной dispatch без force)
    }
    if (DRY) {
      const st = loadState();
      await usdRate(st);
      await sweep(st, loadSubs());
      writePublic(st);
      console.log("DRY RUN завершён");
      return;
    }
    // GUARD: крон-тик = страховка; если живой прогон есть — тихо выходим
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
