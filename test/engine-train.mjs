// Learns the engine's weights from real fits and checks them on days it never saw.
// Usage: node test/engine-train.mjs <data-dir> [--write]
//   Good fits: every morning-sheet fit (weight 1) and every fit Skyler logged as worn (weight 2).
//   Bad fits:  the same fit with one piece swapped at random, the layer dropped, or a random outfit.
//   5-fold cross-validation by day; --write puts the weights trained on everything into engine.js (TUNED).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const E = require("../engine.js");
const [dir, flag] = process.argv.slice(2);
const J = f => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const data = { wardrobe: J("wardrobe.json"), log: J("fit-log.json"), laundry: J("laundry.json") };

const goods = [];
for (const p of data.log.planned) for (const f of p.fits) goods.push({ date: p.date, items: f.items, when: f.when, weight: 1, src: "plan" });
for (const x of data.log.worn) goods.push({ date: x.date, items: x.items, when: x.occasion, weather: x.weather, weight: x.didnt ? .5 : 2, src: "worn" });
const days = [...new Set(goods.map(g => g.date))].sort();
const fold = d => days.indexOf(d) % 5;

const pairsAll = E.makePairs(data, goods, { swaps: 3, randoms: 2, seed: 7 });
const tag = new Map(); goods.forEach(g => tag.set(g.date + g.items.join(), g.src));
console.log(`${goods.length} good fits over ${days.length} days -> ${pairsAll.length} training pairs`);

const report = (name, pairs, w) => {
  const swap = pairs.filter(p => p.slot !== "random"), rnd = pairs.filter(p => p.slot === "random");
  const bySlot = ["top", "bottom", "shoes", "socks", "cap", "layer"].map(s => s + " " + (E.accuracy(pairs.filter(p => p.slot === s), w) * 100).toFixed(0)).join(" | ");
  return `${name.padEnd(10)} one-swap ${(E.accuracy(swap, w) * 100).toFixed(1)}%  random ${(E.accuracy(rnd, w) * 100).toFixed(1)}%   (${bySlot})`;
};

for (const lambda of [0.005, 0.02, 0.08]) {
  const held = { prior: [], tuned: [] };
  const heldPairs = [], heldWornPairs = [];
  for (let k = 0; k < 5; k++) {
    const tr = pairsAll.filter(p => fold(p.date) !== k), te = pairsAll.filter(p => fold(p.date) === k);
    const w = E.train(tr, E.PRIOR, { lambda, iters: 400 });
    te.forEach(p => { heldPairs.push([p, w]); });
  }
  const acc = (list, useTuned, filt = () => true) => {
    const L = list.filter(([p]) => filt(p));
    return L.reduce((a, [p, w]) => { const m = Object.keys(p.d).reduce((s, k) => s + ((useTuned ? w : E.PRIOR)[k] || 0) * p.d[k], 0); return a + (m > 0 ? 1 : m === 0 ? .5 : 0); }, 0) / L.length * 100;
  };
  const isSwap = p => p.slot !== "random";
  console.log(`\nlambda ${lambda}: held-out one-swap  hand ${acc(heldPairs, false, isSwap).toFixed(1)}%  ->  learned ${acc(heldPairs, true, isSwap).toFixed(1)}%` +
    `   | random  hand ${acc(heldPairs, false, p => !isSwap(p)).toFixed(1)}% -> learned ${acc(heldPairs, true, p => !isSwap(p)).toFixed(1)}%`);
  for (const s of ["top", "bottom", "shoes", "socks", "cap", "layer"])
    process.stdout.write(`   ${s} ${acc(heldPairs, false, p => p.slot === s).toFixed(0)}->${acc(heldPairs, true, p => p.slot === s).toFixed(0)}`);
  console.log();
}

const LAMBDA = 0.005;
const final = E.train(pairsAll, E.PRIOR, { lambda: LAMBDA, iters: 600 });
console.log("\n" + report("hand", pairsAll, E.PRIOR) + "\n" + report("learned", pairsAll, final) + "   <- in-sample");
const moved = Object.keys(final).map(k => [k, E.PRIOR[k], final[k]]).sort((a, b) => Math.abs(b[2] - b[1]) - Math.abs(a[2] - a[1]));
console.log("\nbiggest changes from the hand weights:");
moved.slice(0, 16).forEach(([k, a, b]) => console.log(`  ${k.padEnd(20)} ${a.toFixed(2).padStart(6)} -> ${b.toFixed(2).padStart(6)}`));

if (flag === "--write") {
  const f = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "engine.js");
  const src = fs.readFileSync(f, "utf8");
  const body = `  // learned ${new Date().toISOString().slice(0, 10)} from ${goods.length} fits over ${days.length} days (test/engine-train.mjs)\n  const TUNED = ${JSON.stringify(final)};\n`;
  fs.writeFileSync(f, src.replace(/\/\*tuned:start\*\/\n[\s\S]*?  \/\*tuned:end\*\//, `/*tuned:start*/\n${body}  /*tuned:end*/`));
  console.log("\nwrote TUNED into engine.js");
}
