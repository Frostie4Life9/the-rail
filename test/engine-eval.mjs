// Backtests the fit engine on a real closet. Usage: node test/engine-eval.mjs <data-dir>
// 1. rank: where do real fits (Skyler's worn, Claude's planned) land among random valid outfits, by engine score?
// 2. rules: do generated fits obey the hard rules?  3. variety: 14 simulated days.  4. agreement with Claude's sheets.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const E = require("../engine.js");
const dir = process.argv[2];
const J = f => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const data = { wardrobe: J("wardrobe.json"), log: J("fit-log.json"), laundry: J("laundry.json") };
const by = c => data.wardrobe.items.find(i => i.code === c);

// weather from the planned sheet subtitles ("Provo: 48°F high / 32°F low · sunny · 0% rain · ...")
const wxOf = sub => {
  const m = /(\d+)°F high \/ (\d+)°F low/.exec(sub || ""); if (!m) return null;
  const r = /(\d+)% rain/.exec(sub), w = /(\d+)(?:-(\d+))? mph/.exec(sub);
  return { hi: +m[1], lo: +m[2], rain: r ? +r[1] : 0, snow: /snow/i.test(sub), wind: w ? +(w[2] || w[1]) : 0 };
};
const planned = data.log.planned.filter(p => wxOf(p.subtitle));
const wxByDate = Object.fromEntries(planned.map(p => [p.date, wxOf(p.subtitle)]));
const before = (d) => ({ wardrobe: data.wardrobe, laundry: data.laundry, log: {
  worn: data.log.worn.filter(x => x.date < d), planned: data.log.planned.filter(p => p.date < d) } });

// deterministic RNG for sampling
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const pickOne = a => a[Math.floor(rnd() * a.length)];
const usable = data.wardrobe.items.filter(i => !i.avoid && !i.retired);
const S = slot => usable.filter(i => i.slot === slot);
const randomFit = () => [pickOne(S("top")), pickOne(S("bottom")), pickOne(S("shoes")), pickOne(S("socks")), pickOne(S("cap")),
  ...(rnd() < .35 ? [pickOne(S("layer"))] : [])].map(i => i.code);

const kindOf = (when = "") => /lab/i.test(when) ? "lab" : /church/i.test(when) ? "church" : /(home|lounge|homework|couch|study)/i.test(when) ? "lounge"
  : /(going out|hangout|date|dinner|evening out|out tonight)/i.test(when) ? "out" : "class";
const phaseOf = (when = "") => /(night|evening|tonight|5pm|6pm|7pm|8pm|date|dinner)/i.test(when) ? "evening" : "day";

/* ---- 1. rank ---- */
function rankOf(fit, date, wx, kind, phase) {
  const d = before(date), opts = { today: date, weather: wx, occasion: { kind, phase }, rules: { labShortSleeve: false } };   // rank = taste, so the lab sleeve rule is checked in section 2 instead
  const mine = E.scoreFit(d, opts, fit); if (mine == null) return null;
  let lower = 0, N = 300;
  for (let i = 0; i < N; i++) { const r = E.scoreFit(d, opts, randomFit()); if (r < mine) lower++; }
  return lower / N;
}
const pct = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length * 100).toFixed(0) + "th pct avg, median " + (a.slice().sort((x, y) => x - y)[a.length >> 1] * 100).toFixed(0) + ", " + (a.filter(v => v >= .8).length / a.length * 100).toFixed(0) + "% in top 20%" : "n/a";
const wornR = [], planR = [], rnd0 = [];
for (const x of data.log.worn) {
  const wx = wxByDate[x.date]; if (!wx) continue;
  const r = rankOf(x.items, x.date, wx, kindOf(x.occasion), phaseOf(x.occasion)); if (r != null) wornR.push(r);
}
for (const p of planned) for (const f of p.fits) {
  const r = rankOf(f.items, p.date, wxByDate[p.date], kindOf(f.when), phaseOf(f.when)); if (r != null) planR.push(r);
}
for (let i = 0; i < 150; i++) { const p = pickOne(planned); const r = rankOf(randomFit(), p.date, wxByDate[p.date], "class", "day"); if (r != null) rnd0.push(r); }
console.log("== 1. Where real fits rank among random valid outfits (higher = engine agrees) ==");
console.log(" Skyler's worn fits  (n=" + wornR.length + "):", pct(wornR));
console.log(" Claude's planned    (n=" + planR.length + "):", pct(planR));
console.log(" random outfits      (n=" + rnd0.length + "):", pct(rnd0), " <- control, should sit near 50");

