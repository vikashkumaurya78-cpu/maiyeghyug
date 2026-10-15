/* ══════════════════════════════════════════════════════════════
   engine.js — multi-timeframe signal engine + SIGNAL LOCK

   1. Every timeframe is scored continuously from 13 weighted
      factors derived from real Binance candles.
   2. A lock can only ARM when all 10 gates pass.
   3. Once armed the levels are frozen: entry, stop, three targets.
   4. The lock then tracks live price until target / stop / expiry.
   ══════════════════════════════════════════════════════════════ */
'use strict';

const ENGINE = (() => {
  const { TIMEFRAMES, TF_MAP, HIGHER_OF, isNum, clamp, round, tickRound, last, avg, bus, SYMBOL } = CORE;

  const LOCK_SCORE   = 58;   // |score| needed to arm
  const CONFIRM_BARS = 2;    // consecutive closed bars with the same bias
  const LOCK_BARS    = 8;    // lock lifetime in bars of its own timeframe
  const COOLDOWN     = 2;    // bars to wait after a lock resolves
  const WARMUP       = 210;  // closed bars required

  const WEIGHTS = [
    { key:'ema',     name:'EMA STACK',          detail:'9 / 21 / 50 alignment',        w:14 },
    { key:'trend',   name:'TREND POSITION',     detail:'Close vs EMA 200',              w:7  },
    { key:'cvd',     name:'ORDER FLOW DELTA',   detail:'Binance taker buy/sell ratio',  w:14 },
    { key:'cmf',     name:'CHAIKIN MONEY FLOW', detail:'Institutional accumulation CMF',w:8  },
    { key:'sq',      name:'SQUEEZE PRO',        detail:'Volatility squeeze breakout',   w:10 },
    { key:'fvg',     name:'FAIR VALUE GAP',     detail:'Smart money imbalance retest',  w:8  },
    { key:'rsi',     name:'RSI',                detail:'14 · scaled 50 centre',         w:10 },
    { key:'stoch',   name:'STOCHASTIC',         detail:'14 / 3 · %K vs %D',             w:7  },
    { key:'macd',    name:'MACD',               detail:'12/26/9 · histogram + cross',   w:10 },
    { key:'struct',  name:'MARKET STRUCTURE',   detail:'Swings / last pivot',           w:12 },
    { key:'dmi',     name:'DMI / ADX',          detail:'+DI vs −DI under ADX',          w:10 },
    { key:'bb',      name:'BOLLINGER %B',       detail:'20 / 2 band position',          w:6  },
    { key:'vol',     name:'VOLUME FLOW',        detail:'Volume ratio × body side',      w:8  },
    { key:'vwap',    name:'SESSION VWAP',       detail:'Price vs anchored VWAP',        w:7  },
    { key:'super',   name:'SUPERTREND',         detail:'10 / 3 trailing flip',          w:7  },
    { key:'ich',     name:'ICHIMOKU',           detail:'Tenkan / Kijun / Kumo',         w:6  },
    { key:'mom',     name:'MOMENTUM',           detail:'CMO 14 + ROC 12',               w:6  },
  ];
  const TOTAL_W = WEIGHTS.reduce((s, f) => s + f.w, 0);

  const state = Object.fromEntries(TIMEFRAMES.map(t => [t.id, {
    bias: 'NEUTRAL', score: 0, factors: [], confirm: 0, snap: null,
    lock: null, history: [], cooldown: 0, lastEval: 0, lastClosed: 0,
    medAtrPct: null, err: null, version: -1,
  }]));

  let globalHistory = [];
  let lockSeq = 0;
  let composite = { score: 0, bias: 'NEUTRAL', agree: 0, oppose: 0, higher: 0 };

  /* ── factor scoring ──────────────────────────────────────── */
  const sgn = (v, d) => { const s = v / d; return clamp(s, -1, 1) };
  const band = (v, lo, hi) => v >= hi ? 1 : v <= lo ? -1 : 0;

  function score(candles) {
    const s = TA.snapshot(candles);
    if (!s) return null;
    const F = {};
    const emaAlign = (() => {
      if (!isNum(s.ema9) || !isNum(s.ema21) || !isNum(s.ema50)) return 0;
      const ordered = s.ema9 > s.ema21 && s.ema21 > s.ema50 ? 1 : s.ema9 < s.ema21 && s.ema21 < s.ema50 ? -1 : 0;
      const sep = Math.abs(s.ema9 - s.ema50) / (s.atr || 1);
      return clamp(ordered * clamp(sep / 0.9, 0.3, 1.2), -1, 1);
    })();
    F.ema = emaAlign;
    F.trend = isNum(s.ema200) && s.atr ? sgn(s.close - s.ema200, s.atr * 2.2) : 0;
    F.cvd = isNum(s.cvdRatio) ? clamp(s.cvdRatio / 0.18, -1, 1) : 0;
    F.cmf = isNum(s.cmf) ? clamp(s.cmf / 0.12, -1, 1) : 0;
    F.sq = isNum(s.sqHist) && s.atr ? clamp(s.sqHist / (s.atr * 0.4), -1, 1) : 0;
    F.fvg = s.fvg ? (s.fvg.type === 'BULLISH' ? 0.8 : -0.8) : 0;
    F.rsi = isNum(s.rsi) ? clamp((s.rsi - 50) / 13, -1, 1) : 0;
    F.stoch = (() => {
      if (!isNum(s.stochK) || !isNum(s.stochD)) return 0;
      const cross = clamp((s.stochK - s.stochD) / 12, -1, 1);
      const zone = s.stochK > 80 ? -0.5 : s.stochK < 20 ? 0.5 : 0;
      return clamp(cross + zone * 0.6, -1, 1);
    })();
    F.macd = (() => {
      if (!isNum(s.macdHist) || !isNum(s.atr)) return 0;
      const h = clamp(s.macdHist / (s.atr * 0.16), -1, 1);
      const x = s.macd > s.macdSig ? 0.35 : -0.35;
      return clamp(h + x * Math.min(1, Math.abs(s.macdHist) / (s.atr * 0.06) || 0), -1, 1);
    })();
    F.struct = (() => {
      const { swHi, swLo } = s;
      if (!isNum(swHi) || !isNum(swLo) || !isNum(s.atr)) return 0;
      const range = swHi - swLo;
      if (range <= 0) return 0;
      const pos = clamp((s.close - swLo) / range, 0, 1) * 2 - 1;
      const near = range / s.atr;
      return clamp(pos * clamp(near / 1.4, 0.35, 1.3), -1, 1);
    })();
    F.dmi = (() => {
      if (!isNum(s.plusDI) || !isNum(s.minusDI)) return 0;
      const diff = clamp((s.plusDI - s.minusDI) / 28, -1, 1);
      const strength = isNum(s.adx) ? clamp(s.adx / 25, 0.4, 1.3) : 0.6;
      return clamp(diff * strength, -1, 1);
    })();
    F.bb = isNum(s.bbPctB) ? clamp((s.bbPctB - 0.5) * 1.7, -1, 1) : 0;
    F.vol = (() => {
      if (!isNum(s.volAvg) || s.volAvg <= 0) return 0;
      const ratio = s.vol / s.volAvg;
      const body = s.close >= candles[candles.length - 1].open ? 1 : -1;
      const conf = clamp((ratio - 0.75) / 0.8, -0.4, 1);
      return clamp(body * conf * (ratio > 1 ? 1 : 0.55), -1, 1);
    })();
    F.vwap = isNum(s.vwap) && s.atr ? sgn(s.close - s.vwap, s.atr * 0.9) : 0;
    F.super = isNum(s.stDir) ? s.stDir : 0;
    F.ich = (() => {
      if (!isNum(s.tenkan) || !isNum(s.kijun) || !isNum(s.spanB)) return 0;
      let v = 0;
      if (s.tenkan > s.kijun) v += 0.5; else if (s.tenkan < s.kijun) v -= 0.5;
      if (s.close > s.spanB) v += 0.5; else if (s.close < s.spanB) v -= 0.5;
      return clamp(v, -1, 1);
    })();
    F.mom = (() => {
      const a = isNum(s.cmo) ? clamp(s.cmo / 55, -1, 1) : 0;
      const b = isNum(s.roc) ? clamp(s.roc / 0.35, -1, 1) * 0.5 : 0;
      return clamp(a + b * 0.5, -1, 1);
    })();

    const factors = WEIGHTS.map(f => ({ key: f.key, name: f.name, detail: f.detail, w: f.w, strength: F[f.key] ?? 0,
      direction: F[f.key] > 0.12 ? 'LONG' : F[f.key] < -0.12 ? 'SHORT' : 'NEUTRAL' }));
    const raw = factors.reduce((sum, f) => sum + f.w * f.strength, 0);
    const scoreV = clamp(raw / TOTAL_W * 100, -100, 100);
    return { snap: s, factors, score: scoreV };
  }

  /* ── gate evaluation ─────────────────────────────────────── */
  function gates(tf, ctx) {
    const st = state[tf], cfg = TF_MAP[tf];
    const series = FEED.getSeries(tf);
    const closed = series.filter(c => c.confirmed);
    const higherIds = [];
    for (let id = HIGHER_OF[tf]; id; id = HIGHER_OF[id]) higherIds.push(id);
    const others = higherIds.map(id => state[id]).filter(x => x && x.snap);
    const agreeN = ctx.dir === 'LONG' ? others.filter(o => o.bias === 'LONG').length : ctx.dir === 'SHORT' ? others.filter(o => o.bias === 'SHORT').length : 0;
    const opposeN = ctx.dir === 'LONG' ? others.filter(o => o.bias === 'SHORT').length : ctx.dir === 'SHORT' ? others.filter(o => o.bias === 'LONG').length : 0;
    const opposing = ctx.dir === 'NEUTRAL' ? true : opposeN > 0 && agreeN <= opposeN;

    const q = FEED.state.quote, book = FEED.state.book;
    const spread = q ? q.ask - q.bid : null;
    const atr = ctx.snap?.atr;
    const spreadOk = spread !== null && isNum(atr) && spread > 0 && spread <= atr * 0.06;
    const stale = !isNum(ctx.lastCloseAge) || ctx.lastCloseAge > cfg.seconds * 1000 * 2 + 25000;
    const volRegime = ctx.medAtrPct ? (ctx.snap.atrPct >= ctx.medAtrPct * 0.45 && ctx.snap.atrPct <= ctx.medAtrPct * 2.6) : true;
    const conflicting = ctx.dir === 'NEUTRAL' ? 0
      : ctx.factors.filter(f => Math.abs(f.strength) >= 0.45 && f.direction !== ctx.dir).length;
    const highVol = ctx.snap && ctx.snap.volAvg ? ctx.snap.vol / ctx.snap.volAvg : 1;
    const htfDetail = ctx.dir === 'NEUTRAL' ? 'needs bias first' : (higherIds.length ? `▲${agreeN} ▼${opposeN}` : 'top TF');
    const requiredWarmup = (tf === '4h' || tf === '6h') ? 40 : (tf === '2h' || tf === '3h') ? 50 : (tf === '1h') ? 70 : 100;
    const depthOk = closed.length >= requiredWarmup;

    return [
      { id:'feed',    label:'Live Binance feed',        ok: (FEED.status().futWs || FEED.status().restOk) && !stale, detail: stale ? 'stale candle' : FEED.status().futWs ? 'streaming' : 'REST polling', hot: stale },
      { id:'bars',    label:'History depth',            ok: depthOk, detail: `${closed.length}/${requiredWarmup}` },
      { id:'score',   label:`Engine score ≥ ${LOCK_SCORE}`, ok: Math.abs(ctx.score) >= LOCK_SCORE, detail: ctx.score.toFixed(1) },
      { id:'confirm', label:`${CONFIRM_BARS} closed-bar confirm`, ok: ctx.confirm >= CONFIRM_BARS, detail: `${ctx.confirm}/${CONFIRM_BARS}` },
      { id:'dir',     label:'Directional consensus',    ok: ctx.dir !== 'NEUTRAL', detail: ctx.dir },
      { id:'htf',     label:'Higher-TF filter',         ok: !opposing, detail: htfDetail, hot: opposing },
      { id:'adx',     label:'Trend strength ADX ≥ 18',  ok: isNum(ctx.snap?.adx) && ctx.snap.adx >= 18, detail: ctx.snap?.adx ? ctx.snap.adx.toFixed(1) : '—' },
      { id:'conflict',label:'Opposing factors ≤ 1',     ok: conflicting <= 1, detail: `${conflicting}` },
      { id:'volreg',  label:'Volatility regime sane',   ok: volRegime, detail: ctx.snap?.atrPct ? ctx.snap.atrPct.toFixed(3) + '%' : '—' },
      { id:'spread',  label:'Spread within 6% of ATR',  ok: spreadOk, detail: spread !== null ? spread.toFixed(2) : '—' },
      { id:'volume',  label:'Volume confirmation',      ok: highVol >= 0.9, detail: `${highVol.toFixed(2)}×`, hot: highVol >= 1.3 },
      { id:'slot',    label:'Lock slot free',           ok: !st.lock && st.cooldown <= 0, detail: st.lock ? 'occupied' : st.cooldown > 0 ? `cool ${st.cooldown}` : 'free' },
    ];
  }

  /* ── build a frozen lock ─────────────────────────────────── */
  function buildLock(tf, dir, ctx, forced = false) {
    const cfg = TF_MAP[tf], f = FEED.state.filters;
    const c = ctx.snap.close, a = ctx.snap.atr;
    const q = FEED.state.quote;
    const mark = q ? (q.bid + q.ask) / 2 : c;
    const price = isNum(mark) && Math.abs(mark - c) < a * 3 ? mark : c;
    const tick = f.tickSize || 0.01;
    const long = dir === 'LONG';

    /* entry zone: pull back into the nearest structural level */
    const structLvl = isNum(ctx.snap.ema9) && Math.abs(ctx.snap.ema9 - price) < a * 1.6
      ? ctx.snap.ema9
      : (isNum(ctx.snap.vwap) && Math.abs(ctx.snap.vwap - price) < a * 1.6 ? ctx.snap.vwap : price - long ? 0 : 0);
    const base = isNum(structLvl) ? structLvl : price;
    let zoneLow, zoneHigh;
    if (long) {
      zoneLow  = tickRound(Math.max(base, price - a * 0.85), 'floor');
      zoneHigh = tickRound(Math.max(zoneLow + tick * 3, price - a * 0.12), 'ceil');
      if (zoneHigh > price) zoneHigh = tickRound(price, 'ceil');
      if (zoneLow > zoneHigh) zoneLow = tickRound(zoneHigh - a * 0.5, 'floor');
    } else {
      zoneHigh = tickRound(Math.min(base, price + a * 0.85), 'ceil');
      zoneLow  = tickRound(Math.min(zoneHigh - tick * 3, price + a * 0.12), 'floor');
      if (zoneLow < price) zoneLow = tickRound(price, 'floor');
      if (zoneLow > zoneHigh) zoneHigh = tickRound(zoneLow + a * 0.5, 'ceil');
    }
    const entry = tickRound((zoneLow + zoneHigh) / 2);

    /* stop beyond the last 5-bar structure plus volatility buffer */
    const recent = FEED.getSeries(tf).slice(-6, -1);
    let stop;
    if (long) {
      const sw = recent.length ? Math.min(...recent.map(x => x.low)) : price - a;
      stop = tickRound(Math.min(entry - a * 1.15, sw - a * 0.35), 'floor');
    } else {
      const sw = recent.length ? Math.max(...recent.map(x => x.high)) : price + a;
      stop = tickRound(Math.max(entry + a * 1.15, sw + a * 0.35), 'ceil');
    }
    let risk = Math.abs(entry - stop);
    if (risk < a * 0.6) { stop = tickRound(long ? entry - a * 0.9 : entry + a * 0.9, long ? 'floor' : 'ceil'); risk = Math.abs(entry - stop) }
    if (risk > a * 3)   { stop = tickRound(long ? entry - a * 2.2 : entry + a * 2.2, long ? 'floor' : 'ceil'); risk = Math.abs(entry - stop) }
    risk = Math.abs(entry - stop);
    if (risk <= 0 || !isNum(risk)) return null;

    const sgn_ = long ? 1 : -1;
    const tp1 = tickRound(entry + sgn_ * risk * 1.5);
    const tp2 = tickRound(entry + sgn_ * risk * 2.5);
    const tp3 = tickRound(entry + sgn_ * risk * 4.0);

    /* confidence — transparent weighted build-up to 100% full confidence */
    const parts = [];
    let conf = Math.min(64, Math.abs(ctx.score));
    parts.push(`Base score ${ctx.score.toFixed(1)} → base ${conf.toFixed(0)}%`);
    const htf = gates(tf, ctx).find(g => g.id === 'htf');
    if (htf.ok && htf.detail !== 'top TF') { conf += 12; parts.push('All higher timeframes aligned +12%') }
    else if (htf.ok) { conf += 6; parts.push('Top of measured structure +6%') }
    if (ctx.confirm >= CONFIRM_BARS + 1) { conf += 6; parts.push(`${ctx.confirm} consecutive confirming closes +6%`) }
    if (isNum(ctx.snap.cvdRatio) && (long ? ctx.snap.cvdRatio > 0.08 : ctx.snap.cvdRatio < -0.08)) { conf += 8; parts.push('Order Flow CVD dominance confirmed +8%') }
    if (isNum(ctx.snap.cmf) && (long ? ctx.snap.cmf > 0.05 : ctx.snap.cmf < -0.05)) { conf += 6; parts.push('Institutional accumulation CMF aligned +6%') }
    if (ctx.snap.sqHist && (long ? ctx.snap.sqHist > 0 : ctx.snap.sqHist < 0)) { conf += 5; parts.push('TTM Squeeze momentum expansion +5%') }
    if (ctx.snap.fvg && ((long && ctx.snap.fvg.type === 'BULLISH') || (!long && ctx.snap.fvg.type === 'BEARISH'))) { conf += 5; parts.push('Smart Money FVG confluence +5%') }
    if (ctx.snap.volAvg && ctx.snap.vol / ctx.snap.volAvg >= 1.2) { conf += 4; parts.push('Volume surge validates scalp +4%') }
    if (ctx.medAtrPct && ctx.snap.atrPct >= ctx.medAtrPct * 0.7 && ctx.snap.atrPct <= ctx.medAtrPct * 1.8) { conf += 4; parts.push('Volatility regime optimal +4%') }
    const sp = q ? q.ask - q.bid : null;
    if (sp !== null && sp <= a * 0.03) { conf += 4; parts.push(`Tight spread ${sp.toFixed(2)} +4%`) }
    if (isNum(ctx.snap.adx) && ctx.snap.adx >= 25) { conf += 5; parts.push(`ADX ${ctx.snap.adx.toFixed(0)} strong trend +5%`) }
    const oppose = gates(tf, ctx).filter(g => ['htf', 'conflict', 'volume', 'spread'].includes(g.id) && !g.ok);
    oppose.forEach(g => { conf -= g.id === 'htf' ? 8 : g.id === 'conflict' ? 5 : 3; parts.push(`${g.label} failed`) });
    if (forced) { conf = Math.max(conf, 96); parts.push('100% Full Confidence Execution armed by operator'); }
    conf = clamp(Math.round(conf), 20, 100);

    const lockedAt = FEED.now();
    const expires = lockedAt + LOCK_BARS * cfg.seconds * 1000;
    const why = [
      `${cfg.label} bias <b>${dir}</b> · composite score <b>${ctx.score.toFixed(1)}</b>`,
      `Order Flow: CVD ${ctx.snap.cvdDelta > 0 ? '+' : ''}${ctx.snap.cvdDelta?.toFixed(1)} · CMF ${(ctx.snap.cmf ?? 0).toFixed(2)}`,
      `EMA stack ${ctx.snap.ema9?.toFixed(2)} / ${ctx.snap.ema21?.toFixed(2)} / ${ctx.snap.ema50?.toFixed(2)}`,
      `RSI ${ctx.snap.rsi?.toFixed(1)} · ADX ${ctx.snap.adx?.toFixed(1)} · Squeeze ${ctx.snap.sqOn ? 'COMPRESSED' : 'EXPANDING'}`,
      `MACD histogram ${ctx.snap.macdHist >= 0 ? '+' : ''}${ctx.snap.macdHist?.toFixed(3)}`,
      `Stop beyond ${recent.length}-bar structure · ATR ${a.toFixed(2)} (${ctx.snap.atrPct?.toFixed(3)}%)`,
      `Targets: TP1 1.5R / TP2 2.5R / TP3 4.0R (1 : 4.0 Max R:R)`,
      `Spread ${(sp ?? 0).toFixed(2)} · latency p95 ${FEED.status().latency.p95 ?? '—'}ms`,
    ];
    const top = [...ctx.factors].sort((x, y) => Math.abs(y.strength) * y.w - Math.abs(x.strength) * x.w).slice(0, 5);
    top.forEach(ft => { if (ft.direction !== 'NEUTRAL') why.push(`${ft.name} → <b>${ft.direction}</b> (${(ft.strength * 100).toFixed(0)}%)`) });

    return {
      id: `L${String(++lockSeq).padStart(3, '0')}-${SYMBOL}-${cfg.label}`,
      tf, dir, entry, zoneLow, zoneHigh, stop, tp1, tp2, tp3, risk,
      rr1: 1.5, rr2: 2.5, rr3: 4.0,
      priceAtLock: price, confidence: conf, confParts: parts,
      score: ctx.score, confirm: ctx.confirm, factors: ctx.factors, why,
      lockedAt, expires, status: 'ACTIVE', statusAt: lockedAt, exitPrice: null,
      progress: 0, maxR: 0, forced,
    };
  }

  /* ── track a live lock ───────────────────────────────────── */
  function track(lock, live, series) {
    if (lock.status !== 'ACTIVE') return false;
    const long = lock.dir === 'LONG';
    const highs = [], lows = [];
    for (const c of series) { if (c.time >= lock.lockedAt - TF_MAP[lock.tf].seconds * 1000) { highs.push(c.high); lows.push(c.low) } }
    const hi = Math.max(live ?? -Infinity, ...highs);
    const lo = Math.min(live ?? Infinity, ...lows);
    const touched = {
      tp1: long ? hi >= lock.tp1 : lo <= lock.tp1,
      tp2: long ? hi >= lock.tp2 : lo <= lock.tp2,
      tp3: long ? hi >= lock.tp3 : lo <= lock.tp3,
      stop: long ? lo <= lock.stop : hi >= lock.stop,
    };
    const rOf = p => (long ? p - lock.entry : lock.entry - p) / lock.risk;
    const openR = live != null ? rOf(live) : 0;
    lock.maxR = Math.max(lock.maxR, touched.tp1 ? Math.max(1.5, lock.maxR) : lock.maxR, isNum(openR) ? openR : 0);

    let changed = null;
    if (touched.stop && !touched.tp1) {
      lock.status = 'STOPPED'; lock.exitPrice = lock.stop; changed = { type: 'STOP' };
    } else if (touched.stop && touched.tp1) {
      lock.status = 'STOPPED'; lock.exitPrice = lock.stop; changed = { type: 'STOP', be: true };
    } else if (touched.tp3) { lock.status = 'TP3 HIT'; lock.exitPrice = lock.tp3; changed = { type: 'TP', level: 3 } }
    else if (touched.tp2 && lock.status !== 'TP2 HIT' && lock.status !== 'TP1 HIT') { lock.status = 'TP2 HIT'; lock.exitPrice = lock.tp2; changed = { type: 'TP', level: 2 } }
    else if (touched.tp1 && lock.status === 'ACTIVE') { lock.status = 'TP1 HIT'; lock.exitPrice = lock.tp1; changed = { type: 'TP', level: 1 } }

    if (lock.status === 'ACTIVE' && FEED.now() >= lock.expires) {
      lock.status = 'EXPIRED'; lock.exitPrice = live ?? lock.priceAtLock; changed = { type: 'EXP' };
    }
    lock.progress = clamp(rOf(live ?? lock.entry), -1.2, 4.5);
    lock.liveR = isNum(openR) ? openR : 0;
    if (changed) { lock.statusAt = FEED.now(); lock.pnlR = rOf(lock.exitPrice); return changed }
    return false;
  }

  /* ── main evaluation pass ────────────────────────────────── */
  function evaluate(tf, { force = false } = {}) {
    const st = state[tf];
    const series = FEED.getSeries(tf);
    if (series.length < 40) { st.err = 'loading'; return st }

    const now = FEED.now();
    const key = `${series.length}:${last(series)?.close}:${last(series)?.time}`;
    if (!force && key === st.version && now - st.lastEval < 1200) return st;
    st.version = key; st.lastEval = now;

    const r = score(series.slice(-320));
    if (!r) return st;
    st.snap = r.snap; st.factors = r.factors; st.score = r.score;
    st.bias = r.score >= 22 ? 'LONG' : r.score <= -22 ? 'SHORT' : 'NEUTRAL';

    /* median volatility for the regime gate */
    const atrS = r.snap.series.atr;
    const pctList = [];
    for (let i = Math.max(14, atrS.length - 120); i < atrS.length; i++) {
      if (atrS[i] !== null && series[series.length - atrS.length + i]) {
        const c = series[series.length - atrS.length + i];
        if (c.close > 0) pctList.push(atrS[i] / c.close * 100);
      }
    }
    if (pctList.length > 10) { const srt = [...pctList].sort((a, b) => a - b); st.medAtrPct = srt[Math.floor(srt.length / 2)] }

    /* confirmations counted on CLOSED bars only */
    const closed = series.filter(c => c.confirmed);
    const closedScore = closed.length > 250 ? score(closed.slice(-320)) : null;
    const ref = closedScore ? closedScore.score : r.score;
    const refBias = ref >= 22 ? 'LONG' : ref <= -22 ? 'SHORT' : 'NEUTRAL';
    const prev = st.lastRefBias;
    if (refBias !== 'NEUTRAL' && refBias === prev) st.confirm = Math.min(9, st.confirm + 0);  // counted below on close
    st.lastRefBias = refBias;

    st.lastClosed = closed.length ? last(closed).time : 0;
    st.lastCloseAge = st.lastClosed ? now - (st.lastClosed + TF_MAP[tf].seconds * 1000) : 0;
    st.closedRefBias = refBias;

    /* progress confirmations only when a new closed bar appears */
    const closedKey = st.lastClosed;
    if (closedKey !== st.markClosed) {
      st.markClosed = closedKey;
      if (refBias !== 'NEUTRAL' && refBias === st.prevClosedBias) st.confirm = Math.min(9, st.confirm + 1);
      else st.confirm = refBias === 'NEUTRAL' ? 0 : 1;
      st.prevClosedBias = refBias;
      if (st.cooldown > 0) st.cooldown--;
    }

    /* ── arm / maintain / resolve the lock ── */
    const live = FEED.state.quote?.bid ? (FEED.state.quote.bid + FEED.state.quote.ask) / 2 : null;

    if (st.lock) {
      const ev = track(st.lock, live, series);
      if (ev) {
        resolveLock(st, ev, live);
      }
    } else if (st.cooldown <= 0) {
      const dir = st.bias;
      const ctx = { score: r.score, factors: r.factors, snap: r.snap, confirm: st.confirm, dir, medAtrPct: st.medAtrPct, lastCloseAge: st.lastCloseAge };
      const gs = gates(tf, ctx);
      const allOk = gs.every(g => g.ok);
      st.gates = gs;
      if (allOk && dir !== 'NEUTRAL') {
        const lock = buildLock(tf, dir, ctx);
        if (lock) arm(st, lock);
      } else st.pending = gs;
    }

    if (st.lock) {
      const ctx = { score: r.score, factors: r.factors, snap: r.snap, confirm: st.confirm, dir: st.lock.dir, medAtrPct: st.medAtrPct, lastCloseAge: st.lastCloseAge };
      st.gates = gates(tf, ctx);
      st.pending = null;
    }
    return st;
  }

  function arm(st, lock) {
    st.lock = lock; st.cooldown = COOLDOWN;
    globalHistory.unshift(lock);
    if (globalHistory.length > 60) globalHistory.pop();
    bus.emit('lock', lock);
    bus.emit('log', { kind: 'LOCK', title: `${lock.tf.toUpperCase()} LOCK ARMED`,
      detail: `<b>${lock.dir}</b> entry <b>${lock.entry.toFixed(2)}</b> · SL <b>${lock.stop.toFixed(2)}</b> · TP1 ${lock.tp1.toFixed(2)} · confidence <b>${lock.confidence.toFixed(0)}%</b>` });
    CORE.beep('lock');
    bus.emit('lock-fired', lock);
  }

  function resolveLock(st, ev, live) {
    const lock = st.lock;
    lock.resolved = true;
    st.history.unshift(lock);
    if (st.history.length > 20) st.history.pop();
    st.lastResolved = { at: FEED.now(), type: ev.type, lock };
    st.lock = null;
    st.confirm = 0;
    const r = lock.pnlR ?? 0;
    if (ev.type === 'TP') {
      bus.emit('log', { kind: 'TP', title: `TARGET ${ev.level} · ${lock.tf.toUpperCase()}`,
        detail: `<b>${lock.dir}</b> reached <b>${lock.exitPrice.toFixed(2)}</b> for <b>${r >= 0 ? '+' : ''}${r.toFixed(2)}R</b>${ev.be ? ' · stop protected' : ''}` });
      CORE.beep('tp');
    } else if (ev.type === 'STOP') {
      bus.emit('log', { kind: 'STOP', title: `STOPPED · ${lock.tf.toUpperCase()}`,
        detail: `<b>${lock.dir}</b> exited at <b>${lock.stop.toFixed(2)}</b> for <b>${r.toFixed(2)}R</b>` });
      CORE.beep('stop');
    } else {
      bus.emit('log', { kind: 'SYS', title: `LOCK EXPIRED · ${lock.tf.toUpperCase()}`,
        detail: `<b>${lock.dir}</b> expired after ${TF_MAP[lock.tf].label} timeout` });
    }
    bus.emit('lock-resolved', lock);
  }

  /* ── operator controls ───────────────────────────────────── */
  function forceLock(tf) {
    const st = state[tf];
    if (st.lock) return { ok: false, why: 'A lock is already active on this timeframe' };
    const series = FEED.getSeries(tf);
    if (series.length < 60) return { ok: false, why: 'Not enough history yet' };
    const r = score(series.slice(-320));
    if (!r) return { ok: false, why: 'Engine not ready' };
    const ctx = { score: r.score, factors: r.factors, snap: r.snap, confirm: st.confirm, dir: st.bias === 'NEUTRAL' ? (r.score >= 0 ? 'LONG' : 'SHORT') : st.bias, medAtrPct: st.medAtrPct, lastCloseAge: st.lastCloseAge };
    if (ctx.dir === 'NEUTRAL') return { ok: false, why: 'Bias is neutral' };
    const lock = buildLock(tf, ctx.dir, ctx, true);
    if (!lock) return { ok: false, why: 'Could not price the levels' };
    st.cooldown = 0;
    arm(st, lock);
    return { ok: true, lock };
  }

  function release(tf, reason = 'operator') {
    const st = state[tf];
    if (!st.lock) return false;
    st.lock.status = 'RELEASED'; st.lock.exitPrice = FEED.state.quote?.bid ?? st.lock.priceAtLock;
    st.lock.pnlR = (st.lock.dir === 'LONG' ? st.lock.exitPrice - st.lock.entry : st.lock.entry - st.lock.exitPrice) / st.lock.risk;
    st.lock.resolved = true;
    st.history.unshift(st.lock);
    st.lastResolved = { at: FEED.now(), type: 'REL', lock: st.lock };
    bus.emit('log', { kind: 'SYS', title: `LOCK RELEASED · ${tf.toUpperCase()}`, detail: `Released by <b>${reason}</b> at ${(st.lock.exitPrice).toFixed(2)}` });
    st.lock = null; st.confirm = 0;
    bus.emit('lock-resolved', st.lastResolved.lock);
    return true;
  }

  /* ── cross-timeframe composite ───────────────────────────── */
  function computeComposite() {
    const wts = { '1m':1, '3m':1, '5m':1.3, '15m':1.7, '30m':2.0, '1h':2.4, '2h':2.6, '3h':2.8, '4h':3.2, '6h':3.6 };
    let num = 0, den = 0, agree = 0, oppose = 0, higher = 0;
    TIMEFRAMES.forEach(t => {
      const s = state[t.id];
      if (!s.snap) return;
      num += (wts[t.id] || 1) * s.score; den += (wts[t.id] || 1);
    });
    const main = ['5m', '15m', '30m', '1h', '4h', '6h'].map(id => state[id]).filter(s => s.snap);
    main.forEach(s => { if (s.bias === 'LONG') agree++; else if (s.bias === 'SHORT') oppose++ });
    higher = ['1h', '2h', '3h', '4h', '6h'].map(id => state[id]).filter(s => s.snap && s.bias !== 'NEUTRAL');
    composite = {
      score: den ? num / den : 0,
      bias: (den ? num / den : 0) >= 18 ? 'LONG' : (den ? num / den : 0) <= -18 ? 'SHORT' : 'NEUTRAL',
      agree, oppose, htfLong: higher.filter(s => s.bias === 'LONG').length, htfShort: higher.filter(s => s.bias === 'SHORT').length,
    };
    return composite;
  }

  function evaluateAll() { TIMEFRAMES.forEach(t => evaluate(t.id)); computeComposite() }

  return {
    LOCK_SCORE, CONFIRM_BARS, LOCK_BARS, WEIGHTS, TOTAL_W,
    state, get: tf => state[tf], gates: (tf, ctx) => gates(tf, ctx),
    score, evaluate, evaluateAll, forceLock, release, computeComposite,
    get composite() { return composite },
    get history() { return globalHistory },
  };
})();
