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
    await addResult(env, s.chat_id, r.correct, s.total);
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

async function showMain(env, chat_id, message_id, user) {
  if (user && !(await gate(env, user, chat_id, "*", "m"))) return;
  const cat = await catalog(env);
  const cnt = (g) => g.secs.reduce((a, id) => a + ((cat.sections.find((x) => x.id === id) || { tests: [] }).tests.length), 0);
  const kb = (cat.groups || []).map((g) => [{ text: `${g.icon} ${g.title} (${cnt(g)})`, callback_data: `g:${g.id}` }]);
  const body = { chat_id, text: MAIN_TEXT, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } };
  if (message_id) return tg(env, "editMessageText", { ...body, message_id });
  return tg(env, "sendMessage", body);
}

async function showGroup(env, chat_id, message_id, gid, user) {
  if (user && !(await gate(env, user, chat_id, "*", `g:${gid}`))) return;
  const cat = await catalog(env);
  const g = (cat.groups || []).find((x) => x.id === gid);
  if (!g) return showMain(env, chat_id, message_id, user);
  const kb = g.secs.map((id) => cat.sections.find((x) => x.id === id)).filter(Boolean)
    .map((sec) => [{ text: `${sec.icon} ${sec.title} (${sec.tests.length})`, callback_data: `s:${sec.id}:0` }]);
  kb.push([{ text: "⬅️ Bosh menyu", callback_data: "m" }]);
  const body = { chat_id, parse_mode: "HTML", reply_markup: { inline_keyboard: kb },
    text: `${g.icon} <b>${esc(g.title)}</b>\n\nBo'limni tanlang 👇` };
  if (message_id) return tg(env, "editMessageText", { ...body, message_id });
  return tg(env, "sendMessage", body);
}

