// ===== Isakov school viktorina boti — Cloudflare Worker + D1 + Queue + avto =====
const API = (env, m) => `https://api.telegram.org/bot${env.BOT_TOKEN}/${m}`;

// Forward/saqlashdan himoya: faqat egasining (admin) shaxsiy chatida himoyasiz
const PROTECT = new Set(["sendMessage", "sendPhoto", "sendPoll", "sendDocument", "sendVideo", "copyMessage"]);
async function tg(env, method, body, retry = true) {
  if (PROTECT.has(method) && body && body.chat_id != null && body.protect_content === undefined && String(body.chat_id) !== OWNER(env))
    body = { ...body, protect_content: true };
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
  try { await bump(env, (await sectionOf(env, s.quiz_id)) || "boshqa"); await bump(env, s.chat_id > 0 ? "_shaxsiy" : "_guruh"); } catch (_) {}
  const { results } = await env.DB.prepare(
    "SELECT name, correct, answered FROM scores WHERE chat_id=? AND session_id=? ORDER BY correct DESC, answered ASC LIMIT 40"
  ).bind(s.chat_id, s.session_id).all();
  if (s.chat_id > 0) {
    const r = results[0] || { correct: 0 };
    await addResult(env, s.chat_id, r.correct, s.total);
    const pct = Math.round((r.correct / s.total) * 100);
    const baho = pct >= 86 ? "🏆 A'lo!" : pct >= 71 ? "👍 Yaxshi!" : pct >= 56 ? "🙂 Qoniqarli" : "📖 Mavzuni yana takrorlang";
    try { await saveResult(env, s, r.correct); } catch (e) { console.log("natija saqlash", e); }
    let streak = null; try { streak = await bumpStreak(env, s.chat_id); } catch (e) { console.log("streak", e); }
    const rmd = await getStreak(env, s.chat_id).catch(() => ({ active: 1 }));
    const mc = await mistakeCount(env, s.chat_id).catch(() => 0);
    const kb = [];
    for (const row of [
      ...(s.quiz_id === "qidiruv" ? [] : [[s.quiz_id === "kun10" ? `🔁 Yana 10 ta savol` : `🔁 Qayta ishlash`, s.quiz_id === "xatolar" ? "x" : s.quiz_id === "kun10" ? "d10" : `q:${s.quiz_id}`, s.quiz_id === "xatolar" ? "xato" : s.quiz_id === "kun10" ? "kun10" : s.quiz_id]]),
      ...(mc && s.quiz_id !== "xatolar" ? [[`🧩 Xatolar ustida ishlash (${mc})`, "x", "xato"]] : []),
      ...(!["xatolar", "kun10", "qidiruv"].includes(s.quiz_id) ? [[`📄 PDF yuklab olish`, `p:${s.quiz_id}`, `p_${s.quiz_id}`]] : []),
      [`📈 Natijalarim`, "r", "natija"],
      ...(!rmd.active ? [[`⏰ Kunlik eslatma qo'yish`, "rmm", "eslatma"]] : []),
      [`📚 Boshqa test tanlash`, "m", "menu"],
    ]) kb.push([await btn(env, s.chat_id, row[0], row[1], row[2])]);
    await send(env, s.chat_id,
      `🏁 <b>«${esc(s.title)}» yakunlandi!</b>\n\n✅ To'g'ri javoblar: <b>${r.correct} / ${s.total}</b>\n📊 Natija: <b>${pct}%</b> — ${baho}` +
      (s.quiz_id === "xatolar" ? `\n\n🧩 Qolgan xato savollar: <b>${mc}</b>` : "") +
      (streak ? `\n\n${fire(streak)} Ketma-ket kunlar: <b>${streak}</b>${[7, 30, 100].includes(streak) ? " — 🎉 Tabriklaymiz, yangi belgi!" : ""}` : ""),
      { reply_markup: { inline_keyboard: kb } });
    if (pct >= 70 && !["xatolar", "kun10", "qidiruv"].includes(s.quiz_id) && s.total >= 10) {
      const user = await env.DB.prepare("SELECT name, username FROM users WHERE user_id=?").bind(s.chat_id).first().catch(() => null);
      await sendCertificate(env, s, user ? { first_name: user.name, username: user.username } : null, r.correct, pct).catch((e) => console.log("sertifikat", e));
    }
    return;
  }
  const medals = ["🥇", "🥈", "🥉"];
  let t = `🏁 <b>«${esc(s.title)}» viktorinasi yakunlandi!</b>\n\n`;
  t += `Savollar: ${s.total} ta · Qatnashchilar: ${results.length} nafar\n\n`;
  if (!results.length) t += "Hech kim javob bermadi 🙂";
  results.forEach((r, i) => {
    t += `${medals[i] || i + 1 + "."} ${esc(r.name)} — <b>${r.correct}</b> ta to'g'ri\n`;
  });
  t += "\n🏆 G'oliblarni tabriklaymiz!";
  const nx = await nextTest(env, s.quiz_id).catch(() => null);
  const kb = [];
  if (nx) kb.push([{ text: `▶️ Keyingi: ${nx.t}`.slice(0, 60), callback_data: `q:${nx.n}` }]);
  kb.push([{ text: "📚 Boshqa mavzu tanlash", callback_data: "m" }]);
  await send(env, s.chat_id, t, { reply_markup: { inline_keyboard: kb } });
  await teacherReport(env, s).catch((e) => console.log("jadval", e));
}


// ---------- Testni boshlash ----------
const QCACHE = new Map();
async function fetchQuiz(env, name) {
  const c = QCACHE.get(name);
  if (c && Date.now() - c.t < 600000) return c.d;
  if (name.startsWith("u-")) {
    await ensureCustom(env);
    const row = await env.DB.prepare("SELECT data FROM custom_tests WHERE n=?").bind(name).first();
    if (!row) throw new Error("topilmadi");
    const d = JSON.parse(row.data); QCACHE.set(name, { d, t: Date.now() }); return d;
  }
  const r = await fetch(new URL(name + ".json", env.QUIZ_BASE_URL).href + "?v=" + Math.floor(Date.now() / 600000));
  if (!r.ok) throw new Error("topilmadi");
  const d = await r.json();
  QCACHE.set(name, { d, t: Date.now() });
  return d;
}
async function startQuiz(env, chat_id, arg, starter = null) {
  const cur = await env.DB.prepare("SELECT running FROM sessions WHERE chat_id=?").bind(chat_id).first();
  if (cur && cur.running) return "⏳ Viktorina davom etyapti. Avval /stop bosing.";
  let data;
  try { data = await fetchQuiz(env, arg); } catch (e) { return `❌ «${esc(arg)}» testi topilmadi yoki fayl xato.`; }
  const qs = (data.questions || []).filter((q) => q.q && Array.isArray(q.options) && q.options.length >= 2);
  if (!qs.length) return "❌ Testda savol yo'q.";
  const time = Math.max(5, Math.min(600, parseInt(data.time) || 30));
  const sid = await startWithQuestions(env, chat_id, arg, data.title || arg, qs, time);
  if (chat_id < 0) await recordRun(env, chat_id, sid, starter, data.title || arg, qs.length).catch((e) => console.log("run", e));
  return null;
}
async function startWithQuestions(env, chat_id, quiz_id, title, qs, time) {
  const session_id = String(Date.now());
  await env.DB.prepare(
    "INSERT OR REPLACE INTO sessions (chat_id, session_id, quiz_id, title, idx, total, time, running, last_sent, questions) VALUES (?,?,?,?,0,?,?,1,?,?)"
  ).bind(chat_id, session_id, quiz_id, title, qs.length, time, Date.now(), JSON.stringify(qs)).run();
  await send(env, chat_id,
    `📝 <b>${esc(title)}</b>\n\n❓ ${qs.length} ta savol\n⏱ Har bir savolga ${time} soniya\n\nOmad! Birinchi savol hozir chiqadi 👇`);
  const s = await env.DB.prepare("SELECT * FROM sessions WHERE chat_id=?").bind(chat_id).first();
  await new Promise((r) => setTimeout(r, 2000));
  await sendQuestion(env, s, 0);
  return session_id;
}

// ---------- Avtomatik viktorina ----------
let AUTO_OK = false;
async function ensureAuto(env) {
  if (AUTO_OK) return;
  AUTO_OK = true;
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
  const { results } = await env.DB.prepare("SELECT chat_id, interval_min, list, pos, next_at FROM auto WHERE next_at<=?").bind(now).all();
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
  const base = await r.json();
  try { CAT = mergeCustom(base, await customList(env)); } catch (e) { console.log("custom", e); CAT = base; }
  CAT_AT = Date.now();
  return CAT;
}
async function botUser(env) {
  if (BOTU) return BOTU;
  const r = await tg(env, "getMe", {});
  BOTU = r.result && r.result.username;
  return BOTU;
}
// Egasi uchun tugmalar havola (deep link) bo'ladi — forward qilinganda ham ishlaydi
async function btn(env, chat_id, text, cb, start) {
  if (String(chat_id) === OWNER(env)) return { text, url: `https://t.me/${await botUser(env)}?start=${start}` };
  return { text, callback_data: cb };
}
const MAIN_TEXT = "📚 <b>ISAKOV SCHOOL — testlar</b>\n\nBo'limni tanlang, so'ng mavzuni bosing — test shu yerda boshlanadi 👇\n\n🔍 <i>Qidirish uchun mavzu nomini yozing, masalan: Amir Temur</i>";

async function showMain(env, chat_id, message_id, user) {
  if (user && !(await gate(env, user, chat_id, "*", "m"))) return;
  const cat = await catalog(env);
  const cnt = (g) => g.secs.reduce((a, id) => a + ((cat.sections.find((x) => x.id === id) || { tests: [] }).tests.length), 0);
  const kb = [];
  for (const g of cat.groups || []) kb.push([await btn(env, chat_id, `${g.icon} ${g.title} (${cnt(g)})`, `g:${g.id}`, `g_${g.id}`)]);
  if (chat_id > 0) kb.push([await btn(env, chat_id, "📈 Natijalarim", "r", "natija"), await btn(env, chat_id, "🧩 Xatolarim", "x", "xato")]);
  if (chat_id > 0) kb.push([await btn(env, chat_id, "🎁 Do'stni taklif qilish", "ref", "taklif"), await btn(env, chat_id, "👩‍🏫 O'qituvchilar uchun", "tch", "oqituvchi")]);
  const body = { chat_id, text: MAIN_TEXT, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } };
  if (message_id) return tg(env, "editMessageText", { ...body, message_id });
  return tg(env, "sendMessage", body);
}

async function showGroup(env, chat_id, message_id, gid, user) {
  if (user && !(await gate(env, user, chat_id, "*", `g:${gid}`))) return;
  const cat = await catalog(env);
  const g = (cat.groups || []).find((x) => x.id === gid);
  if (!g) return showMain(env, chat_id, message_id, user);
  if (g.secs.length === 1) return showSection(env, chat_id, message_id, g.secs[0], 0, user);
  const kb = [];
  for (const sec of g.secs.map((id) => cat.sections.find((x) => x.id === id)).filter(Boolean))
    kb.push([await btn(env, chat_id, `${sec.icon} ${sec.title} (${sec.tests.length})`, `s:${sec.id}:0`, `s_${sec.id}`)]);
  kb.push([await btn(env, chat_id, "⬅️ Bosh menyu", "m", "menu")]);
  const body = { chat_id, parse_mode: "HTML", reply_markup: { inline_keyboard: kb },
    text: `${g.icon} <b>${esc(g.title)}</b>\n\nBo'limni tanlang 👇` };
  if (message_id) return tg(env, "editMessageText", { ...body, message_id });
  return tg(env, "sendMessage", body);
}

async function showSection(env, chat_id, message_id, id, page, user, pdf = false) {
  if (user && !(await gate(env, user, chat_id, id, `${pdf ? "sp" : "s"}:${id}:${page}`))) return;
  const cat = await catalog(env);
  const sec = cat.sections.find((x) => x.id === id);
  if (!sec) return showMain(env, chat_id, message_id);
  const per = 15, pages = Math.max(1, Math.ceil(sec.tests.length / per));
  page = Math.min(Math.max(0, page), pages - 1);
  const P = pdf ? "sp" : "s"; // callback prefiksi
  const kb = [];
  for (const t of sec.tests.slice(page * per, page * per + per)) {
    let label = `${pdf ? "📄 " : ""}${t.t} (${t.c})`;
    if (label.length > 60) label = (pdf ? "📄 " : "") + t.t.slice(0, 50) + "… (" + t.c + ")";
    kb.push([await btn(env, chat_id, label, pdf ? `p:${t.n}` : `q:${t.n}`, pdf ? `p_${t.n}` : t.n)]);
  }
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push(await btn(env, chat_id, "◀️ Oldingi", `${P}:${id}:${page - 1}`, `${P}_${id}_${page - 1}`));
    nav.push(await btn(env, chat_id, `${page + 1}/${pages}`, `${P}:${id}:${page}`, `${P}_${id}_${page}`));
    if (page < pages - 1) nav.push(await btn(env, chat_id, "Keyingi ▶️", `${P}:${id}:${page + 1}`, `${P}_${id}_${page + 1}`));
    kb.push(nav);
  }
  if (chat_id > 0) kb.push([pdf
    ? await btn(env, chat_id, "📝 Test ishlash rejimi", `s:${id}:${page}`, `s_${id}_${page}`)
    : await btn(env, chat_id, "📄 PDF yuklab olish", `sp:${id}:${page}`, `sp_${id}_${page}`)]);
  const grp = (cat.groups || []).find((x) => x.secs.includes(id));
  const back = grp && grp.secs.length > 1;
  kb.push([await btn(env, chat_id, "⬅️ Orqaga", back ? `g:${grp.id}` : "m", back ? `g_${grp.id}` : "menu")]);
  const body = {
    chat_id, parse_mode: "HTML", reply_markup: { inline_keyboard: kb },
    text: `${sec.icon} <b>${esc(sec.title)}</b>\n${sec.tests.length} ta test · ` + (pdf ? "📄 PDF olish uchun mavzuni tanlang 👇\n<i>(PDF oxirida javoblar va izohlar bor)</i>" : "mavzuni tanlang 👇"),
  };
  if (message_id) return tg(env, "editMessageText", { ...body, message_id });
  return tg(env, "sendMessage", body);
}

async function sendPdf(env, chat_id, name, user) {
  const sec = (await sectionOf(env, name)) || "*";
  if (user && !(await gate(env, user, chat_id, sec, `p:${name}`))) return;
  if (user && !(await needSubs(env, user, chat_id, name))) return;
  const cat = await catalog(env);
  const t = cat.sections.flatMap((x) => x.tests).find((x) => x.n === name);
  const u = await botUser(env);
  const r = await tg(env, "sendDocument", {
    chat_id, document: new URL(`pdf/${name}.pdf`, env.QUIZ_BASE_URL).href, parse_mode: "HTML",
    caption: `📄 <b>${esc(t ? t.t : name)}</b>${t ? ` · ${t.c} ta savol` : ""}\nJavoblar va izohlar — fayl oxirida.\n\n🤖 Test ishlash: @${u}`,
    reply_markup: { inline_keyboard: [[await btn(env, chat_id, "📝 Shu testni ishlash", `q:${name}`, name)]] },
  });
  if (!r.ok) await send(env, chat_id, "❌ Bu test uchun PDF hali tayyor emas.");
  else await bump(env, "_pdf");
}

