// Saytdagi (beruniy-ilmi-maktabi-) yozma javobli savollarni (36–45) bot testlariga "written" maydoni sifatida qo'shadi.
// Ishlatish: node tools/add-written.js <sayt_repo_papkasi>
const fs = require("fs"), path = require("path");
const SITE = process.argv[2], R = path.join(__dirname, "..") + "/";
const MAP = {
  "sertifikat.html": "huquq-demo-1", "sertifikat-2.html": "huquq-demo-2", "sertifikat-3.html": "huquq-demo-3",
  "sertifikat-4.html": "huquq-demo-4", "sertifikat-5.html": "huquq-demo-5", "sertifikat-6.html": "huquq-demo-6",
  "sertifikat-7.html": "huquq-aprob-7", "sertifikat-8.html": "huquq-demo-7", "sertifikat-9.html": "huquq-demo-8",
  "sertifikat-afrika.html": "ms-afrika", "sertifikat-buxoro.html": "ms-buxoro", "sertifikat-qoqon.html": "ms-qoqon",
  "sertifikat-xiva.html": "ms-xiva", "sertifikat-tarix-14-11-2026.html": "ms-14-11", "sertifikat-tarix-15-11-2026.html": "ms-15-11",
};
const clean = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/^Qisqa javob:\s*/i, "").trim();
const cat = JSON.parse(fs.readFileSync(R + "catalog.json"));
let total = 0;
for (const [page, name] of Object.entries(MAP)) {
  const s = fs.readFileSync(path.join(SITE, page), "utf8");
  const Q = JSON.parse(s.match(/var Q=(\[.*?\]);/s)[1]);
  const W = Q.filter((q) => q.t !== "t").map((q) => ({
    n: q.n, q: clean(q.text), ...(q.w ? { w: q.w } : {}),
    parts: q.parts ? q.parts.map((p) => ({ l: p.lab || "", q: clean(p.q), a: p.forms })) : [{ l: "", q: "", a: q.forms }],
    ...(clean(q.iz || q.man) ? { explanation: clean(q.iz || q.man) } : {}),
  })).filter((q) => q.parts.every((p) => p.a && p.a.length));
  const f = R + name + ".json", d = JSON.parse(fs.readFileSync(f));
  d.written = W;
  fs.writeFileSync(f, JSON.stringify(d, null, 1));
  for (const sec of cat.sections) for (const t of sec.tests) if (t.n === name) t.w = W.length;
  total += W.length;
  console.log(name.padEnd(14), W.length, "ta yozma");
}
fs.writeFileSync(R + "catalog.json", JSON.stringify(cat, null, 0));
console.log("Jami:", total);