/* ---- 2. rules ---- */
const dirtyOf = d => { const c = E.prepare(d, { today: d.__today }); return new Set(d.wardrobe.items.filter(i => !c.avail.includes(i) && !i.avoid).map(i => i.code)); };
let checks = 0, fails = [];
const today = "2026-11-18";
const scenarios = [];
for (const p of planned) for (const kind of ["class", "lab", "lounge", "out", "church"]) scenarios.push({ date: p.date, wx: wxByDate[p.date], kind, phase: kind === "out" ? "evening" : "day" });
for (const sc of scenarios) {
  const d = before(sc.date); d.__today = sc.date;
  const res = E.suggest(d, { today: sc.date, weather: sc.wx, occasion: { kind: sc.kind, phase: sc.phase }, n: 3 });
  const dirty = dirtyOf(d);
  for (const f of res.fits) {
    const its = f.items.map(by); checks++;
    const wet = sc.wx.snow || sc.wx.rain >= 50, sh = its.find(i => i.slot === "shoes");
    const tops = its.filter(i => i.slot === "top"), top = tops.find(i => i.type === "tee") || tops[0];   // the piece against the skin
    const bad = [];
    if (!its.some(i => i.slot === "cap")) bad.push("no cap");
    if (its.some(i => i.avoid)) bad.push("hidden item used");
    if (f.items.some(c => dirty.has(c))) bad.push("hamper item used");
    if (wet && E.attrs(sh).suede) bad.push("suede in wet");
    if (sc.kind === "lab" && E.attrs(top).sleeve === "long") bad.push("long sleeve at lab");
    if (its.some(i => i.type === "shorts") && sc.wx.lo < 60) bad.push("shorts in cold");
    if (!["top", "bottom", "shoes", "socks"].every(s => its.some(i => i.slot === s))) bad.push("missing slot");
    if (bad.length) fails.push(`${sc.date} ${sc.kind}: ${bad.join(", ")} [${f.items.join(" ")}]`);
  }
}
console.log("\n== 2. Hard rules over " + checks + " generated fits (" + scenarios.length + " weather/occasion scenarios) ==");
console.log(fails.length ? " FAILS (" + fails.length + "):\n  " + fails.slice(0, 12).join("\n  ") : " all passed");

/* ---- 3. variety: 14 simulated days, wearing fit #1 each day ---- */
{
  const sim = { wardrobe: data.wardrobe, laundry: JSON.parse(JSON.stringify(data.laundry)), log: { worn: [], planned: [] } };
  sim.laundry.last_full = "2026-10-01T00:00:00Z"; sim.laundry.dirtied = {};
  const wxs = planned.map(p => p.date).sort().slice(-14).map(d => [d, wxByDate[d]]);
  const used = {}, combos = new Set(); let day = 0;
  for (const [d, wx] of wxs) {
    const res = E.suggestDay(sim, { today: d, weather: wx, occasions: [{ kind: "class", phase: "day", label: "Class" }, { kind: "lounge", phase: "evening", label: "Home" }] });
    const f = res[0]; if (!f) continue;
    combos.add(f.items.join(","));
    f.items.forEach(c => used[c] = (used[c] || 0) + 1);
    sim.log.worn.push({ date: d, name: f.name, items: f.items, logged_at: d + "T17:00:00Z" });
    day++;
  }
  const core = ["top", "bottom", "shoes", "layer"], codes = Object.keys(used).filter(c => core.includes(by(c).slot));
  const avail = usable.filter(i => core.includes(i.slot)).length;
  const maxRep = Math.max(...codes.map(c => used[c]));
  console.log("\n== 3. Variety over " + day + " simulated days (one worn fit per day, hamper rules on) ==");
  console.log(" distinct outfits:", combos.size + "/" + day, "| distinct tops/bottoms/shoes/layers used:", codes.length + "/" + avail,
    "| most-repeated piece:", maxRep + "x", by(codes.find(c => used[c] === maxRep)).name);
  const bs = {}; Object.keys(used).forEach(c => { const s = by(c).slot; bs[s] = (bs[s] || 0) + 1; });
  console.log(" distinct per slot:", JSON.stringify(bs));
}

/* ---- 4. agreement with Claude's sheets (best match by shared top/bottom/shoes) ---- */
{
  const key = f => ["top", "bottom", "shoes"].map(s => f.map(by).find(i => i && i.slot === s)?.code);
  const ov = (a, b) => a.filter((x, i) => x === b[i]).length;
  let sumE = 0, sumR = 0, n = 0, full = 0;
  for (const p of planned) {
    const d = before(p.date), wx = wxByDate[p.date];
    const eng = E.suggestDay(d, { today: p.date, weather: wx, occasions: p.fits.map(f => ({ kind: kindOf(f.when), phase: phaseOf(f.when), label: f.when })) });
    const theirs = p.fits.map(f => key(f.items));
    eng.forEach(f => { const k = key(f.items); const best = Math.max(...theirs.map(t => ov(k, t))); sumE += best; if (best === 3) full++; n++; });
    for (let i = 0; i < eng.length; i++) sumR += Math.max(...theirs.map(t => ov(key(randomFit()), t)));
  }
  console.log("\n== 4. Overlap with Claude's own sheets (top/bottom/shoes matches, best of that day's fits, max 3) ==");
  console.log(" engine:", (sumE / n).toFixed(2), "| random:", (sumR / n).toFixed(2), "| exact top+bottom+shoes matches:", full + "/" + n);
}

/* ---- sample: today ---- */
{
  const wx = { hi: 48, lo: 32, rain: 0, snow: false, wind: 10 };
  const d = data;
  console.log("\n== Sample: " + today + " (48/32F, dry), with real history ==");
  const res = E.suggestDay(d, { today, weather: wx, occasions: [
    { kind: "class", phase: "morning", label: "Chem 11am" }, { kind: "lab", phase: "day", label: "Physics lab 2pm" },
    { kind: "lounge", phase: "evening", label: "Home, homework" }, { kind: "out", phase: "evening", label: "Out tonight" }] });
  for (const f of res) console.log(` ${f.when}: ${f.name} | ${f.items.map(c => by(c).name).join(" / ")} | ${f.score} | ${f.why.join("; ")}`);
}