// Guruh uchun katalog: tugma bosilsa, bot shaxsiy chatda ochiladi va mavzular chiqadi
async function postGroupMenu(env, chat_id) {
  const cat = await catalog(env);
  const u = await botUser(env);
  const cnt = (g) => g.secs.reduce((a, id) => a + ((cat.sections.find((x) => x.id === id) || { tests: [] }).tests.length), 0);
  const kb = (cat.groups || []).map((g) => [{ text: `${g.icon} ${g.title} (${cnt(g)})`, url: `https://t.me/${u}?start=g_${g.id}` }]);
  const total = cat.sections.reduce((a, x) => a + x.tests.length, 0);
  const r = await tg(env, "sendMessage", {
    chat_id, parse_mode: "HTML", reply_markup: { inline_keyboard: kb }, protect_content: false,
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
  if (chat && chat.type !== "private") {
    const r = await tg(env, "getChatMember", { chat_id: chat.id, user_id: cq.from.id });
    if (!(r.ok && ["creator", "administrator"].includes(r.result.status)))
      return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, show_alert: true,
        text: "Bu tugmalar faqat guruh adminlari uchun. Testni o'zingiz ishlash uchun guruhdagi 📚 katalogdan foydalaning." });
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  if (!chat) return;
  if (d.startsWith("kp:") && chat.type === "private" && String(cq.from.id) === OWNER(env)) {
    if (d === "kp:ok") return kanalSend(env, chat.id);
    await env.DB.prepare("DELETE FROM settings WHERE k='kanal_pending'").run(); return send(env, chat.id, "❌ Bekor qilindi.");
  }
  if (d.startsWith("a:")) {
    if (chat.type === "private" && String(cq.from.id) === OWNER(env)) return adminAction(env, cq, d.slice(2));
    return;
  }
  if (chat.type === "private") await touchUser(env, cq.from);
  const mid = cq.message.message_id;
  const user = chat.type === "private" ? cq.from : null;
  if (d === "m") return showMain(env, chat.id, mid, user);
  if (d === "r" && chat.type === "private") return myResults(env, chat.id, cq.from);
  if (d === "d10" && chat.type === "private") return startDaily10(env, chat.id, cq.from);
  if (d === "rmm" && chat.type === "private") return remindMenu(env, chat.id, cq.from);
  if (d.startsWith("rm:") && chat.type === "private") return setRemind(env, chat.id, cq.from, d.slice(3));
  if (d.startsWith("sq:") && chat.type === "private") return startSearchQuiz(env, chat.id, cq.from, d.slice(3));
  if (d === "tch" && chat.type === "private") return teacherGuide(env, chat.id);
  if (d === "ref" && chat.type === "private") return showReferral(env, chat.id, cq.from);
  if (d === "x" && chat.type === "private") return startMistakes(env, chat.id, cq.from);
  if (d.startsWith("g:")) return showGroup(env, chat.id, mid, d.slice(2), user);
  if (d.startsWith("s:")) { const [, id, pg] = d.split(":"); return showSection(env, chat.id, mid, id, +pg || 0, user); }
  if (d.startsWith("sp:")) { const [, id, pg] = d.split(":"); return showSection(env, chat.id, mid, id, +pg || 0, user, true); }
  if (d.startsWith("p:") && chat.type === "private") { const name = d.slice(2); if (/^[\w-]+$/.test(name)) return sendPdf(env, chat.id, name, cq.from); }
  if (d.startsWith("q:") && chat.type === "private") {
    const name = d.slice(2);
    if (/^[\w-]+$/.test(name)) return startPrivate(env, chat.id, name, cq.from);
  }
  if (d.startsWith("q:") && chat.type !== "private") {
    const name = d.slice(2);
    if (!/^[\w-]+$/.test(name)) return;
    await tg(env, "deleteMessage", { chat_id: chat.id, message_id: mid });
    const err = await startQuiz(env, chat.id, name, cq.from.id);
    if (err) await send(env, chat.id, err);
  }
}

// Guruh: keyingi mavzu
async function nextTest(env, name) {
  const cat = await catalog(env);
  for (const sec of cat.sections) {
    const i = sec.tests.findIndex((t) => t.n === name);
    if (i >= 0) return sec.tests[i + 1] || null;
  }
  return null;
}


// ---------- Parol bilan himoya ----------
const OWNER = (env) => String(env.ADMIN_ID || "6806557484");
let LOCK_OK = false;
async function ensureLock(env) {
  if (LOCK_OK) return;
  LOCK_OK = true;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS access (user_id INTEGER PRIMARY KEY, ver INTEGER, name TEXT, at INTEGER)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS pending (user_id INTEGER PRIMARY KEY, target TEXT, tries INTEGER, until INTEGER)").run();
}
let LOCK_C = null, LOCK_T = 0;
async function getLock(env) {
  if (Date.now() - LOCK_T < 60000) return LOCK_C;
  await ensureLock(env);
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='lock'").first();
  LOCK_C = r ? JSON.parse(r.v) : null; LOCK_T = Date.now();
  return LOCK_C; // {pw, ver, secs:[]}
}
async function sectionOf(env, name) {
  const cat = await catalog(env);
  const sec = cat.sections.find((x) => x.tests.some((t) => t.n === name));
  return sec ? sec.id : null;
}
// true qaytarsa — davom etish mumkin; false — parol so'raldi
async function gate(env, user, chat_id, secId, target) {
  if (String(user.id) === OWNER(env)) return true;
  if (!(await refGate(env, user, chat_id, secId))) return false;
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
    L.pw = ""; await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('lock', ?)").bind(JSON.stringify(L)).run(); LOCK_T = 0;
    return send(env, msg.chat.id, "🔓 Parol o'chirildi. Testlar hamma uchun ochiq.");
  }
  L = { pw: parts[0], ver: (L.ver || 0) + 1, secs: parts.slice(1) };
  await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('lock', ?)").bind(JSON.stringify(L)).run(); LOCK_T = 0;
  return send(env, msg.chat.id,
    `🔒 <b>Parol o'rnatildi:</b> <code>${esc(L.pw)}</code>\nYopiq: ${L.secs.length ? esc(L.secs.join(", ")) : "barcha testlar"}\n\nO'quvchilar endi shu parolni kiritib kiradi. Parolni almashtirsangiz, hamma yangisini qayta kiritadi.`);
}


// ---------- Majburiy obuna ----------
const HUQUQ_CH = { id: "@huquqmezoni", name: "Huquq mezoni", link: "https://t.me/+JHqVNFFPSwE1Mjdi" };
const SUBS_DEFAULT = { on: true, tarix: ["@yoldashaliisakov"], huquq: ["@yoldashaliisakov"] };
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
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='subs_v2'").first();
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
  const save = () => env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('subs_v2', ?)").bind(JSON.stringify(S)).run();
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
let ENSU_OK = false;
async function ensureUsers(env) {
  if (ENSU_OK) return;
  ENSU_OK = true;
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


// ---------- Kunlik hisobot va ogohlantirish ----------
const dayKey = (ts = Date.now()) => new Date(ts + TZ).toISOString().slice(0, 10);
let STATS_OK = false;
async function ensureStats(env) {
  if (STATS_OK) return;
  STATS_OK = true;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS stats (day TEXT, sec TEXT, n INTEGER, PRIMARY KEY (day, sec))").run();
}
async function bump(env, sec, by = 1) {
  try {
    await ensureStats(env);
    await env.DB.prepare("INSERT INTO stats (day, sec, n) VALUES (?,?,?) ON CONFLICT(day, sec) DO UPDATE SET n=n+excluded.n")
      .bind(dayKey(), sec, by).run();
  } catch (e) { console.log("stats xato", e); }
}
let ALERT_AT = 0;
async function alertOwner(env, where, e) {
  const msg = String((e && (e.message || e)) || "").slice(0, 300);
  console.log("XATO [" + where + "]", e && (e.stack || e));
  if (Date.now() - ALERT_AT < 30 * 60000) return; // 30 daqiqada ko'pi bilan 1 marta
  ALERT_AT = Date.now();
  const d1 = /D1|limit|chegara/i.test(msg);
  await tg(env, "sendMessage", {
    chat_id: OWNER(env), parse_mode: "HTML",
    text: `⚠️ <b>Botda nosozlik!</b>\n\n📍 Joyi: ${esc(where)}\n🧾 Xato: <code>${esc(msg)}</code>` +
      (d1 ? "\n\n💡 Bu Cloudflare bazasi (D1) bilan bog'liq. Kunlik limit tugagan bo'lsa, bot Toshkent vaqti bilan 05:00 da o'zi tiklanadi." : "") +
      `\n\n🔍 Tekshirish: https://quizbot.yoldashaliisaqov8.workers.dev/tekshir?secret=…`,
  }).catch(() => {});
  try { await bump(env, "_xato"); } catch (_) {}
}
async function dailyReport(env, chat) {
  await ensureUsers(env); await ensureStats(env);
  const d0 = dayStart(), day = dayKey();
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).first();
  const all = await q("SELECT COUNT(*) n FROM users");
  const nw = await q("SELECT COUNT(*) n FROM users WHERE first_seen>=?", d0);
  const act = await q("SELECT COUNT(*) n FROM users WHERE last_seen>=?", d0);
  const { results } = await env.DB.prepare("SELECT sec, n FROM stats WHERE day=? ORDER BY n DESC").bind(day).all();
  const get = (k) => (results.find((r) => r.sec === k) || { n: 0 }).n;
  const secs = results.filter((r) => !r.sec.startsWith("_"));
  const tests = secs.reduce((a, r) => a + r.n, 0);
  const cat = await catalog(env).catch(() => ({ sections: [] }));
  const nm = (id) => { const x = cat.sections.find((y) => y.id === id); return x ? `${x.icon} ${x.title}` : id; };
  let t = `📊 <b>Kunlik hisobot · ${day.split("-").reverse().join(".")}</b>\n\n` +
    `🆕 Yangi a'zolar: <b>+${nw.n}</b> (jami ${all.n})\n🔥 Bugun faol: <b>${act.n}</b>\n` +
    `📝 Ishlangan testlar: <b>${tests}</b> (shaxsiy: ${get("_shaxsiy")}, guruhda: ${get("_guruh")})\n`;
  if (secs.length) t += `\n🏆 <b>Eng faol bo'limlar:</b>\n` + secs.slice(0, 5).map((r, i) => `${i + 1}. ${esc(nm(r.sec))} — ${r.n} ta`).join("\n") + "\n";
  if (get("_pdf")) t += `📄 Yuklab olingan PDF: <b>${get("_pdf")}</b>\n`;
  if (get("_app")) t += `📱 Ilova ochildi: <b>${get("_app")}</b> marta, ilovada test: <b>${get("_ilova")}</b>\n`;
  if (get("_qidiruv")) t += `🔍 Qidiruvlar: <b>${get("_qidiruv")}</b>\n`;
  const err = get("_xato");
  t += `\n${err ? `⚠️ Bugun nosozliklar: <b>${err}</b>` : "✅ Bugun nosozlik bo'lmadi"}`;
  return send(env, chat, t);
}
async function reportTick(env) {
  const d = new Date();
  if (d.getUTCHours() !== 16) return; // Toshkent 21:00
  await ensureLock(env);
  const day = dayKey();
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='report_day'").first();
  if (r && r.v === day) return;
  await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('report_day', ?)").bind(day).run();
  await dailyReport(env, OWNER(env));
}


// ---------- Admin panel (tugmalar) ----------
const ADMIN_KB = { inline_keyboard: [
  [{ text: "👥 A'zolar", callback_data: "a:azolar" }, { text: "🕒 Faollar", callback_data: "a:faollar" }],
  [{ text: "🏆 Reyting", callback_data: "a:reyting" }, { text: "📊 Excel", callback_data: "a:excel" }],
  [{ text: "📢 Hammaga xabar", callback_data: "a:xabar" }, { text: "📈 Hisobot", callback_data: "a:hisobot" }],
  [{ text: "🏆 Haftalik reyting", callback_data: "a:haftalik" }, { text: "☀️ Kun savoli", callback_data: "a:kun" }],
  [{ text: "🎁 Referal", callback_data: "a:ref" }],
  [{ text: "🔒 Parol", callback_data: "a:parol" }, { text: "📣 Obuna", callback_data: "a:obuna" }],
  [{ text: "📚 Testlar menyusi", callback_data: "a:menyu" }],
] };
async function adminPanel(env, chat) {
  return send(env, chat, "🛠 <b>Admin panel</b>\n\nKerakli bo'limni tanlang 👇", { reply_markup: ADMIN_KB });
}
async function adminAction(env, cq, act) {
  const chat = cq.message.chat.id;
  const fake = { from: cq.from, chat: { id: chat, type: "private" } };
  if (act === "azolar") return azolarCmd(env, chat);
  if (act === "faollar") return faollarCmd(env, chat);
  if (act === "reyting") return reytingCmd(env, chat);
  if (act === "excel") return excelCmd(env, chat);
  if (act === "xabar") return xabarCmd(env, chat);
  if (act === "hisobot") return dailyReport(env, chat);
  if (act === "kun") return kunCmd(env, fake, "/kunsavoli");
  if (act === "ref") return referalCmd(env, fake, "/referal");
  if (act === "haftalik") return send(env, chat, (await weeklyText(env, null)) + "\n\n<i>Guruhlarga hoziroq yuborish: /haftalik yubor</i>");
  if (act === "parol") return parolCmd(env, fake, "/parol");
  if (act === "obuna") return obunaCmd(env, fake, "/obuna");
  if (act === "menyu") return showMain(env, chat, null, cq.from);
}


