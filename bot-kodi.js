// ===== Isakov school viktorina boti — Cloudflare Worker + D1 + Queue + avto =====
const API = (env, m) => `https://api.telegram.org/bot${env.BOT_TOKEN}/${m}`;

async function tg(env, method, body, retry = true) {
  const r = await fetch(API(env, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok && j.error_code === 429 && retry) {
    const wait = Math.min((j.parameters?.retry_after || 2), 10);
    await new Promise((res) => setTimeout(res, wait * 1000));
    return tg(env, method, body, false);
  }
  if (!j.ok) console.log("TG xato", method, JSON.stringify(j));
  return j;
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const send = (env, chat_id, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

// ---------- Savol yuborish ----------
async function sendQuestion(env, s, idx) {
  const qs = JSON.parse(s.questions);
  const q = qs[idx];
  const n = `${idx + 1}/${qs.length}. `;
  const base = env.QUIZ_BASE_URL;
  const img = q.image ? new URL(q.image, base).href : null;
  const longQ = (n + q.q).length > 290;
  const longOpt = q.options.some((o) => o.length > 100);
  const letters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

  let pollQuestion = n + q.q;
  let pollOptions = q.options;
  let headText = null;

  if (longQ || longOpt) {
    headText = `<b>${esc(n + q.q)}</b>`;
    if (longOpt) {
      headText += "\n\n" + q.options.map((o, i) => `${letters[i]}) ${esc(o)}`).join("\n");
      pollOptions = q.options.map((_, i) => letters[i]);
    }
    pollQuestion = longQ ? n + "Savolni yuqorida o'qing 👆" : n + q.q;
  }

  if (img) {
    const cap = headText && headText.length <= 1000 ? headText : undefined;
    await tg(env, "sendPhoto", { chat_id: s.chat_id, photo: img, caption: cap, parse_mode: "HTML" });
    if (headText && !cap) await send(env, s.chat_id, headText);
  } else if (headText) {
    await send(env, s.chat_id, headText);
  }

  const body = {
    chat_id: s.chat_id,
    question: pollQuestion.slice(0, 300),
    options: pollOptions.map((t) => ({ text: String(t).slice(0, 100) })),
    type: "quiz",
    is_anonymous: false,
    correct_option_id: q.answer,
    open_period: s.time,
  };
  if (q.explanation) body.explanation = String(q.explanation).slice(0, 200);
  const r = await tg(env, "sendPoll", body);
  if (r.ok) {
    if (env.TIMER) {
      try {
        await env.TIMER.send({ chat_id: s.chat_id, session_id: s.session_id, idx }, { delaySeconds: s.time + 1 });
      } catch (e) { console.log("Navbat xato:", e.stack || e); }
    }
    await env.DB.prepare(
      "INSERT OR REPLACE INTO polls (poll_id, chat_id, session_id, idx, correct) VALUES (?,?,?,?,?)"
    ).bind(r.result.poll.id, s.chat_id, s.session_id, idx, q.answer).run();
  }
  await env.DB.prepare("UPDATE sessions SET last_sent=? WHERE chat_id=? AND session_id=?")
    .bind(Date.now(), s.chat_id, s.session_id).run();
}

// ---------- Keyingi savolga o'tish (faqat bir marta ishlaydi) ----------
async function advance(env, chat_id, session_id, fromIdx, pause = 2000) {
  const u = await env.DB.prepare(
    "UPDATE sessions SET idx=idx+1, last_sent=? WHERE chat_id=? AND session_id=? AND idx=? AND running=1"
  ).bind(Date.now(), chat_id, session_id, fromIdx).run();
  if (!u.meta || u.meta.changes !== 1) return; // allaqachon o'tilgan
  const s = await env.DB.prepare("SELECT * FROM sessions WHERE chat_id=?").bind(chat_id).first();
  if (!s) return;
  if (s.idx >= s.total) return finish(env, s);
  if (pause) await new Promise((r) => setTimeout(r, pause)); // tanaffus
  await sendQuestion(env, s, s.idx);
}

// ---------- Yakuniy natija ----------
async function finish(env, s) {
  await env.DB.prepare("UPDATE sessions SET running=0 WHERE chat_id=? AND session_id=?")
    .bind(s.chat_id, s.session_id).run();
  const { results } = await env.DB.prepare(
    "SELECT name, correct, answered FROM scores WHERE chat_id=? AND session_id=? ORDER BY correct DESC, answered ASC LIMIT 40"
  ).bind(s.chat_id, s.session_id).all();
  if (s.chat_id > 0) {
    const r = results[0] || { correct: 0 };
    const pct = Math.round((r.correct / s.total) * 100);
    const baho = pct >= 86 ? "🏆 A'lo!" : pct >= 71 ? "👍 Yaxshi!" : pct >= 56 ? "🙂 Qoniqarli" : "📖 Mavzuni yana takrorlang";
    return send(env, s.chat_id,
      `🏁 <b>«${esc(s.title)}» yakunlandi!</b>\n\n✅ To'g'ri javoblar: <b>${r.correct} / ${s.total}</b>\n📊 Natija: <b>${pct}%</b> — ${baho}`,
      { reply_markup: { inline_keyboard: [
        [{ text: "🔁 Qayta ishlash", callback_data: `q:${s.quiz_id}` }],
        [{ text: "📚 Boshqa test tanlash", callback_data: "m" }],
      ] } });
  }
  const medals = ["🥇", "🥈", "🥉"];
  let t = `🏁 <b>«${esc(s.title)}» viktorinasi yakunlandi!</b>\n\n`;
  t += `Savollar: ${s.total} ta · Qatnashchilar: ${results.length} nafar\n\n`;
  if (!results.length) t += "Hech kim javob bermadi 🙂";
  results.forEach((r, i) => {
    t += `${medals[i] || i + 1 + "."} ${esc(r.name)} — <b>${r.correct}</b> ta to'g'ri\n`;
  });
  t += "\n🏆 G'oliblarni tabriklaymiz!";
  await send(env, s.chat_id, t);
}


// ---------- Testni boshlash ----------
async function startQuiz(env, chat_id, arg) {
  const cur = await env.DB.prepare("SELECT running FROM sessions WHERE chat_id=?").bind(chat_id).first();
  if (cur && cur.running) return "⏳ Viktorina davom etyapti. Avval /stop bosing.";
  let data;
  try {
    const r = await fetch(new URL(arg + ".json", env.QUIZ_BASE_URL).href + "?v=" + Date.now());
    if (!r.ok) throw new Error("topilmadi");
    data = await r.json();
  } catch (e) {
    return `❌ «${esc(arg)}» testi topilmadi yoki fayl xato.`;
  }
  const qs = (data.questions || []).filter((q) => q.q && Array.isArray(q.options) && q.options.length >= 2);
  if (!qs.length) return "❌ Testda savol yo'q.";
  const time = Math.max(5, Math.min(600, parseInt(data.time) || 30));
  const title = data.title || arg;
  const session_id = String(Date.now());
  await env.DB.prepare(
    "INSERT OR REPLACE INTO sessions (chat_id, session_id, quiz_id, title, idx, total, time, running, last_sent, questions) VALUES (?,?,?,?,0,?,?,1,?,?)"
  ).bind(chat_id, session_id, arg, title, qs.length, time, Date.now(), JSON.stringify(qs)).run();
  await send(env, chat_id,
    `📝 <b>${esc(title)}</b>\n\n❓ ${qs.length} ta savol\n⏱ Har bir savolga ${time} soniya\n\nOmad! Birinchi savol hozir chiqadi 👇`);
  const s = await env.DB.prepare("SELECT * FROM sessions WHERE chat_id=?").bind(chat_id).first();
  await new Promise((r) => setTimeout(r, 2000));
  await sendQuestion(env, s, 0);
  return null;
}

// ---------- Avtomatik viktorina ----------
async function ensureAuto(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS auto (chat_id INTEGER PRIMARY KEY, interval_min INTEGER, list TEXT, pos INTEGER, next_at INTEGER)"
  ).run();
}

// "6-1..6-44" -> 6-1, 6-2, ... 6-44 ; "7-uz-3" -> o'zi
function expandList(parts) {
  const out = [];
  for (const p of parts) {
    const m = p.match(/^([\w-]*?)(\d+)\.\.([\w-]*?)(\d+)$/);
    if (m && m[1] === m[3]) {
      const a = +m[2], b = +m[4];
      if (Math.abs(b - a) > 300) continue;
      const step = a <= b ? 1 : -1;
      for (let i = a; i !== b + step; i += step) out.push(m[1] + i);
    } else if (/^[\w-]+$/.test(p)) out.push(p);
  }
  return out;
}

async function autoTick(env) {
  await ensureAuto(env);
  const now = Date.now();
  const { results } = await env.DB.prepare("SELECT * FROM auto WHERE next_at<=?").bind(now).all();
  for (const a of results) {
    const busy = await env.DB.prepare("SELECT running FROM sessions WHERE chat_id=?").bind(a.chat_id).first();
    if (busy && busy.running) continue; // oldingi test tugashini kutamiz
    const list = JSON.parse(a.list);
    const name = list[a.pos % list.length];
    // avval vaqtni suramiz — ikki marta boshlanib ketmasligi uchun
    const u = await env.DB.prepare("UPDATE auto SET pos=pos+1, next_at=? WHERE chat_id=? AND pos=?")
      .bind(now + a.interval_min * 60000, a.chat_id, a.pos).run();
    if (!u.meta || u.meta.changes !== 1) continue;
    const err = await startQuiz(env, a.chat_id, name);
    if (err) await send(env, a.chat_id, err + "\n(keyingisiga o'tamiz)");
  }
}


// ---------- Mavzulashtirilgan menyu ----------
let CAT = null, CAT_AT = 0, BOTU = null;
async function catalog(env) {
  if (CAT && Date.now() - CAT_AT < 600000) return CAT;
  const r = await fetch(new URL("catalog.json", env.QUIZ_BASE_URL).href + "?v=" + Date.now());
  CAT = await r.json(); CAT_AT = Date.now();
  return CAT;
}
async function botUser(env) {
  if (BOTU) return BOTU;
  const r = await tg(env, "getMe", {});
  BOTU = r.result && r.result.username;
  return BOTU;
}
const MAIN_TEXT = "📚 <b>ISAKOV SCHOOL — testlar</b>\n\nBo'limni tanlang, so'ng mavzuni bosing — test shu yerda boshlanadi 👇";

async function showMain(env, chat_id, message_id) {
  const cat = await catalog(env);
  const kb = [];
  cat.sections.forEach((sec, i) => {
    const b = { text: `${sec.icon} ${sec.title}`, callback_data: `s:${sec.id}:0` };
    if (i % 2 === 0) kb.push([b]); else kb[kb.length - 1].push(b);
  });
  const body = { chat_id, text: MAIN_TEXT, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } };
  if (message_id) return tg(env, "editMessageText", { ...body, message_id });
  return tg(env, "sendMessage", body);
}

async function showSection(env, chat_id, message_id, id, page) {
  const cat = await catalog(env);
  const sec = cat.sections.find((x) => x.id === id);
  if (!sec) return showMain(env, chat_id, message_id);
  const per = 15, pages = Math.max(1, Math.ceil(sec.tests.length / per));
  page = Math.min(Math.max(0, page), pages - 1);
  const kb = sec.tests.slice(page * per, page * per + per).map((t) => {
    let label = `${t.t} (${t.c})`;
    if (label.length > 60) label = t.t.slice(0, 52) + "… (" + t.c + ")";
    return [{ text: label, callback_data: `q:${t.n}` }];
  });
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: "◀️ Oldingi", callback_data: `s:${id}:${page - 1}` });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: `s:${id}:${page}` });
    if (page < pages - 1) nav.push({ text: "Keyingi ▶️", callback_data: `s:${id}:${page + 1}` });
    kb.push(nav);
  }
  kb.push([{ text: "⬅️ Bo'limlar", callback_data: "m" }]);
  const body = {
    chat_id, parse_mode: "HTML", reply_markup: { inline_keyboard: kb },
    text: `${sec.icon} <b>${esc(sec.title)}</b>\n${sec.tests.length} ta test · mavzuni tanlang 👇`,
  };
  if (message_id) return tg(env, "editMessageText", { ...body, message_id });
  return tg(env, "sendMessage", body);
}

