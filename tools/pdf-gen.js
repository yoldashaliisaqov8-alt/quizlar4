const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const R = process.env.REPO || path.join(__dirname, '..');
const cat = JSON.parse(fs.readFileSync(R + '/catalog.json', 'utf8'));
const face = 'data:image/png;base64,' + fs.readFileSync(__dirname + '/face.png').toString('base64');
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const L = 'ABCDEFGHIJ';
function html(name, d, sec) {
  const qs = d.questions;
  const body = qs.map((q, i) => {
    const img = q.image ? `<img src="file://${R}/${q.image}">` : '';
    const lines = esc(q.q).replace(/\n?\(Jadval rasmda 👆\)/, '').split('\n');
    const tab = lines.filter(l => l.includes(' | '));
    let qtxt;
    if (tab.length >= 2) {
      const pre = lines.slice(0, lines.indexOf(tab[0])), post = lines.slice(lines.indexOf(tab[tab.length - 1]) + 1);
      qtxt = pre.join('<br>') + `<table>${tab.map((r, k) => `<tr>${r.split(' | ').map(c => k ? `<td>${c}</td>` : `<th>${c}</th>`).join('')}</tr>`).join('')}</table>` + post.join('<br>');
    } else qtxt = lines.join('<br>');
    return `<div class="q"><div class="qt"><b>${i + 1}.</b> ${qtxt}</div>${img}<div class="op">${q.options.map((o, k) => `<div>${L[k]}) ${esc(o)}</div>`).join('')}</div></div>`;
  }).join('');
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
  h3{font-family:Lora,serif;margin-top:16px} .iz p{margin:3px 0;font-size:9.5pt;break-inside:avoid}
  </style></head><body>
  <div class="hd"><img src="${face}"><div><div class="b">ISAKOV SCHOOL</div><div class="s">Ustoz Yo‘ldashali Isaqov · t.me/yoldashaliisakov</div></div></div>
  <h1>${esc(d.title || name)}</h1><div class="meta">${esc(sec)} · ${qs.length} ta savol · Telegram bot: @${'BOTNAME'}</div>
  ${body}<h2>Javoblar</h2>${keys}${iz}</body></html>`;
}
(async () => {
  const only = process.argv[2];
  const b = await chromium.launch(); const p = await b.newPage();
  fs.mkdirSync(R + '/pdf', { recursive: true });
  let n = 0;
  for (const s of cat.sections) for (const t of s.tests) {
    if (only && t.n !== only) continue;
    const d = JSON.parse(fs.readFileSync(`${R}/${t.n}.json`, 'utf8'));
    const f = path.join(require('os').tmpdir(), 'isakov-h.html');
    fs.writeFileSync(f, html(t.n, d, `${s.icon} ${s.title}`).replace('@BOTNAME', process.env.BOTNAME || 'Isakov school Quiz'));
    await p.goto('file://' + f);
    await p.pdf({ path: `${R}/pdf/${t.n}.pdf`, format: 'A4', printBackground: true, displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font-size:8px;color:#7a6020;padding:0 14mm;display:flex;justify-content:space-between;font-family:Inter,sans-serif"><span>Isakov school · t.me/yoldashaliisakov</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>` ,
      margin: { top: '14mm', bottom: '16mm', left: '14mm', right: '14mm' } });
    n++;
  }
  await b.close(); console.log(n, 'ta PDF');
})();