// ---------- O'quvchi: natijalar, xatolar, sertifikat, haftalik reyting ----------
let LRN_OK = false;
async function ensureLearn(env) {
  if (LRN_OK) return;
  LRN_OK = true;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS results (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, quiz_id TEXT, title TEXT, correct INTEGER, total INTEGER, at INTEGER)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS results_user ON results(user_id, at)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS results_at ON results(at)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS topic (user_id INTEGER, quiz_id TEXT, ok INTEGER DEFAULT 0, n INTEGER DEFAULT 0, at INTEGER, PRIMARY KEY (user_id, quiz_id))").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS mistakes (user_id INTEGER, quiz_id TEXT, idx INTEGER, at INTEGER, PRIMARY KEY (user_id, quiz_id, idx))").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS groups (chat_id INTEGER PRIMARY KEY, title TEXT, last_seen INTEGER)").run();
}
async function trackMistake(env, p, uid, ok) {
  if (!(p.chat_id > 0 && p.chat_id === uid)) return;
  await ensureLearn(env);
  const s = await env.DB.prepare("SELECT session_id, quiz_id, questions FROM sessions WHERE chat_id=?").bind(p.chat_id).first();
  if (!s || s.session_id !== p.session_id) return;
  const q = (JSON.parse(s.questions) || [])[p.idx];
  if (!q) return;
  const [qid, qi] = q.src || [s.quiz_id, p.idx];
  if (ok) await env.DB.prepare("DELETE FROM mistakes WHERE user_id=? AND quiz_id=? AND idx=?").bind(uid, qid, qi).run();
  else await env.DB.prepare("INSERT OR REPLACE INTO mistakes (user_id, quiz_id, idx, at) VALUES (?,?,?,?)").bind(uid, qid, qi, Date.now()).run();
  await topicAdd(env, uid, qid, ok ? 1 : 0, 1);
}
// Mavzular bo'yicha statistika (har bir savol o'z testi/mavzusiga yoziladi)
const topicStmt = (env, uid, qid, ok, n) => env.DB.prepare("INSERT INTO topic (user_id, quiz_id, ok, n, at) VALUES (?,?,?,?,?) ON CONFLICT(user_id, quiz_id) DO UPDATE SET ok=ok+excluded.ok, n=n+excluded.n, at=excluded.at").bind(uid, String(qid).slice(0, 40), ok, n, Date.now());
async function topicAdd(env, uid, qid, ok, n) { try { await topicStmt(env, uid, qid, ok, n).run(); } catch (e) { console.log("topic", e); } }
const SPECIAL_Q = ["xatolar", "kun10", "qidiruv", "sim-ms", "sim-huquq", "sim-att"];
async function getTopics(env, uid) {
  await ensureLearn(env);
  const seeded = await env.DB.prepare("SELECT 1 FROM topic WHERE user_id=? AND quiz_id='_seed'").bind(uid).first();
  if (!seeded) { // eski natijalardan boshlang'ich ma'lumot (faqat statistika yuritilishidan oldingilari)
    const m = await env.DB.prepare("SELECT MIN(at) t FROM topic WHERE user_id=?").bind(uid).first();
    const before = (m && m.t) || Date.now() + 1;
    await env.DB.prepare(`INSERT INTO topic (user_id, quiz_id, ok, n, at) SELECT user_id, quiz_id, SUM(correct), SUM(total), MAX(at) FROM results WHERE user_id=? AND at<? AND quiz_id NOT IN (${SPECIAL_Q.map(() => "?").join(",")}) GROUP BY quiz_id
      ON CONFLICT(user_id, quiz_id) DO UPDATE SET ok=ok+excluded.ok, n=n+excluded.n`).bind(uid, before, ...SPECIAL_Q).run();
    await env.DB.prepare("INSERT OR IGNORE INTO topic (user_id, quiz_id, ok, n, at) VALUES (?, '_seed', 0, 0, ?)").bind(uid, Date.now()).run();
  }
  const { results } = await env.DB.prepare("SELECT quiz_id, ok, n FROM topic WHERE user_id=? AND quiz_id<>'_seed' LIMIT 600").bind(uid).all();
  return results;
}
async function weakText(env, uid) {
  const tp = (await getTopics(env, uid)).filter((r) => r.n >= 5);
  if (!tp.length) return "";
  const cat = await catalog(env);
  const all = cat.sections.flatMap((x) => x.tests.map((t) => ({ ...t, sec: x })));
  const weak = tp.map((r) => ({ ...r, p: Math.round((r.ok / r.n) * 100), t: all.find((x) => x.n === r.quiz_id) })).filter((r) => r.t && r.p < 60).sort((a, b) => a.p - b.p).slice(0, 3);
  if (!weak.length) return "\n\n💪 Zaif mavzular yo'q — barcha mavzularda 60% dan yuqori!";
  return "\n\n<b>⚠️ Takrorlash kerak:</b>\n" + weak.map((r) => `🔴 <b>${r.p}%</b> — ${esc(r.t.t)}`).join("\n");
}
async function mistakeCount(env, uid) {
  await ensureLearn(env);
  const r = await env.DB.prepare("SELECT COUNT(*) n FROM mistakes WHERE user_id=?").bind(uid).first();
  return r ? r.n : 0;
}
async function startMistakes(env, chat_id, user) {
  if (user && !(await gate(env, user, chat_id, "*", "x"))) return;
  await ensureLearn(env);
  const { results } = await env.DB.prepare("SELECT quiz_id, idx FROM mistakes WHERE user_id=? ORDER BY at DESC LIMIT 80").bind(chat_id).all();
  if (!results.length) return send(env, chat_id, "🎉 <b>Xatolaringiz yo'q!</b>\n\nTest ishlaganingizda xato qilgan savollaringiz shu yerga yig'iladi.", { reply_markup: { inline_keyboard: [[{ text: "📚 Testlar menyusi", callback_data: "m" }]] } });
  const quizzes = [...new Set(results.map((r) => r.quiz_id))].slice(0, 8);
  const qs = [];
  for (const qid of quizzes) {
    let d; try { d = await fetchQuiz(env, qid); } catch (e) { continue; }
    for (const r of results.filter((x) => x.quiz_id === qid)) {
      const q = (d.questions || [])[r.idx];
      if (q) qs.push({ ...q, src: [qid, r.idx] });
    }
  }
  if (!qs.length) return send(env, chat_id, "Xato savollar topilmadi.");
  for (let i = qs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [qs[i], qs[j]] = [qs[j], qs[i]]; }
  await env.DB.prepare("UPDATE sessions SET running=0 WHERE chat_id=? AND running=1").bind(chat_id).run();
  await startWithQuestions(env, chat_id, "xatolar", "🔁 Xatolar ustida ishlash", qs.slice(0, 30), 45);
}
async function saveResult(env, s, correct) {
  await ensureLearn(env);
  await env.DB.prepare("INSERT INTO results (user_id, quiz_id, title, correct, total, at) VALUES (?,?,?,?,?,?)")
    .bind(s.chat_id, s.quiz_id, s.title, correct, s.total, Date.now()).run();
}
async function myResults(env, chat_id, user) {
  await ensureLearn(env);
  const { results } = await env.DB.prepare("SELECT quiz_id, title, correct, total, at FROM results WHERE user_id=? ORDER BY at DESC LIMIT 15").bind(chat_id).all();
  const agg = await env.DB.prepare("SELECT COUNT(*) n, SUM(correct) c, SUM(total) t FROM results WHERE user_id=?").bind(chat_id).first();
  const mc = await mistakeCount(env, chat_id);
  const kb = [];
  if (mc) kb.push([await btn(env, chat_id, `🔁 Xatolar ustida ishlash (${mc})`, "x", "xato")]);
  kb.push([await btn(env, chat_id, "📚 Testlar menyusi", "m", "menu")]);
  if (!results.length) return send(env, chat_id, "📈 <b>Natijalarim</b>\n\nHali test ishlamadingiz. Menyudan mavzuni tanlang 👇", { reply_markup: { inline_keyboard: kb } });
  const avg = agg.t ? Math.round((agg.c / agg.t) * 100) : 0;
  const ic = (p) => (p >= 86 ? "🏆" : p >= 70 ? "✅" : p >= 56 ? "🙂" : "📖");
  const lines = results.map((r) => { const p = Math.round((r.correct / r.total) * 100); return `${ic(p)} <b>${p}%</b> — ${esc(r.title)} · ${r.correct}/${r.total} · ${fmtT(r.at).slice(5, 10).split("-").reverse().join(".")}`; });
  return send(env, chat_id,
    `📈 <b>Natijalarim</b>\n\n${fire((await getStreak(env, chat_id)).streak)} Ketma-ket kunlar: <b>${(await getStreak(env, chat_id)).streak}</b>\n📝 Ishlangan testlar: <b>${agg.n}</b>\n🎯 O'rtacha natija: <b>${avg}%</b>\n🔁 Xato savollar: <b>${mc}</b>${await weakText(env, chat_id)}\n\n<b>Oxirgi natijalar:</b>\n${lines.join("\n")}\n\n📱 To'liq tahlil — ilovada: /ilova`,
    { reply_markup: { inline_keyboard: kb } });
}