// Guruh uchun katalog: tugma bosilsa, bot shaxsiy chatda ochiladi va mavzular chiqadi
async function postGroupMenu(env, chat_id) {
  const cat = await catalog(env);
  const u = await botUser(env);
  const kb = [];
  cat.sections.forEach((sec, i) => {
    const b = { text: `${sec.icon} ${sec.title}`, url: `https://t.me/${u}?start=s_${sec.id}` };
    if (i % 2 === 0) kb.push([b]); else kb[kb.length - 1].push(b);
  });
  const total = cat.sections.reduce((a, x) => a + x.tests.length, 0);
  const r = await tg(env, "sendMessage", {
    chat_id, parse_mode: "HTML", reply_markup: { inline_keyboard: kb },
    text: `📚 <b>ISAKOV SCHOOL — TESTLAR KATALOGI</b>\n\n🗂 Jami: <b>${total} ta test</b>, mavzular bo'yicha\n\n` +
      `👇 Bo'limni bosing → bot ochiladi → mavzuni tanlang → test boshlanadi.\n` +
      `Javob bergach, keyingi savol 1 soniyada chiqadi. Oxirida natijangiz ko'rsatiladi.`,
  });
  if (r.ok) await tg(env, "pinChatMessage", { chat_id, message_id: r.result.message_id, disable_notification: true });
}

