/* ══════════════════════════════════════════════════════════════
   indicators.js — technical analysis library
   Every series returns an array aligned to the input, with `null`
   during warm-up so charts and engines never read half-built data.
   ══════════════════════════════════════════════════════════════ */
'use strict';

const TA = (() => {
  const { isNum, last, avg, clamp } = CORE;
  const N = v => (isNum(v) ? v : null);

  const closesOf = c => c.map(x => x.close);
  const highsOf  = c => c.map(x => x.high);
  const lowsOf   = c => c.map(x => x.low);
  const volsOf   = c => c.map(x => x.volume);

  /* ── moving averages ─────────────────────────────────────── */
  function sma(vals, p) {
    const out = new Array(vals.length).fill(null);
    let s = 0;
    for (let i = 0; i < vals.length; i++) {
      s += vals[i];
      if (i >= p) s -= vals[i - p];
      if (i >= p - 1) out[i] = s / p;
    }
    return out;
  }
  function ema(vals, p) {
    const out = new Array(vals.length).fill(null);
    if (!vals.length) return out;
    const k = 2 / (p + 1);
    let prev = null, seed = 0;
    for (let i = 0; i < vals.length; i++) {
      if (i < p) { seed += vals[i]; if (i === p - 1) { prev = seed / p; out[i] = prev } continue }
      prev = vals[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }
  /* Wilder smoothing (used by RSI / ATR / ADX) */
  function rma(vals, p) {
    const out = new Array(vals.length).fill(null);
    if (vals.length < p) return out;
    let s = 0;
    for (let i = 0; i < p; i++) s += vals[i];
    let prev = s / p; out[p - 1] = prev;
    for (let i = p; i < vals.length; i++) { prev = (prev * (p - 1) + vals[i]) / p; out[i] = prev }
    return out;
  }
  function wma(vals, p) {
    const out = new Array(vals.length).fill(null);
    const denom = (p * (p + 1)) / 2;
    for (let i = p - 1; i < vals.length; i++) {
      let s = 0;
      for (let j = 0; j < p; j++) s += vals[i - j] * (p - j);
      out[i] = s / denom;
    }
    return out;
  }
  const highest = (vals, p, i) => { let m = -Infinity; for (let j = Math.max(0, i - p + 1); j <= i; j++) m = Math.max(m, vals[j]); return m };
  const lowest  = (vals, p, i) => {  let m = Infinity; for (let j = Math.max(0, i - p + 1); j <= i; j++) m = Math.min(m, vals[j]); return m };

  /* ── oscillators ─────────────────────────────────────────── */
  function rsi(closes, p = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length <= p) return out;
    const g = [], l = [];
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      g.push(Math.max(0, d)); l.push(Math.max(0, -d));
    }
    const ag = rma(g, p), al = rma(l, p);
    for (let i = 0; i < ag.length; i++) {
      if (ag[i] === null || al[i] === null) continue;
      out[i + 1] = al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i]);
    }
    return out;
  }

  function macd(closes, fast = 12, slow = 26, sig = 9) {
    const ef = ema(closes, fast), es = ema(closes, slow);
    const line = closes.map((_, i) => (ef[i] !== null && es[i] !== null) ? ef[i] - es[i] : null);
    const valid = [], idx = [];
    line.forEach((v, i) => { if (v !== null) { valid.push(v); idx.push(i) } });
    const sigValid = ema(valid, sig);
    const signal = new Array(closes.length).fill(null);
    idx.forEach((i, j) => { signal[i] = sigValid[j] });
    const hist = line.map((v, i) => (v !== null && signal[i] !== null) ? v - signal[i] : null);
    return { line, signal, hist };
  }

  function bollinger(closes, p = 20, mult = 2) {
    const mid = sma(closes, p);
    const upper = new Array(closes.length).fill(null);
    const lower = new Array(closes.length).fill(null);
    for (let i = p - 1; i < closes.length; i++) {
      let sq = 0;
      for (let j = i - p + 1; j <= i; j++) sq += Math.pow(closes[j] - mid[i], 2);
      const sd = Math.sqrt(sq / p);
      upper[i] = mid[i] + mult * sd;
      lower[i] = mid[i] - mult * sd;
    }
    const width = upper.map((u, i) => (u !== null && lower[i] !== null && mid[i]) ? (u - lower[i]) / mid[i] * 100 : null);
    const pctB = upper.map((u, i) => (u !== null && lower[i] !== null && u !== lower[i]) ? (closes[i] - lower[i]) / (u - lower[i]) : null);
    return { mid, upper, lower, width, pctB };
  }

  function stoch(c, p = 14, d = 3) {
    const h = highsOf(c), l = lowsOf(c), cl = closesOf(c);
    const k = cl.map((_, i) => {
      if (i < p - 1) return null;
      const hh = highest(h, p, i), ll = lowest(l, p, i);
      return hh === ll ? 50 : (cl[i] - ll) / (hh - ll) * 100;
    });
    const kv = k.map(v => v === null ? 0 : v);
    const dv = sma(kv, d);
    const kd = k.map((v, i) => (v === null || dv[i] === null) ? null : dv[i]);
    return { k, d: kd };
  }

  function cci(c, p = 20) {
    const tp = c.map(x => (x.high + x.low + x.close) / 3);
    const ma = sma(tp, p);
    return tp.map((v, i) => {
      if (i < p - 1 || ma[i] === null) return null;
      let md = 0;
      for (let j = i - p + 1; j <= i; j++) md += Math.abs(tp[j] - ma[i]);
      md /= p;
      return md === 0 ? 0 : (v - ma[i]) / (0.015 * md);
    });
  }

  function willr(c, p = 14) {
    const h = highsOf(c), l = lowsOf(c), cl = closesOf(c);
    return cl.map((_, i) => {
      if (i < p - 1) return null;
      const hh = highest(h, p, i), ll = lowest(l, p, i);
      return hh === ll ? -50 : -100 * (hh - cl[i]) / (hh - ll);
    });
  }

  function roc(closes, p = 12) {
    return closes.map((v, i) => i < p || closes[i - p] === 0 ? null : (v - closes[i - p]) / closes[i - p] * 100);
  }

  function cmo(closes, p = 14) {
    return closes.map((_, i) => {
      if (i < p) return null;
      let up = 0, dn = 0;
      for (let j = i - p + 1; j <= i; j++) { const d = closes[j] - closes[j - 1]; d >= 0 ? up += d : dn -= d }
      return up + dn === 0 ? 0 : (up - dn) / (up + dn) * 100;
    });
  }

  /* ── trend / volatility ──────────────────────────────────── */
  function trueRange(c) {
    return c.map((x, i) => i === 0 ? x.high - x.low
      : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)));
  }
  function atr(c, p = 14) { return rma(trueRange(c), p) }

  function adx(c, p = 14) {
    const up = [], dn = [], tr = trueRange(c);
    for (let i = 0; i < c.length; i++) {
      if (i === 0) { up.push(0); dn.push(0); continue }
      const hu = c[i].high - c[i - 1].high, hd = c[i - 1].low - c[i].low;
      up.push(hu > hd && hu > 0 ? hu : 0);
      dn.push(hd > hu && hd > 0 ? hd : 0);
    }
    const str = rma(tr, p), sp = rma(up, p), sn = rma(dn, p);
    const pdi = str.map((v, i) => (v === null || sp[i] === null || v === 0) ? null : 100 * sp[i] / v);
    const mdi = str.map((v, i) => (v === null || sn[i] === null || v === 0) ? null : 100 * sn[i] / v);
    const dx = pdi.map((v, i) => {
      if (v === null || mdi[i] === null) return null;
      const s = v + mdi[i];
      return s === 0 ? 0 : 100 * Math.abs(v - mdi[i]) / s;
    });
    const dxv = dx.map(v => v === null ? 0 : v);
    const a = rma(dxv, p);
    const adxArr = dx.map((v, i) => v === null ? null : a[i]);
    return { adx: adxArr, plusDI: pdi, minusDI: mdi };
  }

  function supertrend(c, p = 10, mult = 3) {
    const a = atr(c, p);
    const line = new Array(c.length).fill(null);
    const dir = new Array(c.length).fill(null);
    let upper = null, lower = null, d = 1;
    for (let i = 0; i < c.length; i++) {
      if (a[i] === null) continue;
      const mid = (c[i].high + c[i].low) / 2;
      let bu = mid + mult * a[i], bl = mid - mult * a[i];
      if (upper === null) { upper = bu; lower = bl }
      else {
        bu = (bu < upper || c[i - 1].close > upper) ? bu : upper;
        bl = (bl > lower || c[i - 1].close < lower) ? bl : lower;
      }
      if (d === 1) { if (c[i].close < bl) { d = -1; lower = bl } else if (c[i].close > bu) upper = bu }
      else { if (c[i].close > bu) { d = 1; upper = bu } else if (c[i].close < bl) lower = bl }
      upper = bu; lower = bl;
      dir[i] = d; line[i] = d === 1 ? lower : upper;
    }
    return { line, dir };
  }

  function ichimoku(c) {
    const h = highsOf(c), l = lowsOf(c);
    const conv = h.map((_, i) => i < 8 ? null : (highest(h, 9, i) + lowest(l, 9, i)) / 2);
    const base = h.map((_, i) => i < 25 ? null : (highest(h, 26, i) + lowest(l, 26, i)) / 2);
    const spanA = h.map((_, i) => (conv[i] === null || base[i] === null) ? null : (conv[i] + base[i]) / 2);
    const spanB = h.map((_, i) => i < 51 ? null : (highest(h, 52, i) + lowest(l, 52, i)) / 2);
    return { conv, base, spanA, spanB };
  }

  /* ── volume ──────────────────────────────────────────────── */
  function obv(c) {
    const out = new Array(c.length).fill(0);
    for (let i = 1; i < c.length; i++) {
      out[i] = out[i - 1] + (c[i].close > c[i - 1].close ? c[i].volume : c[i].close < c[i - 1].close ? -c[i].volume : 0);
    }
    return out;
  }
  function vwapSession(c, fromTime) {
    const out = new Array(c.length).fill(null);
    let pv = 0, vv = 0;
    for (let i = 0; i < c.length; i++) {
      if (c[i].time < fromTime) continue;
      const tp = (c[i].high + c[i].low + c[i].close) / 3;
      pv += tp * c[i].volume; vv += c[i].volume;
      out[i] = vv > 0 ? pv / vv : null;
    }
    return out;
  }
  function vwapRolling(c, p = 50) {
    const out = new Array(c.length).fill(null);
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(0, i - p + 1);
      let pv = 0, vv = 0;
      for (let j = s; j <= i; j++) { const tp = (c[j].high + c[j].low + c[j].close) / 3; pv += tp * c[j].volume; vv += c[j].volume }
      out[i] = vv > 0 ? pv / vv : null;
    }
    return out;
  }
  const volSma = (c, p = 20) => sma(volsOf(c), p);

  /* ── Cumulative Volume Delta (CVD) ────────────────────────── */
  function cvd(c) {
    const delta = new Array(c.length).fill(0);
    const cum = new Array(c.length).fill(0);
    let running = 0;
    for (let i = 0; i < c.length; i++) {
      const vol = c[i].volume || 0;
      const takerBuy = isNum(c[i].takerBuy) ? c[i].takerBuy : (vol * 0.5);
      const takerSell = Math.max(0, vol - takerBuy);
      const d = takerBuy - takerSell;
      delta[i] = d;
      running += d;
      cum[i] = running;
    }
    return { delta, cum };
  }

  /* ── Chaikin Money Flow (CMF) ────────────────────────────── */
  function cmf(c, p = 20) {
    const out = new Array(c.length).fill(null);
    if (c.length < p) return out;
    const mfv = [];
    for (let i = 0; i < c.length; i++) {
      const range = c[i].high - c[i].low;
      const mult = range > 0 ? ((c[i].close - c[i].low) - (c[i].high - c[i].close)) / range : 0;
      mfv.push(mult * (c[i].volume || 0));
    }
    for (let i = p - 1; i < c.length; i++) {
      let sumMfv = 0, sumVol = 0;
      for (let j = i - p + 1; j <= i; j++) {
        sumMfv += mfv[j];
        sumVol += (c[j].volume || 0);
      }
      out[i] = sumVol > 0 ? sumMfv / sumVol : 0;
    }
    return out;
  }

  /* ── TTM Squeeze Momentum ─────────────────────────────────── */
  function squeeze(c, bbP = 20, bbMult = 2, kcMult = 1.5) {
    const cl = closesOf(c);
    const bb = bollinger(cl, bbP, bbMult);
    const a = atr(c, bbP);
    const ma = sma(cl, bbP);
    const on = new Array(c.length).fill(false);
    const hist = new Array(c.length).fill(null);
    for (let i = 0; i < c.length; i++) {
      if (bb.upper[i] === null || a[i] === null || ma[i] === null) continue;
      const kcU = ma[i] + kcMult * a[i];
      const kcL = ma[i] - kcMult * a[i];
      on[i] = bb.upper[i] < kcU && bb.lower[i] > kcL;
      hist[i] = cl[i] - ma[i];
    }
    return { on, hist };
  }

  /* ── Fair Value Gap (FVG) / Smart Money Imbalance ────────── */
  function fvg(c) {
    const out = new Array(c.length).fill(null);
    for (let i = 2; i < c.length; i++) {
      if (c[i].low > c[i - 2].high) {
        out[i] = { type: 'BULLISH', top: c[i].low, bottom: c[i - 2].high, size: c[i].low - c[i - 2].high };
      } else if (c[i].high < c[i - 2].low) {
        out[i] = { type: 'BEARISH', top: c[i - 2].low, bottom: c[i].high, size: c[i - 2].low - c[i].high };
      }
    }
    return out;
  }

  /* ── volume profile (POC / value area) ───────────────────── */
  function volumeProfile(c, buckets = 40, lookback = 200) {
    const slice = c.slice(-lookback).filter(x => x.volume > 0);
    if (slice.length < 10) return null;
    let hi = -Infinity, lo = Infinity;
    slice.forEach(x => { hi = Math.max(hi, x.high); lo = Math.min(lo, x.low) });
    if (!isNum(hi) || !isNum(lo) || hi <= lo) return null;
    const step = (hi - lo) / buckets;
    const bins = new Array(buckets).fill(0);
    slice.forEach(x => {
      const a = Math.max(0, Math.floor((x.low - lo) / step));
      const b = Math.min(buckets - 1, Math.floor((x.high - lo) / step));
      const span = b - a + 1;
      for (let k = a; k <= b; k++) bins[k] += x.volume / span;
    });
    let pocI = 0;
    bins.forEach((v, i) => { if (v > bins[pocI]) pocI = i });
    const total = bins.reduce((s, v) => s + v, 0);
    let target = total * 0.7, loI = pocI, hiI = pocI;
    let inside = bins[pocI];
    while (inside < target && (loI > 0 || hiI < buckets - 1)) {
      const below = loI > 0 ? bins[loI - 1] : -1;
      const above = hiI < buckets - 1 ? bins[hiI + 1] : -1;
      if (above >= below) { hiI++; inside += bins[hiI] } else { loI--; inside += bins[loI] }
      if (loI === 0 && hiI === buckets - 1) break;
    }
    const px = i => lo + step * (i + 0.5);
    return { poc: px(pocI), val: px(loI), vah: px(hiI), hi, lo };
  }

  /* ── pivot points from a completed reference candle ──────── */
  function pivots(ref) {
    if (!ref) return null;
    const P = (ref.high + ref.low + ref.close) / 3;
    const r = ref.high - ref.low;
    return {
      P,
      R1: 2 * P - ref.low, S1: 2 * P - ref.high,
      R2: P + r,           S2: P - r,
      R3: ref.high + 2 * (P - ref.low), S3: ref.low - 2 * (ref.high - P),
    };
  }

  /* ── swing structure ─────────────────────────────────────── */
  function swings(c, strength = 3) {
    const hi = [], lo = [];
    for (let i = strength; i < c.length - strength; i++) {
      let isH = true, isL = true;
      for (let j = i - strength; j <= i + strength; j++) {
        if (j === i) continue;
        if (c[j].high >= c[i].high) isH = false;
        if (c[j].low <= c[i].low) isL = false;
      }
      if (isH) hi.push({ i, time: c[i].time, price: c[i].high });
      if (isL) lo.push({ i, time: c[i].time, price: c[i].low });
    }
    return { hi, lo };
  }

  /* ── single consolidated read-out for a timeframe ────────── */
  function snapshot(c) {
    if (!c || c.length < 60) return null;
    const cl = closesOf(c);
    const i = c.length - 1;
    const ema9 = ema(cl, 9), ema21 = ema(cl, 21), ema50 = ema(cl, 50), ema200 = ema(cl, 200);
    const r = rsi(cl, 14), m = macd(cl), bb = bollinger(cl, 20, 2), a = atr(c, 14);
    const x = adx(c, 14), s = stoch(c, 14, 3), ci = cci(c, 20), wr = willr(c, 14);
    const st = supertrend(c, 10, 3), ich = ichimoku(c);
    const ob = obv(c), ro = roc(cl, 12), cm = cmo(cl, 14);
    const dayStart = Math.floor(c[i].time / CORE.DAY) * CORE.DAY;
    const vw = vwapSession(c, dayStart), vws = vwapRolling(c, 50), vsm = volSma(c, 20);
    const sw = swings(c, 3);
    const swHi = sw.hi.length ? sw.hi[sw.hi.length - 1].price : null;
    const swLo = sw.lo.length ? sw.lo[sw.lo.length - 1].price : null;
    const aPct = a[i] !== null && cl[i] ? (a[i] / cl[i]) * 100 : null;

    const cv = cvd(c), cf = cmf(c, 20), sq = squeeze(c, 20, 2, 1.5), fv = fvg(c);

    return {
      last: i, close: cl[i],
      ema9: ema9[i], ema21: ema21[i], ema50: ema50[i], ema200: ema200[i],
      rsi: r[i], stochK: s.k[i], stochD: s.d[i],
      macd: m.line[i], macdSig: m.signal[i], macdHist: m.hist[i],
      bbU: bb.upper[i], bbL: bb.lower[i], bbMid: bb.mid[i], bbW: bb.width[i], bbPctB: bb.pctB[i],
      atr: a[i], atrPct: aPct,
      adx: x.adx[i], plusDI: x.plusDI[i], minusDI: x.minusDI[i],
      cci: ci[i], willr: wr[i],
      stDir: st.dir[i], stLine: st.line[i],
      tenkan: ich.conv[i], kijun: ich.base[i], spanA: ich.spanA[i], spanB: ich.spanB[i],
      obv: ob[i], obvPrev: ob[i - 5] ?? ob[i], roc: ro[i], cmo: cm[i],
      vwap: vw[i], vwapRoll: vws[i],
      cvdDelta: cv.delta[i], cvdCum: cv.cum[i],
      cvdRatio: c[i].volume > 0 ? (cv.delta[i] / c[i].volume) : 0,
      cmf: cf[i],
      sqOn: sq.on[i], sqHist: sq.hist[i],
      fvg: fv[i] || fv[i - 1] || null,
      vol: c[i].volume, volAvg: vsm[i],
      swHi, swLo,
      series: { ema9, ema21, ema50, ema200, bb, vwap: vw, st, ich, rsi: r, macd: m, atr: a, volSma: vsm, cvd: cv, cmf: cf },
      profile: volumeProfile(c, 40, 200),
      pivots: null,
    };
  }

  return {
    sma, ema, rma, wma, highest, lowest, rsi, macd, bollinger, stoch, cci, willr, roc, cmo,
    trueRange, atr, adx, supertrend, ichimoku, obv, vwapSession, vwapRolling, volSma,
    volumeProfile, pivots, swings, snapshot, closesOf, highsOf, lowsOf, volsOf,
    cvd, cmf, squeeze, fvg,
  };
})();
