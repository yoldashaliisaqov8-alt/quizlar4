const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const R = process.env.REPO || path.join(__dirname, '..');
const cat = JSON.parse(fs.readFileSync(R + '/catalog.json', 'utf8'));
const face = 'data:image/png;base64,' + fs.readFileSync(__dirname + '/face.png').toString('base64');
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const L = 'ABCDEFGHIJ';
function ansBody(d) {
  return (d.parts || [[null, d.questions]]).map(([h, list]) => (h ? `<h4 class="ph">${esc(h)}</h4>` : '') +
    `<div class="keys">${list.map((q, i) => `<span><b>${i + 1}</b>–${L[q.answer]}</span>`).join('')}</div>` +
    (list.some(q => q.explanation) ? `<div class="iz">${list.map((q, i) => q.explanation ? `<p><b>${i + 1}. ${L[q.answer]})</b> ${esc(q.explanation)}</p>` : '').join('')}</div>` : '')).join('');
}
function wrQ(d) {
  if (!d.written || !d.written.length) return '';
  return `<h4 class="ph">✍️ Yozma javobli savollar</h4>` + d.written.map((w) => `<div class="q"><div class="qt"><b>${w.n}.</b> ${esc(w.q).replace(/\n/g, '<br>')}</div>${w.image ? `<img src="file://${R}/${w.image}">` : ''}<div class="op">${(w.parts || []).map((x) => `<div>${esc(x.l)}) ${esc(x.q)} <span style="color:#9aa">______________</span></div>`).join('')}</div></div>`).join('');
}
function wrA(d) {
  if (!d.written || !d.written.length) return '';
  return `<h4 class="ph">✍️ Yozma savollar javoblari</h4><div class="iz">` + d.written.map((w) => `<p><b>${w.n}.</b> ${(w.parts || []).map((x) => `${esc(x.l)}) ${esc((x.a || [])[0] || '')}`).join('; ')}${w.explanation ? ` <i>— ${esc(w.explanation)}</i>` : ''}</p>`).join('') + `</div>`;
}
const SPLIT = () => true; // hamma bo‘limlar: savollar va parolli javoblar alohida
const { execFileSync } = require('child_process');
function lock(f) {
  const pw = process.env.PDF_PASS;
  if (!pw) { console.warn('PDF_PASS yo‘q — javoblar paroli qo‘yilmadi:', f); return; }
  const t = f + '.tmp'; execFileSync('qpdf', ['--encrypt', pw, pw + '-own-' + Date.now(), '256', '--', f, t]); fs.renameSync(t, f);
}
function html(name, d, sec, mode = 'full') {
  const qs = d.questions;
  const body = (d.parts || [[null, qs]]).map(([h, list], pi) => (h ? `<h4 class="ph">${esc(h)}</h4>` : '') + list.map((q, i) => {
    const img = q.image ? `<img src="file://${R}/${q.image}">` : '';
    const lines = esc(q.q).replace(/\n?\(Jadval rasmda 👆\)/, '').split('\n');
    const tab = lines.filter(l => l.includes(' | '));
    let qtxt;
    if (tab.length >= 2) {
      const pre = lines.slice(0, lines.indexOf(tab[0])), post = lines.slice(lines.indexOf(tab[tab.length - 1]) + 1);
      qtxt = pre.join('<br>') + `<table>${tab.map((r, k) => `<tr>${r.split(' | ').map(c => k ? `<td>${c}</td>` : `<th>${c}</th>`).join('')}</tr>`).join('')}</table>` + post.join('<br>');
    } else qtxt = lines.join('<br>');
    return `<div class="q"><div class="qt"><b>${i + 1}.</b> ${qtxt}</div>${img}<div class="op">${q.options.map((o, k) => `<div>${L[k]}) ${esc(o)}</div>`).join('')}</div></div>`;
  }).join('')).join('');
  const keys = `<div class="keys">${qs.map((q, i) => `<span><b>${i + 1}</b>–${L[q.answer]}</span>`).join('')}</div>`;
  const iz = qs.some(q => q.explanation) ? `<h3>Izohlar</h3><div class="iz">${qs.map((q, i) => q.explanation ? `<p><b>${i + 1}. ${L[q.answer]})</b> ${esc(q.explanation)}</p>` : '').join('')}</div>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page{size:A4;margin:16mm 14mm 16mm 14mm}
  body{font-family:Inter,'DejaVu Sans',sans-serif;font-size:10.5pt;color:#152238;line-height:1.38}
  .hd{display:flex;align-items:center;gap:12px;border-bottom:2.5px solid #c9a24a;padding-bottom:9px;margin-bottom:12px}
  .hd img{width:54px;height:54px;border-radius:50%;border:2px solid #c9a24a}
  .hd .b{font-weight:800;letter-spacing:2px;font-size:13pt;color:#0b1730}.hd .s{font-size:9pt;color:#7a6020}
  h1{font-family:Lora,serif;font-size:16pt;margin:4px 0 2px;color:#0b1730} .meta{font-size:9pt;color:#5b6b82;margin-bottom:10px}
  .q{break-inside:avoid;margin:0 0 10px;padding:7px 9px;border-left:3px solid #c9a24a;background:#fbf8f0;border-radius:3px}
  .qt{margin-bottom:4px} .op div{margin:1px 0 1px 14px}
  .q img{max-width:70%;max-height:230px;display:block;margin:5px 0 5px 14px}
  table{border-collapse:collapse;margin:5px 0;font-size:9.5pt} td,th{border:1px solid #b9c3d3;padding:3px 6px;text-align:left;vertical-align:top} th{background:#e9eef6}
  h2{page-break-before:always;font-family:Lora,serif;color:#0b1730;border-bottom:2.5px solid #c9a24a;padding-bottom:5px}
  .keys{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:11pt}.keys span{min-width:48px}
  .ph{font-family:Lora,serif;font-size:12.5pt;color:#0b1730;margin:14px 0 6px;border-bottom:1.5px solid #e3d3a6;padding-bottom:3px;break-after:avoid}
  h3{font-family:Lora,serif;margin-top:16px} .iz p{margin:3px 0;font-size:9.5pt;break-inside:avoid}
  </style></head><body>
  <div class="hd"><img src="${face}"><div><div class="b">ISAKOV SCHOOL</div><div class="s">Ustoz Yo‘ldashali Isaqov · t.me/yoldashaliisakov</div></div></div>
  <h1>${esc(d.title || name)}</h1><div class="meta">${esc(sec)} · ${qs.length} ta savol · Telegram bot: @${'BOTNAME'}</div>
  ${mode === 'ans' ? `<div class="meta">🔑 Javoblar kaliti${d.parts ? '' : ''}</div>` + ansBody(d) + wrA(d) : body + wrQ(d) + (mode === 'q' ? '' : `<h2>Javoblar</h2>${d.parts ? ansBody(d) : keys + iz}${wrA(d)}`)}</body></html>`;
}
(async () => {
  const only = process.argv[2];
  const b = await chromium.launch(); const p = await b.newPage();
  fs.mkdirSync(R + '/pdf', { recursive: true });
  let n = 0;
  const render = async (file, h) => {
    const f = path.join(require('os').tmpdir(), 'isakov-h.html');
    fs.writeFileSync(f, h.replace('@BOTNAME', process.env.BOTNAME || 'Isakov school Quiz'));
    await p.goto('file://' + f);
    await p.pdf({ path: file, format: 'A4', printBackground: true, displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font-size:8px;color:#7a6020;padding:0 14mm;display:flex;justify-content:space-between;font-family:Inter,sans-serif"><span>Isakov school · t.me/yoldashaliisakov</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>` ,
      margin: { top: '14mm', bottom: '16mm', left: '14mm', right: '14mm' } });
    n++;
  };
  const need = (f) => process.env.FORCE || !fs.existsSync(f);
  for (const s of cat.sections) {
    if (s.nopdf) continue; // PDFsiz bo‘limlar (ingliz tili)
    const split = SPLIT(s.id) && !s.ansend, secT = `${s.icon} ${s.title}`;
    for (const t of s.tests) {
      if (only && t.n !== only && s.id !== only) continue;
      const main = `${R}/pdf/${t.n}.pdf`, ans = `${R}/pdf/${t.n}-javob.pdf`;
      if (!only && !need(main) && (!split || !need(ans))) continue;
      const d = JSON.parse(fs.readFileSync(`${R}/${t.n}.json`, 'utf8'));
      await render(main, html(t.n, d, secT, split ? 'q' : 'full'));
      if (split) { await render(ans, html(t.n, { ...d, title: d.title + ' — javoblar' }, secT, 'ans')); lock(ans); }
    }
    if ((split || s.ansend) && (!only || only === s.id)) { // butun kitob: bitta PDF + parolli javoblar
      const main = `${R}/pdf/${s.id}.pdf`, ans = `${R}/pdf/${s.id}-javob.pdf`;
      if (!only && !need(main) && !need(ans)) continue;
      const parts = s.tests.map((t) => { const d = JSON.parse(fs.readFileSync(`${R}/${t.n}.json`, 'utf8')); return [t.t, d.questions]; });
      const all = { title: s.title + ' — butun kitob', questions: parts.flatMap((x) => x[1]), parts };
      if (!split) { await render(main, html(s.id, all, secT, 'full')); continue; }
      await render(main, html(s.id, all, secT, 'q'));
      await render(ans, html(s.id, { ...all, title: s.title + ' — javoblar' }, secT, 'ans')); lock(ans);
    }
  }
  await b.close(); console.log(n, 'ta PDF');
  // R2 ko'chirish ro'yxati (bot /pdfsync shu ro'yxat bo'yicha ishlaydi)
  const fl = fs.readdirSync(R + '/pdf').filter((f) => f.endsWith('.pdf')).sort().map((f) => [f, fs.statSync(R + '/pdf/' + f).size]);
  fs.writeFileSync(R + '/pdf-list.json', JSON.stringify(fl));
})();