// Shaxsiy chatda oldingi testni jimgina yopib, yangisini boshlash
async function startPrivate(env, chat_id, name) {
  await env.DB.prepare("UPDATE sessions SET running=0 WHERE chat_id=? AND running=1").bind(chat_id).run();
  const err = await startQuiz(env, chat_id, name);
  if (err) await send(env, chat_id, err);
}

async function onCallback(env, cq) {
  const d = cq.data || "";
  const chat = cq.message && cq.message.chat;
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  if (!chat) return;
  const mid = cq.message.message_id;
  if (d === "m") return showMain(env, chat.id, mid);
  if (d.startsWith("s:")) { const [, id, pg] = d.split(":"); return showSection(env, chat.id, mid, id, +pg || 0); }
  if (d.startsWith("q:") && chat.type === "private") {
    const name = d.slice(2);
    if (/^[\w-]+$/.test(name)) return startPrivate(env, chat.id, name);
  }
}

// ---------- Adminmi? ----------
async function isAdmin(env, msg) {
  if (msg.chat.type === "private") return true;
  const r = await tg(env, "getChatMember", { chat_id: msg.chat.id, user_id: msg.from.id });
  return r.ok && ["creator", "administrator"].includes(r.result.status);
}

// ---------- Buyruqlar ----------
async function onMessage(env, msg) {
  const text = msg.text || "";
  if (!text.startsWith("/")) return;
  const [cmdRaw, arg] = text.trim().split(/\s+/, 2);
  const cmd = cmdRaw.split("@")[0].toLowerCase();
  const chat_id = msg.chat.id;

  if (cmd === "/start" && msg.chat.type === "private") {
    if (arg && arg.startsWith("s_")) return showSection(env, chat_id, null, arg.slice(2), 0);
    if (arg && arg !== "menu" && /^[\w-]+$/.test(arg)) return startPrivate(env, chat_id, arg);
    return showMain(env, chat_id, null);
  }

  if (cmd === "/menyu" || cmd === "/menu" || cmd === "/testlar") {
    if (msg.chat.type === "private") return showMain(env, chat_id, null);
    if (!(await isAdmin(env, msg))) return;
    return postGroupMenu(env, chat_id);
  }

  if (cmd === "/start" || cmd === "/help") {
    return send(env, chat_id,
      "👋 <b>Viktorina boti</b>\n\n" +
      "/quiz <i>nomi</i> — viktorinani boshlash (masalan: /quiz tarix1)\n" +
      "/stop — to'xtatish va natijani chiqarish\n" +
      "/natija — joriy natijalar\n" +
      "/avto — har N daqiqada avtomatik test\n" +
      "/menyu — mavzulashtirilgan testlar katalogi\n\n" +
      "Boshlash va to'xtatish faqat guruh adminlari uchun.");
  }

  if (cmd === "/quiz") {
    if (!(await isAdmin(env, msg))) return send(env, chat_id, "⛔ Viktorinani faqat admin boshlay oladi.");
    if (!arg || !/^[\w-]+$/.test(arg)) return send(env, chat_id, "Test nomini yozing: /quiz tarix1");
    if (msg.chat.type === "private") return startPrivate(env, chat_id, arg);
    const err = await startQuiz(env, chat_id, arg);
    if (err) return send(env, chat_id, err);
    return;
  }

  if (cmd === "/avto") {
    if (!(await isAdmin(env, msg))) return send(env, chat_id, "⛔ Faqat admin uchun.");
    await ensureAuto(env);
    const parts = text.trim().split(/\s+/).slice(1);
    if (!parts.length) {
      const a = await env.DB.prepare("SELECT * FROM auto WHERE chat_id=?").bind(chat_id).first();
      if (!a) return send(env, chat_id,
        "⏰ <b>Avtomatik viktorina o'chiq.</b>\n\nYoqish: <code>/avto 20 6-1..6-44</code>\n" +
        "(har 20 daqiqada keyingi test boshlanadi)\n\nBir nechta test: <code>/avto 20 6-1 6-5 7-uz-3</code>\nO'chirish: <code>/avto stop</code>");
      const list = JSON.parse(a.list);
      const left = Math.max(0, Math.round((a.next_at - Date.now()) / 60000));
      return send(env, chat_id,
        `⏰ <b>Avtomatik viktorina yoqiq</b>\nHar ${a.interval_min} daqiqada\nKeyingi test: <b>${esc(list[a.pos % list.length])}</b> (~${left} daqiqadan keyin)\nRo'yxatda: ${list.length} ta test\n\nO'chirish: /avto stop`);
    }
    if (parts[0].toLowerCase() === "stop") {
      await env.DB.prepare("DELETE FROM auto WHERE chat_id=?").bind(chat_id).run();
      return send(env, chat_id, "⏹ Avtomatik viktorina o'chirildi.");
    }
    const mins = parseInt(parts[0]);
    if (!(mins >= 5 && mins <= 1440) || parts.length < 2)
      return send(env, chat_id, "Namuna: <code>/avto 20 6-1..6-44</code> (oraliq 5–1440 daqiqa)");
    const list = expandList(parts.slice(1));
    if (!list.length) return send(env, chat_id, "❌ Test nomlari noto'g'ri yozilgan.");
    await env.DB.prepare(
      "INSERT OR REPLACE INTO auto (chat_id, interval_min, list, pos, next_at) VALUES (?,?,?,0,?)"
    ).bind(chat_id, mins, JSON.stringify(list), Date.now()).run();
    return send(env, chat_id,
      `✅ <b>Avtomatik viktorina yoqildi!</b>\n\nHar <b>${mins} daqiqada</b> yangi test boshlanadi.\nRo'yxatda: ${list.length} ta test (${esc(list[0])} → ${esc(list[list.length - 1])})\nBirinchisi 1 daqiqa ichida boshlanadi.\n\nHolat: /avto · O'chirish: /avto stop`);
  }

  if (cmd === "/stop") {
    if (!(await isAdmin(env, msg))) return;
    const s = await env.DB.prepare("SELECT * FROM sessions WHERE chat_id=? AND running=1").bind(chat_id).first();
    if (!s) return send(env, chat_id, "Hozir viktorina yo'q.");
    return finish(env, s);
  }

  if (cmd === "/natija") {
    const s = await env.DB.prepare("SELECT * FROM sessions WHERE chat_id=?").bind(chat_id).first();
    if (!s) return send(env, chat_id, "Hali viktorina o'tkazilmagan.");
    const { results } = await env.DB.prepare(
      "SELECT name, correct FROM scores WHERE chat_id=? AND session_id=? ORDER BY correct DESC LIMIT 10"
    ).bind(chat_id, s.session_id).all();
    let t = `📊 <b>${esc(s.title)}</b> — ${Math.min(s.idx + 1, s.total)}/${s.total}-savol\n\n`;
    results.forEach((r, i) => (t += `${i + 1}. ${esc(r.name)} — ${r.correct}\n`));
    return send(env, chat_id, results.length ? t : t + "Hali javob yo'q.");
  }
}

