/* The Rail fit engine: free, deterministic, no AI and no network.
 *
 * suggest(data, opts) builds candidate outfits from the closet, drops the ones that break a hard rule,
 * scores the rest, and returns a few that are good AND different from each other.
 *
 * Scoring is a linear model over named features (colour pop, contrast, warmth gap, rotation, ...).
 * PRIOR holds hand-set weights; TUNED holds weights learned from real fits (test/engine-train.mjs writes it);
 * personalize(data) learns a per-person adjustment from that person's own worn log, in the browser.
 *
 *   data = {wardrobe: {items: [...]}, log: {worn: [...], planned: [...]}, laundry: {...}}   (the three JSON files)
 *   opts = {today: "YYYY-MM-DD", weather: {hi, lo, rain (0-100), snow (bool), wind (mph)},
 *           occasion: {kind: "class"|"lab"|"lounge"|"out"|"church"|"errand", phase: "morning"|"day"|"evening"|"night"},
 *           n: 3, salt: 0, avoid: [codes to steer away from], exclude: [[codes], ...] fits already shown,
 *           rules: {cap: "always"|"optional"|"never", labShortSleeve}, weights}
 *         (the old {alwaysCap: false} still works and means "optional")
 *
 * Works in the browser (window.RailEngine) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RailEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------------ weights: + is good, - is bad */
  const PRIOR = {
    // warmth and weather
    warmDef: -2.4, overdressed: -0.9, topTooWarm: -0.9, warmOK: 0.8, layerHot: -1.2, shortsCold: -5,
    openToeCold: -2.5, openToeOut: -1, wetSuede: -5, wetLight: -3, wetBeater: 1, wetLightBottom: -1.2,
    shirtOverHoodie: -1.5, linenCold: -1.5, layered: 0,
    // formality
    formUnder: -1.3, formOver: -1.3, formGap: -1.3, churchUnder: -2.5,
    // colour
    quiet: 0.8, pop: 2, clash: -3.5, twoHues: 0.4, crowded: -6, matchy: -0.9, contrastHi: 1, contrastLow: -0.6,
    contrastTB: 0, navyBlack: -0.6, earth: 0, allDark: 0, allLight: 0, shoeBottomContrast: 0,
    // statement pieces
    loudNone: 0.2, loudOne: 1, loudTwo: -0.8, loudMany: -2.5, shoePopQuiet: 0.6, shoePopBusy: -1,
    // rotation and history
    recent2: -1.2, recent4: -0.6, fresh: 0.5, cold14: 0.8, newItem: 1, yBottom: -2, yShoe: -2, pairs: 0.3, didnt: -1.2,
    // affinity: how often these pieces have been put together in past sheets and worn fits (lift over chance)
    coreAff: 0.5, sockAff: 0.3, capAff: 0.3,
    // socks
    sockDefault: 0.6, sockMatch: 0.8, sockEcho: 1, sockOff: -0.8, sockBrownBlack: -0.5, sockLight: 0.2,
    // caps
    capMatch: 1, capNeutral: 0.2, capOff: -0.6, capCamel: 0.4, capRecent: -0.5, capMatchShoe: 0,
  };
  /*tuned:start*/
  // learned 2026-11-24 from 153 fits over 29 days (test/engine-train.mjs)
  const TUNED = {"warmDef":-0.905,"overdressed":-0.9,"topTooWarm":-0.883,"warmOK":-0.49,"layerHot":-1.2,"shortsCold":-5,"openToeCold":-2.5,"openToeOut":-1.411,"wetSuede":-5,"wetLight":-3,"wetBeater":1,"wetLightBottom":-1.2,"shirtOverHoodie":-1.34,"linenCold":-1.526,"layered":0.857,"formUnder":-0.746,"formOver":-1.37,"formGap":-1.89,"quiet":0.54,"pop":1.288,"clash":-2.863,"twoHues":0.735,"crowded":-6,"matchy":-0.941,"contrastHi":0.06,"contrastLow":0.102,"contrastTB":-0.346,"navyBlack":-0.6,"earth":-0.6,"allDark":0.872,"allLight":-0.399,"shoeBottomContrast":0.012,"loudNone":0.294,"loudOne":-0.066,"loudTwo":-0.35,"loudMany":-1.978,"shoePopQuiet":0.209,"shoePopBusy":0.134,"recent2":-1.2,"recent4":-0.6,"fresh":0.5,"cold14":0.8,"newItem":1,"yBottom":-2,"yShoe":-2,"pairs":0.766,"didnt":-1.2,"coreAff":0.985,"sockAff":0.528,"capAff":0.12,"sockDefault":0.6,"sockMatch":1.028,"sockEcho":0.413,"sockOff":-1.083,"sockBrownBlack":-0.398,"sockLight":-0.503,"capMatch":0.549,"capNeutral":0.461,"capOff":-0.6,"capCamel":-0.012,"capRecent":-0.5,"capMatchShoe":0.291};
  /*tuned:end*/
  const W = Object.assign({}, PRIOR, TUNED || {});
  const HARD = {lab: 50, repeatCombo: 6, reuseOnDay: 4, jitter: 0.12};
  // Policy, not taste: rotation and safety stay at their hand values. Learning them from people who re-wear favourites
  // would switch rotation off, and safety rules rarely show up in the data at all.
  const FIXED = new Set(["recent2", "recent4", "fresh", "cold14", "newItem", "yBottom", "yShoe", "capRecent", "didnt", "sockDefault",
    "churchUnder", "shortsCold", "wetSuede", "wetLight", "wetBeater", "wetLightBottom", "openToeCold"]);

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
  const EARTH = new Set(["brown", "tan", "camel", "cream", "olive", "rust", "sage"]);
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
    a.suede = /suede/.test(n + " " + c) && !/not suede/.test(note);
    a.openToe = /birkenstock|slides|adilette|sandal/.test(n);
    a.beater = /beater/.test(note);
    const cs = colours(it);
    a.lightShoe = t === "shoes" && cs.some(x => x.primary && x.light > .7);
    a.colours = cs;
    a.fam = (cs[0] || {}).family;
    a.light = cs[0] ? cs[0].light : .5;
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
      if (ago(x.date, today) <= 0) return;
      for (let i = 0; i < x.items.length; i++) for (let j = i + 1; j < x.items.length; j++) {
        const k = pk(x.items[i], x.items[j]);
        pair[k] = (pair[k] || 0) + 1;
        if (x.didnt) bad[k] = 1;
      }
    });
    // co-occurrence across every good fit before today: sheets (weight 1) and worn fits (weight 2)
    const co = {}, cnt = {};
    let N = 0;
    const addFit = (items, wt) => {
      N += wt; items.forEach(c => cnt[c] = (cnt[c] || 0) + wt);
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) { const k = pk(items[i], items[j]); co[k] = (co[k] || 0) + wt; }
    };
    worn.forEach(x => { if (ago(x.date, today) > 0) addFit(x.items, 2); });
    planned.forEach(p => { if (ago(p.date, today) > 0) (p.fits || []).forEach(f => addFit(f.items, 1)); });
    // smoothed log lift: >0 these two go together more than chance, <0 they're kept apart
    const aff = (a, b) => N < 10 ? 0 : Math.log(((co[pk(a, b)] || 0) + .5) / (((cnt[a] || 0) * (cnt[b] || 0)) / N + .5));
    const seen = new Set();
    worn.forEach(x => { if (ago(x.date, today) <= 14) x.items.forEach(c => seen.add(c)); });
    planned.forEach(p => { if (ago(p.date, today) <= 14) (p.fits || []).forEach(f => f.items.forEach(c => seen.add(c))); });
    const hasHistory = worn.length + planned.length >= 6;
    return {today, avail, bySlot, last, count60, yesterday, recentCombos, pair, bad, seen, hasHistory, pk, aff};
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

  /* ------------------------------------------------------------------ features */
  function groups(parts) {
    // weight of each hue group visible in the outfit
    const g = {}, wt = {top: 1, layer: 1, bottom: 1, shoes: .8, cap: .5, socks: .3};
    parts.forEach(([it, slot]) => attrs(it).colours.forEach(c => {
      const grp = HUE[c.family]; if (!grp) return;
      g[grp] = (g[grp] || 0) + wt[slot] * (c.primary ? 1 : .5);
    }));
    return g;
  }
  const shortName = it => String(it.name).replace(/^(corduroy|heavy|short-sleeve|ribbed|open-knit)\s+/i, "").toLowerCase();

  // Features of the core outfit (layer, top, bottom, shoes). note[feature] = text collects reasons when asked.
  function coreFeats(ctx, o, wx, {layer, top, bottom, shoes}, note) {
    const A = {top: attrs(top), bottom: attrs(bottom), shoes: attrs(shoes), layer: layer && attrs(layer)};
    const F = {};
    const say = (k, txt) => { if (note) note[k] = txt; };

    // --- warmth
    const f = feel(wx, o.phase), nCold = need(f.start), nWarm = need(f.peak);
    const layered = !!(layer && A.layer.over);                    // tee under a hoodie / crewneck: the tee adds less
    const upper = layered ? A.layer.warmth + A.top.warmth * .55 : A.top.warmth + (layer ? A.layer.warmth : 0);
    const deficit = nCold - upper, excess = A.top.warmth - nWarm - 0.7;
    if (deficit > .3) F.warmDef = deficit - .3;
    else if (deficit < -1.2 && !layer) F.overdressed = -deficit - 1.2;
    if (excess > 0) F.topTooWarm = excess;
    if (deficit <= .3 && deficit > -1.2) { F.warmOK = 1; say("warmOK", "warm enough for " + Math.round(f.start) + "°F" + (layer ? " with the " + shortName(layer) : "")); }
    if (wx.hi >= 68 && layer) F.layerHot = 1;
    if (layered) F.layered = 1;
    if (bottom.type === "shorts" && f.start < 62) F.shortsCold = 1;
    if (A.shoes.openToe && f.start < 42 && o.kind !== "lounge") F.openToeCold = 1;
    if (A.shoes.openToe && o.kind !== "lounge") F.openToeOut = 1;
    const wet = wx.snow || (wx.rain || 0) >= 50;
    if (wet) {
      if (A.shoes.suede) F.wetSuede = 1;
      if (A.shoes.lightShoe) F.wetLight = 1;
      if (A.shoes.beater) { F.wetBeater = 1; say("wetBeater", "the " + shortName(shoes) + " can take the wet"); }
      if (A.bottom.light > .8) F.wetLightBottom = 1;
    }
    if (layer && !A.layer.over && layer.type === "collared" && A.top.warmth >= 2.2) F.shirtOverHoodie = 1;
    if (/linen/.test(String(bottom.name).toLowerCase()) && f.start < 55) F.linenCold = (55 - f.start) / 7;

    // --- formality
    const fs = [A.top.formal, A.bottom.formal, A.shoes.formal].concat(layer ? [A.layer.formal] : []);
    const mean = fs.reduce((a, b) => a + b, 0) / fs.length, tgt = TARGET[o.kind] ?? 1.2;
    if (mean < tgt) F.formUnder = tgt - mean; else F.formOver = mean - tgt;
    if (o.kind === "church" && mean < tgt) F.churchUnder = tgt - mean;      // dressing down for church is a rule, not a taste
    const gap = Math.max(...fs) - Math.min(...fs);
    if (gap > 1.2) F.formGap = gap - 1.2;

    // --- colour
    const core = [[top, "top"], [bottom, "bottom"], [shoes, "shoes"]].concat(layer ? [[layer, "layer"]] : []);
    const g = groups(core), strong = Object.keys(g).filter(k => g[k] >= .8);
    if (strong.length === 0) F.quiet = 1;
    else if (strong.length === 1) { F.pop = 1; say("pop", "one colour pop"); }
    else if (CLASH.some(([x, y]) => g[x] >= .5 && g[y] >= .5)) F.clash = 1;
    else if (strong.length === 2) F.twoHues = 1;
    else F.crowded = 1;
    const vis = layer ? A.layer : A.top;                                  // what reads from across the room
    const tl = vis.light, bl = A.bottom.light, d = Math.abs(tl - bl);
    F.contrastTB = d;
    if (d >= .35) { F.contrastHi = 1; say("contrastHi", "light against dark"); }
    else if (d < .15 && !(tl < .3 && bl < .3)) F.contrastLow = 1;
    if (A.top.fam && A.top.fam === A.bottom.fam && A.top.fam !== "black") F.matchy = 1;
    if ((vis.fam === "navy" && A.bottom.fam === "black") || (vis.fam === "black" && A.bottom.fam === "navy")) F.navyBlack = 1;
    const fams = core.map(([it]) => attrs(it).fam).filter(Boolean);
    F.earth = fams.filter(x => EARTH.has(x)).length / Math.max(fams.length, 1);
    if (F.earth >= .75) say("earth", "earthy palette");
    const lights = core.map(([it]) => attrs(it).light);
    if (lights.every(x => x < .32)) F.allDark = 1;
    if (lights.every(x => x > .7)) F.allLight = 1;
    F.shoeBottomContrast = Math.abs(A.shoes.light - bl);

    // --- one statement piece
    const loud = A.top.loud + (layer ? A.layer.loud : 0) + A.bottom.loud;
    if (loud === 0) F.loudNone = 1; else if (loud === 1) { F.loudOne = 1; say("loudOne", "one statement piece"); }
    else if (loud === 2) F.loudTwo = 1; else F.loudMany = 1;
    if (A.shoes.loud >= 2) {
      if (loud <= 1) { F.shoePopQuiet = 1; say("shoePopQuiet", "the " + shortName(shoes) + " are the statement"); }
      else F.shoePopBusy = 1;
    }

    // --- rotation
    [[top, 1], [bottom, 1], [shoes, 1], [layer, .7]].forEach(([it, k]) => {
      if (!it || it.qty > 1) return;
      const dd = ctx.last[it.code], c60 = ctx.count60[it.code] || 0;
      if (dd != null && dd <= 2) F.recent2 = (F.recent2 || 0) + k; else if (dd != null && dd <= 4) F.recent4 = (F.recent4 || 0) + k;
      F.fresh = (F.fresh || 0) + k / (1 + c60);
      if (ctx.hasHistory && !ctx.seen.has(it.code)) { F.cold14 = (F.cold14 || 0) + k; say("cold14", "you haven't worn the " + shortName(it) + " in a while"); }
      if (it.added && ago(it.added, ctx.today) <= 14) { F.newItem = (F.newItem || 0) + k; say("newItem", "gets the new " + shortName(it) + " out"); }
    });
    if (ctx.yesterday.has(bottom.code)) F.yBottom = 1;
    if (ctx.yesterday.has(shoes.code)) F.yShoe = A.shoes.beater ? .4 : 1;

    // --- learned pairs
    const codes = [top, bottom, shoes].concat(layer ? [layer] : []).map(i => i.code);
    let learn = 0;
    for (let i = 0; i < codes.length; i++) for (let j = i + 1; j < codes.length; j++) {
      const k = ctx.pk(codes[i], codes[j]);
      learn += Math.sqrt(Math.min(ctx.pair[k] || 0, 3));
      if (ctx.bad[k]) F.didnt = (F.didnt || 0) + 1;
    }
    if (learn) { F.pairs = Math.min(learn, 3); if (learn >= 2) say("pairs", "a pairing you've worn before"); }
    let af = 0, np = 0;
    for (let i = 0; i < codes.length; i++) for (let j = i + 1; j < codes.length; j++) { af += ctx.aff(codes[i], codes[j]); np++; }
    if (np) { F.coreAff = af / np; if (F.coreAff > .6) say("coreAff", "pieces that have worked together for you"); }
    return F;
  }

  function sockFeats(ctx, sock, out, note) {
    const a = attrs(sock), F = {};
    const coreIt = ["top", "layer", "bottom", "shoes"].map(k => out[k]).filter(Boolean);
    F.sockAff = coreIt.reduce((s, it) => s + ctx.aff(sock.code, it.code), 0) / coreIt.length;
    if (!a.fam) return F;
    if (sock.qty > 1 && /black/.test(sock.colour)) F.sockDefault = 1;              // the default, never scarce
    const shoeF = attrs(out.shoes).fam, botF = attrs(out.bottom).fam;
    if (a.fam === shoeF || a.fam === botF) F.sockMatch = 1;
    const g = groups(["top", "layer", "bottom", "shoes"].filter(k => out[k]).map(k => [out[k], k]));
    const grp = HUE[a.fam];
    if (grp && g[grp] >= .8) {
      F.sockEcho = 1;
      const src = ["shoes", "layer", "top", "bottom"].map(k => out[k]).find(it => it && attrs(it).colours.some(c => HUE[c.family] === grp));
      if (note && src) note.sockEcho = shortName(sock) + " pick up the " + shortName(src);
    } else if (grp) F.sockOff = 1;
    if (a.fam === "brown" && shoeF === "black") F.sockBrownBlack = 1;
    if (["white", "cream"].includes(a.fam) && !["white", "cream"].includes(shoeF) && !attrs(out.shoes).openToe) F.sockLight = 1;
    return F;
  }

  function capFeats(ctx, cap, out) {
    const a = attrs(cap), F = {};
    const coreIt = ["top", "layer", "bottom", "shoes"].map(k => out[k]).filter(Boolean);
    F.capAff = coreIt.reduce((s, it) => s + ctx.aff(cap.code, it.code), 0) / coreIt.length;
    if (!a.fam) return F;
    const fams = ["top", "bottom", "shoes", "layer"].map(k => out[k] && attrs(out[k]).fam).filter(Boolean);
    if (fams.includes(a.fam)) F.capMatch = 1; else if (NEUTRAL.has(a.fam)) F.capNeutral = 1; else F.capOff = 1;
    if (a.fam === "camel" && fams.some(f => ["brown", "tan", "cream"].includes(f))) F.capCamel = 1;
    if (attrs(out.shoes).fam === a.fam) F.capMatchShoe = 1;
    const d = ctx.last[cap.code];
    if (d != null && d <= 1) F.capRecent = 1;
    return F;
  }

  const dot = (w, F) => { let s = 0; for (const k in F) s += (w[k] || 0) * F[k]; return s; };
  const merge = (...fs) => Object.assign({}, ...fs);

  /* ------------------------------------------------------------------ full outfit from a list of codes */
  function split(data, codes) {
    const its = codes.map(c => data.wardrobe.items.find(i => i.code === c)).filter(Boolean);
    const pick = slot => its.find(i => i.slot === slot);
    const tops = its.filter(i => i.slot === "top");
    let top = tops[0], layer = pick("layer") || null;
    if (tops.length >= 2) { top = tops.find(i => i.type === "tee") || tops[0]; layer = tops.find(i => i !== top); }   // tee under a hoodie / crewneck
    return {top, layer, bottom: pick("bottom"), shoes: pick("shoes"), socks: pick("socks"), cap: pick("cap")};
  }
  function outfitFeats(ctx, o, wx, out) {
    if (!out.top || !out.bottom || !out.shoes) return null;
    return merge(coreFeats(ctx, o, wx, out, null), out.socks ? sockFeats(ctx, out.socks, out) : {}, out.cap ? capFeats(ctx, out.cap, out) : {});
  }
  // Each person's own rules. Missing ones fall back to the original owner defaults (cap on every fit, lab-day sleeves).
  function normRules(r) {
    r = Object.assign({labShortSleeve: true}, r || {});
    if (!["always", "optional", "never"].includes(r.cap)) r.cap = r.alwaysCap === false ? "optional" : "always";
    r.alwaysCap = r.cap === "always";
    return r;
  }
  const labBreak = (o, rules, out) => o.kind === "lab" && rules.labShortSleeve !== false && attrs(out.top).sleeve === "long";

  /* ------------------------------------------------------------------ naming */
  function fitName(top, layer, bottom) {
    if (layer && attrs(layer).over) return layer.name + " over " + String(top.name).toLowerCase();
    return String(top.name) + " & " + (layer ? layer.name : bottom.name).toLowerCase();
  }

  /* ------------------------------------------------------------------ main */
  function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const defaults = opts => ({
    o: Object.assign({kind: "class", phase: "day"}, opts.occasion || {}),
    wx: Object.assign({hi: 60, lo: 45, rain: 0, snow: false, wind: 0}, opts.weather || {}),
    rules: normRules(opts.rules),
    w: opts.weights || W,
  });

  function suggest(data, opts) {
    const {o, wx, rules, w} = defaults(opts);
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
        const out = {top, layer, bottom, shoes};
        let s = dot(w, coreFeats(ctx, o, wx, out, null));
        if (labBreak(o, rules, out)) s -= HARD.lab;
        const items = [top.code, bottom.code, shoes.code].concat(layer ? [layer.code] : []);
        if (ctx.recentCombos.some(c => items.every(x => c.has(x)))) s -= HARD.repeatCombo;   // nothing from the last 2 weeks again
        items.forEach(c => { if (steer.has(c)) s -= HARD.reuseOnDay; });
        cands.push({s: s + (rand() - .5) * 2 * HARD.jitter, out});
      }
    cands.sort((a, b) => b.s - a.s);
    const pool = cands.slice(0, 300);
    // socks and cap depend on what the outfit looks like, so they're picked per outfit
    pool.forEach(c => {
      let bs = -1e9, bc = -1e9;
      B.socks.forEach(k => { const v = dot(w, sockFeats(ctx, k, c.out)) + (rand() - .5) * .3; if (v > bs) { bs = v; c.out.socks = k; } });
      if (rules.cap !== "never") B.cap.forEach(k => { const v = dot(w, capFeats(ctx, k, c.out)) + (rand() - .5) * .3; if (v > bc) { bc = v; c.out.cap = k; } });
      if (rules.cap === "optional" && c.out.cap && bc <= 0) { c.out.cap = null; bc = 0; }   // only when a cap actually helps the fit
      c.s += bs + (c.out.cap ? bc : 0);
    });
    pool.sort((a, b) => b.s - a.s);

    // greedy pick with a diversity penalty so the fits are genuinely different, from each other and from fits already shown
    const shown = (opts.exclude || []).map(items => ({out: split(data, items)}));
    const picked = [];
    // how alike two outfits look: shared pieces, whatever role they play. The piece people see first (the top, or a
    // hoodie / crewneck worn over a tee) counts most; a jacket or vest over different tops counts least.
    const looks = out => { const m = new Map([[out.top, 2], [out.bottom, 1.5], [out.shoes, 1]]); if (out.layer) m.set(out.layer, attrs(out.layer).over ? 2 : .5); return m; };
    const sim = (a, b) => { const A = a._l || (a._l = looks(a)), B = b._l || (b._l = looks(b)); let s = 0; A.forEach((v, it) => { if (B.has(it)) s += Math.max(v, B.get(it)); }); return s; };
    while (picked.length < n && pool.length) {
      let bi = -1, bv = -1e9;
      pool.forEach((c, i) => {
        const v = c.s - 1.1 * picked.reduce((m, p) => Math.max(m, sim(c.out, p.out)), 0) - 1.6 * shown.reduce((m, p) => Math.max(m, sim(c.out, p.out)), 0);
        if (v > bv) { bv = v; bi = i; }
      });
      picked.push(pool.splice(bi, 1)[0]);
    }
    const fits = picked.map(c => {
      const out = c.out, note = {};
      const F = merge(coreFeats(ctx, o, wx, out, note), sockFeats(ctx, out.socks, out, note));
      // reasons: the features that added the most to this fit's score, in plain words
      const why = Object.keys(note).filter(k => k !== "warmOK" && (w[k] || 0) * (F[k] || 0) > .3).sort((a, b) => w[b] * F[b] - w[a] * F[a]).map(k => note[k]);
      if (note.warmOK) why.unshift(note.warmOK);
      const items = [out.layer, out.top, out.bottom, out.socks, out.shoes, out.cap].filter(Boolean).map(i => i.code);
      return {name: fitName(out.top, out.layer, out.bottom), items, score: Math.round(c.s * 100) / 100, why: why.slice(0, 3),
        capOptional: !!out.cap && (o.kind === "church" || rules.cap === "optional")};
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
    const {o, wx, rules, w} = defaults(opts);
    const ctx = opts.ctx || prepare(data, {today: opts.today});
    const out = split(data, codes), F = outfitFeats(ctx, o, wx, out);
    if (!F) return null;
    return dot(w, F) - (labBreak(o, rules, out) ? HARD.lab : 0);
  }

  /** Hard-rule problems with an outfit, in words (used to check the morning sheet before it's saved). */
  function check(data, opts, codes) {
    const {o, wx, rules} = defaults(opts), out = split(data, codes), bad = [];
    const by = c => data.wardrobe.items.find(i => i.code === c);
    codes.forEach(c => { if (!by(c)) bad.push("unknown piece " + c); else if (by(c).avoid) bad.push(by(c).name + " is hidden"); });
    if (!out.cap && rules.cap === "always") bad.push("no cap");
    if (!out.top || !out.bottom || !out.shoes) bad.push("missing a top, bottom or shoes");
    if (out.top && o.kind === "lab" && rules.labShortSleeve !== false && attrs(out.top).sleeve === "long") bad.push("lab: " + out.top.name + " is long-sleeved against the skin (lab coat goes over it)");
    if (out.shoes && (wx.snow || wx.rain >= 50) && attrs(out.shoes).suede) bad.push("suede " + out.shoes.name + " on a wet day");
    if (out.bottom && out.bottom.type === "shorts" && wx.lo < 55) bad.push("shorts in the cold");
    return bad;
  }

  /* ------------------------------------------------------------------ learning */
  /** Guess the occasion from a sheet's "when" text ("Chem 11am → Physics lab 2pm", "Home after Lit", ...). */
  function guessOccasion(when) {
    const s = String(when || "");
    const kind = /lab\b/i.test(s) ? "lab" : /church/i.test(s) ? "church" : /(home|lounge|homework|couch|study)/i.test(s) ? "lounge"
      : /(going out|hangout|date|dinner|evening out|out tonight|night out|tonight)/i.test(s) ? "out" : "class";
    const phase = /(night|evening|tonight|[5-9]\s?pm|date|dinner)/i.test(s) ? "evening" : "day";
    return {kind, phase};
  }
  /** Weather from a sheet subtitle: "Provo: 48°F high / 32°F low · sunny · 0% rain · …". */
  function parseWeather(sub) {
    const m = /(\d+)°F high \/ (\d+)°F low/.exec(sub || ""); if (!m) return null;
    const r = /(\d+)% rain/.exec(sub), w = /(\d+)(?:-(\d+))? mph/.exec(sub);
    return {hi: +m[1], lo: +m[2], rain: r ? +r[1] : 0, snow: /snow/i.test(sub), wind: w ? +(w[2] || w[1]) : 0};
  }

  /** Training pairs: each good fit vs. the same fit with one piece swapped, and vs. a random outfit.
   *  goods = [{date, items, when, weather?, occasion?, weight}]. Returns [{d: featureDiff, w, slot}]. */
  function makePairs(data, goods, {swaps = 3, randoms = 2, seed = 1} = {}) {
    const rand = rng(seed), wxBy = {};
    ((data.log && data.log.planned) || []).forEach(p => { const x = parseWeather(p.subtitle); if (x) wxBy[p.date] = x; });
    const usable = data.wardrobe.items.filter(i => !i.avoid && !i.retired);
    const S = {}; usable.forEach(i => (S[i.slot] = S[i.slot] || []).push(i));
    const one = a => a[Math.floor(rand() * a.length)];
    const ctxs = {}, pairs = [];
    const before = d => ({wardrobe: data.wardrobe, laundry: data.laundry,
      log: {worn: data.log.worn.filter(x => x.date < d), planned: (data.log.planned || []).filter(p => p.date < d)}});
    for (const g of goods) {
      const ctx = ctxs[g.date] || (ctxs[g.date] = prepare(before(g.date), {today: g.date}));
      const wx = g.weather || wxBy[g.date] || {hi: 60, lo: 45, rain: 0, snow: false, wind: 0};
      const o = g.occasion || guessOccasion(g.when);
      const out = split(data, g.items), F = outfitFeats(ctx, o, wx, out);
      if (!F) continue;
      const negs = [];
      for (const slot of ["top", "bottom", "shoes", "socks", "cap", "layer"]) {
        const cur = out[slot]; if (!cur && slot !== "layer") continue;
        const alts = (S[slot] || []).filter(i => i !== cur); if (!alts.length) continue;
        for (let k = 0; k < swaps; k++) negs.push([slot, Object.assign({}, out, {[slot]: one(alts)})]);
      }
      if (out.layer) negs.push(["layer", Object.assign({}, out, {layer: null})]);
      for (let k = 0; k < randoms; k++) negs.push(["random", {top: one(S.top), bottom: one(S.bottom), shoes: one(S.shoes), socks: one(S.socks),
        cap: S.cap ? one(S.cap) : null, layer: rand() < .35 && S.layer ? one(S.layer) : null}]);
      for (const [slot, nOut] of negs) {
        if (o.kind === "lab" && attrs(nOut.top).sleeve === "long") continue;   // the hard rule handles those
        const N = outfitFeats(ctx, o, wx, nOut); if (!N) continue;
        const d = {};
        for (const k in F) d[k] = F[k];
        for (const k in N) d[k] = (d[k] || 0) - N[k];
        pairs.push({d, w: g.weight || 1, slot, date: g.date});
      }
    }
    return pairs;
  }

  /** Pairwise logistic regression, pulled toward a prior so a handful of fits can't swing everything. */
  function train(pairs, prior = W, {lambda = 0.02, iters = 400, lr = 0.5} = {}) {
    const keys = Object.keys(prior).filter(k => !FIXED.has(k)), w = Object.assign({}, prior);
    const tw = pairs.reduce((a, p) => a + p.w, 0) || 1;
    for (let it = 0; it < iters; it++) {
      const g = {};
      for (const p of pairs) {
        const m = dot(w, p.d), s = p.w / (1 + Math.exp(Math.min(m, 30)));      // gradient of log(1 + e^-m)
        for (const k in p.d) g[k] = (g[k] || 0) + s * p.d[k];
      }
      for (const k of keys) w[k] += lr * ((g[k] || 0) / tw - lambda * (w[k] - prior[k]));
    }
    for (const k of keys) w[k] = Math.round(w[k] * 1000) / 1000;
    return w;
  }
  const accuracy = (pairs, w) => pairs.reduce((a, p) => { const m = dot(w, p.d); return a + (m > 0 ? 1 : m === 0 ? .5 : 0) * p.w; }, 0) / (pairs.reduce((a, p) => a + p.w, 0) || 1);

  /** Per-person weights from their own worn log (runs in the browser). Null until there's enough to learn from. */
  function personalize(data, {min = 12} = {}) {
    const worn = ((data.log && data.log.worn) || []).filter(x => x.items && x.items.length >= 3);
    if (worn.length < min) return null;
    const goods = worn.map(x => ({date: x.date, items: x.items, when: x.occasion, weather: x.weather, weight: x.didnt ? .3 : 1,
      occasion: x.kind ? {kind: x.kind, phase: guessOccasion(x.occasion).phase} : undefined}));
    const pairs = makePairs(data, goods, {swaps: 2, randoms: 1, seed: worn.length});
    return train(pairs, W, {lambda: 0.08, iters: 200});
  }

  return {suggest, suggestDay, scoreFit, check, prepare, attrs, feel, need, W, PRIOR, TUNED, HARD,
    FIXED, makePairs, train, accuracy, personalize, guessOccasion, parseWeather, split, outfitFeats};
});
