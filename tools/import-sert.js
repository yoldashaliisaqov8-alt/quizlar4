// Saytdagi sertifikat sahifasini (var Q=…) bot testiga aylantiradi: yopiq savollar + yozma savollar,
// jadval/SVG rasmlarini img/ ga JPEG qilib chizadi.
// Ishlatish: node tools/import-sert.js <sahifa.html> <test_nomi> [sarlavha]
const fs = require("fs"), path = require("path"), { chromium } = require("playwright");
const [, , page, name, title0] = process.argv, R = path.join(__dirname, "..") + "/";
const clean = (s) => String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/^Qisqa javob:\s*/i, "").trim();
(async () => {
  const html = fs.readFileSync(page, "utf8");
  const Q = JSON.parse(html.match(/var Q=(\[.*?\]);/s)[1]);
  const title = title0 || clean(html.match(/<title>(.*?)<\/title>/)[1]);
  const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 });
  const questions = [];
  for (const q of Q.filter((x) => x.t === "t")) {
    const o = { q: (q.pre ? clean(q.pre) + "\n\n" : "") + clean(q.text), options: q.opts.map(clean), answer: q.ans };
    if (clean(q.iz || q.man)) o.explanation = clean(q.iz || q.man);
    if (q.svg) {
      const f = `img/${name}-${String(q.n).padStart(2, "0")}.jpg`;
      await p.setContent(`<body style="margin:0;background:#fff;font-family:Arial,sans-serif"><div id="x" style="display:inline-block;padding:14px;background:#fff;min-width:300px">${q.svg}</div></body>`);
      await (await p.$("#x")).screenshot({ path: R + f, type: "jpeg", quality: 85 });
      o.image = f;
    }
    questions.push(o);
  }
  const written = Q.filter((x) => x.t !== "t").map((q) => ({
    n: q.n, q: (q.pre ? clean(q.pre) + "\n\n" : "") + clean(q.text), ...(q.w ? { w: q.w } : {}),
    parts: q.parts ? q.parts.map((x) => ({ l: x.lab || "", q: clean(x.q), a: x.forms })) : [{ l: "", q: "", a: q.forms }],
    ...(clean(q.iz || q.man) ? { explanation: clean(q.iz || q.man) } : {}),
  })).filter((q) => q.parts.every((x) => x.a && x.a.length));
  fs.writeFileSync(R + name + ".json", JSON.stringify({ title, time: 45, questions, written }, null, 1));
  await b.close();
  console.log(name, questions.length, "yopiq,", written.length, "yozma,", questions.filter((x) => x.image).length, "rasm");
})();
