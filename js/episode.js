/* Notcast — episode generator.
 * An episode is a seed. Everything about it (dish, weather, timeline, chapters,
 * captions) is derived deterministically from (show, episode number), so the
 * same episode always plays back the same way and the catalog never runs out.
 *
 * Output shape:
 *   { show, n, seed, date, dish, title, notes, D (seconds), chapters[{t,title}],
 *     events[{t,type,p,cap,zone}], layers{name: fn(t)->0..1+}, clock, clockPhase,
 *     rngFor(sec) }
 */
(function (global) {
  'use strict';

  // ---------- seeded randomness ----------
  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function Rand(seed) {
    const r = mulberry32(seed);
    return {
      next: r,
      range: (a, b) => a + (b - a) * r(),
      int: (a, b) => Math.floor(a + (b - a + 1) * r()),
      pick: (arr) => arr[Math.floor(r() * arr.length)],
      chance: (p) => r() < p,
    };
  }
  function poisson(R, lambda) {
    if (lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss(R)));
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= R.next(); } while (p > L);
    return k - 1;
  }
  function gauss(R) {
    const u = Math.max(1e-9, R.next()), v = R.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // ---------- keyframe layers ----------
  function KF(v0) { this.k = [[0, v0 || 0]]; }
  KF.prototype.add = function (t, v) { this.k.push([t, v]); return this; };
  KF.prototype.finish = function () {
    this.k.sort((a, b) => a[0] - b[0]);
    const k = this.k;
    return function (t) {
      if (t <= k[0][0]) return k[0][1];
      const last = k[k.length - 1];
      if (t >= last[0]) return last[1];
      let lo = 0, hi = k.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (k[m][0] <= t) lo = m; else hi = m; }
      const a = k[lo], b = k[hi];
      return b[0] === a[0] ? b[1] : a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
    };
  };

  // ---------- the kitchen ----------
  const DISHES = [
    { key: 'leek', name: 'Leek and potato soup', lead: 'Leeks', chop: [['leeks', 0.35], ['potatoes', 0.7], ['an onion', 0.6]], aromatic: 'the leeks', liquid: 'the stock', sizzle: 0.55, sizzleLen: 0.8, simmer: 1.0, note: 'The potatoes take as long as they take.' },
    { key: 'risotto', name: 'Mushroom risotto', lead: 'Mushrooms', chop: [['mushrooms', 0.3], ['a shallot', 0.6], ['parsley', 0.2]], aromatic: 'the shallot', liquid: 'the first ladle of stock', sizzle: 0.7, sizzleLen: 0.6, simmer: 0.75, noLid: true, note: 'The rice gets stirred more than it strictly needs.' },
    { key: 'dal', name: 'Weeknight dal', lead: 'Lentils', chop: [['an onion', 0.6], ['ginger', 0.8], ['garlic', 0.5], ['tomatoes', 0.3]], aromatic: 'the cumin seeds', liquid: 'the lentils and water', sizzle: 0.95, sizzleLen: 0.5, simmer: 1.1, note: 'The lentils fall apart right on schedule.' },
    { key: 'friedrice', name: "Fried rice from yesterday's rice", lead: 'Fried Rice', chop: [['scallions', 0.5], ['carrots', 0.9], ['garlic', 0.5]], aromatic: 'the garlic', sizzle: 1, sizzleLen: 0.9, simmer: 0, quick: true, secondAdd: 'the rice', note: 'The wok gets very hot and then it is over.' },
    { key: 'sauce', name: 'Sunday tomato sauce', lead: 'Tomatoes', chop: [['onions', 0.6], ['garlic', 0.5], ['basil', 0.15]], aromatic: 'the onions', liquid: 'the tomatoes', sizzle: 0.55, sizzleLen: 0.9, simmer: 1.4, note: 'The sauce blips quietly under a crooked lid.' },
    { key: 'congee', name: 'Congee', lead: 'Congee', chop: [['ginger', 0.8], ['scallions', 0.5]], aromatic: null, sizzle: 0, simmer: 1.5, kettle: true, note: 'Rice and water, mostly. Then more water.' },
    { key: 'onions', name: 'Caramelized onions, slowly', lead: 'Onions', chop: [['six onions', 0.6]], aromatic: 'the onions', sizzle: 0.45, sizzleLen: 2.6, simmer: 0, stirs: 'often', note: 'Forty minutes of onions doing almost nothing.' },
    { key: 'minestrone', name: 'Minestrone', lead: 'Minestrone', chop: [['carrots', 0.9], ['celery', 0.75], ['an onion', 0.6], ['zucchini', 0.4]], aromatic: 'the soffritto', liquid: 'the broth', sizzle: 0.6, sizzleLen: 0.8, simmer: 1.1, note: 'Everything in the crisper drawer, eventually.' },
    { key: 'greens', name: 'Stir-fried greens', lead: 'Greens', chop: [['bok choy', 0.45], ['garlic', 0.5]], aromatic: 'the garlic', sizzle: 1, sizzleLen: 0.5, simmer: 0, quick: true, kettle: true, secondAdd: 'the greens', note: 'Garlic, greens, a splash of water, a lid. Done.' },
    { key: 'stock', name: 'Chicken stock', lead: 'Stock', chop: [['carrots', 0.9], ['celery', 0.75], ['an onion', 0.6]], aromatic: null, sizzle: 0, simmer: 1.7, note: 'Bones and vegetables. Then a long time.' },
    { key: 'pancakes', name: 'Saturday pancakes', lead: 'Pancakes', chop: [], whisk: true, aromatic: 'the first ladle of batter', sizzle: 0.42, sizzleLen: 1.4, simmer: 0, kettle: true, morning: 'Saturday', note: 'The first one is always a little wrong.' },
    { key: 'tea', name: 'Tea and toast', lead: 'Toast', chop: [], aromatic: null, sizzle: 0, simmer: 0, kettle: true, toast: true, morning: true, note: 'The kettle, the toaster, the butter knife.' },
  ];
  const OBJECTS = ['A Wooden Spoon', 'The Good Knife', 'A Crooked Lid', 'The Fridge', 'Cast Iron', 'The Back Burner', 'Two Plates', 'A Dish Towel', 'The Colander', 'A Clean Board', 'The Spice Drawer', 'The Spoon Rest'];
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  function cap1(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function lower1(s) { return s.charAt(0).toLowerCase() + s.slice(1); }

  // A shuffled order per cycle so neighbouring episodes rarely repeat a dish.
  function dishFor(show, n) {
    const L = DISHES.length, cycle = Math.floor((n - 1) / L), pos = (n - 1) % L;
    const R = Rand(hash32(show + ':cycle:' + cycle));
    const idx = DISHES.map((_, i) => i);
    for (let i = L - 1; i > 0; i--) { const j = Math.floor(R.next() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    return DISHES[idx[pos]];
  }

  function buildEpisode(show, n, firstDate) {
    const seed = hash32(show + ':' + n);
    const R = Rand(seed);
    const dish = dishFor(show, n);

    const L = {
      sizzle: new KF(0), bubbles: new KF(0), lid: new KF(0), rain: new KF(0), fridge: new KF(0),
      kettle: new KF(0), water: new KF(0), fillAmt: new KF(0), fillFreq: new KF(400),
    };
    const bumps = [];
    const E = [];
    const C = [];
    const ev = (t, type, p, cap, zone) => E.push({ t, type, p: p || {}, cap: cap || null, zone: zone || null });

    // weather + household
    const rainBase = R.pick([0, 0, 0.3, 0.5, 0.55, 0.85]);
    const traffic = R.range(0.35, 1);
    const clock = R.chance(0.5);

    function flow(t, dur, lvl, opts) {
      opts = opts || {};
      L.water.add(t - 0.001, 0).add(t + 0.12, lvl).add(t + dur * 0.5, lvl * R.range(0.85, 1.1)).add(t + dur - 0.2, lvl).add(t + dur, 0);
      if (opts.fill) {
        L.fillAmt.add(t - 0.001, 0).add(t + 0.8, opts.fill).add(t + dur - 0.2, opts.fill).add(t + dur, 0);
        L.fillFreq.add(t - 0.001, opts.f0 || 280).add(t + dur, opts.f1 || 1100);
      }
      ev(t, 'tapOn', {}, opts.cap === false ? null : (opts.cap || '[the tap runs]'), 'sink');
      ev(t + dur, 'tapOff', { drips: R.int(0, 3) }, null, 'sink');
      return t + dur;
    }

    function kettle(t, pourInto) {
      t = flow(t, R.range(6, 10), 0.8, { fill: 0.55, f0: 520, f1: 1500, cap: '[filling the kettle]' });
      t += R.range(3, 6);
      ev(t, 'click', { f: 2600 }, '[the kettle clicks on]', 'kettle');
      const dur = R.range(120, 170);
      L.kettle.add(t, 0).add(t + dur * 0.35, 0.35).add(t + dur * 0.8, 0.75).add(t + dur, 1).add(t + dur + 0.3, 0.55).add(t + dur + 9, 0);
      ev(t + dur * 0.45, 'caption', {}, '[the kettle starts to rumble]', 'kettle');
      ev(t + dur, 'click', { f: 2100 }, '[the kettle clicks off]', 'kettle');
      const tp = t + dur + R.range(8, 25);
      if (pourInto !== false) {
        ev(tp, 'pour', { dur: R.range(3.5, 5) }, '[pouring]', 'kettle');
        ev(tp + R.range(150, 220), 'mugStir', { n: R.int(7, 10) }, '[a spoon in a mug]', 'kettle');
      }
      return t + dur;
    }

    let t = 0;
    C.push({ t: 0, title: 'Cold open' });
    t = R.range(35, 75);
    t = flow(t, R.range(5, 9), R.range(0.7, 0.9), { cap: '[hands under the tap]' });
    ev(t + 1.5, 'towel', {}, '[a dish towel]', 'sink');
    t += R.range(8, 16);

    // ---- prep ----
    if (dish.chop.length) {
      const first = dish.chop[0][0].replace(/^(an?|six) /, '');
      C.push({ t, title: cap1(first) + ', mostly' });
      ev(t, 'boardDown', {}, '[the cutting board comes out]', 'board');
      t += R.range(3, 6);
      for (const [item, crisp] of dish.chop) {
        if (R.chance(0.45)) {
          const d = R.range(3, 6);
          ev(t, 'fridgeDoor', { dur: d }, '[the fridge door, then ' + item + ']', 'fridge');
          t += d + R.range(3, 6);
        } else {
          ev(t, 'clink', { kind: 'ceramic', f: R.range(650, 950), amp: 0.8 }, null, 'board');
          t += R.range(2, 4);
        }
        ev(t, 'caption', {}, '[chopping ' + item + ']', 'board');
        const runs = R.int(2, 5) * (item.indexOf('six') === 0 ? 3 : 1);
        for (let r = 0; r < runs; r++) {
          const N = R.int(8, 26), iv = R.range(0.19, 0.34) * (crisp > 0.7 ? 1.12 : 1);
          for (let i = 0; i < N; i++) {
            ev(t, 'chop', { crisp: Math.min(1, crisp * R.range(0.8, 1.2)), amp: R.range(0.72, 1.05) }, null, 'board');
            t += iv * R.range(0.88, 1.12);
          }
          if (R.chance(0.6)) { t += R.range(0.3, 0.8); ev(t, 'scrape', { dur: R.range(0.5, 1.0) }, null, 'board'); t += 1.2; }
          t += R.range(2.5, 10);
        }
        ev(t, 'clink', { kind: 'metal', f: R.range(2300, 3200), amp: 0.55 }, null, 'board');
        t += R.range(8, 26);
      }
    } else if (dish.whisk) {
      C.push({ t, title: 'Batter' });
      ev(t, 'clink', { kind: 'ceramic', f: 620, amp: 1 }, '[a big bowl]', 'board');
      t += R.range(4, 8);
      for (let i = 0; i < 2; i++) { ev(t, 'eggCrack', {}, i === 0 ? '[eggs, cracked on the rim]' : null, 'board'); t += R.range(3, 6); }
      const wd = R.range(25, 40);
      ev(t, 'whisk', { dur: wd }, '[whisking]', 'board');
      t += wd + R.range(10, 20);
      t = kettle(t) + R.range(10, 30);
    } else if (dish.toast) {
      C.push({ t, title: 'The kettle' });
      const tk = kettle(t);
      const tt = t + R.range(70, 110);
      ev(tt, 'toasterDown', {}, '[the toaster lever]', 'kettle');
      const pop = tt + R.range(150, 190);
      ev(pop, 'toasterPop', {}, '[toast pops]', 'kettle');
      C.push({ t: pop, title: 'Toast' });
      let tb = pop + R.range(8, 14);
      ev(tb, 'clink', { kind: 'ceramic', f: 900, amp: 0.8 }, '[a plate]', 'table');
      tb += R.range(4, 8);
      ev(tb, 'drawer', {}, null, 'table');
      tb += R.range(5, 9);
      ev(tb, 'butter', { n: R.int(5, 9) }, '[butter, scraped thin]', 'board');
      tb += 8;
      ev(tb + 25, 'toasterDown', {}, '[a second round]', 'kettle');
      const pop2 = tb + 25 + R.range(150, 190);
      ev(pop2, 'toasterPop', {}, null, 'kettle');
      ev(pop2 + 10, 'butter', { n: R.int(5, 8) }, null, 'board');
      t = Math.max(tk + 240, pop2 + 30);
      C.push({ t, title: 'Sitting' });
      t += R.range(300, 520);
    }

    // ---- into the pan ----
    if (dish.sizzle > 0) {
      const s = dish.sizzle, len = R.range(300, 560) * dish.sizzleLen;
      C.push({ t, title: dish.whisk ? 'The first one' : 'Into the pan' });
      ev(t, 'panDown', {}, '[a pan on the burner]', 'stove');
      t += R.range(2, 4);
      ev(t, 'igniter', { n: R.int(3, 6) }, '[click, click, whump]', 'stove');
      t += 2;
      const heat = R.range(45, 75);
      L.sizzle.add(t, 0).add(t + heat, 0.12 * s);
      t += heat;
      ev(t, 'onset', { amp: s }, '[' + dish.aromatic + ' hit the hot pan]', 'stove');
      const t0 = t;
      if (dish.whisk) {
        L.sizzle.add(t, 0.12 * s).add(t + 0.4, 0.85 * s).add(t + len, 0.7 * s);
        let tp = t;
        let k = 0;
        while (tp < t0 + len - 120) {
          if (k > 0) { ev(tp, 'onset', { amp: s * 0.7 }, k === 1 ? '[another ladle of batter]' : null, 'stove'); bumps.push({ t: tp, a: 0.3 * s }); }
          const fl = tp + R.range(70, 100);
          ev(fl, 'flip', {}, k === 0 ? '[a flip]' : null, 'stove'); bumps.push({ t: fl, a: 0.35 * s });
          const pl = fl + R.range(55, 75);
          ev(pl, 'plateDown', { soft: true }, k === 0 ? '[onto the stack]' : null, 'table');
          tp = pl + R.range(6, 14); k++;
        }
      } else {
        L.sizzle.add(t, 0.12 * s).add(t + 0.3, 1.0 * s).add(t + 30, 0.72 * s).add(t + len * 0.5, 0.56 * s).add(t + len, 0.45 * s);
        const often = dish.stirs === 'often';
        let ts = t + R.range(20, 40);
        while (ts < t0 + len - 10) {
          const d = R.range(3, 7);
          ev(ts, 'stirPan', { dur: d }, R.chance(0.25) ? '[a wooden spoon in the pan]' : null, 'stove');
          bumps.push({ t: ts, a: 0.18 * s });
          ts += d + R.range(often ? 15 : 25, often ? 45 : 80);
        }
        if (dish.secondAdd) {
          const ta = t0 + len * R.range(0.4, 0.55);
          ev(ta, 'onset', { amp: s * 0.8 }, '[' + dish.secondAdd + ' go in]', 'stove');
          bumps.push({ t: ta, a: 0.45 * s });
        }
        if (dish.kettle && !dish.whisk) kettle(t0 + R.range(30, 90), false);
      }
      t = t0 + len;
      if (!(dish.simmer > 0)) {
        ev(t, 'knob', {}, '[burner off]', 'stove');
        L.sizzle.add(t, dish.whisk ? 0.7 * s : 0.45 * s).add(t + 25, 0);
        t += R.range(20, 40);
      }
    }

    // ---- leave it alone ----
    if (dish.simmer > 0) {
      C.push({ t, title: R.pick(['Leave it alone', 'Let it go', 'Low and slow']) });
      if (dish.sizzle > 0) {
        ev(t, 'pourIn', {}, '[' + dish.liquid + ' goes in; the pan hushes]', 'stove');
        L.sizzle.add(t, 0.45 * dish.sizzle).add(t + 2.5, 0);
        t += 4;
      } else {
        t = flow(t, R.range(14, 22), 0.9, { fill: 0.6, f0: 240, f1: 950, cap: '[filling a pot]' });
        t += 2.5;
        ev(t, 'potDown', {}, '[a pot on the burner]', 'stove');
        t += 2.5;
        ev(t, 'igniter', { n: R.int(3, 6) }, '[click, click, whump]', 'stove');
        t += 2;
      }
      const heat = R.range(100, 200), boil = R.range(16, 24);
      L.bubbles.add(t, 0).add(t + heat * 0.45, 1.2).add(t + heat, boil);
      t += heat;
      ev(t, 'caption', {}, '[it comes to a boil]', 'stove');
      t += R.range(20, 50);
      ev(t, 'knob', {}, '[heat down]', 'stove');
      let sim = R.range(4, 8);
      L.bubbles.add(t, boil).add(t + 15, sim);
      t += R.range(6, 12);
      const len = R.range(480, 1000) * dish.simmer, end = t + len;
      if (dish.noLid) {
        let tc = t + R.range(20, 40), k = 0;
        while (tc < end - 30) {
          const d = R.range(4, 9);
          ev(tc, 'stirPot', { dur: d }, k === 0 ? '[stirring, and stirring]' : null, 'stove');
          ev(tc + d + 0.3, 'tap2', {}, null, 'stove');
          if (k % 3 === 2) ev(tc + d + R.range(4, 8), 'ladle', { pourIn: true }, k === 2 ? '[another ladle of stock]' : null, 'stove');
          tc += d + R.range(30, 70); k++;
        }
      } else {
        ev(t, 'lidOn', {}, '[the lid settles]', 'stove');
        L.lid.add(t - 0.01, 0).add(t, 1);
        if (dish.kettle) kettle(t + R.range(120, 300));
        let tc = t + R.range(120, 240);
        while (tc < end - 60) {
          ev(tc, 'lidOff', {}, R.chance(0.5) ? '[lid off; steam]' : null, 'stove');
          L.lid.add(tc - 0.01, 1).add(tc, 0);
          const d = R.range(4, 9);
          ev(tc + 1.5, 'stirPot', { dur: d }, null, 'stove');
          ev(tc + 2 + d, 'tap2', {}, null, 'stove');
          const lo = tc + d + R.range(4, 8);
          ev(lo, 'lidOn', {}, null, 'stove');
          L.lid.add(lo - 0.01, 0).add(lo, 1);
          const nsim = sim * R.range(0.8, 1.25);
          L.bubbles.add(lo + 5, sim).add(lo + 40, nsim); sim = nsim;
          tc = lo + R.range(150, 320);
        }
      }
      t = end;
      ev(t, 'knob', {}, '[burner off]', 'stove');
      L.bubbles.add(t, sim).add(t + 45, 0);
      t += R.range(25, 45);
    }

    // ---- plates ----
    if (!dish.toast) {
      C.push({ t, title: R.pick(['Plates', 'Bowls, two of them', 'Serving']) });
      ev(t, 'cabinet', {}, '[a cupboard; plates]', 'table');
      t += R.range(3, 5);
      const nPlates = R.int(2, 4);
      for (let i = 0; i < nPlates; i++) { ev(t, 'plateDown', {}, null, 'table'); t += R.range(0.8, 2.2); }
      ev(t, 'drawer', {}, '[the cutlery drawer]', 'table');
      t += R.range(3, 5);
      for (let i = 0; i < nPlates; i++) { ev(t, 'ladle', {}, i === 0 ? '[serving]' : null, 'stove'); t += R.range(3, 6); }
      t += R.range(4, 10);
      C.push({ t, title: 'Quiet for a while' });
      t += R.range(150, 420);
    }

    // ---- dishes ----
    C.push({ t, title: 'Dishes' });
    const items = dish.toast ? R.int(3, 5) : R.int(7, 13);
    for (let i = 0; i < items; i++) {
      t = flow(t, R.range(1.5, 5), R.range(0.55, 1), { cap: i === 0 ? '[washing up]' : false });
      t += R.range(0.3, 1.2);
      if (R.chance(0.6)) { const d = R.range(2, 5); ev(t, 'scrub', { dur: d }, null, 'sink'); t += d + R.range(0.3, 1); }
      ev(t, 'clink', { kind: R.pick(['ceramic', 'metal', 'glass', 'ceramic']), amp: R.range(0.5, 1) }, null, 'sink');
      t += R.range(1, 4);
      if (R.chance(0.5)) { ev(t, 'rack', {}, null, 'sink'); t += R.range(1, 3); }
    }
    ev(t, 'towel', {}, '[drying hands]', 'sink');
    t += R.range(6, 12);
    C.push({ t, title: 'Lights off' });
    t += R.range(70, 150);
    const D = Math.round(t);

    // ---- background, spanning the whole episode ----
    let fOn = R.chance(0.5), tf = 0;
    L.fridge.k[0][1] = fOn ? 1 : 0;
    while (true) {
      tf += fOn ? R.range(240, 600) : R.range(300, 800);
      if (tf >= D - 20) break;
      fOn = !fOn;
      if (fOn) { L.fridge.add(tf, 0).add(tf + 1.5, 1); ev(tf, 'fridgeOn', {}, '[the fridge hums on]', 'fridge'); }
      else { L.fridge.add(tf, 1).add(tf + 2.5, 0); ev(tf, 'fridgeOff', {}, '[the fridge shudders off]', 'fridge'); }
    }
    if (rainBase > 0) {
      let prev = rainBase * R.range(0.8, 1.1), tr = 0;
      L.rain.k[0][1] = prev;
      while (true) {
        tr += R.range(120, 300);
        if (tr >= D) break;
        const v = Math.max(0.06, Math.min(1, rainBase * R.range(0.5, 1.45)));
        L.rain.add(tr + 40, v);
        if (v - prev > 0.22) ev(tr + 20, 'caption', {}, '[the rain picks up]', 'window');
        else if (prev - v > 0.25) ev(tr + 20, 'caption', {}, '[the rain eases]', 'window');
        prev = v;
      }
    }
    let tt = R.range(20, 90);
    while (tt < D - 15) {
      ev(tt, 'carPass', { dur: R.range(5, 10), dir: R.chance(0.5) ? 1 : -1, amp: R.range(0.45, 1), wet: rainBase > 0 }, R.chance(0.2) ? '[a car passes outside]' : null, 'window');
      tt += R.range(50, 240) / traffic;
    }
    if (R.chance(0.4)) ev(R.range(0.2, 0.8) * D, 'plane', { dur: R.range(25, 40) }, '[a plane, very high up]', 'window');

    E.sort((a, b) => a.t - b.t);
    const layers = {};
    for (const k in L) layers[k] = L[k].finish();
    const baseSizzle = layers.sizzle;
    layers.sizzle = function (x) {
      let v = baseSizzle(x);
      for (let i = 0; i < bumps.length; i++) {
        const dt = x - bumps[i].t;
        if (dt < 0 || dt > 9) continue;
        v += bumps[i].a * (dt < 1 ? dt : 1 - (dt - 1) / 8);
      }
      return v;
    };

    // ---- packaging ----
    const date = new Date(firstDate.getTime());
    date.setDate(date.getDate() + 7 * (n - 1));
    const morning = !!dish.morning;
    const day = typeof dish.morning === 'string' ? dish.morning : R.pick(DAYS);
    const tod = morning ? 'morning' : R.pick(['evening', 'evening', 'evening', 'afternoon', 'night']);
    const weatherWord = rainBase === 0 ? (morning ? 'Morning Light' : R.pick(['A Dry Evening', 'Window Shut', 'No Rain'])) :
      rainBase < 0.4 ? 'Light Rain' : rainBase < 0.7 ? 'Rain' : 'Heavy Rain';
    let obj = R.pick(dish.simmer > 0 ? OBJECTS : OBJECTS.filter((o) => o !== 'A Crooked Lid' && o !== 'The Back Burner'));
    if (dish.kettle && R.chance(0.5)) obj = 'The Kettle';
    const title = dish.lead + ', ' + weatherWord + ', ' + obj;
    const rainPhrase = rainBase === 0 ? '' : rainBase < 0.4 ? ' while it drizzles' : rainBase < 0.7 ? ' while it rains' : ' while it pours';
    const dishName = DAYS.some((d) => dish.name.indexOf(d + ' ') === 0) ? dish.name.replace(/^\w+ /, '') : lower1(dish.name);
    let notes = day + ' ' + tod + '. Someone makes ' + dishName + rainPhrase + '. ' + dish.note;
    if (clock) notes += ' A clock ticks on the wall.';
    notes += ' Nobody talks.';

    const chapters = C.filter((c, i) => c.t < D && (i === 0 || c.t - C[i - 1].t > 1));

    return {
      show, n, seed, date, dish: dish.name, title, notes, D, chapters, events: E, layers,
      clock, clockPhase: R.range(0.05, 0.95), rain: rainBase,
      rngFor: (sec) => Rand((seed ^ Math.imul(sec + 1, 0x9e3779b1)) >>> 0),
      poisson,
    };
  }

  global.NotcastEpisodes = { buildEpisode, hash32, Rand, poisson };
})(typeof window !== 'undefined' ? window : globalThis);