// Sertifikat (SVG → wsrv.nl orqali PNG)
const BOT_URL = (env) => env.BOT_URL || "https://quizbot.yoldashaliisaqov8.workers.dev";
const b64u = (str) => btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (b) => decodeURIComponent(escape(atob(b.replace(/-/g, "+").replace(/_/g, "/"))));
async function sign(env, data) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode((env.WEBHOOK_SECRET || "") + "|" + data));
  return [...new Uint8Array(h)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const xml = (t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const USTOZ_PHOTO = "data:image/jpeg;base64,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";
const star8 = (cx, cy, R, r) => { let d = ""; for (let i = 0; i < 16; i++) { const a = (Math.PI / 8) * i - Math.PI / 2, rr = i % 2 ? r : R; d += (i ? "L" : "M") + (cx + rr * Math.cos(a)).toFixed(1) + " " + (cy + rr * Math.sin(a)).toFixed(1); } return d + "Z"; };
function certSvg(c) {
  const PHOTO = USTOZ_PHOTO;
  const xml = (t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const W = 1130, H = 1600, G = "#b8924a";
  const tile = `<pattern id="gt" width="80" height="80" patternUnits="userSpaceOnUse"><g fill="none" stroke="${G}" stroke-width="2"><path d="${star8(40, 40, 30, 16)}"/><path d="${star8(40, 40, 13, 7)}"/><path d="M0 0L14 14M80 0L66 14M0 80L14 66M80 80L66 66M40 0V10M40 80V70M0 40H10M80 40H70"/></g></pattern>`;
  const band = `<pattern id="gb" width="26" height="26" patternUnits="userSpaceOnUse"><path d="${star8(13, 13, 9, 4.5)}" fill="${G}" fill-opacity=".55"/></pattern>`;
  const fade = (id, cx, cy) => `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${430}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset=".7" stop-color="#fff" stop-opacity=".25"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`;
  const rosette = (x, y) => `<g transform="translate(${x} ${y})"><circle r="22" fill="#f6eedb" stroke="url(#gold)" stroke-width="3"/><path d="${star8(0, 0, 16, 7)}" fill="${G}"/></g>`;
  const row = (y, k, v, big) => `<text x="120" y="${y}" font-size="${big ? 30 : 27}" fill="#3a3326">${k}</text><text x="560" y="${y}" font-size="${big ? 32 : 28}" font-weight="bold" fill="#1d1a14">${xml(v)}</text>`;
  const title = String(c.t || "").slice(0, 60), tfs = title.length > 44 ? 24 : 28;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Serif, Liberation Serif, serif">
<defs>${tile}${band}${fade("f1", W, 0)}${fade("f2", 0, H)}
<radialGradient id="paper" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#fcf7ea"/><stop offset="1" stop-color="#eadcb8"/></radialGradient>
<linearGradient id="gold" x1="0" x2="1"><stop offset="0" stop-color="#8f6d2c"/><stop offset=".5" stop-color="#d9b965"/><stop offset="1" stop-color="#8f6d2c"/></linearGradient>
<mask id="m1"><rect width="${W}" height="${H}" fill="url(#f1)"/><rect width="${W}" height="${H}" fill="url(#f2)"/></mask>
<clipPath id="ph"><circle cx="565" cy="200" r="76"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="url(#paper)"/>
<rect width="${W}" height="${H}" fill="url(#gt)" mask="url(#m1)"/>
<g transform="translate(565 1010)" fill="none" stroke="${G}" stroke-opacity=".13" stroke-width="3"><path d="${star8(0, 0, 330, 180)}"/><path d="${star8(0, 0, 230, 125)}"/><circle r="120"/><path d="${star8(0, 0, 105, 55)}"/></g>
<path fill-rule="evenodd" fill="url(#gb)" d="M30 30H${W - 30}V${H - 30}H30Z M58 58V${H - 58}H${W - 58}V58Z"/>
<rect x="30" y="30" width="${W - 60}" height="${H - 60}" fill="none" stroke="url(#gold)" stroke-width="4"/>
<rect x="58" y="58" width="${W - 116}" height="${H - 116}" fill="none" stroke="url(#gold)" stroke-width="3"/>
<rect x="70" y="70" width="${W - 140}" height="${H - 140}" fill="none" stroke="${G}" stroke-width="1" stroke-opacity=".6"/>
${rosette(44, 44)}${rosette(W - 44, 44)}${rosette(44, H - 44)}${rosette(W - 44, H - 44)}
<circle cx="565" cy="200" r="86" fill="#fbf5e6" stroke="url(#gold)" stroke-width="5"/>
<image x="489" y="124" width="152" height="152" href="${PHOTO}" xlink:href="${PHOTO}" clip-path="url(#ph)" preserveAspectRatio="xMidYMid slice"/>
<text x="565" y="335" text-anchor="middle" font-size="30" font-weight="bold" letter-spacing="8" fill="#1d1a14" font-family="DejaVu Sans, sans-serif">ISAKOV SCHOOL</text>
<text x="565" y="372" text-anchor="middle" font-size="21" fill="#5a4f3a" font-family="DejaVu Sans, sans-serif">Ustoz Yo‘ldashali Isaqovning ta’lim loyihasi</text>
<rect x="120" y="402" width="890" height="4" fill="#1d1a14"/>
<path d="${star8(565, 404, 14, 6)}" fill="${G}" stroke="#fbf5e6" stroke-width="3"/>
<text x="565" y="475" text-anchor="middle" font-size="40" font-weight="bold" fill="#1d1a14">TEST NATIJASI</text>
<text x="565" y="522" text-anchor="middle" font-size="40" font-weight="bold" fill="#1d1a14">TO‘G‘RISIDA SERTIFIKAT</text>
<text x="120" y="600" font-size="26" fill="#3a3326">Sertifikat raqami:</text><text x="560" y="600" font-size="28" font-weight="bold" fill="#1d1a14">${xml(c.id)}</text>
<line x1="120" y1="635" x2="1010" y2="635" stroke="${G}" stroke-width="1.5"/>
${row(700, "Ism-familiya:", String(c.n || "").slice(0, 30))}
<text x="120" y="760" font-size="27" fill="#3a3326">Test:</text><text x="120" y="808" font-size="${tfs}" font-weight="bold" fill="#1d1a14">«${xml(title)}»</text>
<line x1="120" y1="850" x2="1010" y2="850" stroke="${G}" stroke-width="1.5"/>
${row(920, c.ck || "To‘g‘ri javoblar:", c.c + " / " + c.q)}
${row(985, "Natija:", c.p + " %", 1)}
${row(1050, c.lk || "Baho:", c.lv || "", 1)}
<line x1="120" y1="1290" x2="1010" y2="1290" stroke="${G}" stroke-width="1.5"/>
<text x="120" y="1350" font-size="24" fill="#3a3326">Berilgan sana: <tspan font-weight="bold" fill="#1d1a14">${xml(c.d)}</tspan></text>
<text x="1010" y="1350" text-anchor="end" font-size="24" fill="#3a3326">t.me/yoldashaliisakov</text>
<text x="565" y="1440" text-anchor="middle" font-size="26" fill="#3a3326">Ustoz <tspan font-weight="bold" fill="#1d1a14">Yo‘ldashali Isaqov</tspan></text>
<text x="565" y="1485" text-anchor="middle" font-size="19" fill="#6d6250" font-family="DejaVu Sans, sans-serif">Isakov school ilovasidagi mashq testi natijasi · rasmiy hujjat emas</text>
</svg>`;
}
async function sendCertificate(env, s, user, correct, pct) {
  const name = user ? ((user.first_name || "") + (user.last_name ? " " + user.last_name : "")).trim() || user.username || "O'quvchi" : "O'quvchi";
  const MSL = [["A+", 70], ["A", 65], ["B+", 60], ["B", 55], ["C+", 50], ["C", 46]];
  let ck = "", lk = "Baho:", lv = pct >= 86 ? "A'lo" : "Yaxshi";
  if (s.quiz_id === "sim-ms" || s.quiz_id === "sim-huquq") { const sc = Math.round(pct * 7.5) / 10; lk = "Daraja:"; ck = "Xom ball:"; lv = ((MSL.find((x) => sc >= x[1]) || ["—"])[0]) + " (taxminiy ball " + String(sc.toFixed(1)).replace(".", ",") + ")"; }
  if (s.quiz_id === "sim-att") { lk = "Toifa darajasi:"; lv = pct >= 80 ? "Oliy" : pct >= 70 ? "Birinchi" : "Ikkinchi"; }
  const c = { ...(ck ? { ck } : {}), lk, lv, n: name, t: s.title, p: pct, c: correct, q: s.total, d: dayKey().split("-").reverse().join("."), id: "IS-" + dayKey().replace(/-/g, "").slice(2) + "-" + String(s.chat_id).slice(-4) + Math.floor(Math.random() * 90 + 10) };
  const d = b64u(JSON.stringify(c));
  const svgUrl = `${BOT_URL(env)}/sert.svg?d=${d}&s=${await sign(env, d)}`;
  const png = `https://wsrv.nl/?url=${encodeURIComponent(svgUrl)}&output=png&w=1130`;
  const u = await botUser(env);
  const r = await tg(env, "sendPhoto", {
    chat_id: s.chat_id, photo: png, protect_content: false, parse_mode: "HTML",
    caption: `🎖 <b>Tabriklaymiz, ${esc(name)}!</b>\n\nSiz «${esc(s.title)}» testini <b>${pct}%</b> natija bilan topshirdingiz.\n\nSertifikatni do'stlaringizga ulashing! 👇`,
    reply_markup: { inline_keyboard: [[{ text: "📚 Isakov school — bepul testlar", url: `https://t.me/${u}` }]] },
  });
  if (!r.ok) await send(env, s.chat_id, `🎖 Sertifikatingiz: ${svgUrl}`, { protect_content: false });
  return { png, svg: svgUrl, bot: u };
}

// Guruhlarni eslab qolish va haftalik reyting
async function touchGroup(env, chat) {
  await ensureLearn(env);
  await env.DB.prepare("INSERT INTO groups (chat_id, title, last_seen) VALUES (?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title, last_seen=excluded.last_seen")
    .bind(chat.id, chat.title || "", Date.now()).run();
}
async function badgeMap(env, ids) {
  const m = new Map(); if (!ids.length) return m;
  await ensureRef(env);
  const { results } = await env.DB.prepare(`SELECT inviter, COUNT(*) n FROM referrals WHERE inviter IN (${ids.map(() => "?").join(",")}) GROUP BY inviter`).bind(...ids).all();
  for (const r of results) m.set(r.inviter, refBadge(r.n));
  return m;
}
async function weeklyText(env, gid) {
  await ensureLearn(env);
  const since = Date.now() - 7 * 86400000;
  const md = ["🥇", "🥈", "🥉"];
  let t = `🏆 <b>HAFTA G'OLIBLARI</b>\n<i>${fmtT(since).slice(0, 10).split("-").reverse().join(".")} – ${dayKey().split("-").reverse().join(".")}</i>\n`;
  if (gid) {
    const { results } = await env.DB.prepare(
      "SELECT user_id, MAX(name) name, SUM(correct) c, SUM(answered) a FROM scores WHERE chat_id=? AND session_id>=? GROUP BY user_id ORDER BY c DESC, a ASC LIMIT 10"
    ).bind(gid, String(since)).all();
    const bm = await badgeMap(env, results.map((r) => r.user_id));
    t += `\n🎯 <b>Guruh viktorinalari:</b>\n` + (results.length ? results.map((r, i) => `${md[i] || i + 1 + "."} ${esc(r.name || "—")}${bm.get(r.user_id) || ""} — <b>${r.c}</b> ta to'g'ri`).join("\n") : "Bu hafta guruhda viktorina bo'lmadi.") + "\n";
  }
  const { results: pr } = await env.DB.prepare(
    "SELECT r.user_id, MAX(u.name) name, SUM(r.correct) c, COUNT(*) n FROM results r LEFT JOIN users u ON u.user_id=r.user_id WHERE r.at>=? GROUP BY r.user_id ORDER BY c DESC LIMIT 5"
  ).bind(since).all();
  const bm2 = await badgeMap(env, pr.map((r) => r.user_id));
  if (pr.length) t += `\n🤖 <b>Botda eng ko'p ishlaganlar:</b>\n` + pr.map((r, i) => `${md[i] || i + 1 + "."} ${esc(r.name || "—")}${bm2.get(r.user_id) || ""} — <b>${r.c}</b> ta to'g'ri (${r.n} test)`).join("\n") + "\n";
  t += `\n👏 G'oliblarni tabriklaymiz! Keyingi haftada siz ham ro'yxatda bo'ling 💪`;
  return t;
}
async function weeklyPost(env) {
  await ensureLearn(env);
  const u = await botUser(env);
  const { results } = await env.DB.prepare("SELECT chat_id FROM groups WHERE last_seen>=?").bind(Date.now() - 30 * 86400000).all();
  for (const g of results) {
    await send(env, g.chat_id, await weeklyText(env, g.chat_id), { protect_content: false,
      reply_markup: { inline_keyboard: [[{ text: "📚 Testlarni ishlash", url: `https://t.me/${u}?start=menu` }]] } });
  }
  return results.length;
}
async function weeklyTick(env) {
  const now = new Date();
  if (new Date(Date.now() + TZ).getUTCDay() !== 0 || now.getUTCHours() !== 15) return; // yakshanba 20:00
  await ensureLock(env);
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='weekly_day'").first();
  if (r && r.v === dayKey()) return;
  await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('weekly_day', ?)").bind(dayKey()).run();
  const n = await weeklyPost(env);
  await send(env, OWNER(env), `🏆 Haftalik reyting ${n} ta guruhga yuborildi.`);
}


// ---------- Kun savoli ----------
const DQ_DEFAULT = { on: true, time: "09:00", secs: [], extra: [] };
let DQ_C = null, DQ_T = 0;
async function getDQ(env) {
  if (DQ_C && Date.now() - DQ_T < 300000) return DQ_C;
  await ensureLock(env);
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='dq'").first();
  DQ_C = r ? { ...DQ_DEFAULT, ...JSON.parse(r.v) } : DQ_DEFAULT; DQ_T = Date.now();
  return DQ_C;
}
async function saveDQ(env, c) {
  await ensureLock(env);
  await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('dq', ?)").bind(JSON.stringify(c)).run();
  DQ_C = c; DQ_T = Date.now();
}
async function pickDaily(env, secs) {
  const cat = await catalog(env);
  const def = (cat.groups || []).filter((g) => g.id !== "huquq").flatMap((g) => g.secs).filter((id) => id !== "attru");
  const ids = secs && secs.length ? secs : def;
  const pool = cat.sections.filter((x) => ids.includes(x.id)).flatMap((x) => x.tests.map((t) => ({ sec: x, t })));
  for (let k = 0; k < 6 && pool.length; k++) {
    const it = pool[Math.floor(Math.random() * pool.length)];
    let d; try { d = await fetchQuiz(env, it.t.n); } catch (e) { continue; }
    const ok = (d.questions || []).filter((q) => q.q && q.q.length <= 280 && q.options && q.options.length >= 2 && q.options.length <= 10 && q.options.every((o) => String(o).length <= 100));
    if (ok.length) return { q: ok[Math.floor(Math.random() * ok.length)], sec: it.sec, test: d.title || it.t.t };
  }
  return null;
}
async function sendDaily(env, chat_id, pick, isChannel) {
  const u = await botUser(env);
  const day = dayKey().split("-").reverse().join(".");
  const q = pick.q;
  const head = `☀️ <b>KUN SAVOLI</b> · ${day}\n${pick.sec.icon} ${esc(pick.sec.title)}\n\nJavobingizni belgilang 👇`;
  if (q.image) await tg(env, "sendPhoto", { chat_id, photo: new URL(q.image, env.QUIZ_BASE_URL).href, caption: head, parse_mode: "HTML", protect_content: false });
  else await send(env, chat_id, head, { protect_content: false });
  const body = {
    chat_id, question: "☀️ " + q.q.slice(0, 290), options: q.options.map((t) => ({ text: String(t).slice(0, 100) })),
    type: "quiz", is_anonymous: !!isChannel, correct_option_id: q.answer, protect_content: false,
    reply_markup: { inline_keyboard: [[{ text: "📚 Ko'proq testlar — Isakov school", url: `https://t.me/${u}?start=menu` }]] },
  };
  if (q.explanation) body.explanation = String(q.explanation).slice(0, 200);
  const r = await tg(env, "sendPoll", body);
  // Guruhda javoblar haftalik reytingga qo'shiladi
  if (r.ok && !isChannel)
    await env.DB.prepare("INSERT OR REPLACE INTO polls (poll_id, chat_id, session_id, idx, correct) VALUES (?,?,?,?,?)")
      .bind(r.result.poll.id, chat_id, String(Date.now()), 0, q.answer).run();
  return r.ok;
}
async function dailyTargets(env, c) {
  await ensureLearn(env);
  const { results } = await env.DB.prepare("SELECT chat_id FROM groups WHERE last_seen>=?").bind(Date.now() - 30 * 86400000).all();
  return [...results.map((g) => ({ id: g.chat_id, ch: false })), ...(c.extra || []).map((x) => ({ id: x, ch: true }))];
}
async function dailyPostAll(env) {
  const c = await getDQ(env);
  const pick = await pickDaily(env, c.secs);
  if (!pick) return 0;
  let n = 0;
  for (const t of await dailyTargets(env, c)) if (await sendDaily(env, t.id, pick, t.ch)) n++;
  return n;
}
async function dailyQTick(env) {
  const c = await getDQ(env);
  if (!c.on) return;
  const hm = new Date(Date.now() + TZ).toISOString().slice(11, 16);
  if (hm < c.time) return;
  if (hm > c.time && hm.slice(0, 2) !== c.time.slice(0, 2)) return; // faqat shu soat ichida
  await ensureLock(env);
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='dq_day'").first();
  if (r && r.v === dayKey()) return;
  await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('dq_day', ?)").bind(dayKey()).run();
  await dailyPostAll(env);
}
async function kunCmd(env, msg, text) {
  const chat = msg.chat.id;
  const parts = text.trim().split(/\s+/).slice(1);
  const c = { ...(await getDQ(env)) };
  const info = async () => {
    const tg_ = await dailyTargets(env, c);
    return `☀️ <b>Kun savoli: ${c.on ? "YOQIQ ✅" : "O'CHIQ"}</b>\n🕘 Vaqti: <b>${c.time}</b> (Toshkent)\n📚 Bo'limlar: ${c.secs.length ? esc(c.secs.join(", ")) : "Tarix + Attestatsiya (hammasi)"}\n📍 Qayerga: ${tg_.filter((x) => !x.ch).length} ta guruh${c.extra.length ? " + " + esc(c.extra.join(", ")) : ""}\n\n` +
      `<code>/kunsavoli 09:00</code> — vaqtni o'zgartirish\n<code>/kunsavoli off</code> · <code>/kunsavoli on</code>\n<code>/kunsavoli bolim att1213 t6</code> — faqat shu bo'limlardan (<code>/kunsavoli bolim hammasi</code>)\n<code>/kunsavoli kanal @kanal</code> — kanalga ham (<code>/kunsavoli kanal off</code>)\n<code>/kunsavoli sinov</code> — o'zingizga namuna\n<code>/kunsavoli hozir</code> — hammaga hoziroq yuborish`;
  };
  if (!parts.length) return send(env, chat, await info());
  const k = parts[0].toLowerCase();
  if (k === "sinov") { const pk = await pickDaily(env, c.secs); return pk ? sendDaily(env, chat, pk, false) : send(env, chat, "Savol topilmadi."); }
  if (k === "hozir") { const n = await dailyPostAll(env); return send(env, chat, `✅ Kun savoli ${n} ta joyga yuborildi.`); }
  if (k === "on" || k === "off") c.on = k === "on";
  else if (/^\d{1,2}:\d{2}$/.test(k)) { const [h, m] = k.split(":"); if (+h > 23 || +m > 59) return send(env, chat, "Vaqt noto'g'ri. Namuna: /kunsavoli 09:00"); c.time = h.padStart(2, "0") + ":" + m; }
  else if (k === "bolim" || k === "bo'lim") c.secs = parts[1] && parts[1] !== "hammasi" ? parts.slice(1) : [];
  else if (k === "kanal") c.extra = parts[1] && parts[1] !== "off" ? parts.slice(1).filter((x) => /^(@\w{4,}|-100\d+)$/.test(x)) : [];
  else return send(env, chat, await info());
  await saveDQ(env, c);
  return send(env, chat, "✅ Saqlandi.\n\n" + (await info()));
}


// ---------- O'qituvchilar rejimi: guruh natijalari jadvali ----------
let TCH_OK = false;
async function ensureTeach(env) {
  if (TCH_OK) return;
  TCH_OK = true;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS runs (chat_id INTEGER, session_id TEXT, starter INTEGER, title TEXT, total INTEGER, started INTEGER, PRIMARY KEY (chat_id, session_id))").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS answers (chat_id INTEGER, session_id TEXT, user_id INTEGER, idx INTEGER, ok INTEGER, PRIMARY KEY (chat_id, session_id, user_id, idx))").run();
}
async function recordRun(env, chat_id, sid, starter, title, total) {
  await ensureTeach(env);
  await env.DB.prepare("INSERT OR REPLACE INTO runs (chat_id, session_id, starter, title, total, started) VALUES (?,?,?,?,?,?)")
    .bind(chat_id, sid, starter, title, total, Date.now()).run();
}
async function recordAnswer(env, p, uid, ok) {
  if (p.chat_id >= 0) return;
  await ensureTeach(env);
  await env.DB.prepare("INSERT OR IGNORE INTO answers (chat_id, session_id, user_id, idx, ok) VALUES (?,?,?,?,?)").bind(p.chat_id, p.session_id, uid, p.idx, ok).run();
}
const baho5 = (p) => (p >= 86 ? 5 : p >= 71 ? 4 : p >= 56 ? 3 : 2);
async function buildRunCsv(env, chat_id, sid) {
  await ensureTeach(env);
  const run = await env.DB.prepare("SELECT * FROM runs WHERE chat_id=? AND session_id=?").bind(chat_id, sid).first();
  if (!run) return null;
  const g = await env.DB.prepare("SELECT title FROM groups WHERE chat_id=?").bind(chat_id).first().catch(() => null);
  const { results: sc } = await env.DB.prepare("SELECT user_id, name, correct, answered FROM scores WHERE chat_id=? AND session_id=? ORDER BY correct DESC, answered ASC").bind(chat_id, sid).all();
  const { results: an } = await env.DB.prepare("SELECT user_id, idx, ok FROM answers WHERE chat_id=? AND session_id=?").bind(chat_id, sid).all();
  const m = new Map();
  for (const a of an) { if (!m.has(a.user_id)) m.set(a.user_id, {}); m.get(a.user_id)[a.idx] = a.ok; }
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["№", "O'quvchi", "To'g'ri", "Javob bergan", "Jami savol", "Foiz %", "Baho"];
  for (let i = 1; i <= run.total; i++) head.push(`${i}-savol`);
  const rows = [
    [`Test: ${run.title}`], [`Guruh: ${(g && g.title) || chat_id}`], [`Sana: ${fmtT(run.started)}`], [`Qatnashchilar: ${sc.length} nafar`], [], head,
  ];
  sc.forEach((r, i) => {
    const pct = Math.round((r.correct / run.total) * 100);
    const row = [i + 1, r.name, r.correct, r.answered, run.total, pct, baho5(pct)];
    const a = m.get(r.user_id) || {};
    for (let k = 0; k < run.total; k++) row.push(a[k] === 1 ? "+" : a[k] === 0 ? "-" : "");
    rows.push(row);
  });
  if (sc.length) {
    const st = ["", "Savol bo'yicha to'g'ri %", "", "", "", "", ""];
    for (let k = 0; k < run.total; k++) {
      const v = an.filter((x) => x.idx === k);
      st.push(v.length ? Math.round((v.filter((x) => x.ok).length / v.length) * 100) + "%" : "");
    }
    rows.push([], st);
  }
  return { run, csv: "﻿" + rows.map((r) => r.map(cell).join(";")).join("\r\n"), n: sc.length };
}
async function sendRunCsv(env, to, chat_id, sid) {
  const b = await buildRunCsv(env, chat_id, sid);
  if (!b) return { ok: false };
  const fd = new FormData();
  fd.append("chat_id", String(to));
  fd.append("caption", `📊 «${b.run.title}» natijalari — ${b.n} nafar o'quvchi\n(+ to'g'ri, - xato, bo'sh — javob bermagan; oxirgi qatorda har bir savol bo'yicha foiz)`);
  fd.append("document", new Blob([b.csv], { type: "text/csv" }), `natijalar-${fmtT(b.run.started).slice(0, 10)}-${String(b.run.title).replace(/[^\wА-яЁё-]+/g, "_").slice(0, 40)}.csv`);
  const r = await fetch(API(env, "sendDocument"), { method: "POST", body: fd });
  const j = await r.json().catch(() => ({}));
  return { ok: !!j.ok };
}
async function teacherReport(env, s) {
  await ensureTeach(env);
  const run = await env.DB.prepare("SELECT starter FROM runs WHERE chat_id=? AND session_id=?").bind(s.chat_id, s.session_id).first();
  if (!run) return;
  const u = await botUser(env);
  const sent = run.starter ? (await sendRunCsv(env, run.starter, s.chat_id, s.session_id)).ok : false;
  if (sent) return send(env, s.chat_id, "📊 Batafsil natijalar jadvali (Excel) o'qituvchiga shaxsiy xabarda yuborildi.");
  return send(env, s.chat_id, "📊 O'qituvchi uchun batafsil natijalar jadvali tayyor:", {
    reply_markup: { inline_keyboard: [[{ text: "📥 Jadvalni olish (faqat adminlar)", url: `https://t.me/${u}?start=res_${String(s.chat_id).replace("-", "m")}_${s.session_id}` }]] },
  });
}
async function adminOf(env, chat_id, uid) {
  const r = await tg(env, "getChatMember", { chat_id, user_id: uid });
  return r.ok && ["creator", "administrator"].includes(r.result.status);
}
async function teacherGuide(env, chat_id) {
  const u = await botUser(env);
  return send(env, chat_id,
    `👩‍🏫 <b>O'qituvchilar uchun</b>\n\nSinfingiz bilan test o'tkazing — natijalar avtomatik jadval bo'lib keladi:\n\n` +
    `1️⃣ Pastdagi tugma orqali botni <b>sinf guruhingizga</b> qo'shing.\n` +
    `2️⃣ Guruhga <b>/boshla</b> deb yozing va mavzuni tanlang.\n` +
    `3️⃣ O'quvchilar javob beradi, vaqt tugagach keyingi savol o'zi chiqadi.\n` +
    `4️⃣ Oxirida guruhga reyting, <b>sizga esa Excel jadval</b> keladi: har bir o'quvchining natijasi, foizi, bahosi va har bir savolga javobi.\n\n` +
    `📌 Oxirgi test jadvalini qayta olish: guruhda <b>/natijalar</b>\n📌 Har kuni avtomatik "Kun savoli" va har yakshanba "Hafta g'oliblari" ham chiqadi.\n\n` +
    `<i>Bepul. ${430}+ ta test: attestatsiya, Milliy sertifikat, 6–9-sinf tarix, huquq.</i>`,
    { reply_markup: { inline_keyboard: [[{ text: "➕ Botni guruhga qo'shish", url: `https://t.me/${u}?startgroup=true` }]] }, protect_content: false });
}


// ---------- Do'stni taklif qilish (referal) ----------
const REF_DEFAULT = { need: 3, secs: [] };
let REF_OK = false, REF_C = null, REF_T = 0;
async function ensureRef(env) {
  if (REF_OK) return;
  REF_OK = true;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS referrals (invitee INTEGER PRIMARY KEY, inviter INTEGER, at INTEGER)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS referrals_inviter ON referrals(inviter)").run();
}
async function getRef(env) {
  if (REF_C && Date.now() - REF_T < 60000) return REF_C;
  await ensureLock(env);
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='ref'").first();
  REF_C = r ? { ...REF_DEFAULT, ...JSON.parse(r.v) } : REF_DEFAULT; REF_T = Date.now();
  return REF_C;
}
async function refCount(env, uid) {
  await ensureRef(env);
  const r = await env.DB.prepare("SELECT COUNT(*) n FROM referrals WHERE inviter=?").bind(uid).first();
  return r ? r.n : 0;
}
const refBadge = (n) => (n >= 10 ? " 🌟" : n >= 3 ? " ⭐" : "");
async function refLink(env, uid) { return `https://t.me/${await botUser(env)}?start=ref_${uid}`; }
// Yangi foydalanuvchi /start ref_X bilan kirsa
async function handleReferral(env, msg, isNew) {
  const m = (msg.text || "").match(/^\/start(?:@\w+)?\s+ref_(\d+)/);
  if (!m || !isNew) return;
  const inviter = Number(m[1]);
  if (!inviter || inviter === msg.from.id) return;
  await ensureRef(env);
  const r = await env.DB.prepare("INSERT OR IGNORE INTO referrals (invitee, inviter, at) VALUES (?,?,?)").bind(msg.from.id, inviter, Date.now()).run();
  if (!r.meta || r.meta.changes !== 1) return;
  const n = await refCount(env, inviter);
  const R = await getRef(env);
  const nm = ((msg.from.first_name || "") + (msg.from.last_name ? " " + msg.from.last_name : "")).trim() || "Do'stingiz";
  let t = `🎉 <b>${esc(nm)}</b> sizning havolangiz orqali botga qo'shildi!\n\n👥 Taklif qilganlaringiz: <b>${n}</b>`;
  if (R.secs.length) t += n >= R.need ? (n === R.need ? `\n\n🔓 <b>Tabriklaymiz!</b> Yopiq bo'limlar siz uchun ochildi!` : "") : `\n🎁 Yopiq bo'limlar ochilishiga yana <b>${R.need - n}</b> ta do'st qoldi.`;
  if (n === 3 || n === 10) t += `\n\n${refBadge(n).trim()} Sizga reytingda «${n >= 10 ? "Oltin elchi 🌟" : "Elchi ⭐"}» belgisi berildi!`;
  await send(env, inviter, t).catch(() => {});
}
async function refGate(env, user, chat_id, secId) {
  if (String(user.id) === OWNER(env)) return true;
  const R = await getRef(env);
  if (!R.secs.length || secId === "*" || !R.secs.includes(secId)) return true;
  const n = await refCount(env, user.id);
  if (n >= R.need) return true;
  await showReferral(env, chat_id, user, `🔒 <b>Bu bo'lim do'stlarini taklif qilganlar uchun ochiq.</b>\nBotga <b>${R.need} ta</b> do'stingizni taklif qiling — bo'lim siz uchun avtomatik ochiladi.\n\n`);
  return false;
}
async function showReferral(env, chat_id, user, prefix = "") {
  const n = await refCount(env, user.id);
  const R = await getRef(env);
  const link = await refLink(env, user.id);
  const cat = await catalog(env).catch(() => ({ sections: [] }));
  const names = R.secs.map((id) => { const x = cat.sections.find((y) => y.id === id); return x ? `${x.icon} ${x.title}` : id; });
  const bar = R.secs.length ? "🟩".repeat(Math.min(n, R.need)) + "⬜".repeat(Math.max(0, R.need - n)) : "";
  let t = prefix + `🎁 <b>Do'stlaringizni taklif qiling!</b>\n\nSizning shaxsiy havolangiz:\n${link}\n\n👥 Taklif qilganlaringiz: <b>${n}</b> ${bar}\n`;
  if (R.secs.length) t += n >= R.need ? `🔓 Yopiq bo'limlar siz uchun ochiq:\n${names.map((x) => "• " + esc(x)).join("\n")}\n` : `🔒 ${R.need} ta do'st taklif qilsangiz, ochiladi:\n${names.map((x) => "• " + esc(x)).join("\n")}\n`;
  t += `\n⭐ 3 ta do'st — «Elchi» belgisi, 🌟 10 ta — «Oltin elchi».\n<i>Do'stingiz havola orqali botga birinchi marta kirsa hisoblanadi.</i>`;
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("📚 Attestatsiya, Milliy sertifikat va tarix testlari — bepul! Isakov school botida ishlang 👇")}`;
  return send(env, chat_id, t, { protect_content: false, disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: "📤 Do'stlarga yuborish", url: share }], [await btn(env, chat_id, "📚 Testlar menyusi", "m", "menu")]] } });
}
async function referalCmd(env, msg, text) {
  const chat = msg.chat.id;
  const parts = text.trim().split(/\s+/).slice(1);
  await ensureRef(env);
  const R = { ...(await getRef(env)) };
  if (parts.length) {
    if (parts[0].toLowerCase() === "off") R.secs = [];
    else if (/^\d+$/.test(parts[0])) { R.need = Math.max(1, Math.min(50, +parts[0])); if (parts.length > 1) R.secs = parts.slice(1); }
    await ensureLock(env);
    await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('ref', ?)").bind(JSON.stringify(R)).run();
    REF_T = 0;
  }
  const tot = await env.DB.prepare("SELECT COUNT(*) n FROM referrals").first();
  const wk = await env.DB.prepare("SELECT COUNT(*) n FROM referrals WHERE at>=?").bind(Date.now() - 7 * 86400000).first();
  const { results } = await env.DB.prepare("SELECT r.inviter, COUNT(*) n, MAX(u.name) name, MAX(u.username) un FROM referrals r LEFT JOIN users u ON u.user_id=r.inviter GROUP BY r.inviter ORDER BY n DESC LIMIT 15").all();
  const top = results.map((r, i) => `${i + 1}. ${esc(r.name || String(r.inviter))}${r.un ? " @" + esc(r.un) : ""} — <b>${r.n}</b>${refBadge(r.n)}`).join("\n") || "Hali yo'q.";
  return send(env, chat,
    `🎁 <b>Referal tizimi</b>\n\n👥 Jami taklif orqali kelganlar: <b>${tot.n}</b> (7 kunda: ${wk.n})\n🔒 Yopiq bo'limlar: ${R.secs.length ? esc(R.secs.join(", ")) + ` — ${R.need} ta do'st kerak` : "yo'q (faqat belgilar beriladi)"}\n\n🏆 <b>Eng ko'p taklif qilganlar:</b>\n${top}\n\n` +
    `<code>/referal 3 att1213 att13</code> — shu bo'limlarni 3 ta do'stga yopish\n<code>/referal off</code> — yopiq bo'limlarni bekor qilish`);
}