// ---------- Javob qabul qilish ----------
async function onPollAnswer(env, pa) {
  const p = await env.DB.prepare("SELECT * FROM polls WHERE poll_id=?").bind(pa.poll_id).first();
  if (!p || !pa.user || !pa.option_ids?.length) return;
  const ok = pa.option_ids[0] === p.correct ? 1 : 0;
  const u = pa.user;
  const name = (u.first_name || "") + (u.last_name ? " " + u.last_name : "") || u.username || "Ishtirokchi";
  await env.DB.prepare(
    `INSERT INTO scores (chat_id, session_id, user_id, name, correct, answered) VALUES (?,?,?,?,?,1)
     ON CONFLICT(chat_id, session_id, user_id) DO UPDATE SET correct=correct+excluded.correct, answered=answered+1, name=excluded.name`
  ).bind(p.chat_id, p.session_id, u.id, name, ok).run();

  // Shaxsiy chatda (o'quvchi botni o'zi ochganda): javob berdi — 1 soniyadan keyin keyingi savol
  if (p.chat_id > 0 && p.chat_id === u.id) {
    await new Promise((r) => setTimeout(r, 1000));
    await advance(env, p.chat_id, p.session_id, p.idx, 0);
  }
}

// ---------- Vaqt tugaganda ----------
async function onPoll(env, poll) {
  if (!poll.is_closed) return;
  const p = await env.DB.prepare("SELECT * FROM polls WHERE poll_id=?").bind(poll.id).first();
  if (p) await advance(env, p.chat_id, p.session_id, p.idx);
}