async function showSection(env, chat_id, message_id, id, page, user) {
  if (user && !(await gate(env, user, chat_id, id, `s:${id}:${page}`))) return;
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
  const grp = (cat.groups || []).find((x) => x.secs.includes(id));
  kb.push([{ text: "⬅️ Orqaga", callback_data: grp ? `g:${grp.id}` : "m" }]);
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
  const cnt = (g) => g.secs.reduce((a, id) => a + ((cat.sections.find((x) => x.id === id) || { tests: [] }).tests.length), 0);
  const kb = (cat.groups || []).map((g) => [{ text: `${g.icon} ${g.title} (${cnt(g)})`, url: `https://t.me/${u}?start=g_${g.id}` }]);
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
async function startPrivate(env, chat_id, name, user) {
  if (user && !(await gate(env, user, chat_id, (await sectionOf(env, name)) || "*", `q:${name}`))) return;
  if (user && !(await needSubs(env, user, chat_id, name))) return;
  await env.DB.prepare("UPDATE sessions SET running=0 WHERE chat_id=? AND running=1").bind(chat_id).run();
  const err = await startQuiz(env, chat_id, name);
  if (err) await send(env, chat_id, err);
}

async function onCallback(env, cq) {
  const d = cq.data || "";
  const chat = cq.message && cq.message.chat;
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  if (!chat) return;
  if (chat.type === "private") await touchUser(env, cq.from);
  const mid = cq.message.message_id;
  const user = chat.type === "private" ? cq.from : null;
  if (d === "m") return showMain(env, chat.id, mid, user);
  if (d.startsWith("g:")) return showGroup(env, chat.id, mid, d.slice(2), user);
  if (d.startsWith("s:")) { const [, id, pg] = d.split(":"); return showSection(env, chat.id, mid, id, +pg || 0, user); }
  if (d.startsWith("q:") && chat.type === "private") {
    const name = d.slice(2);
    if (/^[\w-]+$/.test(name)) return startPrivate(env, chat.id, name, cq.from);
  }
}


// ---------- Parol bilan himoya ----------
const OWNER = (env) => String(env.ADMIN_ID || "6806557484");
async function ensureLock(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS access (user_id INTEGER PRIMARY KEY, ver INTEGER, name TEXT, at INTEGER)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS pending (user_id INTEGER PRIMARY KEY, target TEXT, tries INTEGER, until INTEGER)").run();
}
async function getLock(env) {
  await ensureLock(env);
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='lock'").first();
  return r ? JSON.parse(r.v) : null; // {pw, ver, secs:[]}
}
async function sectionOf(env, name) {
  const cat = await catalog(env);
  const sec = cat.sections.find((x) => x.tests.some((t) => t.n === name));
  return sec ? sec.id : null;
}
// true qaytarsa — davom etish mumkin; false — parol so'raldi
async function gate(env, user, chat_id, secId, target) {
  if (String(user.id) === OWNER(env)) return true;
  const L = await getLock(env);
  if (!L || !L.pw) return true;
  if (L.secs && L.secs.length && secId !== "*" && !L.secs.includes(secId)) return true;
  if (secId === "*" && L.secs && L.secs.length) return true; // faqat ayrim bo'limlar yopiq — menyu ochiq
  const a = await env.DB.prepare("SELECT ver FROM access WHERE user_id=?").bind(user.id).first();
  if (a && a.ver === L.ver) return true;
  await env.DB.prepare(
    "INSERT INTO pending (user_id, target, tries, until) VALUES (?,?,0,0) ON CONFLICT(user_id) DO UPDATE SET target=excluded.target"
  ).bind(user.id, target).run();
  await send(env, chat_id, "🔒 <b>Bu bo'lim parol bilan himoyalangan.</b>\n\nParolni shu yerga yozib yuboring 👇\n\n<i>Parolni olish uchun: @ustoztarix1</i>");
  return false;
}
async function tryPassword(env, msg) {
  const L = await getLock(env);
  const pd = await env.DB.prepare("SELECT * FROM pending WHERE user_id=?").bind(msg.from.id).first();
  if (!L || !L.pw || !pd) return false;
  const now = Date.now();
  if (pd.until > now) {
    await send(env, msg.chat.id, `⏳ Juda ko'p noto'g'ri urinish. ${Math.ceil((pd.until - now) / 60000)} daqiqadan keyin qayta urinib ko'ring.`);
    return true;
  }
  if (msg.text.trim().toLowerCase() === String(L.pw).toLowerCase()) {
    const u = msg.from;
    const name = ((u.first_name || "") + (u.last_name ? " " + u.last_name : "")).trim() || u.username || "";
    await env.DB.prepare(
      "INSERT INTO access (user_id, ver, name, at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET ver=excluded.ver, name=excluded.name, at=excluded.at"
    ).bind(u.id, L.ver, name, now).run();
    await env.DB.prepare("DELETE FROM pending WHERE user_id=?").bind(u.id).run();
    await send(env, msg.chat.id, "✅ <b>Parol to'g'ri!</b> Xush kelibsiz 🎉");
    const t = pd.target || "m";
    if (t.startsWith("q:")) { await startPrivate(env, msg.chat.id, t.slice(2), u); return true; }
    if (t.startsWith("s:")) { const [, id, pg] = t.split(":"); await showSection(env, msg.chat.id, null, id, +pg || 0, u); return true; }
    if (t.startsWith("g:")) { await showGroup(env, msg.chat.id, null, t.slice(2), u); return true; }
    await showMain(env, msg.chat.id, null, u);
    return true;
  }
  const tries = pd.tries + 1;
  const until = tries >= 5 ? now + 10 * 60000 : 0;
  await env.DB.prepare("UPDATE pending SET tries=?, until=? WHERE user_id=?").bind(until ? 0 : tries, until, msg.from.id).run();
  await send(env, msg.chat.id, until ? "⛔ 5 marta noto'g'ri. 10 daqiqadan keyin qayta urinib ko'ring." : `❌ Parol noto'g'ri (${tries}/5). Qayta yozing.`);
  return true;
}
async function parolCmd(env, msg, text) {
  if (String(msg.from.id) !== OWNER(env)) return;
  const parts = text.trim().split(/\s+/).slice(1);
  let L = (await getLock(env)) || { pw: "", ver: 0, secs: [] };
  if (!parts.length) {
    const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM access WHERE ver=?").bind(L.ver).first();
    return send(env, msg.chat.id, L.pw
      ? `🔒 <b>Parol yoqiq</b>\nParol: <code>${esc(L.pw)}</code>\nYopiq bo'limlar: ${L.secs.length ? esc(L.secs.join(", ")) : "hammasi"}\nKirgan o'quvchilar: ${c ? c.n : 0} nafar\n\nO'zgartirish: <code>/parol yangi_soz</code>\nFaqat ayrim bo'limlar: <code>/parol soz att hd</code>\nO'chirish: <code>/parol off</code>`
      : "🔓 Parol o'chiq — testlar hamma uchun ochiq.\n\nYoqish: <code>/parol soz</code>\nFaqat ayrim bo'limlar: <code>/parol soz att attru hd</code>\n\nBo'lim kodlari: t6 t7u t7j t8u t8j t9u t9j att attru hd h8 h9 h10 h11");
  }
  if (parts[0].toLowerCase() === "off") {
    L.pw = ""; await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('lock', ?)").bind(JSON.stringify(L)).run();
    return send(env, msg.chat.id, "🔓 Parol o'chirildi. Testlar hamma uchun ochiq.");
  }
  L = { pw: parts[0], ver: (L.ver || 0) + 1, secs: parts.slice(1) };
  await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('lock', ?)").bind(JSON.stringify(L)).run();
  return send(env, msg.chat.id,
    `🔒 <b>Parol o'rnatildi:</b> <code>${esc(L.pw)}</code>\nYopiq: ${L.secs.length ? esc(L.secs.join(", ")) : "barcha testlar"}\n\nO'quvchilar endi shu parolni kiritib kiradi. Parolni almashtirsangiz, hamma yangisini qayta kiritadi.`);
}


// ---------- Majburiy obuna ----------
const HUQUQ_CH = { id: "@huquqmezoni", name: "Huquq mezoni", link: "https://t.me/+JHqVNFFPSwE1Mjdi" };
const SUBS_DEFAULT = { on: true, tarix: ["@yoldashaliisakov", HUQUQ_CH], huquq: ["@yoldashaliisakov", HUQUQ_CH] };
// Kanal: "@nom" yoki {id: "@nom" | "-100…", name, link}
const chObj = (c) => typeof c === "string" ? { id: c, name: c, link: `https://t.me/${c.replace(/^@/, "")}` } : c;
function parseChannels(tokens) {
  const out = [];
  for (const t of tokens) {
    if (/^@\w{4,}$/.test(t) || /^-100\d{5,}$/.test(t)) out.push({ id: t, name: t.startsWith("@") ? t : "Kanal", link: t.startsWith("@") ? `https://t.me/${t.slice(1)}` : "" });
    else if (/^https:\/\/t\.me\//.test(t) && out.length) out[out.length - 1].link = t;
  }
  return out.filter((c) => c.link);
}
async function getSubs(env) {
  await ensureLock(env);
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='subs'").first();
  return r ? JSON.parse(r.v) : SUBS_DEFAULT;
}
// Huquq bo'limlari (hd, h8..h11) → huquq kanali, qolganlari → tarix kanali
async function needSubs(env, user, chat_id, name) {
  if (String(user.id) === OWNER(env)) return true;
  const S = await getSubs(env);
  if (!S.on) return true;
  const sec = (await sectionOf(env, name)) || "";
  const list = /^h(d|\d+)$/.test(sec) ? S.huquq : S.tarix;
  const missing = [];
  for (const c of list || []) {
    const ch = chObj(c);
    const r = await tg(env, "getChatMember", { chat_id: ch.id, user_id: user.id });
    if (!r.ok) { console.log("Obuna tekshirib bo'lmadi (bot kanalda admin emasmi?)", ch.id, JSON.stringify(r)); continue; }
    const st = r.result.status;
    const ok = ["creator", "administrator", "member"].includes(st) || (st === "restricted" && r.result.is_member);
    if (!ok) missing.push(ch);
  }
  if (!missing.length) return true;
  const kb = missing.map((ch) => [{ text: `📢 ${ch.name} — obuna bo'lish`, url: ch.link }]);
  kb.push([{ text: "✅ Obuna bo'ldim — testni boshlash", callback_data: `q:${name}` }]);
  await send(env, chat_id,
    `📢 <b>Testni boshlash uchun kanalimizga obuna bo'ling!</b>\n\nKanalda yangi testlar, foydali materiallar va e'lonlar chiqib boradi.\n\nObuna bo'lgach, pastdagi <b>"✅ Obuna bo'ldim"</b> tugmasini bosing 👇`,
    { reply_markup: { inline_keyboard: kb } });
  return false;
}
async function obunaCmd(env, msg, text) {
  if (String(msg.from.id) !== OWNER(env)) return;
  const parts = text.trim().split(/\s+/).slice(1);
  const S = await getSubs(env);
  const save = () => env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('subs', ?)").bind(JSON.stringify(S)).run();
  const info = () => `📢 <b>Majburiy obuna: ${S.on ? "YOQIQ ✅" : "O'CHIQ"}</b>\nTarix testlari: ${esc((S.tarix || []).map((c) => chObj(c).name + " (" + chObj(c).id + ")").join(", ") || "—")}\nHuquq testlari: ${esc((S.huquq || []).map((c) => chObj(c).name + " (" + chObj(c).id + ")").join(", ") || "—")}\n\n<code>/obuna off</code> · <code>/obuna on</code>\n<code>/obuna tarix @kanal1 @kanal2</code>\n<code>/obuna huquq @kanal https://t.me/+taklif</code>\n\nYopiq kanal ID sini bilish uchun: kanaldan biror postni botga <b>forward</b> qiling.\n⚠️ Bot har bir kanalda admin bo'lishi shart.`;
  if (!parts.length) return send(env, msg.chat.id, info());
  const k = parts[0].toLowerCase();
  if (k === "off" || k === "on") S.on = k === "on";
  else if (k === "tarix" || k === "huquq" || k === "hammasi") {
    const chs = parseChannels(parts.slice(1));
    if (!chs.length) return send(env, msg.chat.id, "❌ Kanal topilmadi. Namuna: <code>/obuna huquq @kanal https://t.me/+taklif</code>");
    for (const c of chs) {
      const g = await tg(env, "getChat", { chat_id: c.id });
      if (g.ok && g.result.title) c.name = g.result.title;
    }
    if (k === "hammasi") { S.tarix = chs; S.huquq = chs; } else S[k] = chs;
  }
  else return send(env, msg.chat.id, info());
  await save();
  return send(env, msg.chat.id, "✅ Saqlandi.\n\n" + info());
}


// ---------- A'zolar va admin panel ----------
const TZ = 5 * 3600000; // Toshkent
const fmtT = (ts) => ts ? new Date(ts + TZ).toISOString().slice(0, 16).replace("T", " ") : "—";
const dayStart = () => { const n = Date.now() + TZ; return n - (n % 86400000) - TZ; };
async function ensureUsers(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS users (user_id INTEGER PRIMARY KEY, name TEXT, username TEXT, first_seen INTEGER, last_seen INTEGER, tests INTEGER DEFAULT 0, correct INTEGER DEFAULT 0, total INTEGER DEFAULT 0, blocked INTEGER DEFAULT 0)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS bc (id INTEGER PRIMARY KEY, batches INTEGER, done INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, blocked INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, started INTEGER)").run();
  // Bir martalik: avval botdan foydalanganlarni ro'yxatga qo'shish
  await ensureLock(env);
  const bf = await env.DB.prepare("SELECT v FROM settings WHERE k='users_bf'").first();
  if (!bf) {
    await env.DB.prepare(`INSERT OR IGNORE INTO users (user_id, name, username, first_seen, last_seen)
      SELECT user_id, MAX(name), '', MIN(CAST(session_id AS INTEGER)), MAX(CAST(session_id AS INTEGER)) FROM scores WHERE chat_id>0 GROUP BY user_id`).run();
    await env.DB.prepare(`INSERT OR IGNORE INTO users (user_id, name, username, first_seen, last_seen) SELECT user_id, name, '', at, at FROM access`).run();
    await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('users_bf', '1')").run();
  }
}
let USERS_OK = false;
async function touchUser(env, u) {
  if (!u || u.is_bot) return;
  if (!USERS_OK) { await ensureUsers(env); USERS_OK = true; }
  const name = ((u.first_name || "") + (u.last_name ? " " + u.last_name : "")).trim();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (user_id, name, username, first_seen, last_seen, blocked) VALUES (?,?,?,?,?,0)
     ON CONFLICT(user_id) DO UPDATE SET name=excluded.name, username=excluded.username, last_seen=excluded.last_seen, blocked=0`
  ).bind(u.id, name, u.username || "", now, now).run();
}
async function addResult(env, uid, correct, total) {
  await ensureUsers(env);
  await env.DB.prepare("UPDATE users SET tests=tests+1, correct=correct+?, total=total+? WHERE user_id=?").bind(correct, total, uid).run();
}
const isOwner = (env, msg) => msg.from && String(msg.from.id) === OWNER(env);

async function azolarCmd(env, chat) {
  await ensureUsers(env);
  const d0 = dayStart(), w7 = Date.now() - 7 * 86400000;
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).first();
  const all = await q("SELECT COUNT(*) n FROM users");
  const newD = await q("SELECT COUNT(*) n FROM users WHERE first_seen>=?", d0);
  const new7 = await q("SELECT COUNT(*) n FROM users WHERE first_seen>=?", w7);
  const actD = await q("SELECT COUNT(*) n FROM users WHERE last_seen>=?", d0);
  const act7 = await q("SELECT COUNT(*) n FROM users WHERE last_seen>=?", w7);
  const blk = await q("SELECT COUNT(*) n FROM users WHERE blocked=1");
  const tst = await q("SELECT COALESCE(SUM(tests),0) n FROM users");
  return send(env, chat,
    `👥 <b>Bot a'zolari</b>\n\nJami: <b>${all.n}</b>\n🆕 Bugun qo'shilgan: <b>${newD.n}</b>\n🆕 Oxirgi 7 kunda: <b>${new7.n}</b>\n\n` +
    `🔥 Bugun faol: <b>${actD.n}</b>\n🔥 7 kunda faol: <b>${act7.n}</b>\n⛔ Botni bloklagan: <b>${blk.n}</b>\n\n📝 Jami ishlangan testlar: <b>${tst.n}</b>`);
}
async function faollarCmd(env, chat) {
  await ensureUsers(env);
  const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY last_seen DESC LIMIT 30").all();
  if (!results.length) return send(env, chat, "Hali a'zolar yo'q.");
  const t = results.map((u, i) => `${i + 1}. ${esc(u.name || "—")}${u.username ? " @" + esc(u.username) : ""} — ${fmtT(u.last_seen)} · ${u.tests} test${u.blocked ? " ⛔" : ""}`).join("\n");
  return send(env, chat, `🕒 <b>Oxirgi faol 30 a'zo</b>\n\n${t}\n\nTo'liq ro'yxat: /excel`);
}
async function reytingCmd(env, chat) {
  await ensureUsers(env);
  const { results } = await env.DB.prepare("SELECT * FROM users WHERE total>0 ORDER BY correct DESC, total ASC LIMIT 20").all();
  if (!results.length) return send(env, chat, "Hali natijalar yo'q.");
  const md = ["🥇", "🥈", "🥉"];
  const t = results.map((u, i) => `${md[i] || i + 1 + "."} ${esc(u.name || "—")}${u.username ? " @" + esc(u.username) : ""} — <b>${u.correct}</b> to'g'ri (${u.tests} test, ${Math.round((u.correct / u.total) * 100)}%)`).join("\n");
  return send(env, chat, `🏆 <b>TOP-20 o'quvchi</b>\n\n${t}`);
}
async function excelCmd(env, chat) {
  await ensureUsers(env);
  const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY first_seen").all();
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["№", "Ism", "Username", "Telegram ID", "Birinchi kirgan", "Oxirgi faollik", "Testlar soni", "To'g'ri javoblar", "Jami savollar", "O'rtacha natija %", "Holat"]];
  results.forEach((u, i) => rows.push([i + 1, u.name, u.username ? "@" + u.username : "", u.user_id, fmtT(u.first_seen), fmtT(u.last_seen), u.tests, u.correct, u.total, u.total ? Math.round((u.correct / u.total) * 100) : "", u.blocked ? "bloklagan" : "faol"]));
  const csv = "﻿" + rows.map((r) => r.map(cell).join(";")).join("\r\n");
  const fd = new FormData();
  fd.append("chat_id", String(chat));
  fd.append("caption", `📊 Bot a'zolari: ${results.length} nafar (${fmtT(Date.now())})`);
  fd.append("document", new Blob([csv], { type: "text/csv" }), `azolar-${fmtT(Date.now()).slice(0, 10)}.csv`);
  const r = await fetch(API(env, "sendDocument"), { method: "POST", body: fd });
  if (!r.ok) console.log("excel xato", await r.text());
}

// /xabar: keyingi xabar hammaga
async function xabarCmd(env, chat) {
  await ensureLock(env);
  await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('bc_wait', '1')").run();
  return send(env, chat, "📢 <b>Hammaga yuboriladigan xabarni yuboring</b> (matn, rasm, video, fayl yoki kanaldan forward).\n\nBekor qilish: /bekor");
}
async function startBroadcast(env, msg) {
  await ensureUsers(env);
  await env.DB.prepare("DELETE FROM settings WHERE k='bc_wait'").run();
  const { results } = await env.DB.prepare("SELECT user_id FROM users WHERE blocked=0").all();
  const ids = results.map((r) => r.user_id).filter((id) => String(id) !== OWNER(env));
  if (!ids.length) return send(env, msg.chat.id, "A'zolar hali yo'q.");
  const per = 15, batches = Math.ceil(ids.length / per), id = Date.now();
  await env.DB.prepare("INSERT INTO bc (id, batches, started) VALUES (?,?,?)").bind(id, batches, id).run();
  await send(env, msg.chat.id, `⏳ Xabar <b>${ids.length}</b> nafar a'zoga yuborilmoqda (taxminan ${Math.max(1, Math.ceil(batches * 6 / 60))} daqiqa). Tugagach hisobot keladi.`);
  for (let i = 0; i < batches; i++) {
    const body = { t: "bc", bc: id, from: msg.chat.id, mid: msg.message_id, ids: ids.slice(i * per, i * per + per) };
    if (env.TIMER) await env.TIMER.send(body, { delaySeconds: Math.min(i * 6, 43200) });
    else await runBroadcastBatch(env, body);
  }
}
async function runBroadcastBatch(env, b) {
  let sent = 0, blocked = 0, failed = 0;
  for (const uid of b.ids) {
    const r = await tg(env, "copyMessage", { chat_id: uid, from_chat_id: b.from, message_id: b.mid });
    if (r.ok) sent++;
    else if (r.error_code === 403) { blocked++; await env.DB.prepare("UPDATE users SET blocked=1 WHERE user_id=?").bind(uid).run(); }
    else failed++;
    await new Promise((x) => setTimeout(x, 40));
  }
  await env.DB.prepare("UPDATE bc SET done=done+1, sent=sent+?, blocked=blocked+?, failed=failed+? WHERE id=?").bind(sent, blocked, failed, b.bc).run();
  const r = await env.DB.prepare("SELECT * FROM bc WHERE id=?").bind(b.bc).first();
  if (r && r.done === r.batches) {
    await send(env, b.from,
      `✅ <b>Xabar yuborildi!</b>\n\n📬 Yetib bordi: <b>${r.sent}</b>\n⛔ Botni bloklagan: <b>${r.blocked}</b>\n⚠️ Boshqa xato: <b>${r.failed}</b>\n⏱ ${Math.max(1, Math.round((Date.now() - r.started) / 1000))} soniya`);
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
  if (msg.chat.type === "private" && msg.from) await touchUser(env, msg.from);
  if (msg.chat.type === "private" && isOwner(env, msg)) {
    const t0 = (msg.text || "").trim().split(/\s+/)[0].split("@")[0].toLowerCase();
    if (t0 === "/bekor") { await ensureLock(env); await env.DB.prepare("DELETE FROM settings WHERE k='bc_wait'").run(); return send(env, msg.chat.id, "❌ Bekor qilindi."); }
    if (!t0.startsWith("/")) {
      await ensureLock(env);
      const w = await env.DB.prepare("SELECT v FROM settings WHERE k='bc_wait'").first();
      if (w) return startBroadcast(env, msg);
    }
    if (t0 === "/azolar") return azolarCmd(env, msg.chat.id);
    if (t0 === "/faollar") return faollarCmd(env, msg.chat.id);
    if (t0 === "/reyting") return reytingCmd(env, msg.chat.id);
    if (t0 === "/excel") return excelCmd(env, msg.chat.id);
    if (t0 === "/xabar") return xabarCmd(env, msg.chat.id);
    if (t0 === "/admin") return send(env, msg.chat.id, "🛠 <b>Admin panel</b>\n\n/azolar — a'zolar soni\n/faollar — oxirgi faol a'zolar\n/reyting — TOP-20\n/excel — a'zolar jadvali\n/xabar — hammaga xabar\n/parol — parol sozlamalari\n/obuna — majburiy obuna");
  }
  const fch = msg.forward_from_chat || (msg.forward_origin && msg.forward_origin.chat);
  if (msg.chat.type === "private" && fch && msg.from && String(msg.from.id) === OWNER(env)) {
    const r = await tg(env, "getChatMember", { chat_id: fch.id, user_id: (await tg(env, "getMe", {})).result.id });
    const adm = r.ok && ["administrator", "creator"].includes(r.result.status);
    return send(env, msg.chat.id,
      `📢 <b>${esc(fch.title || "")}</b>\nID: <code>${fch.id}</code>${fch.username ? "\nUsername: @" + fch.username : ""}\nBot bu kanalda admin: ${adm ? "HA ✅" : "YO'Q ❌ — avval admin qiling"}\n\nObunaga qo'shish uchun (taklif havolasini o'zingiznikiga almashtiring):\n<code>/obuna hammasi @yoldashaliisakov ${fch.id} https://t.me/+taklif</code>`);
  }
  if (!text.startsWith("/")) {
    if (msg.chat.type === "private" && text && msg.from) await tryPassword(env, msg);
    return;
  }
  const [cmdRaw, arg] = text.trim().split(/\s+/, 2);
  const cmd = cmdRaw.split("@")[0].toLowerCase();
  const chat_id = msg.chat.id;

  if (cmd === "/start" && msg.chat.type === "private") {
    if (arg && arg.startsWith("g_")) return showGroup(env, chat_id, null, arg.slice(2), msg.from);
    if (arg && arg.startsWith("s_")) return showSection(env, chat_id, null, arg.slice(2), 0, msg.from);
    if (arg && arg !== "menu" && /^[\w-]+$/.test(arg)) return startPrivate(env, chat_id, arg, msg.from);
    return showMain(env, chat_id, null, msg.from);
  }

  if (cmd === "/parol" && msg.chat.type === "private") return parolCmd(env, msg, text);
  if (cmd === "/obuna" && msg.chat.type === "private") return obunaCmd(env, msg, text);

  if (cmd === "/menyu" || cmd === "/menu" || cmd === "/testlar") {
    if (msg.chat.type === "private") return showMain(env, chat_id, null, msg.from);
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
    if (msg.chat.type === "private") return startPrivate(env, chat_id, arg, msg.from);
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
        if (b.t === "bc") await runBroadcastBatch(env, b);
        else await advance(env, b.chat_id, b.session_id, b.idx);
      } catch (e) { console.log("Taymer xato:", e.stack || e); }
      m.ack();
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(watchdog(env).catch((e) => console.log(e)));
    ctx.waitUntil(autoTick(env).catch((e) => console.log("Avto xato:", e.stack || e)));
  },
};