// ---------- Qidiruv ----------
const STOPW = new Set("qaysi bilan uchun yilda aniqlang toping topin javob berilgan quyidagi ularning ushbu davrida hamda yillarda qanday nima kimning kim nechta asrda asrning bo'lgan bolgan edi etdi qilgan yil yili tomonidan haqida".split(" "));
const normTok = (s) => (String(s).toLowerCase().replace(/[‘’ʻʼ`´'"]/g, "").match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length >= 3 && !STOPW.has(t));
function shardOf(key) {
  let h = 5381;
  for (const ch of key.slice(0, 2)) h = (((h * 33) >>> 0) ^ ch.codePointAt(0)) >>> 0;
  return (h % 256).toString(16).padStart(2, "0");
}
const SCACHE = new Map();
async function sfetch(env, f) {
  const c = SCACHE.get(f);
  if (c && Date.now() - c.t < 1800000) return c.d;
  const r = await fetch(new URL("s/" + f, env.QUIZ_BASE_URL).href);
  const d = r.ok ? await r.json() : (f === "tests.json" ? [] : {});
  SCACHE.set(f, { d, t: Date.now() });
  if (SCACHE.size > 60) SCACHE.delete(SCACHE.keys().next().value);
  return d;
}
async function searchIds(env, query) {
  const toks = [...new Set(normTok(query))].slice(0, 4);
  if (!toks.length) return { ids: [], toks };
  const sets = [];
  for (const t of toks) {
    const key = t.slice(0, 6);
    const sh = await sfetch(env, shardOf(key) + ".json");
    const set = new Set();
    for (const k in sh) if (k === key || (key.length < 6 && k.startsWith(key))) for (const id of sh[k]) set.add(id);
    sets.push(set);
  }
  const cnt = new Map();
  for (const st of sets) for (const id of st) cnt.set(id, (cnt.get(id) || 0) + 1);
  const ids = [...cnt.entries()].sort((a, b) => b[1] - a[1]).filter((e, _, arr) => e[1] === arr[0][1]).map((e) => e[0]);
  return { ids, toks };
}
async function doSearch(env, chat_id, user, query) {
  query = String(query || "").trim().slice(0, 60);
  if (normTok(query).length === 0) return send(env, chat_id, "🔍 Qidirish uchun mavzu yoki atamani yozing.\nMasalan: <code>Amir Temur</code>, <code>Jaloliddin</code>, <code>Kushon</code>");
  const { ids } = await searchIds(env, query);
  const names = await sfetch(env, "tests.json");
  if (!ids.length) return send(env, chat_id, `🔍 «${esc(query)}» bo'yicha hech narsa topilmadi.\nBoshqa so'z bilan urinib ko'ring.`);
  const byTest = new Map();
  for (const id of ids) { const n = names[Math.floor(id / 1000)]; if (n) byTest.set(n, (byTest.get(n) || 0) + 1); }
  const cat = await catalog(env);
  const all = cat.sections.flatMap((x) => x.tests.map((t) => ({ ...t, sec: x })));
  const top = [...byTest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const kb = [[{ text: `▶️ Topilgan savollardan test (${Math.min(ids.length, 30)})`, callback_data: ("sq:" + query).slice(0, 60) }]];
  for (const [n, c] of top) { const t = all.find((x) => x.n === n); if (t) kb.push([await btn(env, chat_id, `${t.sec.icon} ${t.t}`.slice(0, 50) + ` · ${c}`, `q:${n}`, n)]); }
  await bump(env, "_qidiruv");
  return send(env, chat_id, `🔍 <b>«${esc(query)}»</b>\n\nTopildi: <b>${ids.length}</b> ta savol · <b>${byTest.size}</b> ta testda\n\nTopilgan savollardan test tuzing yoki mos testni tanlang 👇`, { reply_markup: { inline_keyboard: kb } });
}
async function startSearchQuiz(env, chat_id, user, query) {
  if (user && !(await gate(env, user, chat_id, "*", "m"))) return;
  const { ids } = await searchIds(env, query);
  const names = await sfetch(env, "tests.json");
  if (!ids.length) return send(env, chat_id, "Topilmadi.");
  const byTest = new Map();
  for (const id of ids) { const n = names[Math.floor(id / 1000)]; if (!n) continue; if (!byTest.has(n)) byTest.set(n, []); byTest.get(n).push(id % 1000); }
  const tests = [...byTest.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8);
  const qs = [];
  for (const [n, idxs] of tests) {
    let d; try { d = await fetchQuiz(env, n); } catch (e) { continue; }
    for (const i of idxs) if (d.questions[i]) qs.push({ ...d.questions[i], src: [n, i] });
  }
  for (let i = qs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [qs[i], qs[j]] = [qs[j], qs[i]]; }
  await env.DB.prepare("UPDATE sessions SET running=0 WHERE chat_id=? AND running=1").bind(chat_id).run();
  await startWithQuestions(env, chat_id, "qidiruv", `🔍 «${query}» bo'yicha test`, qs.slice(0, 30), 30);
}

// ---------- Eslatmalar va 🔥 ketma-ketlik ----------
let RM_OK = false;
async function ensureRemind(env) {
  if (RM_OK) return;
  RM_OK = true;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS remind (user_id INTEGER PRIMARY KEY, hhmm TEXT, active INTEGER DEFAULT 0, streak INTEGER DEFAULT 0, best INTEGER DEFAULT 0, last_day TEXT, sent_day TEXT)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS remind_time ON remind(hhmm, active)").run();
}
const prevDay = () => dayKey(Date.now() - 86400000);
async function getStreak(env, uid) {
  await ensureRemind(env);
  const r = await env.DB.prepare("SELECT * FROM remind WHERE user_id=?").bind(uid).first();
  if (!r) return { streak: 0, best: 0, active: 0, hhmm: null };
  const alive = r.last_day === dayKey() || r.last_day === prevDay();
  return { ...r, streak: alive ? r.streak : 0 };
}
async function bumpStreak(env, uid) {
  await ensureRemind(env);
  const r = await env.DB.prepare("SELECT streak, best, last_day FROM remind WHERE user_id=?").bind(uid).first();
  const today = dayKey();
  if (r && r.last_day === today) return null;
  const st = r && r.last_day === prevDay() ? r.streak + 1 : 1;
  const best = Math.max(st, (r && r.best) || 0);
  await env.DB.prepare(`INSERT INTO remind (user_id, streak, best, last_day) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET streak=excluded.streak, best=excluded.best, last_day=excluded.last_day`).bind(uid, st, best, today).run();
  return st;
}
const fire = (n) => (n >= 100 ? "👑" : n >= 30 ? "💎" : "🔥");
async function remindMenu(env, chat_id, user) {
  const r = await getStreak(env, user.id);
  const times = ["07:00", "12:00", "18:00", "20:00", "21:00", "22:00"];
  const kb = [times.slice(0, 3).map((t) => ({ text: (r.active && r.hhmm === t ? "✅ " : "") + t, callback_data: "rm:" + t })),
    times.slice(3).map((t) => ({ text: (r.active && r.hhmm === t ? "✅ " : "") + t, callback_data: "rm:" + t }))];
  if (r.active) kb.push([{ text: "🔕 Eslatmani o'chirish", callback_data: "rm:off" }]);
  kb.push([{ text: "▶️ Bugungi 10 ta savol", callback_data: "d10" }]);
  return send(env, chat_id,
    `⏰ <b>Kunlik eslatma</b>\n\n${r.active ? `Hozir: har kuni <b>${r.hhmm}</b> da ✅` : "Hozir o'chiq."}\n${fire(r.streak)} Ketma-ket kunlar: <b>${r.streak}</b> (eng yaxshi: ${r.best || 0})\n\n` +
    `Vaqtni tanlang — har kuni shu paytda <b>10 ta savol</b> yuboraman. Boshqa vaqt: <code>/eslatma 19:30</code>\n\n🔥 7 kun · 💎 30 kun · 👑 100 kun — belgilar!`,
    { reply_markup: { inline_keyboard: kb } });
}
async function setRemind(env, chat_id, user, hhmm) {
  await ensureRemind(env);
  if (hhmm === "off") {
    await env.DB.prepare("UPDATE remind SET active=0 WHERE user_id=?").bind(user.id).run();
    return send(env, chat_id, "🔕 Eslatma o'chirildi. Qayta yoqish: /eslatma");
  }
  await env.DB.prepare("INSERT INTO remind (user_id, hhmm, active) VALUES (?,?,1) ON CONFLICT(user_id) DO UPDATE SET hhmm=excluded.hhmm, active=1").bind(user.id, hhmm).run();
  return send(env, chat_id, `✅ Har kuni <b>${hhmm}</b> da 10 ta savol yuboraman. Ketma-ketlikni uzmang 🔥`);
}
async function remindTick(env) {
  await ensureRemind(env);
  const hm = new Date(Date.now() + TZ).toISOString().slice(11, 16), today = dayKey();
  const { results } = await env.DB.prepare("SELECT user_id FROM remind WHERE hhmm=? AND active=1 AND (sent_day IS NULL OR sent_day<>?) LIMIT 600").bind(hm, today).all();
  if (!results.length) return;
  await env.DB.prepare("UPDATE remind SET sent_day=? WHERE hhmm=? AND active=1").bind(today, hm).run();
  const ids = results.map((r) => r.user_id);
  for (let i = 0; i < ids.length; i += 15) {
    const body = { t: "rm", ids: ids.slice(i, i + 15) };
    if (env.TIMER) await env.TIMER.send(body, { delaySeconds: Math.floor(i / 15) * 3 }); else await runRemindBatch(env, body);
  }
}
async function runRemindBatch(env, b) {
  for (const uid of b.ids) {
    const r = await getStreak(env, uid);
    const doneToday = r.last_day === dayKey();
    if (doneToday) continue;
    const res = await send(env, uid, r.streak
      ? `${fire(r.streak)} <b>${r.streak}-kun ketma-ket!</b> Zanjirni uzmang — bugungi 10 ta savolingiz tayyor 👇`
      : "☀️ <b>Bugungi 10 ta savolingiz tayyor!</b> 5 daqiqada bilimingizni yangilang 👇",
      { reply_markup: { inline_keyboard: [[{ text: "▶️ Boshlash", callback_data: "d10" }], [{ text: "⏰ Eslatma sozlamalari", callback_data: "rmm" }]] } });
    if (!res.ok && res.error_code === 403) { await env.DB.prepare("UPDATE remind SET active=0 WHERE user_id=?").bind(uid).run(); await env.DB.prepare("UPDATE users SET blocked=1 WHERE user_id=?").bind(uid).run().catch(() => {}); }
    await new Promise((x) => setTimeout(x, 40));
  }
}
async function startDaily10(env, chat_id, user) {
  if (user && !(await gate(env, user, chat_id, "*", "d10"))) return;
  await ensureLearn(env);
  const qs = [];
  const { results: ms } = await env.DB.prepare("SELECT quiz_id, idx FROM mistakes WHERE user_id=? ORDER BY at DESC LIMIT 40").bind(chat_id).all();
  const mq = [...new Set(ms.map((r) => r.quiz_id))].slice(0, 3);
  for (const qid of mq) {
    let d; try { d = await fetchQuiz(env, qid); } catch (e) { continue; }
    for (const r of ms.filter((x) => x.quiz_id === qid)) if (d.questions[r.idx] && qs.length < 5) qs.push({ ...d.questions[r.idx], src: [qid, r.idx] });
  }
  const { results: rs } = await env.DB.prepare("SELECT quiz_id FROM results WHERE user_id=? ORDER BY at DESC LIMIT 20").bind(chat_id).all();
  const cat = await catalog(env);
  const secIds = new Set();
  for (const r of rs) for (const x of cat.sections) if (x.tests.some((t) => t.n === r.quiz_id)) secIds.add(x.id);
  let pool = cat.sections.filter((x) => (secIds.size ? secIds.has(x.id) : x.id !== "attru")).flatMap((x) => x.tests.map((t) => t.n));
  if (!pool.length) pool = cat.sections.flatMap((x) => x.tests.map((t) => t.n));
  for (let k = 0; k < 4 && qs.length < 10; k++) {
    const n = pool[Math.floor(Math.random() * pool.length)];
    let d; try { d = await fetchQuiz(env, n); } catch (e) { continue; }
    const idxs = d.questions.map((_, i) => i).sort(() => Math.random() - 0.5).slice(0, Math.max(2, Math.ceil((10 - qs.length) / (4 - k))));
    for (const i of idxs) if (qs.length < 10) qs.push({ ...d.questions[i], src: [n, i] });
  }
  if (!qs.length) return send(env, chat_id, "Savollar topilmadi.");
  await env.DB.prepare("UPDATE sessions SET running=0 WHERE chat_id=? AND running=1").bind(chat_id).run();
  await startWithQuestions(env, chat_id, "kun10", "🔥 Bugungi 10 ta savol", qs, 30);
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
  if (msg.chat.type === "private" && msg.from) {
    let isNew = false;
    if (/^\/start(@\w+)?\s+ref_/.test(text)) { await ensureUsers(env); isNew = !(await env.DB.prepare("SELECT 1 FROM users WHERE user_id=?").bind(msg.from.id).first()); }
    await touchUser(env, msg.from);
    if (isNew) await handleReferral(env, msg, true).catch((e) => console.log("referal", e));
  }
  if ((msg.chat.type === "group" || msg.chat.type === "supergroup") && text.startsWith("/")) await touchGroup(env, msg.chat).catch(() => {});
  if (msg.chat.type === "private" && isOwner(env, msg)) {
    const t0 = (msg.text || "").trim().split(/\s+/)[0].split("@")[0].toLowerCase();
    if (t0 === "/bekor") { await ensureLock(env); await env.DB.prepare("DELETE FROM settings WHERE k IN ('bc_wait','kanal_wait','kanal_pending')").run(); return send(env, msg.chat.id, "❌ Bekor qilindi."); }
    if (t0 === "/kanal") return kanalStart(env, msg, msg.text || "");
    if (!t0.startsWith("/") || msg.photo) {
      await ensureLock(env);
      const kw = await env.DB.prepare("SELECT v FROM settings WHERE k='kanal_wait'").first();
      if (kw) return kanalPrepare(env, msg.chat.id, msg.text || msg.caption || "", msg.photo ? msg.photo[msg.photo.length - 1].file_id : null, kw.v);
    }
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
    if (t0 === "/hisobot") return dailyReport(env, msg.chat.id);
    if (t0 === "/referal") return referalCmd(env, msg, msg.text || "");
    if (t0 === "/kunsavoli") return kunCmd(env, msg, msg.text || "");
    if (t0 === "/haftalik") {
      if ((msg.text || "").includes("yubor")) { const n = await weeklyPost(env); return send(env, msg.chat.id, `✅ Haftalik reyting ${n} ta guruhga yuborildi.`); }
      return send(env, msg.chat.id, (await weeklyText(env, null)) + "\n\n<i>Guruhlarga hoziroq yuborish: /haftalik yubor (har yakshanba 20:00 da o'zi yuboriladi)</i>");
    }
    if (t0 === "/admin" || t0 === "/panel") return adminPanel(env, msg.chat.id);
  }
  const fch = msg.forward_from_chat || (msg.forward_origin && msg.forward_origin.chat);
  if (msg.chat.type === "private" && fch && msg.from && String(msg.from.id) === OWNER(env)) {
    const r = await tg(env, "getChatMember", { chat_id: fch.id, user_id: (await tg(env, "getMe", {})).result.id });
    const adm = r.ok && ["administrator", "creator"].includes(r.result.status);
    return send(env, msg.chat.id,
      `📢 <b>${esc(fch.title || "")}</b>\nID: <code>${fch.id}</code>${fch.username ? "\nUsername: @" + fch.username : ""}\nBot bu kanalda admin: ${adm ? "HA ✅" : "YO'Q ❌ — avval admin qiling"}\n\nObunaga qo'shish uchun (taklif havolasini o'zingiznikiga almashtiring):\n<code>/obuna hammasi @yoldashaliisakov ${fch.id} https://t.me/+taklif</code>`);
  }
  if (!text.startsWith("/")) {
    if (msg.chat.type === "private" && text && msg.from) {
      if (!(await tryPassword(env, msg))) await doSearch(env, msg.chat.id, msg.from, text);
    }
    return;
  }
  const [cmdRaw, arg] = text.trim().split(/\s+/, 2);
  const cmd = cmdRaw.split("@")[0].toLowerCase();
  const chat_id = msg.chat.id;

  if (cmd === "/start" && msg.chat.type === "private") {
    if (arg && arg.startsWith("ref_")) return showMain(env, chat_id, null, msg.from);
    if (arg === "taklif") return showReferral(env, chat_id, msg.from);
    if (arg && arg.startsWith("app_")) return appOpen(env, chat_id, arg.slice(4));
    if (arg && arg.startsWith("sinf_")) return joinClass(env, chat_id, msg.from, arg.slice(5));
    if (arg === "natija") return myResults(env, chat_id, msg.from);
    if (arg === "eslatma") return remindMenu(env, chat_id, msg.from);
    if (arg === "kun10") return startDaily10(env, chat_id, msg.from);
    if (arg === "oqituvchi") return teacherGuide(env, chat_id);
    if (arg && arg.startsWith("res_")) {
      const [, gc, sid] = arg.split("_"); const gid = Number(gc.replace("m", "-"));
      if (!(await adminOf(env, gid, msg.from.id))) return send(env, chat_id, "⛔ Jadvalni faqat shu guruh adminlari olishi mumkin.");
      const r = await sendRunCsv(env, chat_id, gid, sid);
      return r.ok ? null : send(env, chat_id, "Natijalar topilmadi.");
    }
    if (arg === "xato") return startMistakes(env, chat_id, msg.from);
    if (arg && arg.startsWith("g_")) return showGroup(env, chat_id, null, arg.slice(2), msg.from);
    if (arg && arg.startsWith("sp_")) { const [id, pg] = arg.slice(3).split("_"); return showSection(env, chat_id, null, id, +pg || 0, msg.from, true); }
    if (arg && arg.startsWith("p_")) return sendPdf(env, chat_id, arg.slice(2), msg.from);
    if (arg && arg.startsWith("s_")) { const [id, pg] = arg.slice(2).split("_"); return showSection(env, chat_id, null, id, +pg || 0, msg.from); }
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
    if (!arg && msg.chat.type !== "private") return showMain(env, chat_id, null, null);
    if (!arg || !/^[\w-]+$/.test(arg)) return send(env, chat_id, "Test nomini yozing: /quiz tarix1");
    if (msg.chat.type === "private") return startPrivate(env, chat_id, arg, msg.from);
    const err = await startQuiz(env, chat_id, arg, msg.from && msg.from.id);
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

  if ((cmd === "/boshla" || cmd === "/mavzu") && msg.chat.type !== "private") {
    if (!(await isAdmin(env, msg))) return;
    return showMain(env, chat_id, null, null);
  }

  if ((cmd === "/natijalarim" || cmd === "/natija") && msg.chat.type === "private") return myResults(env, chat_id, msg.from);
  if ((cmd === "/xatolarim" || cmd === "/xatolar") && msg.chat.type === "private") return startMistakes(env, chat_id, msg.from);

  if (cmd === "/oqituvchi" || cmd === "/teacher") return teacherGuide(env, chat_id);
  if (cmd === "/ilova" && msg.chat.type === "private") return appCmd(env, chat_id);
  if (cmd === "/havola" && String(msg.from && msg.from.id) === OWNER(env)) return havolaCmd(env, chat_id, (text.split(/\s+/)[1] || "").trim());
  if (cmd === "/qidir" && msg.chat.type === "private") return doSearch(env, chat_id, msg.from, text.replace(/^\/qidir(@\w+)?\s*/, ""));
  if (cmd === "/kun10" && msg.chat.type === "private") return startDaily10(env, chat_id, msg.from);
  if (cmd === "/eslatma" && msg.chat.type === "private") {
    const m = text.match(/(\d{1,2}):(\d{2})/);
    if (m && +m[1] < 24 && +m[2] < 60) return setRemind(env, chat_id, msg.from, m[1].padStart(2, "0") + ":" + m[2]);
    if (/off|o'chir/i.test(text)) return setRemind(env, chat_id, msg.from, "off");
    return remindMenu(env, chat_id, msg.from);
  }
  if ((cmd === "/taklif" || cmd === "/dost") && msg.chat.type === "private") return showReferral(env, chat_id, msg.from);
  if (cmd === "/natijalar" && msg.chat.type !== "private") {
    if (!(await isAdmin(env, msg))) return;
    await ensureTeach(env);
    const last = await env.DB.prepare("SELECT session_id FROM runs WHERE chat_id=? ORDER BY started DESC LIMIT 1").bind(chat_id).first();
    if (!last) return send(env, chat_id, "Bu guruhda hali test o'tkazilmagan.");
    const r = await sendRunCsv(env, msg.from.id, chat_id, last.session_id);
    if (r.ok) return send(env, chat_id, "📊 Jadval sizga shaxsiy xabarda yuborildi.");
    const u = await botUser(env);
    return send(env, chat_id, "📊 Jadvalni olish uchun avval botni oching:", { reply_markup: { inline_keyboard: [[{ text: "📥 Jadvalni olish", url: `https://t.me/${u}?start=res_${String(chat_id).replace("-", "m")}_${last.session_id}` }]] } });
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
  try { await trackMistake(env, p, u.id, ok); } catch (e) { console.log("xato yozish", e); }
  try { await recordAnswer(env, p, u.id, ok); } catch (e) { console.log("javob yozish", e); }

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
let IDX_OK = false;
async function ensureIndexes(env) {
  if (IDX_OK) return;
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS sessions_running ON sessions(running)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS polls_sid ON polls(session_id)").run();
  IDX_OK = true;
}
async function watchdog(env) {
  await ensureIndexes(env);
  const now = Date.now();
  const { results } = await env.DB.prepare("SELECT chat_id, session_id, idx, time, last_sent FROM sessions WHERE running=1").all();
  for (const s of results) {
    if (now - s.last_sent > (s.time + 25) * 1000) await advance(env, s.chat_id, s.session_id, s.idx);
  }
  // 3 kundan eski so'rovnomalarni tozalash — soatiga bir marta
  if (new Date().getUTCMinutes() === 7)
    await env.DB.prepare("DELETE FROM polls WHERE session_id < ?").bind(String(now - 3 * 864e5)).run();
}

// ---------- Mini App (Web ilova) API ----------
const APP_URL = (env) => new URL("app/", env.QUIZ_BASE_URL).href;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, X-Init-Data", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const jres = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });
async function hmacRaw(key, data) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? new TextEncoder().encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}
async function webAppUser(env, initData) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + "=" + v).join("\n");
  const secret = await hmacRaw("WebAppData", env.BOT_TOKEN);
  const h = [...(await hmacRaw(secret, dcs))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (h !== hash) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date") || 0) > 7 * 86400) return null;
  try { return JSON.parse(p.get("user")); } catch (e) { return null; }
}
async function appAccess(env, user) {
  if (String(user.id) === OWNER(env)) return { missing: [], locked: [] };
  const missing = [];
  const S = await getSubs(env);
  if (S.on) {
    const seen = new Set();
    for (const c of [...(S.tarix || []), ...(S.huquq || [])]) {
      const ch = chObj(c);
      if (seen.has(ch.id)) continue; seen.add(ch.id);
      const r = await tg(env, "getChatMember", { chat_id: ch.id, user_id: user.id });
      if (!r.ok) continue;
      const st = r.result.status;
      if (!(["creator", "administrator", "member"].includes(st) || (st === "restricted" && r.result.is_member))) missing.push({ name: ch.name, link: ch.link });
    }
  }
  let locked = [];
  const L = await getLock(env);
  if (L && L.pw) {
    const a = await env.DB.prepare("SELECT ver FROM access WHERE user_id=?").bind(user.id).first();
    if (!(a && a.ver === L.ver)) locked = L.secs && L.secs.length ? L.secs : ["*"];
  }
  return { missing, locked };
}
async function handleApi(env, req, url) {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const user = await webAppUser(env, req.headers.get("X-Init-Data"));
  if (!user) return jres({ error: "auth" }, 401);
  await ensureLearn(env);
  const uid = user.id;
  if (url.pathname === "/api/me") {
    await touchUser(env, user);
    const acc = await appAccess(env, user);
    const { results } = await env.DB.prepare("SELECT quiz_id, title, correct, total, at FROM results WHERE user_id=? ORDER BY at DESC LIMIT 12").bind(uid).all();
    const agg = await env.DB.prepare("SELECT COUNT(*) n, SUM(correct) c, SUM(total) t FROM results WHERE user_id=?").bind(uid).first();
    const st = await getStreak(env, uid);
    const since = Date.now() - 7 * 86400000;
    const { results: top } = await env.DB.prepare(
      "SELECT r.user_id, MAX(u.name) name, SUM(r.correct) c, COUNT(*) n FROM results r LEFT JOIN users u ON u.user_id=r.user_id WHERE r.at>=? GROUP BY r.user_id ORDER BY c DESC LIMIT 10"
    ).bind(since).all();
    await bump(env, "_app");
    return jres({
      user: { id: uid, name: user.first_name || "" }, bot: await botUser(env), owner: String(uid) === OWNER(env), ...acc,
      streak: st.streak, best: st.best || 0, remind: st.active ? st.hhmm : null,
      stats: { n: agg.n || 0, avg: agg.t ? Math.round((agg.c / agg.t) * 100) : 0 },
      extra: await customList(env).catch(() => []), tasks: await myTasks(env, uid).catch(() => []),
      done: (await env.DB.prepare("SELECT quiz_id, MAX(correct*100/total) p FROM results WHERE user_id=? GROUP BY quiz_id LIMIT 800").bind(uid).all()).results.map((r) => [r.quiz_id, r.p]),
      mtopics: ((await env.DB.prepare("SELECT COUNT(DISTINCT quiz_id) n FROM mistakes WHERE user_id=?").bind(uid).first()) || { n: 0 }).n,
      mistakes: await mistakeCount(env, uid), results, topics: (await getTopics(env, uid)).map((r) => [r.quiz_id, r.ok, r.n]),
      top: top.map((r) => ({ name: r.name || "—", c: r.c, n: r.n, me: r.user_id === uid })),
    });
  }
  if (url.pathname === "/api/test" && req.method === "GET") {
    const n = url.searchParams.get("n") || "";
    try { return jres(await fetchQuiz(env, n)); } catch (e) { return jres({ error: "404" }, 404); }
  }
  if (url.pathname.startsWith("/api/class/")) {
    const b = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    try { return jres(await classApi(env, uid, url, b)); } catch (e) { return jres({ error: String(e.message || e) }, 403); }
  }
  if (url.pathname === "/api/admin" || url.pathname.startsWith("/api/test/")) {
    if (String(uid) !== OWNER(env)) return jres({ error: "ruxsat" }, 403);
    if (url.pathname === "/api/admin") return jres(await adminApi(env));
    return jres(await customApi(env, url, await req.json().catch(() => ({}))));
  }
  if (url.pathname === "/api/want" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const id = String(b.s || "").replace(/[^a-z]/g, "").slice(0, 20);
    if (id) await bump(env, "_want_" + id);
    return jres({ ok: true });
  }
  if (url.pathname === "/api/mistakes") {
    const { results } = await env.DB.prepare("SELECT quiz_id, idx FROM mistakes WHERE user_id=? ORDER BY at DESC LIMIT 60").bind(uid).all();
    return jres({ items: results.map((r) => [r.quiz_id, r.idx]) });
  }
  if (url.pathname === "/api/result" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const total = Math.min(200, Math.max(1, b.total | 0)), correct = Math.min(total, Math.max(0, b.correct | 0));
    const quiz_id = String(b.quiz_id || "app").slice(0, 40), title = String(b.title || "Test").slice(0, 80);
    await touchUser(env, user);
    await saveResult(env, { chat_id: uid, quiz_id, title, total }, correct);
    const now = Date.now(), stmts = [];
    for (const [q, i] of (b.wrong || []).slice(0, 100)) stmts.push(env.DB.prepare("INSERT OR REPLACE INTO mistakes (user_id, quiz_id, idx, at) VALUES (?,?,?,?)").bind(uid, String(q).slice(0, 40), i | 0, now));
    for (const [q, i] of (b.right || []).slice(0, 200)) stmts.push(env.DB.prepare("DELETE FROM mistakes WHERE user_id=? AND quiz_id=? AND idx=?").bind(uid, String(q).slice(0, 40), i | 0));
    const agg = new Map();
    for (const [q, ok] of [...(b.wrong || []).slice(0, 100).map((x) => [x[0], 0]), ...(b.right || []).slice(0, 200).map((x) => [x[0], 1])]) { const a = agg.get(q) || [0, 0]; a[0] += ok; a[1]++; agg.set(q, a); }
    for (const [q, [ok, n]] of [...agg].slice(0, 40)) stmts.push(topicStmt(env, uid, q, ok, n));
    if (stmts.length) { if (env.DB.batch) await env.DB.batch(stmts); else for (const x of stmts) await x.run(); }
    const streak = await bumpStreak(env, uid);
    const pct = Math.round((correct / total) * 100);
    let cert = false;
    if (pct >= 70 && total >= 10 && !["xatolar", "kun10", "qidiruv"].includes(quiz_id)) {
      try { cert = (await sendCertificate(env, { chat_id: uid, title, total, quiz_id }, user, correct, pct)) || true; } catch (e) { console.log("app sert", e); }
    }
    await bump(env, (await sectionOf(env, quiz_id)) || "boshqa"); await bump(env, "_ilova");
    return jres({ ok: true, streak: streak || (await getStreak(env, uid)).streak, cert, mistakes: await mistakeCount(env, uid) });
  }
  return jres({ error: "404" }, 404);
}
// ---------- O'z testlari (ilovadagi forma orqali qo'shilgan, D1 da saqlanadi) ----------
let CUS_OK = false;
async function ensureCustom(env) {
  if (CUS_OK) return; CUS_OK = true;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS custom_tests (n TEXT PRIMARY KEY, sec TEXT, title TEXT, cnt INTEGER, data TEXT, at INTEGER)").run();
}
async function customList(env) {
  await ensureCustom(env);
  const { results } = await env.DB.prepare("SELECT n, sec, title, cnt FROM custom_tests ORDER BY at DESC LIMIT 300").all();
  return results;
}
const NEW_SEC = { id: "yangi", icon: "🆕", title: "Yangi testlar", tests: [] };
function mergeCustom(base, list) {
  const c = JSON.parse(JSON.stringify(base));
  for (const t of list) {
    let sec = c.sections.find((x) => x.id === t.sec);
    if (!sec) { sec = c.sections.find((x) => x.id === "yangi"); if (!sec) { sec = { ...NEW_SEC, tests: [] }; c.sections.push(sec); } }
    if (!sec.tests.some((x) => x.n === t.n)) sec.tests.unshift({ n: t.n, t: t.title, c: t.cnt });
  }
  if (c.sections.some((x) => x.id === "yangi") && !(c.groups || []).some((g) => g.secs.includes("yangi"))) (c.groups = c.groups || []).unshift({ id: "yangi", icon: "🆕", title: "Yangi testlar", secs: ["yangi"] });
  return c;
}

// ---------- Sinflar (o'qituvchi rejimi) ----------
let CLS_OK = false;
async function ensureClass(env) {
  if (CLS_OK) return; CLS_OK = true;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS classes (id INTEGER PRIMARY KEY AUTOINCREMENT, owner INTEGER, name TEXT, code TEXT UNIQUE, at INTEGER)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS class_members (class_id INTEGER, user_id INTEGER, at INTEGER, PRIMARY KEY (class_id, user_id))").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS cm_user ON class_members(user_id)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS class_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, class_id INTEGER, quiz_id TEXT, title TEXT, at INTEGER)").run();
}
async function joinClass(env, chat_id, user, code) {
  await ensureClass(env);
  const c = await env.DB.prepare("SELECT * FROM classes WHERE code=?").bind(code).first();
  if (!c) return send(env, chat_id, "❌ Sinf topilmadi. Havolani o'qituvchingizdan qayta so'rang.");
  const n = await env.DB.prepare("SELECT COUNT(*) n FROM class_members WHERE class_id=?").bind(c.id).first();
  if (n.n >= 300) return send(env, chat_id, "Sinf to'lgan (300 o'quvchi).");
  const r = await env.DB.prepare("INSERT OR IGNORE INTO class_members (class_id, user_id, at) VALUES (?,?,?)").bind(c.id, user.id, Date.now()).run();
  await touchUser(env, user);
  if (r.meta && r.meta.changes) await send(env, c.owner, `👩‍🏫 «${esc(c.name)}» sinfiga yangi o'quvchi qo'shildi: <b>${esc(((user.first_name || "") + " " + (user.last_name || "")).trim())}</b>${user.username ? " @" + esc(user.username) : ""}`);
  return send(env, chat_id, `✅ Siz <b>«${esc(c.name)}»</b> sinfiga qo'shildingiz!\n\nUstozingiz topshiriq bersa, shu yerga xabar keladi. Natijalaringizni ustozingiz ko'ra oladi.`,
    { reply_markup: { inline_keyboard: [[{ text: "📱 Ilovani ochish", web_app: { url: APP_URL(env) } }]] } });
}
async function runClassBatch(env, b) {
  for (const uid of b.ids) {
    await send(env, uid, `📌 <b>Ustoz topshirig'i</b> — «${esc(b.cls)}»\n\n📝 ${esc(b.title)}\n\nTestni ishlang, natijangiz ustozingizga ko'rinadi 👇`,
      { reply_markup: { inline_keyboard: [[{ text: "📱 Ilovada ishlash", web_app: { url: APP_URL(env) + "#t=" + b.n } }], [{ text: "▶️ Bot ichida ishlash", callback_data: "q:" + b.n }]] } });
    await new Promise((x) => setTimeout(x, 40));
  }
}
const nm = (r) => r.name || "—";
async function classApi(env, uid, url, b) {
  await ensureClass(env); await ensureLearn(env);
  const own = async (id) => { const c = await env.DB.prepare("SELECT * FROM classes WHERE id=? AND owner=?").bind(id | 0, uid).first(); if (!c) throw new Error("ruxsat"); return c; };
  const P = url.pathname;
  if (P === "/api/class/list") {
    const { results: mine } = await env.DB.prepare("SELECT c.id, c.name, c.code, (SELECT COUNT(*) FROM class_members m WHERE m.class_id=c.id) n FROM classes c WHERE owner=? ORDER BY id DESC").bind(uid).all();
    const { results: joined } = await env.DB.prepare("SELECT c.id, c.name FROM class_members m JOIN classes c ON c.id=m.class_id WHERE m.user_id=?").bind(uid).all();
    return { mine, joined, bot: await botUser(env) };
  }
  if (P === "/api/class/new") {
    const name = String(b.name || "").trim().slice(0, 40);
    if (!name) return { error: "Sinf nomini yozing" };
    const k = await env.DB.prepare("SELECT COUNT(*) n FROM classes WHERE owner=?").bind(uid).first();
    if (k.n >= 10) return { error: "Ko'pi bilan 10 ta sinf" };
    const code = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
    await env.DB.prepare("INSERT INTO classes (owner, name, code, at) VALUES (?,?,?,?)").bind(uid, name, code, Date.now()).run();
    return { ok: true };
  }
  if (P === "/api/class/view") {
    const c = await own(b.id);
    const { results: tasks } = await env.DB.prepare("SELECT id, quiz_id, title, at FROM class_tasks WHERE class_id=? ORDER BY id DESC LIMIT 8").bind(c.id).all();
    const since = Date.now() - 30 * 86400000;
    const { results: st } = await env.DB.prepare(`SELECT m.user_id, u.name, u.username, u.last_seen,
      (SELECT COUNT(*) FROM results r WHERE r.user_id=m.user_id AND r.at>=?) n,
      (SELECT SUM(correct) FROM results r WHERE r.user_id=m.user_id AND r.at>=?) c,
      (SELECT SUM(total) FROM results r WHERE r.user_id=m.user_id AND r.at>=?) t
      FROM class_members m LEFT JOIN users u ON u.user_id=m.user_id WHERE m.class_id=? LIMIT 300`).bind(since, since, since, c.id).all();
    const res = {};
    if (tasks.length && st.length) {
      const qids = [...new Set(tasks.map((t) => t.quiz_id))], minAt = Math.min(...tasks.map((t) => t.at));
      const { results: rr } = await env.DB.prepare(`SELECT r.user_id, r.quiz_id, MAX(r.correct*100/r.total) p FROM results r JOIN class_members m ON m.user_id=r.user_id AND m.class_id=? WHERE r.quiz_id IN (${qids.map(() => "?").join(",")}) AND r.at>=? GROUP BY r.user_id, r.quiz_id`).bind(c.id, ...qids, minAt).all();
      for (const r of rr) res[r.user_id + ":" + r.quiz_id] = r.p;
    }
    return { cls: { id: c.id, name: c.name, code: c.code }, bot: await botUser(env), tasks,
      students: st.map((r) => ({ id: r.user_id, name: nm(r), u: r.username || "", last: r.last_seen || 0, n: r.n || 0, avg: r.t ? Math.round((r.c / r.t) * 100) : null, tasks: tasks.map((t) => res[r.user_id + ":" + t.quiz_id] ?? null) })) };
  }
  if (P === "/api/class/task") {
    const c = await own(b.id);
    const cat = await catalog(env), t = cat.sections.flatMap((x) => x.tests).find((x) => x.n === b.n);
    if (!t) return { error: "Test topilmadi" };
    await env.DB.prepare("INSERT INTO class_tasks (class_id, quiz_id, title, at) VALUES (?,?,?,?)").bind(c.id, t.n, t.t, Date.now()).run();
    const { results } = await env.DB.prepare("SELECT user_id FROM class_members WHERE class_id=?").bind(c.id).all();
    const ids = results.map((r) => r.user_id);
    for (let i = 0; i < ids.length; i += 15) {
      const body = { t: "ct", ids: ids.slice(i, i + 15), cls: c.name, title: t.t, n: t.n };
      if (env.TIMER) await env.TIMER.send(body, { delaySeconds: Math.floor(i / 15) * 3 }); else await runClassBatch(env, body);
    }
    return { ok: true, sent: ids.length };
  }
  if (P === "/api/class/kick") { const c = await own(b.id); await env.DB.prepare("DELETE FROM class_members WHERE class_id=? AND user_id=?").bind(c.id, b.uid | 0).run(); return { ok: true }; }
  if (P === "/api/class/del") { const c = await own(b.id); for (const q of ["DELETE FROM class_members WHERE class_id=?", "DELETE FROM class_tasks WHERE class_id=?", "DELETE FROM classes WHERE id=?"]) await env.DB.prepare(q).bind(c.id).run(); return { ok: true }; }
  if (P === "/api/class/leave") { await env.DB.prepare("DELETE FROM class_members WHERE class_id=? AND user_id=?").bind(b.id | 0, uid).run(); return { ok: true }; }
  return { error: "404" };
}
async function myTasks(env, uid) {
  await ensureClass(env);
  const since = Date.now() - 21 * 86400000;
  const { results } = await env.DB.prepare(`SELECT t.id, t.quiz_id, t.title, t.at, c.name cls,
    (SELECT MAX(r.correct*100/r.total) FROM results r WHERE r.user_id=? AND r.quiz_id=t.quiz_id AND r.at>=t.at) p
    FROM class_tasks t JOIN class_members m ON m.class_id=t.class_id AND m.user_id=? JOIN classes c ON c.id=t.class_id WHERE t.at>=? ORDER BY t.id DESC LIMIT 10`).bind(uid, uid, since).all();
  return results;
}

// ---------- Admin statistikasi (ilova uchun) ----------
async function adminApi(env) {
  await ensureLearn(env); await ensureStats(env); await ensureUsers(env);
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(dayKey(Date.now() - i * 86400000));
  const { results: sr } = await env.DB.prepare(`SELECT day, sec, n FROM stats WHERE day>=?`).bind(days[0]).all();
  const tz = TZ, dstart = Date.parse(days[0] + "T00:00:00Z") - tz;
  const { results: nu } = await env.DB.prepare("SELECT first_seen f FROM users WHERE first_seen>=?").bind(dstart).all();
  const act = days.map((d) => ({ d, tests: sr.filter((r) => r.day === d && !r.sec.startsWith("_")).reduce((a, r) => a + r.n, 0), app: (sr.find((r) => r.day === d && r.sec === "_app") || { n: 0 }).n, new: nu.filter((u) => dayKey(u.f) === d).length }));
  const tot = await env.DB.prepare("SELECT COUNT(*) n, SUM(CASE WHEN last_seen>=? THEN 1 ELSE 0 END) d1, SUM(CASE WHEN last_seen>=? THEN 1 ELSE 0 END) d7, SUM(blocked) b FROM users").bind(Date.now() - 86400000, Date.now() - 7 * 86400000).first();
  const since = Date.now() - 30 * 86400000;
  const { results: top } = await env.DB.prepare("SELECT quiz_id, MAX(title) title, COUNT(*) n, ROUND(AVG(correct*100.0/total)) p FROM results WHERE at>=? GROUP BY quiz_id ORDER BY n DESC LIMIT 12").bind(since).all();
  const { results: hard } = await env.DB.prepare("SELECT quiz_id, MAX(title) title, COUNT(*) n, ROUND(AVG(correct*100.0/total)) p FROM results WHERE at>=? AND quiz_id NOT LIKE 'sim-%' AND quiz_id NOT IN ('xatolar','kun10','qidiruv') GROUP BY quiz_id HAVING n>=3 ORDER BY p ASC LIMIT 12").bind(since).all();
  const { results: miss } = await env.DB.prepare("SELECT quiz_id, idx, COUNT(*) n FROM mistakes GROUP BY quiz_id, idx ORDER BY n DESC LIMIT 25").all();
  const { results: want } = await env.DB.prepare("SELECT substr(sec, 7) s, SUM(n) n FROM stats WHERE sec LIKE '_want_%' GROUP BY sec ORDER BY n DESC").all();
  return { want, act, tot, top, hard, miss: miss.map((m) => [m.quiz_id, m.idx, m.n]), custom: await customList(env) };
}
async function customApi(env, url, b) {
  await ensureCustom(env);
  if (url.pathname === "/api/test/save") {
    const qs = (b.questions || []).slice(0, 200).map((q) => ({ q: String(q.q || "").slice(0, 3000), options: (q.options || []).slice(0, 8).map((o) => String(o).slice(0, 500)), answer: q.answer | 0, ...(q.explanation ? { explanation: String(q.explanation).slice(0, 1000) } : {}) }))
      .filter((q) => q.q && q.options.length >= 2 && q.answer < q.options.length);
    const title = String(b.title || "").trim().slice(0, 80);
    if (!title || !qs.length) return { error: "Sarlavha va kamida 1 ta to'g'ri savol kerak" };
    const time = [15, 20, 30, 45, 60, 90].includes(b.time | 0) ? b.time | 0 : 30;
    const n = "u-" + Date.now().toString(36);
    const cat = await catalog(env); const sec = cat.sections.some((x) => x.id === b.sec) ? b.sec : "yangi";
    await env.DB.prepare("INSERT INTO custom_tests (n, sec, title, cnt, data, at) VALUES (?,?,?,?,?,?)").bind(n, sec, title, qs.length, JSON.stringify({ title, time, questions: qs }), Date.now()).run();
    CAT = null;
    return { ok: true, n, cnt: qs.length };
  }
  if (url.pathname === "/api/test/del") {
    await env.DB.prepare("DELETE FROM custom_tests WHERE n=?").bind(String(b.n || "")).run(); CAT = null; QCACHE.delete(String(b.n || ""));
    return { ok: true };
  }
  return { error: "404" };
}

// ---------- 📣 Testni kanalga quiz qilib yuborish (faqat egasi) ----------
function parseTestText(txt) {
  const lines = String(txt || "").replace(/\r/g, "").replace(/[\uFE0E\uFE0F]/g, "").replace(/[✓☑✅]/g, "✔").split("\n");
  const qs = []; let cur = null, last = null;
  const optRe = /^\s*([+*✔✅]\s*)?([A-Ha-hА-Еа-е])\s*[).]\s*(.*)$/, qRe = /^\s*(\d{1,3})\s*[.)]\s*(.+)$/, LET = "ABCDEFGH", CYR = "АБВГДЕ";
  for (const raw of lines) {
    const line = raw.trim(); if (!line) continue; let m;
    if ((m = line.match(/^(javob|to'g'ri javob|to‘g‘ri javob|ответ)\s*[:\-]\s*([A-Ha-hА-Еа-е])\b/i)) && cur) { const c = m[2].toUpperCase(); cur.answer = LET.includes(c) ? LET.indexOf(c) : CYR.indexOf(c); last = null; continue; }
    if ((m = line.match(/^(izoh|manba|пояснение)\s*[:\-]\s*(.*)$/i)) && cur) { cur.explanation = (cur.explanation ? cur.explanation + " " : "") + m[2]; last = "e"; continue; }
    if ((m = line.match(qRe)) && (!cur || cur.options.length >= 2)) { cur = { q: m[2], options: [], answer: -1 }; qs.push(cur); last = "q"; continue; }
    if (!cur && !qRe.test(line) && !optRe.test(line)) { cur = { q: line, options: [], answer: -1 }; qs.push(cur); last = "q"; continue; }
    if (cur && (m = line.match(optRe)) && (cur.options.length > 0 || /^[AaАа]$/.test(m[2]))) {
      let t = m[3]; const mark = !!m[1] || /\s*(✔|✅|\(\+\)|\*)\s*$/.test(t);
      t = t.replace(/\s*(✔|✅|\(\+\)|\*)\s*$/, ""); if (mark) cur.answer = cur.options.length; cur.options.push(t); last = "o"; continue;
    }
    if (cur && line.startsWith("+") && last === "q") { cur.answer = cur.options.length; cur.options.push(line.replace(/^\+\s*/, "")); last = "o"; continue; }
    if (cur && last === "o") cur.options[cur.options.length - 1] += " " + line;
    else if (cur && last === "e") cur.explanation += " " + line;
    else if (cur) cur.q += "\n" + line;
  }
  return qs;
}
const KANAL_HELP = `📣 <b>Testni kanalga yuborish</b>\n\nTestni shu shaklda yuboring (bir xabarda 1–20 ta savol):\n\n<code>1. Amir Temur qachon tug'ilgan?\nA) 1336-yil ✔\nB) 1370-yil\nC) 1405-yil\nD) 1320-yil\nIzoh: Kesh yaqinidagi Xo'ja Ilg'or qishlog'ida.</code>\n\nTo'g'ri javob: variant oxirida ✔ yoki *, oldida +, yoki alohida qatorda «Javob: A».\nRasmli savol: rasm yuboring, testni rasm ostiga (izohga) yozing.\n\nBoshqa kanalga: <code>/kanal @kanal_nomi</code>\nBekor qilish: /bekor`;
async function kanalStart(env, msg, text) {
  await ensureLock(env);
  const m = String(text || "").match(/@\w{4,}/);
  const ch = m ? m[0] : ((await env.DB.prepare("SELECT v FROM settings WHERE k='post_ch'").first()) || {}).v || "@yoldashaliisakov";
  if (m) await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('post_ch', ?)").bind(ch).run();
  const rest = String(text || "").replace(/^\/kanal(@\w+)?/i, "").replace(/@\w{4,}/, "").trim();
  if (rest) return kanalPrepare(env, msg.chat.id, rest, null, ch);
  await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('kanal_wait', ?)").bind(ch).run();
  return send(env, msg.chat.id, KANAL_HELP + `\n\nHozirgi kanal: <b>${esc(ch)}</b>`);
}
async function kanalPrepare(env, chat_id, txt, photo, ch) {
  await ensureLock(env);
  await env.DB.prepare("DELETE FROM settings WHERE k='kanal_wait'").run();
  const all = parseTestText(txt), qs = all.filter((q) => q.answer >= 0 && q.options.length >= 2 && q.options.length <= 10).slice(0, 20);
  if (!qs.length) return send(env, chat_id, "❌ Savol o'qilmadi yoki to'g'ri javob belgilanmagan.\n\n" + KANAL_HELP);
  if (photo) qs[0].photo = photo;
  await env.DB.prepare("INSERT OR REPLACE INTO settings (k, v) VALUES ('kanal_pending', ?)").bind(JSON.stringify({ ch, qs })).run();
  for (const q of qs) await postQuiz(env, chat_id, q, true);
  const skipped = all.length - qs.length;
  return send(env, chat_id, `👆 Namuna. <b>${qs.length}</b> ta savol tayyor${skipped ? ` (⚠️ ${skipped} tasida javob belgilanmagan — tashlab ketildi)` : ""}.\n\nKanal: <b>${esc(ch)}</b>`,
    { reply_markup: { inline_keyboard: [[{ text: "✅ Kanalga yuborish", callback_data: "kp:ok" }], [{ text: "❌ Bekor qilish", callback_data: "kp:no" }]] } });
}
async function postQuiz(env, chat_id, q, preview) {
  const L = "ABCDEFGHIJ";
  const longQ = q.q.length > 290, longO = q.options.some((o) => o.length > 100);
  let head = null;
  if (longQ || longO) head = `<b>${esc(q.q)}</b>` + (longO ? "\n\n" + q.options.map((o, i) => `${L[i]}) ${esc(o)}`).join("\n") : "");
  if (q.photo) { const r = await tg(env, "sendPhoto", { chat_id, photo: q.photo, caption: head && head.length <= 1000 ? head : undefined, parse_mode: "HTML", protect_content: false }); if (!r.ok) return r; if (head && head.length > 1000) await send(env, chat_id, head, { protect_content: false }); }
  else if (head) { const r = await send(env, chat_id, head, { protect_content: false }); if (r && r.ok === false) return r; }
  return tg(env, "sendPoll", {
    chat_id, type: "quiz", is_anonymous: true, protect_content: false,
    question: (longQ ? (q.photo ? "Savolni yuqoridagi rasmda o'qing 👆" : "Savolni yuqorida o'qing 👆") : q.q).slice(0, 300),
    options: (longO ? q.options.map((_, i) => L[i]) : q.options).map((t) => ({ text: String(t).slice(0, 100) })),
    correct_option_id: q.answer, ...(q.explanation ? { explanation: String(q.explanation).slice(0, 200) } : {}),
  });
}
async function kanalSend(env, chat_id) {
  await ensureLock(env);
  const row = await env.DB.prepare("SELECT v FROM settings WHERE k='kanal_pending'").first();
  if (!row) return send(env, chat_id, "Yuboriladigan test topilmadi. /kanal");
  const { ch, qs } = JSON.parse(row.v);
  await env.DB.prepare("DELETE FROM settings WHERE k='kanal_pending'").run();
  let ok = 0, err = null;
  for (const q of qs) { const r = await postQuiz(env, ch, q, false); if (r && r.ok) ok++; else { err = r; break; } await new Promise((x) => setTimeout(x, 300)); }
  if (err) {
    const d = String((err && err.description) || "");
    return send(env, chat_id, `⚠️ ${ok} ta savol yuborildi, keyin xato: <code>${esc(d)}</code>\n\n` + (/not enough rights|administrator|chat not found|forbidden/i.test(d)
      ? `Botni <b>${esc(ch)}</b> kanaliga <b>admin</b> qilib qo'shing va «Xabarlarni joylash» (Post messages) huquqini yoqing, so'ng qayta yuboring.` : "Qayta urinib ko'ring."));
  }
  return send(env, chat_id, `✅ ${ok} ta savol <b>${esc(ch)}</b> kanaliga quiz bo'lib yuborildi!`);
}

async function appOpen(env, chat_id, name) {
  const cat = await catalog(env);
  const t = cat.sections.flatMap((x) => x.tests).find((x) => x.n === name);
  if (!t) return appCmd(env, chat_id);
  return send(env, chat_id, `📝 <b>${esc(t.t)}</b>\n\n❓ ${t.c} ta test savoli${t.w ? ` + ✍️ ${t.w} ta yozma javobli savol` : ""}\n\nIlovada imtihon rejimi, taymer va natija tahlili bor 👇`,
    { reply_markup: { inline_keyboard: [[{ text: "📱 Ilovada ishlash", web_app: { url: APP_URL(env) + "#t=" + name } }], [{ text: "▶️ Bot ichida ishlash (" + t.c + " ta savol)", callback_data: "q:" + name }]] } });
}
async function havolaCmd(env, chat_id, name) {
  const cat = await catalog(env);
  const t = cat.sections.flatMap((x) => x.tests).find((x) => x.n === name);
  if (!t) return send(env, chat_id, "Test nomini yozing: <code>/havola ms-19-11</code>\n\nNomlar ro'yxati: testlar-royxati.txt");
  const u = await botUser(env);
  await send(env, chat_id,
    `🔗 <b>${esc(t.t)}</b>\n\n📱 Ilovada (${t.c}${t.w ? " + " + t.w + " yozma" : ""} savol):\n<code>https://t.me/${u}?start=app_${name}</code>\n\n🤖 Bot ichida (${t.c} savol):\n<code>https://t.me/${u}?start=${name}</code>\n\n<i>Havolani bossangiz nusxa olinadi. Pastdagi tayyor e'lonni kanalga forward qilishingiz mumkin 👇</i>`, { protect_content: false });
  return send(env, chat_id,
    `🔥 <b>YANGI TEST: ${esc(t.t)}</b>\n\n📝 ${t.c} ta test savoli${t.w ? ` + ✍️ ${t.w} ta yozma javobli savol (36–45)` : ""}\n⏱ Imtihon rejimi, taymer, ball va daraja bilan natija\n🎖 70% dan yuqori natijaga — sertifikat\n\n👇 Bosing va hoziroq ishlang!`,
    { protect_content: false, reply_markup: { inline_keyboard: [[{ text: "📱 Testni boshlash", url: `https://t.me/${u}?start=app_${name}` }], [{ text: "🤖 Bot ichida ishlash", url: `https://t.me/${u}?start=${name}` }]] } });
}
async function appCmd(env, chat_id) {
  return send(env, chat_id, "📱 <b>Isakov school ilovasi</b>\n\nTestlar, imtihon rejimi, taymer, natijalar grafigi va reyting — hammasi bitta ilovada.\n\nPastdagi tugmani yoki chap pastdagi <b>«📚 Isakov school»</b> tugmasini bosing 👇",
    { reply_markup: { inline_keyboard: [[{ text: "📱 Ilovani ochish", web_app: { url: APP_URL(env) } }]] } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(env, req, url); } catch (e) { console.log("api", e); return jres({ error: "server" }, 500); }
    }

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
          { command: "ilova", description: "📱 Isakov school ilovasi" },
          { command: "natijalarim", description: "📈 Mening natijalarim" },
          { command: "xatolarim", description: "🧩 Xatolar ustida ishlash" },
          { command: "taklif", description: "🎁 Do'stni taklif qilish" },
          { command: "qidir", description: "🔍 Savol qidirish: /qidir Amir Temur" },
          { command: "eslatma", description: "⏰ Kunlik eslatma va 🔥 ketma-ketlik" },
          { command: "kun10", description: "▶️ Bugungi 10 ta savol" },
          { command: "boshla", description: "Guruhda mavzu tanlab viktorina boshlash" },
          { command: "natijalar", description: "📊 Oxirgi guruh testi jadvali (adminlar)" },
          { command: "oqituvchi", description: "👩‍🏫 O'qituvchilar uchun qo'llanma" },
          { command: "quiz", description: "Viktorinani boshlash: /quiz nomi" },
          { command: "stop", description: "To'xtatish va natija" },
          { command: "natija", description: "Joriy natijalar" },
          { command: "avto", description: "Avtomatik viktorina: /avto 20 6-1..6-44" },
          { command: "help", description: "Yordam" },
        ],
      });
      await tg(env, "setMyCommands", {
        scope: { type: "chat", chat_id: Number(OWNER(env)) },
        commands: [
          { command: "admin", description: "🛠 Admin panel" },
          { command: "menyu", description: "📚 Testlar menyusi" },
          { command: "azolar", description: "👥 A'zolar soni" },
          { command: "hisobot", description: "📈 Bugungi hisobot" },
          { command: "haftalik", description: "🏆 Haftalik reyting" },
          { command: "kunsavoli", description: "☀️ Kun savoli sozlamalari" },
          { command: "referal", description: "🎁 Referal statistikasi" },
          { command: "havola", description: "🔗 Test havolasi: /havola ms-19-11" },
          { command: "kanal", description: "📣 Testni kanalga quiz qilib yuborish" },
          { command: "xabar", description: "📢 Hammaga xabar" },
          { command: "excel", description: "📊 A'zolar jadvali" },
          { command: "reyting", description: "🏆 TOP-20" },
          { command: "parol", description: "🔒 Parol" },
          { command: "obuna", description: "📣 Majburiy obuna" },
        ],
      });
      await tg(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "📚 Isakov school", web_app: { url: APP_URL(env) } } });
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

    if (url.pathname === "/sert.svg") {
      const d = url.searchParams.get("d") || "", sg = url.searchParams.get("s") || "";
      if (!d || sg !== (await sign(env, d))) return new Response("Sertifikat haqiqiy emas", { status: 403 });
      return new Response(certSvg(JSON.parse(unb64u(d))), { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=31536000" } });
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
        } catch (e) {
          await alertOwner(env, "xabarni qayta ishlash", e);
          const c = (upd.message && upd.message.chat) || (upd.callback_query && upd.callback_query.message && upd.callback_query.message.chat);
          if (c && c.type === "private" && String(c.id) !== OWNER(env))
            await tg(env, "sendMessage", { chat_id: c.id, text: "⏳ Bot vaqtincha texnik ishlar sababli javob bera olmayapti. Birozdan keyin qayta urinib ko'ring 🙏" }).catch(() => {});
        }
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
        else if (b.t === "rm") await runRemindBatch(env, b);
        else if (b.t === "ct") await runClassBatch(env, b);
        else await advance(env, b.chat_id, b.session_id, b.idx);
      } catch (e) { await alertOwner(env, "taymer / xabar tarqatish", e); }
      m.ack();
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(watchdog(env).catch((e) => alertOwner(env, "har daqiqalik tekshiruv", e)));
    ctx.waitUntil(autoTick(env).catch((e) => alertOwner(env, "avtomatik viktorina", e)));
    ctx.waitUntil(reportTick(env).catch((e) => alertOwner(env, "kunlik hisobot", e)));
    ctx.waitUntil(weeklyTick(env).catch((e) => alertOwner(env, "haftalik reyting", e)));
    ctx.waitUntil(dailyQTick(env).catch((e) => alertOwner(env, "kun savoli", e)));
    ctx.waitUntil(remindTick(env).catch((e) => alertOwner(env, "eslatmalar", e)));
  },
};
