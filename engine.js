/* The Rail fit engine: free, deterministic, no AI and no network.
 *
 * suggest(data, opts) builds many candidate outfits from the closet, drops the ones that break a hard rule,
 * scores the rest, and returns a few that are good AND different from each other.
 *
 *   data = {wardrobe: {items: [...]}, log: {worn: [...], planned: [...]}, laundry: {...}}   (the three JSON files)
 *   opts = {today: "YYYY-MM-DD", weather: {hi, lo, rain (0-100), snow (bool), wind (mph)},
 *           occasion: {kind: "class"|"lab"|"lounge"|"out"|"church"|"errand", phase: "morning"|"day"|"evening"|"night"},
 *           n: 3, salt: 0, avoid: [codes to steer away from], rules: {alwaysCap: true}}
 *
 * Works in the browser (window.RailEngine) and in Node (module.exports). Everything about taste lives in the
 * tables and in W (weights) so it can be tuned against the closet in test/engine-eval.mjs.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RailEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------------ weights (points; ~+-5 is a big swing) */
  const W = {
    warmthDeficit: 2.4,      // per warmth point under what the weather needs (cold is the worst failure)
    warmthExcess: 0.9,       // per point of overdress
    formality: 1.3,          // per point the outfit's average formality is off the occasion's target
    formalityGap: 1.3,       // per point the biggest gap between pieces exceeds 1.6 (hoodie + dress shoes)
    pop: 2.0, quiet: 0.8,    // exactly one colour pop / no accent colour
    clash: 3.5, crowded: 3.0,
    statementOne: 1.0, statementNone: 0.2, statementTwo: -0.8, statementMany: -2.5,
    shoePop: 0.6, shoePopBusy: 1.0,   // statement shoes are a good thing with a quiet outfit, too much with a busy one
    matchy: 0.9,             // top and bottom the same colour (not black)
    contrast: 1.0,
    recentWorn: 1.2,         // top / bottom / shoes / layer worn in the last 2 days
    recentWorn2: 0.6,        // 3-4 days ago
    yesterdayRepeat: 2.0,    // yesterday's bottoms or shoes again
    fresh: 0.5,              // not worn lately (scaled by how rarely it's been worn in 60 days)
    cold14: 0.8, newItem: 1.0,
    pairLearn: 0.3, pairCap: 0.9, didnt: 1.2,
    sock: 1.0, cap: 1.0,
    reuseOnDay: 4.0,         // a piece already used in an earlier fit the same day
    jitter: 0.12,
  };

  /* ------------------------------------------------------------------ dates */
  const dayNum = s => Math.floor(Date.parse(s.slice(0, 10) + "T12:00:00Z") / 864e5);
  const ago = (d, today) => dayNum(today) - dayNum(d);

  /* ------------------------------------------------------------------ colour model */
  // [pattern, family, lightness 0..1]; first match wins, so specific words come first
  const COLOURS = [
    [/off-?white/, "white", .92], [/white/, "white", .95], [/cream|oatmeal/, "cream", .85],
    [/light denim|denim/, "denim", .62], [/heather gr[ae]y/, "grey", .6], [/dark charcoal/, "charcoal", .2],
    [/charcoal/, "charcoal", .28], [/gr[ae]y/, "grey", .5], [/black/, "black", .08], [/navy/, "navy", .2],
    [/dark brown/, "brown", .2], [/rust/, "rust", .38], [/brown/, "brown", .3], [/camel/, "camel", .6],
    [/tan/, "tan", .68], [/beige|khaki/, "tan", .72], [/burgundy/, "red", .22], [/red/, "red", .4],
    [/orange/, "orange", .55], [/olive/, "olive", .35], [/forest/, "green", .28], [/sage/, "sage", .6],
    [/mint/, "sage", .78], [/green/, "green", .4], [/teal/, "teal", .45], [/lilac|purple/, "purple", .7],
    [/light blue/, "blue", .75], [/blue/, "blue", .45], [/pink/, "pink", .8],
  ];
  const NEUTRAL = new Set(["white", "cream", "black", "charcoal", "grey", "navy", "denim", "brown", "tan", "camel"]);
  const HUE = {red: "red", rust: "orange", orange: "orange", olive: "green", green: "green", sage: "green",
    teal: "blue", blue: "blue", purple: "purple", pink: "pink"};
  const CLASH = [["red", "green"], ["orange", "blue"], ["orange", "purple"], ["pink", "green"], ["red", "blue"]];

  function colours(it) {
    return String(it.colour || "").toLowerCase().split("/").map((p, i) => {
      const m = COLOURS.find(([re]) => re.test(p));
      return m ? {family: m[1], light: m[2], primary: i === 0} : null;
    }).filter(Boolean);
  }

  /* ------------------------------------------------------------------ per-item attributes (derived, overridable by item.attrs) */
  const cache = new WeakMap();
  function attrs(it) {
    if (cache.has(it)) return cache.get(it);
    const n = String(it.name || "").toLowerCase(), c = String(it.colour || "").toLowerCase(),
      note = String(it.note || "").toLowerCase(), t = it.type;
    const a = {};
    const long = /long sleeve|\bls\b|rugby|overshirt|cardigan/.test(n);
    a.sleeve = t === "tee" ? (long ? "long" : "short")
      : t === "collared" ? (long ? "long" : "short")
        : t === "outerwear" ? (/vest/.test(n) ? "none" : "long") : "long";
    a.warmth = t === "tee" ? (long ? 1.5 : 1.0) : t === "collared" ? (/overshirt|fleece/.test(n) ? 2.4 : /cardigan/.test(n) ? 1.2 : long ? 2.0 : 1.1)
      : t === "knit" ? 2.5 : t === "crewneck" ? 2.2 : t === "hoodie" ? 2.8
        : t === "outerwear" ? (/vest/.test(n) ? 1.2 : 2.0) : 0;
    // formality 0 (sweats) .. 3 (smart)
    const f = {hoodie: 0, joggers: 0, shorts: 0, crewneck: 1, tee: 1, collared: 1.8, knit: 2.5, cap: 1, socks: 1,
      trousers: 1.5, outerwear: 1.5, shoes: 1}[t] ?? 1;
    a.formal = /camp shirt/.test(n) ? 1.5 : /rugby/.test(n) ? 1.5 : /polo/.test(n) ? 1.8 : /button-up/.test(n) ? 2.3
      : /barrel jeans|carpenter/.test(n) ? 1 : /cord|corduroy/.test(n) && t === "trousers" ? 1.5 : /linen/.test(n) ? 1.2
        : /pleated/.test(n) ? 2.6 : /chino/.test(n) ? 2.2 : /rockport/.test(n) ? 2.8 : /slip-on/.test(n) ? 1.8
          : /birkenstock|slides|adilette/.test(n) ? 0.4 : /jordan 1/.test(n) ? 0.8 : /vans|one star|converse/.test(n) ? 1 : f;
    // loudness 0 plain, 1 graphic or mild pattern, 2 very loud
    const strong = /stripe|multi|flowers|floral|royal blue|print|colourblock/.test(c + " " + n)
      || (c.split("/").filter(p => { const m = COLOURS.find(([re]) => re.test(p)); return m && !NEUTRAL.has(m[1]); }).length >= 2);
    const graphic = /graphic|tour|chromakopia|cherry bomb|save the bees|portrait|dandelion|swimming|chuckle|starry|monkey club|woozy|geese|estes|golf|byu|\blr\b|who cares/.test(n);
    a.loud = t === "cap" || t === "socks" ? 0 : strong ? 2 : graphic && (t === "tee" || t === "crewneck" || t === "hoodie") ? 1 : 0;
    // shoes
    a.suede = /suede/.test(n + " " + c) && !/not suede/.test(note);
    a.openToe = /birkenstock|slides|adilette|sandal/.test(n);
    a.beater = /beater/.test(note);
    const cs = colours(it);
    a.lightShoe = t === "shoes" && cs.some(x => x.primary && x.light > .7);
    a.colours = cs;
    // pieces that can be worn over a tee as a layer (hoodie, crewneck, sweater), vs. shells (jackets, vests, overshirts)
    a.over = t === "hoodie" || t === "crewneck" || t === "knit";
    if (it.attrs) Object.assign(a, it.attrs);
    cache.set(it, a);
    return a;
  }

  /* ------------------------------------------------------------------ laundry (same rules as the app) */
  function laundryState(data) {
    const L = data.laundry || {}, worn = (data.log && data.log.worn) || [];
    const stamp = code => [L.last_full, (L.washed || {})[code]].filter(Boolean).sort().pop() || "";
    const wears = code => { const s = stamp(code); return worn.filter(x => x.items.includes(code) && (x.logged_at || x.date + "T12:00:00+00:00") > s).length; };
    return {
      isDirty(it) {
        const q = +(it.qty || 0);
        if (q > 1) return Math.min(q, wears(it.code)) >= q;
        const t = (L.dirtied || {})[it.code];
        if (t && t > stamp(it.code)) return true;
        const lim = (L.wash_after || {})[it.type] || 0;
        return lim > 0 && wears(it.code) >= lim;
      },
    };
  }

  /* ------------------------------------------------------------------ context: what's allowed, what's been worn */
  function prepare(data, opts) {
    const today = opts.today, worn = (data.log && data.log.worn) || [], planned = (data.log && data.log.planned) || [];
    const ls = laundryState(data);
    const all = (data.wardrobe.items || []).filter(i => !i.retired);
    const avail = all.filter(i => !i.avoid && !ls.isDirty(i));
    const bySlot = {layer: [], top: [], bottom: [], shoes: [], socks: [], cap: []};
    avail.forEach(i => bySlot[i.slot] && bySlot[i.slot].push(i));
    const last = {}, count60 = {};
    worn.forEach(x => {
      const d = ago(x.date, today);
      if (d <= 0 || d > 60) return;
      x.items.forEach(c => { count60[c] = (count60[c] || 0) + 1; if (last[c] == null || d < last[c]) last[c] = d; });
    });
    const yesterday = new Set(worn.filter(x => ago(x.date, today) === 1).flatMap(x => x.items));
    const recentCombos = [];
    worn.concat(planned.flatMap(p => (p.fits || []).map(f => ({date: p.date, items: f.items}))))
      .forEach(x => { if (ago(x.date, today) > 0 && ago(x.date, today) <= 14) recentCombos.push(new Set(x.items)); });
    // pair affinity learned from what was actually worn; "didn't work" notes count against the pairs in that fit
    const pair = {}, bad = {};
    const pk = (a, b) => a < b ? a + "|" + b : b + "|" + a;
    worn.forEach(x => {
      for (let i = 0; i < x.items.length; i++) for (let j = i + 1; j < x.items.length; j++) {
        const k = pk(x.items[i], x.items[j]);
        pair[k] = (pair[k] || 0) + 1;
        if (x.didnt) bad[k] = 1;
      }
    });
    const seen = new Set();
    worn.forEach(x => { if (ago(x.date, today) <= 14) x.items.forEach(c => seen.add(c)); });
    planned.forEach(p => { if (ago(p.date, today) <= 14) (p.fits || []).forEach(f => f.items.forEach(c => seen.add(c))); });
    const hasHistory = worn.length + planned.length >= 6;
    return {today, avail, bySlot, last, count60, yesterday, recentCombos, pair, bad, seen, hasHistory, pk};
  }

  /* ------------------------------------------------------------------ weather */
  function feel(weather, phase) {
    const hi = weather.hi, lo = weather.lo == null ? weather.hi - 12 : weather.lo;
    const span = hi - lo;
    const start = phase === "morning" ? lo + .45 * span : phase === "evening" ? lo + .3 * span : phase === "night" ? lo + .12 * span : lo + .45 * span;
    const peak = phase === "evening" || phase === "night" ? start : hi - .1 * span;
    const wind = Math.max(0, (weather.wind || 0) - 8) * .4;
    return {start: start - wind, peak: peak - wind * .5};
  }
  const need = T => 1 + (70 - T) * .095;       // warmth points the upper body should carry at T degrees F

  const TARGET = {lounge: .6, class: 1.2, lab: 1.0, errand: 1.0, out: 1.6, church: 2.4};

  /* ------------------------------------------------------------------ scoring pieces */
  function groups(parts) {
    // weight of each hue group visible in the outfit
    const g = {}, wt = {top: 1, layer: 1, bottom: 1, shoes: .8, cap: .5, socks: .3};
    parts.forEach(({it, slot}) => attrs(it).colours.forEach(c => {
      const grp = HUE[c.family]; if (!grp) return;
      g[grp] = (g[grp] || 0) + wt[slot] * (c.primary ? 1 : .5);
    }));
    return g;
  }

  function core(ctx, o, layer, top, bottom, shoes, wx, why, rules) {
    const A = {top: attrs(top), bottom: attrs(bottom), shoes: attrs(shoes), layer: layer && attrs(layer)};
    let s = 0;
    const note = (pts, txt) => { s += pts; if (why && txt && pts > .5) why.push(txt); };

    // --- warmth
    const f = feel(wx, o.phase), nCold = need(f.start), nWarm = need(f.peak);
    const layered = layer && A.layer.over;                       // tee under a hoodie / crewneck: the tee adds less
    const upper = layered ? A.layer.warmth + A.top.warmth * .55 : A.top.warmth + (layer ? A.layer.warmth : 0);
    const deficit = nCold - upper, excess = A.top.warmth - nWarm - 0.7;
    if (deficit > .3) s -= W.warmthDeficit * (deficit - .3);
    else if (deficit < -1.2 && !layer) s -= W.warmthExcess * (-deficit - 1.2);
    if (excess > 0) s -= W.warmthExcess * excess;
    if (deficit <= .3 && deficit > -1.2) s += .8;
    if (wx.hi >= 68 && layer) s -= 1.2;
    if (bottom.type === "shorts" && f.start < 62) s -= 5;
    if (A.shoes.openToe && f.start < 42 && o.kind !== "lounge") s -= 2.5;
    if (A.shoes.openToe && f.start < 55 && o.kind === "class") s -= 1;

    // --- wet weather: suede and pale shoes suffer, beater shoes are made for it
    const wet = wx.snow || (wx.rain || 0) >= 50;
    if (wet) {
      if (A.shoes.suede) s -= 5;
      if (A.shoes.lightShoe) s -= 3;
      if (A.shoes.beater) s += 1;
      if (attrs(bottom).colours.some(c => c.light > .8)) s -= 1.2;
    }

    // --- lab days: no long sleeve worn alone under the lab coat (Skyler's rule), so the top itself must be short sleeve
    if (o.kind === "lab" && rules.labShortSleeve && A.top.sleeve === "long") s -= 50;

    if (layer && !A.layer.over && layer.type === "collared" && A.top.warmth >= 2.2) s -= 1.5;   // shirt-layer over a hoodie
    if (/linen/.test(String(bottom.name).toLowerCase()) && f.start < 55) s -= f.start < 48 ? 3 : 1.5;

    // --- formality
    const fs = [A.top.formal, A.bottom.formal, A.shoes.formal].concat(layer ? [A.layer.formal] : []);
    const mean = fs.reduce((a, b) => a + b, 0) / fs.length, tgt = TARGET[o.kind] ?? 1.2;
    s -= W.formality * Math.abs(mean - tgt);
    const gap = Math.max(...fs) - Math.min(...fs);
    if (gap > 1.2) s -= W.formalityGap * (gap - 1.2);

    // --- colour
    const parts = [{it: top, slot: "top"}, {it: bottom, slot: "bottom"}, {it: shoes, slot: "shoes"}].concat(layer ? [{it: layer, slot: "layer"}] : []);
    const g = groups(parts), strong = Object.keys(g).filter(k => g[k] >= .8);
    if (strong.length === 0) note(W.quiet);
    else if (strong.length === 1) note(W.pop, "one colour pop");
    else {
      const clash = CLASH.some(([x, y]) => g[x] >= .5 && g[y] >= .5);
      if (clash) s -= W.clash; else if (strong.length === 2) s += .4; else s -= W.crowded;
      if (strong.length >= 3) s -= W.crowded;
    }
    const tc = A.top.colours[0], bc = A.bottom.colours[0];
    if (tc && bc) {
      if (tc.family === bc.family && tc.family !== "black") s -= W.matchy;
      const d = Math.abs(tc.light - bc.light);
      if (d >= .35) note(W.contrast, "light against dark");
      else if (d < .15 && !(tc.light < .3 && bc.light < .3)) s -= .6;
      if ((tc.family === "navy" && bc.family === "black") || (tc.family === "black" && bc.family === "navy")) s -= .6;
    }

    // --- one statement piece
    const loud = A.top.loud + (layer ? A.layer.loud : 0) + A.bottom.loud;
    s += loud === 0 ? W.statementNone : loud === 1 ? W.statementOne : loud === 2 ? W.statementTwo : W.statementMany;
    if (loud === 1) why && why.push("one statement piece");
    if (A.shoes.loud >= 2) { if (loud <= 1) { s += W.shoePop; why && why.push("the " + shortName(shoes) + " are the statement"); } else s -= W.shoePopBusy; }

    // --- rotation
    [[top, 1], [bottom, 1], [shoes, 1], [layer, .7]].forEach(([it, k]) => {
      if (!it) return;
      const d = ctx.last[it.code], c60 = ctx.count60[it.code] || 0;
      if (it.qty > 1) return;
      if (d != null && d <= 2) s -= W.recentWorn * k; else if (d != null && d <= 4) s -= W.recentWorn2 * k;
      s += W.fresh * k / (1 + c60);
      if (ctx.hasHistory && !ctx.seen.has(it.code)) { s += W.cold14 * k; if (why) why.push("haven't worn the " + shortName(it) + " in a while"); }
      if (it.added && ago(it.added, ctx.today) <= 14) { s += W.newItem * k; if (why) why.push("the new " + shortName(it)); }
    });
    if (ctx.yesterday.has(bottom.code)) s -= W.yesterdayRepeat;
    if (ctx.yesterday.has(shoes.code) && !A.shoes.beater) s -= W.yesterdayRepeat;
    else if (ctx.yesterday.has(shoes.code)) s -= W.yesterdayRepeat * .4;

    // --- learned pairs
    const codes = [top, bottom, shoes].concat(layer ? [layer] : []).map(i => i.code);
    let learn = 0;
    for (let i = 0; i < codes.length; i++) for (let j = i + 1; j < codes.length; j++) {
      const k = ctx.pk(codes[i], codes[j]);
      learn += W.pairLearn * Math.min(ctx.pair[k] || 0, 3) ** .5;
      if (ctx.bad[k]) s -= W.didnt;
    }
    s += Math.min(learn, W.pairCap);
    return s;
  }

  function sockScore(sock, outfit, ctx) {
    const a = attrs(sock).colours[0]; if (!a) return 0;
    let s = sock.code === "8916" || (sock.qty > 1 && /black/.test(sock.colour)) ? .6 : 0;   // the default, never scarce
    const fam = it => (attrs(it).colours[0] || {}).family;
    const shoeF = fam(outfit.shoes), botF = fam(outfit.bottom);
    if (a.family === shoeF || a.family === botF) s += .8;
    const g = groups(Object.entries(outfit).filter(([k, v]) => v && ["top", "layer", "bottom", "shoes"].includes(k)).map(([k, v]) => ({it: v, slot: k})));
    const grp = HUE[a.family];
    if (grp && g[grp] >= .8) s += 1;
    else if (grp) s -= .8;
    if (a.family === "brown" && shoeF === "black") s -= .5;
    if (["white", "cream"].includes(a.family) && !(["white", "cream"].includes(shoeF))) s += outfit.shoes && attrs(outfit.shoes).openToe ? 0 : .2;
    return s * W.sock;
  }

  function capScore(cap, outfit, ctx) {
    const a = attrs(cap).colours[0]; if (!a) return 0;
    const fams = ["top", "bottom", "shoes", "layer"].map(k => outfit[k] && (attrs(outfit[k]).colours[0] || {}).family).filter(Boolean);
    let s = fams.includes(a.family) ? 1 : (NEUTRAL.has(a.family) ? .2 : -.6);
    if (a.family === "camel" && fams.some(f => ["brown", "tan", "cream"].includes(f))) s += .4;
    const d = ctx.last[cap.code];
    if (d != null && d <= 1) s -= .5;
    return s * W.cap;
  }

  /* ------------------------------------------------------------------ naming */
  function shortName(it) {
    return String(it.name).replace(/^(corduroy|heavy|short-sleeve|ribbed|open-knit)\s+/i, "").replace(/\s+(crewneck|hoodie)$/i, m => m).toLowerCase();
  }
  function fitName(top, layer, bottom) {
    if (layer && attrs(layer).over) return layer.name + " over " + String(top.name).toLowerCase();
    const t = String(top.name).replace(/^(the )/i, "");
    const second = layer ? layer.name : bottom.name;
    return t + " & " + second.toLowerCase();
  }

  /* ------------------------------------------------------------------ main */
  function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  function suggest(data, opts) {
    const o = Object.assign({kind: "class", phase: "day"}, opts.occasion || {});
    const wx = Object.assign({hi: 60, lo: 45, rain: 0, snow: false, wind: 0}, opts.weather || {});
    const rules = Object.assign({alwaysCap: true, labShortSleeve: true}, opts.rules || {});
    const n = opts.n || 3, today = opts.today;
    const ctx = prepare(data, {today});
    const steer = new Set(opts.avoid || []);
    const rand = rng(dayNum(today) * 1009 + (opts.salt || 0) * 7919 + 17);
    const B = ctx.bySlot, problems = [];
    ["top", "bottom", "shoes", "socks"].forEach(k => { if (!B[k].length) problems.push("No clean " + k + " available"); });
    if (rules.alwaysCap && !B.cap.length) problems.push("No clean cap available");
    if (problems.length) return {fits: [], problems};

    const shells = B.layer, overs = B.top.filter(i => attrs(i).over);
    const cands = [];
    for (const top of B.top) for (const layer of [null].concat(shells, top.type === "tee" ? overs : []))
      for (const bottom of B.bottom) for (const shoes of B.shoes) {
      let s = core(ctx, o, layer, top, bottom, shoes, wx, null, rules);
      const items = [top.code, bottom.code, shoes.code].concat(layer ? [layer.code] : []);
      const set = new Set(items);
      if (ctx.recentCombos.some(c => items.every(x => c.has(x)))) s -= 6;            // don't repeat a combo from the last 2 weeks
      steer.forEach(c => { if (set.has(c)) s -= W.reuseOnDay; });
      cands.push({s: s + (rand() - .5) * 2 * W.jitter, layer, top, bottom, shoes});
    }
    cands.sort((a, b) => b.s - a.s);
    const pool = cands.slice(0, 300);
    // socks and cap are picked per outfit (they depend on what the outfit looks like)
    pool.forEach(c => {
      const outfit = {top: c.top, layer: c.layer, bottom: c.bottom, shoes: c.shoes};
      let bestS = null, bs = -1e9;
      B.socks.forEach(k => { const v = sockScore(k, outfit, ctx) + (rand() - .5) * .3; if (v > bs) { bs = v; bestS = k; } });
      let bestC = null, bc = -1e9;
      B.cap.forEach(k => { const v = capScore(k, outfit, ctx) + (rand() - .5) * .3; if (v > bc) { bc = v; bestC = k; } });
      c.socks = bestS; c.cap = bestC; c.s += bs + (bestC ? bc : 0);
    });
    pool.sort((a, b) => b.s - a.s);

    // greedy pick with a diversity penalty so the three fits are genuinely different
    const picked = [];
    const sim = (a, b) => (a.top === b.top ? 2 : 0) + (a.bottom === b.bottom ? 1.5 : 0) + (a.shoes === b.shoes ? 1 : 0) + (a.layer && a.layer === b.layer ? .5 : 0);
    while (picked.length < n && pool.length) {
      let bi = -1, bv = -1e9;
      pool.forEach((c, i) => { const v = c.s - 1.1 * picked.reduce((m, p) => Math.max(m, sim(c, p)), 0); if (v > bv) { bv = v; bi = i; } });
      picked.push(pool.splice(bi, 1)[0]);
    }
    const fits = picked.map(c => {
      const why = [];
      core(ctx, o, c.layer, c.top, c.bottom, c.shoes, wx, why, rules);
      const f = feel(wx, o.phase);
      const upper = attrs(c.top).warmth + (c.layer ? attrs(c.layer).warmth : 0);
      if (upper >= need(f.start) - .3) why.unshift("warm enough for " + Math.round(f.start) + "°F" + (c.layer ? " with the " + shortName(c.layer) : ""));
      const items = [c.layer, c.top, c.bottom, c.socks, c.shoes, c.cap].filter(Boolean).map(i => i.code);
      return {name: fitName(c.top, c.layer, c.bottom), items, score: Math.round(c.s * 100) / 100, why: why.slice(0, 3),
        capOptional: o.kind === "church"};
    });
    return {fits, problems};
  }

  /** Several occasions in one day: later fits steer away from pieces the earlier ones used. */
  function suggestDay(data, opts) {
    const used = [], out = [];
    (opts.occasions || []).forEach((occ, i) => {
      const r = suggest(data, Object.assign({}, opts, {occasion: occ, n: 1, avoid: used.slice(), salt: (opts.salt || 0) + i}));
      const f = r.fits[0]; if (!f) return;
      out.push(Object.assign({when: occ.label || occ.kind, kind: occ.kind}, f));
      f.items.forEach(c => { const it = data.wardrobe.items.find(x => x.code === c); if (it && ["top", "bottom", "shoes", "layer"].includes(it.slot)) used.push(c); });
    });
    return out;
  }

  /** Score one existing outfit (for backtesting and for ranking what Claude or Skyler picked). */
  function scoreFit(data, opts, codes) {
    const o = Object.assign({kind: "class", phase: "day"}, opts.occasion || {});
    const wx = Object.assign({hi: 60, lo: 45, rain: 0, snow: false, wind: 0}, opts.weather || {});
    const ctx = prepare(data, {today: opts.today});
    const by = c => data.wardrobe.items.find(i => i.code === c);
    const its = codes.map(by).filter(Boolean);
    const pick = slot => its.find(i => i.slot === slot);
    const tops = its.filter(i => i.slot === "top"), bottom = pick("bottom"), shoes = pick("shoes");
    let top = tops[0], layer = pick("layer") || null;
    if (tops.length >= 2) { top = tops.find(i => i.type === "tee") || tops[0]; layer = tops.find(i => i !== top); }   // tee under a hoodie / crewneck
    if (!top || !bottom || !shoes) return null;
    const rules = Object.assign({alwaysCap: true, labShortSleeve: true}, opts.rules || {});
    let s = core(ctx, o, layer, top, bottom, shoes, wx, null, rules);
    const outfit = {top, layer, bottom, shoes};
    const sock = pick("socks"), cap = pick("cap");
    s += (sock ? sockScore(sock, outfit, ctx) : 0) + (cap ? capScore(cap, outfit, ctx) : 0);
    return s;
  }

  return {suggest, suggestDay, scoreFit, prepare, attrs, W, feel, need};
});
