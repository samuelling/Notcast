/* Notcast — audio engine.
 * Everything you hear is synthesized live with the Web Audio API. Nothing is recorded.
 *
 * Three kinds of sound:
 *  1. Beds: looping noise sources whose gains follow the episode's layer functions
 *     (room tone, fridge hum, rain, sizzle, boil rumble, running water, kettle).
 *  2. Macro events: the episode's event list (a chop, a lid, a drawer), scheduled
 *     with a short lookahead against the AudioContext clock.
 *  3. Micro events: bubbles, raindrops, droplets, clock ticks. Generated per
 *     one-second bucket from a seeded RNG, so they are deterministic and seekable.
 *
 * Transport maps episode time e to context time c: e = e0 + (c - c0).
 * Pause suspends the context, so the mapping simply freezes.
 */
(function (global) {
  'use strict';

  const MAT = {
    metal:    { r: [1, 2.76, 5.40, 8.93], d: [0.35, 0.2, 0.12, 0.08], a: [1, 0.5, 0.3, 0.15], f: [2200, 3600] },
    ceramic:  { r: [1, 1.62, 2.81, 4.1], d: [0.14, 0.09, 0.06, 0.04], a: [1, 0.6, 0.35, 0.2], f: [800, 1500] },
    glass:    { r: [1, 2.32, 4.25, 6.63], d: [0.7, 0.4, 0.22, 0.14], a: [1, 0.45, 0.25, 0.12], f: [1400, 2600] },
    lid:      { r: [1, 1.71, 2.88, 4.15, 5.2], d: [0.9, 0.6, 0.4, 0.3, 0.2], a: [1, 0.7, 0.5, 0.35, 0.2], f: [380, 480] },
    wood:     { r: [1, 2.4, 3.9], d: [0.05, 0.035, 0.02], a: [1, 0.4, 0.2], f: [380, 520] },
    castiron: { r: [1, 1.5, 2.3, 3.4], d: [0.3, 0.2, 0.12, 0.08], a: [1, 0.6, 0.4, 0.2], f: [150, 190] },
  };
  const rnd = (a, b) => a + (b - a) * Math.random();

  // ---------- buffers ----------
  function detrendNormalize(d, rms) {
    const n = d.length, slope = (d[n - 1] - d[0]) / (n - 1);
    let s = 0;
    for (let i = 0; i < n; i++) { d[i] -= slope * i; s += d[i] * d[i]; }
    const k = rms / Math.sqrt(s / n || 1);
    for (let i = 0; i < n; i++) d[i] *= k;
  }
  function noiseBuf(ctx, sec, kind) {
    const n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    if (kind === 'white') {
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    } else if (kind === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
      }
    } else {
      let last = 0;
      for (let i = 0; i < n; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last; }
    }
    detrendNormalize(d, 0.3);
    return b;
  }
  function crackleBuf(ctx, sec, rate, big) {
    const sr = ctx.sampleRate, n = Math.floor(sr * sec), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
    let i = 0;
    for (;;) {
      i += Math.max(1, Math.floor(-Math.log(1 - Math.random()) / rate * sr));
      if (i >= n) break;
      const a = (0.15 + 0.85 * Math.pow(Math.random(), 3)) * (Math.random() < 0.5 ? -1 : 1);
      const len = Math.floor((big ? 50 : 8) + Math.random() * (big ? 220 : 40)), dec = len / 4;
      for (let j = 0; j < len && i + j < n; j++) d[i + j] += a * (Math.random() * 2 - 1) * Math.exp(-j / dec);
    }
    let p = 0;
    for (let k = 0; k < n; k++) p = Math.max(p, Math.abs(d[k]));
    for (let k = 0; k < n; k++) d[k] *= 0.9 / (p || 1);
    return b;
  }
  function impulse(ctx, sec, pow) {
    const sr = ctx.sampleRate, n = Math.floor(sr * sec), b = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let y = 0;
      for (let i = 0; i < n; i++) {
        const x = (Math.random() * 2 - 1) * Math.pow(1 - i / n, pow);
        y += 0.35 * (x - y);
        d[i] = y;
      }
      // a few early reflections off cabinets and tile
      for (let k = 0; k < 6; k++) { const at = Math.floor(sr * rnd(0.004, 0.035)); d[at] += rnd(-0.6, 0.6); }
    }
    return b;
  }

  class Engine {
    constructor() {
      this.ctx = null; this.ep = null; this.playing = false;
      this.e0 = 0; this.c0 = 0; this.pausedAt = 0;
      this.macroIdx = 0; this.nextBucket = 0;
      this.captions = []; this.pings = [];
      this.volume = 0.85; this.sleepEnd = null; this.timer = null;
      this.levels = {}; this.handlers = {};
    }
    on(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); }
    emit(name, arg) { (this.handlers[name] || []).forEach((f) => f(arg)); }

    // ---------- setup ----------
    ensure() {
      if (this.ctx) return;
      const AC = global.AudioContext || global.webkitAudioContext;
      const ctx = (this.ctx = new AC({ latencyHint: 'playback' }));
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* older Safari */ }
      this.buf = {
        white: noiseBuf(ctx, 4.1, 'white'), pink: noiseBuf(ctx, 6.13, 'pink'), brown: noiseBuf(ctx, 7.37, 'brown'),
        crackle: crackleBuf(ctx, 9.71, 340, false), pops: crackleBuf(ctx, 12.9, 6, true),
      };
      this.master = ctx.createGain(); this.master.gain.value = 0;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -26; comp.knee.value = 14; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.3;
      const makeup = this.gain(3.5);
      const limit = ctx.createDynamicsCompressor();
      limit.threshold.value = -4; limit.knee.value = 0; limit.ratio.value = 20; limit.attack.value = 0.002; limit.release.value = 0.12;
      this.master.connect(comp); comp.connect(makeup); makeup.connect(limit); limit.connect(ctx.destination);
      this.out = limit;
      this.mix = ctx.createGain(); this.mix.connect(this.master);
      this.verb = ctx.createConvolver(); this.verb.buffer = impulse(ctx, 1.1, 3.2);
      const wet = ctx.createGain(); wet.gain.value = 0.55; this.verb.connect(wet); wet.connect(this.mix);
      this.buildBeds();
      this.newGeneration();
    }
    zoneBus(pan, send, dest) {
      const ctx = this.ctx, g = ctx.createGain(), p = ctx.createStereoPanner();
      p.pan.value = pan; g.connect(p); p.connect(dest || this.mix);
      if (send > 0) { const s = ctx.createGain(); s.gain.value = send; p.connect(s); s.connect(this.verb); }
      return g;
    }
    loop(buf, rate) {
      const s = this.ctx.createBufferSource();
      s.buffer = buf; s.loop = true; s.playbackRate.value = rate || 1;
      s.start(0, Math.random() * buf.duration);
      return s;
    }
    filt(type, f, q) { const b = this.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q == null ? 0.707 : q; return b; }
    gain(v) { const g = this.ctx.createGain(); g.gain.value = v || 0; return g; }
    chain(...nodes) { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; }

    buildBeds() {
      const ctx = this.ctx, B = this.buf, Z = (this.Z = {});
      Z.board = this.zoneBus(-0.1, 0.22); Z.stove = this.zoneBus(0.45, 0.16); Z.sink = this.zoneBus(-0.5, 0.26);
      Z.fridge = this.zoneBus(-0.75, 0.12); Z.kettle = this.zoneBus(-0.28, 0.2); Z.table = this.zoneBus(0.15, 0.3);
      Z.clock = this.zoneBus(-0.85, 0.35);
      this.potLP = this.filt('lowpass', 5200, 0.6); this.potLP.connect(this.zoneBus(0.3, 0.16)); Z.pot = this.potLP;
      this.outside = this.filt('lowpass', 1500, 0.5); this.outside.connect(this.zoneBus(0, 0.1)); Z.window = this.outside;
      this.rainIn = this.filt('lowpass', 4200, 0.5); this.rainIn.connect(this.zoneBus(0.05, 0.12)); Z.rain = this.rainIn;

      // room tone: two decorrelated brown streams, wide and low
      for (const [pan, rate] of [[-0.8, 1], [0.8, 0.97]]) {
        this.chain(this.loop(B.brown, rate), this.filt('lowpass', 220), this.gain(0.05), this.zoneBus(pan, 0));
      }
      this.chain(this.loop(B.pink), this.filt('highpass', 3200), this.gain(0.006), this.mix);

      // fridge: mains hum harmonics + fan, with slow wobble
      this.fridgeG = this.gain(0); this.fridgeG.connect(this.filt('lowpass', 900)).connect(Z.fridge);
      const wob = ctx.createOscillator(); wob.frequency.value = 0.21; const wobG = this.gain(6); wob.connect(wobG); wob.start();
      for (const [f, a, type] of [[60, 0.03, 'sine'], [120, 0.04, 'sine'], [180, 0.018, 'sine'], [240, 0.01, 'triangle'], [360, 0.004, 'sine']]) {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; wobG.connect(o.detune);
        this.chain(o, this.gain(a), this.fridgeG); o.start();
      }
      this.chain(this.loop(B.pink, 0.9), this.filt('bandpass', 300, 1.1), this.gain(0.06), this.fridgeG);

      // rain bed
      this.rainG = this.gain(0); this.rainG.connect(this.rainIn);
      this.chain(this.loop(B.pink), this.filt('highpass', 600), this.rainG);
      this.chain(this.loop(B.white, 0.93), this.filt('bandpass', 2600, 0.5), this.gain(0.35), this.rainG);

      // sizzle: hiss + dense crackle + occasional spits
      this.hissG = this.gain(0); this.crackG = this.gain(0); this.popsG = this.gain(0);
      this.chain(this.loop(B.white, 1.07), this.filt('bandpass', 6000, 0.5), this.hissG, Z.stove);
      this.chain(this.loop(B.crackle), this.filt('highpass', 1700), this.crackG, Z.stove);
      this.chain(this.loop(B.pops), this.filt('bandpass', 2100, 0.7), this.popsG, Z.stove);

      // simmering pot
      this.rumbleG = this.gain(0); this.simBedG = this.gain(0);
      this.chain(this.loop(B.brown, 1.1), this.filt('bandpass', 260, 0.9), this.rumbleG, Z.pot);
      this.chain(this.loop(B.pink, 1.05), this.filt('bandpass', 950, 2), this.simBedG, Z.pot);

      // running water: jittering bandpasses make the splash; a low basin body under it
      this.waterG = this.gain(0); this.waterG.connect(Z.sink);
      this.waterBP = [[1100, 1.8], [2300, 2.2], [4100, 2.6]].map(([f, q]) => {
        const bp = this.filt('bandpass', f, q); bp._base = f;
        this.chain(this.loop(B.white, rnd(0.9, 1.1)), bp, this.waterG);
        return bp;
      });
      this.chain(this.loop(B.pink, 1.02), this.filt('lowpass', 500), this.gain(0.5), this.waterG);
      // filling a vessel: a narrow resonance that rises as the air column shortens
      this.fillG = this.gain(0); this.fillBP = this.filt('bandpass', 400, 12);
      this.chain(this.loop(B.white, 0.97), this.fillBP, this.fillG, Z.sink);

      // kettle
      this.kG1 = this.gain(0); this.kG2 = this.gain(0);
      this.chain(this.loop(B.brown, 1.2), this.filt('bandpass', 160, 0.8), this.kG1, Z.kettle);
      this.chain(this.loop(B.white, 1.01), this.filt('bandpass', 3200, 0.6), this.kG2, Z.kettle);
    }

    // Event buses are rebuilt on every seek so anything already scheduled
    // from the old position is cut instead of leaking into the new one.
    newGeneration() {
      const ctx = this.ctx, now = ctx.currentTime;
      if (this.evZ) {
        const old = this.evZ;
        for (const k in old) { old[k].gain.setTargetAtTime(0, now, 0.01); }
        setTimeout(() => { for (const k in old) try { old[k].disconnect(); } catch (e) { /* gone */ } }, 300);
      }
      this.evZ = {};
      for (const k in this.Z) { const g = this.gain(1); g.connect(this.Z[k]); this.evZ[k] = g; }
    }

    // ---------- transport ----------
    load(ep, at) {
      this.ep = ep;
      this.pausedAt = Math.max(0, Math.min(at || 0, ep.D - 1));
      this.captions = []; this.pings = [];
      if (this.ctx) this.resetTo(this.pausedAt);
    }
    position() {
      if (!this.ep) return 0;
      if (!this.playing || !this.ctx) return this.pausedAt;
      return Math.min(this.ep.D, this.e0 + (this.ctx.currentTime - this.c0));
    }
    toCtx(e) { return this.c0 + (e - this.e0); }
    resetTo(e) {
      const ctx = this.ctx;
      this.newGeneration();
      this.e0 = e; this.c0 = ctx.currentTime + 0.05;
      const E = this.ep.events;
      let lo = 0, hi = E.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (E[m].t < e) lo = m + 1; else hi = m; }
      this.macroIdx = lo;
      this.nextBucket = Math.floor(e);
      this.captions = []; this.pings = [];
      this.applyBeds(e, ctx.currentTime, 0.02);
    }
    async play() {
      if (!this.ep) return;
      this.ensure();
      if (this.ctx.state !== 'running') await this.ctx.resume();
      if (!this.playing) {
        this.resetTo(this.pausedAt);
        this.playing = true;
        const now = this.ctx.currentTime;
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setValueAtTime(0, now);
        this.timer = setInterval(() => this.tick(), 50);
        this.tick();
        this.emit('state', true);
      }
    }
    pause() {
      if (!this.playing) return;
      this.pausedAt = this.position();
      this.playing = false;
      clearInterval(this.timer); this.timer = null;
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.master.gain.value, now);
      this.master.gain.linearRampToValueAtTime(0, now + 0.35);
      setTimeout(() => { if (!this.playing && this.ctx.state === 'running') this.ctx.suspend(); }, 450);
      this.emit('state', false);
    }
    seek(e) {
      if (!this.ep) return;
      e = Math.max(0, Math.min(e, this.ep.D - 2));
      this.pausedAt = e;
      if (this.playing) {
        const now = this.ctx.currentTime;
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setValueAtTime(0, now);
        this.resetTo(e);
      }
      this.emit('seek', e);
    }
    setSleep(minutes) {
      this.sleepEnd = minutes ? Date.now() + minutes * 60000 : null;
    }
    envAt(e) {
      if (!this.ep) return 1;
      return Math.max(0, Math.min(1, e / 4, (this.ep.D - e) / 10));
    }

    tick() {
      if (!this.playing) return;
      const ctx = this.ctx, now = ctx.currentTime, ep = this.ep;
      const eNow = this.e0 + (now - this.c0);
      if (eNow >= ep.D) { this.pause(); this.pausedAt = ep.D; this.emit('ended'); return; }
      let sleepMul = 1;
      if (this.sleepEnd) {
        const left = (this.sleepEnd - Date.now()) / 1000;
        if (left <= 0) { this.sleepEnd = null; this.pause(); this.emit('slept'); return; }
        sleepMul = Math.min(1, left / 45);
      }
      const look = document.hidden ? 1.6 : 0.4;
      const eEnd = Math.min(ep.D, eNow + look);
      const E = ep.events;
      while (this.macroIdx < E.length && E[this.macroIdx].t < eEnd) {
        const ev = E[this.macroIdx++];
        if (ev.t >= eNow - 0.05) this.fire(ev, Math.max(now, this.toCtx(ev.t)));
      }
      while (this.nextBucket < eEnd) {
        const sec = this.nextBucket++;
        for (const m of this.bucket(sec)) if (m.t >= eNow - 0.02) this.fire(m, Math.max(now, this.toCtx(m.t)));
      }
      this.master.gain.setTargetAtTime(this.envAt(eNow) * this.volume * sleepMul, now + 0.05, 0.4);
      this.applyBeds(eNow + 0.1, now, null);
    }

    applyBeds(e, now, tcOverride) {
      const L = this.ep.layers;
      const set = (p, v, tc) => p.setTargetAtTime(v, now, tcOverride || tc || 0.12);
      const s = L.sizzle(e), flutter = 1 + 0.18 * Math.sin(e * 0.9) * Math.sin(e * 0.37 + 1);
      set(this.hissG.gain, 0.13 * s * flutter);
      set(this.crackG.gain, 1.5 * s * flutter);
      set(this.popsG.gain, 1.3 * Math.pow(s, 0.8));
      const b = L.bubbles(e);
      set(this.rumbleG.gain, 0.12 * Math.min(1, b / 20));
      set(this.simBedG.gain, 0.08 * Math.min(1, b / 10));
      const lid = L.lid(e);
      set(this.potLP.frequency, lid > 0.5 ? 1100 : 5200, 0.05);
      const f = L.fridge(e); set(this.fridgeG.gain, 0.16 * f, 0.4);
      const r = L.rain(e); set(this.rainG.gain, 0.16 * r, 1.2);
      const w = L.water(e); set(this.waterG.gain, 0.3 * w, 0.05);
      if (w > 0.01) for (const bp of this.waterBP) bp.frequency.setTargetAtTime(bp._base * rnd(0.72, 1.3), now, 0.03);
      set(this.fillG.gain, 0.55 * L.fillAmt(e), 0.05);
      set(this.fillBP.frequency, L.fillFreq(e), 0.2);
      const k = L.kettle(e);
      set(this.kG1.gain, 0.22 * k, 0.5); set(this.kG2.gain, 0.05 * k * k * k, 0.5);
      this.levels = { stove: Math.min(1, Math.max(s, b / 18)), sink: w, fridge: f * 0.35, window: r * 0.6, kettle: k };
    }

    bucket(sec) {
      const ep = this.ep, R = ep.rngFor(sec), L = ep.layers, P = ep.poisson, out = [], mid = sec + 0.5;
      const b = L.bubbles(mid);
      for (let i = 0, n = P(R, b); i < n; i++) out.push({ t: sec + R.next(), type: 'bubble', p: { f: R.range(220, 900), up: R.range(1.6, 2.4), dur: R.range(0.025, 0.07), a: R.range(0.3, 1) } });
      const r = L.rain(mid);
      for (let i = 0, n = P(R, r * 22); i < n; i++) out.push({ t: sec + R.next(), type: 'drop', p: { f: R.range(1800, 6000), pan: R.range(-0.8, 0.8), a: R.range(0.2, 1) } });
      const w = L.water(mid);
      for (let i = 0, n = P(R, w * 30); i < n; i++) out.push({ t: sec + R.next(), type: 'droplet', p: { f: R.range(900, 3200), a: R.range(0.3, 1) } });
      const k = L.kettle(mid);
      if (k > 0.5) for (let i = 0, n = P(R, (k - 0.5) * 24); i < n; i++) out.push({ t: sec + R.next(), type: 'kbubble', p: { f: R.range(500, 1400), a: R.range(0.3, 1) } });
      if (ep.clock) out.push({ t: sec + ep.clockPhase, type: 'tick', p: { tock: sec % 2 }, zone: 'clock' });
      out.sort((a, c) => a.t - c.t);
      return out;
    }

    fire(ev, t) {
      const fn = SYNTH[ev.type];
      const zone = ev.zone || 'table';
      if (fn) fn.call(this, t, ev.p || {}, this.evZ[zone] || this.evZ.table);
      if (ev.cap) this.captions.push({ t, text: ev.cap, zone });
      if (ev.zone) this.pings.push({ t, zone: ev.zone, a: ev.type === 'tick' ? 0.35 : 1 });
    }

    // ---------- small synthesis kit ----------
    noise(t, dur, o, dest) {
      const ctx = this.ctx, src = ctx.createBufferSource();
      src.buffer = this.buf[o.kind || 'white'];
      const f = this.filt(o.type || 'bandpass', o.f || 1000, o.q);
      if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t + dur);
      const g = ctx.createGain(), atk = o.atk || 0.002;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(o.gain || 0.2, t + atk);
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(atk + 0.002, dur));
      src.loop = true;
      src.connect(f); f.connect(g); g.connect(dest);
      src.start(t, Math.random() * src.buffer.duration);
      src.stop(t + dur + 0.05);
      return g;
    }
    // a noise burst with a hand-drawn amplitude curve (stirs, scrubs, passing cars)
    noiseCurve(t, dur, o, curve, dest) {
      const ctx = this.ctx, src = ctx.createBufferSource();
      src.buffer = this.buf[o.kind || 'pink']; src.loop = true;
      const f = this.filt(o.type || 'bandpass', o.f || 1000, o.q);
      if (o.fCurve) f.frequency.setValueCurveAtTime(o.fCurve, t, dur);
      const g = ctx.createGain(); g.gain.value = 0;
      g.gain.setValueCurveAtTime(curve, t, dur);
      src.connect(f); f.connect(g);
      if (o.panCurve) { const p = ctx.createStereoPanner(); p.pan.setValueCurveAtTime(o.panCurve, t, dur); g.connect(p); p.connect(dest); }
      else g.connect(dest);
      src.start(t, Math.random() * 2); src.stop(t + dur + 0.05);
    }
    tone(t, o, dest) {
      const ctx = this.ctx, osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.f, t);
      if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + o.dur);
      const atk = o.atk || 0.002;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(o.gain, t + atk);
      g.gain.exponentialRampToValueAtTime(0.0001, t + atk + o.dur);
      osc.connect(g); g.connect(dest);
      osc.start(t); osc.stop(t + atk + o.dur + 0.05);
    }
    // modal synthesis: an impulse into a handful of tuned, decaying partials
    modal(t, kind, f0, amp, dest, decayScale) {
      const m = MAT[kind] || MAT.metal, ds = decayScale || 1;
      f0 = f0 || rnd(m.f[0], m.f[1]);
      for (let i = 0; i < m.r.length; i++) {
        const fr = f0 * m.r[i] * rnd(0.995, 1.005);
        if (fr > 16000) continue;
        this.tone(t, { f: fr, dur: m.d[i] * ds, gain: amp * m.a[i], atk: 0.001 }, dest);
      }
      this.noise(t, 0.006, { type: 'highpass', f: Math.min(9000, f0 * 2), gain: amp * 0.6 }, dest);
    }
    amCurve(dur, rate, depth, base, rateJitter) {
      const n = Math.max(8, Math.floor(dur * 60)), c = new Float32Array(n);
      let ph = Math.random() * Math.PI * 2;
      for (let i = 0; i < n; i++) {
        const x = i / (n - 1), edge = Math.min(1, x * 8, (1 - x) * 8);
        ph += (2 * Math.PI * rate * dur / n) * (1 + (rateJitter || 0) * (Math.random() - 0.5));
        const am = 1 - depth + depth * Math.pow(Math.abs(Math.sin(ph)), 1.5);
        c[i] = Math.max(0, base * am * edge * rnd(0.85, 1.15));
      }
      c[n - 1] = 0;
      return c;
    }
  }

  // ---------- the sounds ----------
  const SYNTH = {
    caption() {},
    chop(t, p, d) {
      const a = p.amp || 1, crisp = p.crisp || 0.5;
      this.tone(t, { f: 115, f2: 70, dur: 0.06, gain: 0.22 * a }, d);
      this.noise(t, 0.03, { f: rnd(900, 1400), q: 2.5, gain: 0.24 * a }, d);
      this.modal(t, 'wood', rnd(380, 520), 0.07 * a, d);
      this.noise(t, 0.012, { type: 'highpass', f: 3000, gain: 0.13 * crisp * a }, d);
      if (crisp > 0.55) this.noise(t + 0.006, 0.01, { type: 'highpass', f: 4200, gain: 0.07 * crisp * a }, d);
    },
    scrape(t, p, d) { this.noise(t, p.dur || 0.7, { kind: 'pink', f: 2200, f2: 900, q: 1.2, gain: 0.06, atk: 0.06 }, d); },
    clink(t, p, d) { this.modal(t, p.kind || 'ceramic', p.f, 0.07 * (p.amp || 1), d); },
    boardDown(t, p, d) { this.modal(t, 'wood', 220, 0.22, d, 2); this.tone(t, { f: 90, dur: 0.08, gain: 0.18 }, d); },
    towel(t, p, d) {
      this.noise(t, 0.9, { kind: 'pink', f: 1500, q: 0.7, gain: 0.04, atk: 0.25 }, d);
      this.noise(t + 1.1, 0.8, { kind: 'pink', f: 1700, q: 0.7, gain: 0.035, atk: 0.2 }, d);
    },
    tapOn(t, p, d) { this.tone(t, { f: 900, f2: 1250, dur: 0.08, gain: 0.012 }, d); this.noise(t, 0.04, { kind: 'brown', type: 'lowpass', f: 600, gain: 0.08 }, d); },
    tapOff(t, p, d) {
      this.noise(t, 0.05, { kind: 'brown', type: 'lowpass', f: 600, gain: 0.1 }, d);
      for (let i = 0; i < (p.drips || 0); i++) { const f = rnd(1300, 2300); this.tone(t + 0.6 + i * rnd(0.5, 1.4), { f, f2: f * 1.9, dur: 0.03, gain: 0.045 }, d); }
    },
    fridgeDoor(t, p, d) {
      this.noise(t, 0.15, { kind: 'brown', type: 'lowpass', f: 400, gain: 0.3 }, d);
      this.tone(t, { f: 72, dur: 0.1, gain: 0.12 }, d);
      this.modal(t + rnd(0.7, 1.0), 'glass', rnd(900, 1300), 0.04, d);
      this.modal(t + rnd(1.2, 1.6), 'glass', rnd(900, 1300), 0.03, d);
      const c = t + (p.dur || 4);
      this.tone(c, { f: 60, f2: 40, dur: 0.16, gain: 0.3 }, d);
      this.noise(c, 0.2, { kind: 'brown', type: 'lowpass', f: 300, gain: 0.35 }, d);
      this.modal(c + 0.05, 'glass', rnd(1000, 1400), 0.03, d);
      this.modal(c + 0.09, 'glass', rnd(1500, 1900), 0.02, d);
    },
    fridgeOn(t, p, d) {
      this.tone(t, { f: 40, f2: 60, dur: 1.2, gain: 0.12, atk: 0.2 }, d);
      for (let i = 0; i < 3; i++) this.modal(t + 0.1 + i * rnd(0.08, 0.15), 'castiron', rnd(140, 200), 0.03, d);
    },
    fridgeOff(t, p, d) { [0.2, 0.12, 0.06].forEach((g, i) => this.tone(t + i * 0.12, { f: 55, dur: 0.08, gain: g }, d)); },
    igniter(t, p, d) {
      const n = p.n || 4;
      for (let i = 0; i < n; i++) {
        const c = t + i * 0.16 + rnd(-0.01, 0.01);
        this.noise(c, 0.004, { type: 'highpass', f: 2500, gain: 0.22 }, d);
        this.tone(c, { f: 4200, dur: 0.03, gain: 0.015 }, d);
      }
      this.noise(t + n * 0.16, 0.55, { kind: 'brown', type: 'lowpass', f: 150, f2: 900, gain: 0.45, atk: 0.03 }, d);
    },
    knob(t, p, d) { this.noise(t, 0.006, { f: 3000, q: 2, gain: 0.15 }, d); this.modal(t, 'wood', 900, 0.03, d); },
    click(t, p, d) { this.noise(t, 0.008, { f: p.f || 2500, q: 3, gain: 0.2 }, d); this.modal(t, 'wood', 600, 0.05, d); },
    panDown(t, p, d) { this.modal(t, 'castiron', 160, 0.16, d); this.tone(t, { f: 80, dur: 0.08, gain: 0.2 }, d); this.noise(t, 0.08, { kind: 'brown', type: 'lowpass', f: 500, gain: 0.2 }, d); },
    potDown(t, p, d) {
      this.modal(t, 'castiron', 260, 0.12, d, 1.5); this.tone(t, { f: 85, dur: 0.1, gain: 0.2 }, d);
      this.noise(t + 0.02, 0.6, { kind: 'pink', type: 'lowpass', f: 600, gain: 0.12, atk: 0.05 }, d);
    },
    onset(t, p, d) {
      const a = p.amp || 1;
      this.noise(t, 2.6, { type: 'highpass', f: 2500, gain: 0.32 * a, atk: 0.02 }, d);
      this.noise(t, 1.4, { f: 4000, q: 0.8, gain: 0.15 * a, atk: 0.01 }, d);
      for (let i = 0; i < 18; i++) this.noise(t + Math.pow(Math.random(), 1.6) * 1.8, 0.01, { f: rnd(1500, 3500), q: 1.5, gain: rnd(0.05, 0.2) * a }, d);
    },
    pourIn(t, p, d) {
      this.noise(t + 0.2, 3.5, { type: 'highpass', f: 1800, gain: 0.28, atk: 0.05 }, d);
      this.noiseCurve(t, 2.6, { kind: 'pink', f: 700, q: 2 }, this.amCurve(2.6, 6, 0.5, 0.18, 0.6), d);
    },
    stirPan(t, p, d) {
      const dur = p.dur || 4;
      this.noiseCurve(t, dur, { kind: 'pink', f: 850, q: 1.3 }, this.amCurve(dur, 1.1, 0.75, 0.07, 0.3), d);
      this.modal(t + dur + 0.2, 'castiron', 420, 0.03, d);
    },
    stirPot(t, p, d) {
      const dur = p.dur || 5;
      this.noiseCurve(t, dur, { kind: 'pink', f: 480, q: 1.4 }, this.amCurve(dur, 0.9, 0.7, 0.07, 0.3), this.evZ.pot);
      this.noiseCurve(t, dur, { kind: 'brown', type: 'lowpass', f: 450 }, this.amCurve(dur, 0.9, 0.6, 0.12, 0.4), this.evZ.pot);
    },
    tap2(t, p, d) { this.modal(t, 'wood', 700, 0.06, d); this.modal(t + 0.22, 'wood', 690, 0.05, d); },
    lidOn(t, p, d) {
      // a lid settling bounces like a dropped coin: each impact quieter and sooner
      const f0 = rnd(380, 480);
      let at = t, iv = 0.11, a = 0.16;
      for (let k = 0; k < 7; k++) { this.modal(at, 'lid', f0 * rnd(0.99, 1.01), a, d, k === 0 ? 1 : 0.5); at += iv; iv *= 0.68; a *= 0.6; }
    },
    lidOff(t, p, d) { this.modal(t, 'lid', 430, 0.04, d, 0.6); this.noise(t + 0.05, 0.9, { type: 'highpass', f: 3000, gain: 0.06, atk: 0.05 }, d); },
    ladle(t, p, d) {
      this.modal(t, 'metal', rnd(800, 1000), 0.05, d);
      this.noiseCurve(t + 0.2, 0.8, { kind: 'brown', type: 'lowpass', f: 500 }, this.amCurve(0.8, 3, 0.6, 0.12, 0.5), this.evZ.pot);
      if (p.pourIn) this.noise(t + 0.6, 1.8, { type: 'highpass', f: 2000, gain: 0.1, atk: 0.05 }, d);
      else this.modal(t + 1.2, 'ceramic', rnd(1000, 1300), 0.05, this.evZ.table);
    },
    cabinet(t, p, d) {
      this.noise(t, 0.05, { kind: 'brown', type: 'lowpass', f: 700, gain: 0.08 }, d);
      for (let i = 0; i < 3; i++) this.modal(t + 0.8 + i * rnd(0.12, 0.25), 'ceramic', rnd(900, 1300), 0.05, d);
      this.tone(t + 2.5, { f: 100, dur: 0.08, gain: 0.14 }, d);
      this.noise(t + 2.5, 0.06, { kind: 'brown', type: 'lowpass', f: 500, gain: 0.15 }, d);
    },
    plateDown(t, p, d) { this.modal(t, 'ceramic', rnd(700, 1000), p.soft ? 0.06 : 0.11, d); this.tone(t, { f: 120, dur: 0.04, gain: 0.07 }, d); },
    drawer(t, p, d) {
      this.noise(t, 0.45, { kind: 'pink', f: 1300, q: 0.8, gain: 0.06, atk: 0.1 }, d);
      for (let i = 0; i < 14; i++) this.modal(t + rnd(0.05, 0.55), 'metal', rnd(2500, 5500), rnd(0.008, 0.03), d, 0.4);
      this.noise(t + 2.2, 0.35, { kind: 'pink', f: 1200, q: 0.8, gain: 0.05, atk: 0.08 }, d);
      this.tone(t + 2.55, { f: 110, dur: 0.06, gain: 0.08 }, d);
    },
    scrub(t, p, d) { const dur = p.dur || 3; this.noiseCurve(t, dur, { kind: 'white', f: 2400, q: 1 }, this.amCurve(dur, 4.5, 0.8, 0.05, 0.4), d); },
    rack(t, p, d) { this.modal(t, 'ceramic', rnd(1300, 1700), 0.05, d); this.modal(t + 0.02, 'metal', rnd(2300, 2800), 0.015, d); },
    carPass(t, p, d) {
      const dur = p.dur || 7, n = 48, fc = new Float32Array(n), gc = new Float32Array(n), pc = new Float32Array(n), dir = p.dir || 1;
      for (let i = 0; i < n; i++) {
        const x = i / (n - 1), bell = Math.exp(-Math.pow((x - 0.5) / 0.2, 2));
        fc[i] = 180 + 520 * bell; gc[i] = 1.2 * (p.amp || 1) * bell; pc[i] = dir * (x * 1.6 - 0.8);
      }
      gc[n - 1] = 0;
      this.noiseCurve(t, dur, { kind: 'brown', type: 'lowpass', fCurve: fc, panCurve: pc }, gc, d);
      if (p.wet) this.noiseCurve(t, dur, { kind: 'white', f: 2500, q: 0.7, panCurve: pc }, gc.map((v) => v * 0.35), d);
    },
    plane(t, p, d) {
      const dur = p.dur || 30, n = 64, gc = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = i / (n - 1); gc[i] = 0.35 * Math.sin(Math.PI * x) ** 2; }
      this.noiseCurve(t, dur, { kind: 'brown', type: 'lowpass', f: 260 }, gc, d);
    },
    eggCrack(t, p, d) {
      this.noise(t, 0.008, { type: 'highpass', f: 1200, gain: 0.3 }, d);
      this.modal(t, 'ceramic', 1100, 0.05, d);
      this.noise(t + 0.04, 0.05, { type: 'highpass', f: 3000, gain: 0.05 }, d);
    },
    whisk(t, p, d) {
      const dur = p.dur || 30;
      for (let x = 0; x < dur; x += 1 / rnd(8, 10.5)) {
        const tt = t + x, a = Math.min(1, x / 2, (dur - x) / 2);
        this.modal(tt, 'metal', rnd(3500, 5000), 0.012 * a, d, 0.3);
        if (Math.random() < 0.5) this.noise(tt, 0.08, { f: 1800, q: 0.9, gain: 0.02 * a, atk: 0.02 }, d);
      }
    },
    toasterDown(t, p, d) { this.noise(t, 0.12, { kind: 'brown', type: 'lowpass', f: 800, gain: 0.2 }, d); this.modal(t + 0.05, 'metal', 900, 0.03, d); },
    toasterPop(t, p, d) {
      this.tone(t, { f: 220, f2: 520, dur: 0.12, gain: 0.05 }, d);
      this.noise(t, 0.06, { kind: 'brown', type: 'lowpass', f: 600, gain: 0.22 }, d);
      this.modal(t + 0.01, 'metal', 1200, 0.04, d);
    },
    butter(t, p, d) {
      for (let i = 0; i < (p.n || 6); i++) this.noise(t + i * rnd(0.45, 0.7), rnd(0.3, 0.5), { f: 3000, q: 0.9, gain: 0.05, atk: 0.05 }, d);
    },
    pour(t, p, d) {
      const dur = p.dur || 4;
      this.noise(t, dur, { f: 700, f2: 1800, q: 4, gain: 0.12, atk: 0.2 }, d);
      this.noise(t, dur, { kind: 'pink', type: 'lowpass', f: 700, gain: 0.05, atk: 0.2 }, d);
    },
    mugStir(t, p, d) {
      // the allassonic effect: as bubbles clear out of hot liquid, sound travels faster and the tinks rise in pitch
      const n = p.n || 8;
      for (let i = 0; i < n; i++) this.modal(t + i * rnd(0.28, 0.36), 'ceramic', 1500 + (800 * i) / (n - 1), 0.045, d, 0.7);
    },
    flip(t, p, d) { this.noise(t, 0.15, { f: 2500, q: 1, gain: 0.06, atk: 0.02 }, d); this.tone(t + 0.25, { f: 140, dur: 0.05, gain: 0.1 }, d); },
    // ---- micro ----
    bubble(t, p) { this.tone(t, { f: p.f, f2: p.f * p.up, dur: p.dur, gain: 0.06 * p.a }, this.evZ.pot); },
    drop(t, p) { const d = this.evZ.rain; this.noise(t, 0.012, { f: p.f, q: 4, gain: 0.05 * p.a }, d); this.tone(t, { f: p.f * 1.2, dur: 0.01, gain: 0.01 * p.a }, d); },
    droplet(t, p) { this.tone(t, { f: p.f, f2: p.f * 1.8, dur: 0.02, gain: 0.028 * p.a }, this.evZ.sink); },
    kbubble(t, p) { this.tone(t, { f: p.f, f2: p.f * 2, dur: 0.03, gain: 0.03 * p.a }, this.evZ.kettle); },
    tick(t, p, d) { this.noise(t, 0.006, { f: p.tock ? 2800 : 3500, q: 5, gain: 0.04 }, d); this.modal(t, 'wood', p.tock ? 1650 : 1800, 0.006, d); },
  };

  global.NotcastEngine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