// ---------- Zaxira: har daqiqa tekshiradi, hech narsa qotib qolmaydi ----------
async function watchdog(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare("SELECT * FROM sessions WHERE running=1").all();
  for (const s of results) {
    if (now - s.last_sent > (s.time + 25) * 1000) await advance(env, s.chat_id, s.session_id, s.idx);
  }
  // 3 kundan eski so'rovnomalarni tozalash
  await env.DB.prepare("DELETE FROM polls WHERE CAST(session_id AS INTEGER) < ?").bind(now - 3 * 864e5).run();
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === "/setup") {
      if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) return new Response("Ruxsat yo'q", { status: 403 });
      const w = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "poll", "poll_answer", "callback_query"],
        drop_pending_updates: true,
      });
      await tg(env, "setMyCommands", {
        commands: [
          { command: "menyu", description: "📚 Testlar katalogi (mavzular bo'yicha)" },
          { command: "quiz", description: "Viktorinani boshlash: /quiz nomi" },
          { command: "stop", description: "To'xtatish va natija" },
          { command: "natija", description: "Joriy natijalar" },
          { command: "avto", description: "Avtomatik viktorina: /avto 20 6-1..6-44" },
          { command: "help", description: "Yordam" },
        ],
      });
      return new Response(w.ok ? "✅ Bot ulandi! Endi Telegramga qayting." : "❌ Xato: " + JSON.stringify(w),
        { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (url.pathname === "/tekshir") {
      if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) return new Response("Ruxsat yo'q", { status: 403 });
      const out = [];
      try {
        await ensureAuto(env);
        const { results } = await env.DB.prepare("SELECT chat_id, session_id, idx, total, time, running, last_sent FROM sessions").all();
        out.push("Hozir: " + Date.now());
        out.push("Taymer ulanganmi: " + (env.TIMER ? "HA ✅" : "YO'Q ❌"));
        out.push("Sessiyalar: " + JSON.stringify(results));
        const au = await env.DB.prepare("SELECT chat_id, interval_min, pos, next_at FROM auto").all();
        out.push("Avtomatik: " + JSON.stringify(au.results));
        const wh = await tg(env, "getWebhookInfo", {});
        out.push("Webhook: " + JSON.stringify(wh.result));
      } catch (e) {
        out.push("XATO: " + (e.stack || e));
      }
      return new Response(out.join("\n\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (url.pathname === "/webhook" && req.method === "POST") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET)
        return new Response("no", { status: 403 });
      const upd = await req.json();
      const job = (async () => {
        try {
          if (upd.message) await onMessage(env, upd.message);
          else if (upd.poll_answer) await onPollAnswer(env, upd.poll_answer);
          else if (upd.poll) await onPoll(env, upd.poll);
          else if (upd.callback_query) await onCallback(env, upd.callback_query);
        } catch (e) { console.log("Xato:", e.stack || e); }
      })();
      ctx.waitUntil(job);
      return new Response("ok");
    }

    return new Response("Viktorina boti ishlayapti ✅", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },

  // Taymer: savol vaqti tugaganda navbat shu yerni chaqiradi
  async queue(batch, env, ctx) {
    for (const m of batch.messages) {
      try {
        const b = m.body;
        await advance(env, b.chat_id, b.session_id, b.idx);
      } catch (e) { console.log("Taymer xato:", e.stack || e); }
      m.ack();
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(watchdog(env).catch((e) => console.log(e)));
    ctx.waitUntil(autoTick(env).catch((e) => console.log("Avto xato:", e.stack || e)));
  },
};
