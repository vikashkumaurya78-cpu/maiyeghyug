/* ══════════════════════════════════════════════════════════════
   core.js — constants, timeframe table, formatting, math helpers
   ══════════════════════════════════════════════════════════════ */
'use strict';

const CORE = (() => {

  /* Binance Futures symbol used for XAU/USDT */
  const SYMBOL = 'XAUUSDT';
  const DECIMALS = 2;           // tick size 0.01 on XAUUSDT
  const QTY_DECIMALS = 3;       // step size 0.001

  /* ── Timeframes ──────────────────────────────────────────────
     `kline:null` means Binance has no native interval for it.
     3h does not exist on Binance → it is aggregated from real
     1h candles (3 × 1h = 10800s), never invented.            */
  const TIMEFRAMES = [
    { id:'1m',  label:'1M',  seconds:60,     kline:'1m',  synth:null },
    { id:'3m',  label:'3M',  seconds:180,    kline:'3m',  synth:null },
    { id:'5m',  label:'5M',  seconds:300,    kline:'5m',  synth:null },
    { id:'15m', label:'15M', seconds:900,    kline:'15m', synth:null },
    { id:'30m', label:'30M', seconds:1800,   kline:'30m', synth:null },
    { id:'1h',  label:'1H',  seconds:3600,   kline:'1h',  synth:null },
    { id:'2h',  label:'2H',  seconds:7200,   kline:'2h',  synth:null },
    { id:'3h',  label:'3H',  seconds:10800,  kline:null,  synth:'1h' },
    { id:'4h',  label:'4H',  seconds:14400,  kline:'4h',  synth:null },
    { id:'6h',  label:'6H',  seconds:21600,  kline:'6h',  synth:null },
  ];
  const TF_MAP = Object.fromEntries(TIMEFRAMES.map(t => [t.id, t]));
  /* every interval that must be subscribed to on the socket */
  const NATIVE_TF = [...new Set(TIMEFRAMES.map(t => t.kline).filter(Boolean))];
  const HIGHER_OF = {};          // id -> id of the next larger timeframe
  TIMEFRAMES.forEach((t, i) => { HIGHER_OF[t.id] = i < TIMEFRAMES.length - 1 ? TIMEFRAMES[i + 1].id : null });
  const LOWER_OF = {};
  TIMEFRAMES.forEach((t, i) => { LOWER_OF[t.id] = i > 0 ? TIMEFRAMES[i - 1].id : null });

  const MIN = 60000, HOUR = 3600000, DAY = 86400000;

  /* ── numeric helpers ─────────────────────────────────────── */
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
  const round = (v, d = DECIMALS) => {
    if (!isNum(v)) return NaN;
    const f = Math.pow(10, d);
    return Math.round(v * f) / f;
  };
  /* round to exchange tick (0.01) in a given direction */
  const tickRound = (v, mode = 'round') => {
    if (!isNum(v)) return NaN;
    const t = 0.01;
    const n = mode === 'floor' ? Math.floor(v / t + 1e-9)
            : mode === 'ceil'  ? Math.ceil(v / t - 1e-9)
            : Math.round(v / t);
    return round(n * t, DECIMALS);
  };
  const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
  const sum = a => a.reduce((s, x) => s + x, 0);
  const last = a => a.length ? a[a.length - 1] : undefined;
  const sign = v => v > 0 ? 1 : v < 0 ? -1 : 0;

  /* ── formatting ──────────────────────────────────────────── */
  const fmt = (v, d = DECIMALS) => isNum(v) && v !== null && v !== undefined
    ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
    : '—';
  const fmtQty = v => isNum(v)
    ? v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 })
    : '—';
  const compact = v => isNum(v)
    ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v)
    : '—';
  const pct = (v, d = 2) => isNum(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) + '%' : '—';

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const hhmmss = ms => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` };
  const hhmm   = ms => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
  const hmsMs  = ms => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3,'0')}` };
  const usTime = ms => {
    /* microsecond-resolution LOCAL wall clock: ms from Date.now() +
       sub-millisecond remainder from the high-resolution timer.     */
    const whole = Math.floor(ms);
    const frac = Math.round((ms - whole) * 1000);
    return hmsMs(whole) + String(clamp(frac, 0, 999)).padStart(3, '0');
  };
  const dur = ms => {
    if (!isNum(ms) || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  };

  const dirClass = d => d === 'LONG' ? 'up' : d === 'SHORT' ? 'dn' : '';
  const biasClass = d => d;   /* LONG / SHORT / NEUTRAL */

  /* ── latency tracker ─────────────────────────────────────── */
  function Latency(cap = 240) {
    const buf = [];
    let count = 0, windowStart = performance.now(), rate = 0;
    return {
      push(ms) {
        if (!isNum(ms) || ms < 0) return;
        buf.push(ms); if (buf.length > cap) buf.shift();
        count++;
        const now = performance.now();
        if (now - windowStart >= 1000) { rate = count; count = 0; windowStart = now; }
      },
      get now() { return buf.length ? buf[buf.length - 1] : null },
      get p50() { if (!buf.length) return null; const s = [...buf].sort((a, b) => a - b); return s[Math.floor(s.length * .5)] },
      get p95() { if (!buf.length) return null; const s = [...buf].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * .95))] },
      get rate() { return rate },
      reset() { buf.length = 0; count = 0; rate = 0 },
    };
  }

  /* ── tiny DOM helpers ────────────────────────────────────── */
  const $  = id => document.getElementById(id);
  const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt !== undefined) n.textContent = txt; return n };

  /* ── event bus ───────────────────────────────────────────── */
  const bus = (() => {
    const map = new Map();
    return {
      on(k, fn) { (map.get(k) || map.set(k, []).get(k)).push(fn); return () => { const a = map.get(k) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) } },
      emit(k, v) { (map.get(k) || []).forEach(fn => { try { fn(v) } catch (e) { console.error('[bus]', k, e) } }) },
    };
  })();

  /* ── audio alert (WebAudio, no assets) ───────────────────── */
  let actx = null;
  function beep(kind = 'tick') {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const seq = kind === 'lock' ? [880, 1320, 1760] : kind === 'tp' ? [660, 990, 1470] : kind === 'stop' ? [300, 210] : [1046];
      seq.forEach((f, i) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = kind === 'stop' ? 'sawtooth' : 'square'; o.frequency.value = f;
        const t = actx.currentTime + i * 0.09;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.07, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
        o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + 0.15);
      });
    } catch (e) { /* audio blocked until user gesture — non fatal */ }
  }

  return {
    SYMBOL, DECIMALS, QTY_DECIMALS, TIMEFRAMES, TF_MAP, NATIVE_TF, HIGHER_OF, LOWER_OF,
    MIN, HOUR, DAY, isNum, clamp, round, tickRound, avg, sum, last, sign,
    fmt, fmtQty, compact, pct, pad, hhmmss, hhmm, hmsMs, usTime, dur,
    dirClass, biasClass, Latency, $, el, bus, beep,
  };
})();
