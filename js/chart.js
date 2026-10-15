/* ══════════════════════════════════════════════════════════════
   chart.js — dependency-free canvas chart
   candles · overlays · Signal-Lock levels · profile · crosshair
   ══════════════════════════════════════════════════════════════ */
'use strict';

const CHART = (() => {
  const { isNum, clamp, fmt, hhmmss, hhmm, dur, tickRound, TF_MAP, pad } = CORE;

  const C = {
    bg: '#080b10', grid: '#111823', gridStrong: '#182130',
    axis: '#5c6a7d', text: '#c9d3e0',
    up: '#17c98c', dn: '#ff4d6a', flat: '#7b8798',
    amber: '#f0a020', amber2: '#ffc358', info: '#3fa9f5', purple: '#a97bff',
    e9: '#f0a020', e21: '#3fa9f5', e50: '#a97bff', e200: '#8695a8',
    zone: 'rgba(63,169,245,.14)', lockLine: '#3fa9f5',
  };

  const OVERLAYS = [
    { id: 'ema',    label: 'EMA 9/21/50/200', on: true },
    { id: 'bb',     label: 'BOLL',            on: true },
    { id: 'vwap',   label: 'VWAP',            on: true },
    { id: 'super',  label: 'ST',              on: false },
    { id: 'ichi',   label: 'ICHIMOKU',        on: false },
    { id: 'pivot',  label: 'PIVOTS',          on: true },
    { id: 'profile',label: 'VOLUME PROF',     on: false },
    { id: 'levels', label: 'LOCK LEVELS',     on: true },
  ];
  const ovOn = id => (OVERLAYS.find(o => o.id === id) || {}).on;

  let wrap, main, fx, ctx, fctx, W = 0, H = 0, dpr = 1;
  let candles = [], snap = null, lock = null, pivots = null;
  let view = { count: 140, right: 0 };
  let hover = null, dirty = true, fxd = true;
  let tf = '1m';
  let subs = [];
  const PRICE_W = 68, AXIS_H = 18, PAD_T = 8;

  /* ── layout helpers ──────────────────────────────────────── */
  function sizeOf(c) {
    const r = c.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(80, Math.floor(r.width)), h = Math.max(60, Math.floor(r.height));
    if (c.width !== Math.floor(w * dpr) || c.height !== Math.floor(h * dpr)) {
      c.width = Math.floor(w * dpr); c.height = Math.floor(h * dpr);
    }
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h, x };
  }

  let plot = { l: 0, t: 0, w: 0, h: 0 };
  let range = { lo: 0, hi: 1 };
  let startIndex = 0, endIndex = 0, barW = 8;

  function layout() {
    const a = sizeOf(main); W = a.w; H = a.h; ctx = a.x;
    plot.l = 4; plot.t = PAD_T; plot.w = Math.max(40, W - PRICE_W - plot.l); plot.h = Math.max(40, H - AXIS_H - plot.t);
    const n = candles.length;
    view.count = clamp(Math.floor(view.count), 20, Math.min(500, Math.max(20, n)));
    view.right = clamp(view.right, 0, Math.max(0, n - Math.floor(view.count * 0.35)));
    endIndex = n - 1 - view.right;
    startIndex = Math.max(0, endIndex - view.count + 1);
    if (endIndex < 0) { startIndex = 0; endIndex = 0 }
    barW = plot.w / view.count;
  }

  function priceRange() {
    let lo = Infinity, hi = -Infinity;
    for (let i = startIndex; i <= endIndex && i < candles.length; i++) {
      const c = candles[i]; if (!c) continue;
      lo = Math.min(lo, c.low); hi = Math.max(hi, c.high);
      if (ovOn('bb') && snap?.series?.bb) {
        const u = snap.series.bb.upper[i], l = snap.series.bb.lower[i];
        if (u) hi = Math.max(hi, u); if (l) lo = Math.min(lo, l);
      }
      if (ovOn('ema') && snap?.series) {
        ['ema9', 'ema21', 'ema50', 'ema200'].forEach(k => { const v = snap.series[k]?.[i]; if (v) { lo = Math.min(lo, v); hi = Math.max(hi, v) } });
      }
      if (ovOn('vwap')) { const v = snap?.series?.vwap?.[i]; if (v) { lo = Math.min(lo, v); hi = Math.max(hi, v) } }
      if (ovOn('super')) { const v = snap?.series?.st?.line?.[i]; if (v) { lo = Math.min(lo, v); hi = Math.max(hi, v) } }
    }
    if (lock && ovOn('levels')) {
      lo = Math.min(lo, lock.stop, lock.zoneLow); hi = Math.max(hi, lock.stop, lock.zoneHigh, lock.tp3);
    }
    if (!isNum(lo) || !isNum(hi) || hi <= lo) { const p = candles.length ? candles[candles.length - 1].close : 100; lo = p * 0.999; hi = p * 1.001 }
    const pad = (hi - lo) * 0.08 || 1;
    range = { lo: lo - pad, hi: hi + pad };
  }

  const y = p => plot.t + (range.hi - p) / (range.hi - range.lo) * plot.h;
  const x = i => plot.l + (i - startIndex + 0.5) * barW;
  const priceAt = py => range.hi - (py - plot.t) / plot.h * (range.hi - range.lo);

  /* ── main draw ───────────────────────────────────────────── */
  function draw() {
    if (!ctx) return;
    layout(); priceRange();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    if (!candles.length) return;

    drawGrid();
    if (ovOn('profile')) drawProfile();
    if (ovOn('ichi') && snap) drawIchi();
    if (ovOn('bb') && snap) drawBB();
    drawVolume(false);
    drawCandles();
    if (ovOn('ema') && snap) drawEMA();
    if (ovOn('vwap') && snap) drawVWAP();
    if (ovOn('super') && snap) drawSuper();
    if (ovOn('pivot') && pivots) drawPivots();
    if (ovOn('levels') && lock) drawLevels();
    drawLastPrice();
    drawAxis();
    drawSubs();
  }

  function drawGrid() {
    ctx.save(); ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.font = '10px Consolas, monospace'; ctx.fillStyle = C.axis;
    const step = niceStep((range.hi - range.lo) / 6);
    const start = Math.ceil(range.lo / step) * step;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let p = start; p <= range.hi; p += step) {
      const yy = Math.round(y(p)) + 0.5;
      if (yy < plot.t || yy > plot.t + plot.h) continue;
      ctx.beginPath(); ctx.moveTo(plot.l, yy); ctx.lineTo(plot.l + plot.w, yy); ctx.stroke();
      ctx.fillText(fmt(p, 2), plot.l + plot.w + 7, yy);
    }
    /* vertical time grid */
    const barSec = TF_MAP[tf].seconds;
    const pxPerSec = barW / barSec;
    const pxPerLabel = 78;
    const secsPerLabel = Math.max(barSec, Math.ceil(pxPerLabel / pxPerSec / barSec) * barSec);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let i = startIndex; i <= endIndex && i < candles.length; i++) {
      const c = candles[i]; if (!c) continue;
      if (c.time % secsPerLabel !== 0) continue;
      const xx = Math.round(x(i)) + 0.5;
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(xx, plot.t); ctx.lineTo(xx, plot.t + plot.h); ctx.stroke();
      ctx.fillText(barSec >= 86400 ? hhmm(c.time) : barSec >= 3600 ? hhmm(c.time) : hhmmss(c.time).slice(0, 5), xx, plot.t + plot.h + 4);
    }
    ctx.restore();
  }
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
    const n = raw / p;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
  }

  function drawCandles() {
    const bw = Math.max(1, Math.min(barW * 0.7, 18));
    for (let i = startIndex; i <= endIndex && i < candles.length; i++) {
      const c = candles[i]; if (!c) continue;
      const up = c.close >= c.open;
      const col = up ? C.up : C.dn;
      const cx = x(i);
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, Math.min(2, bw * 0.16));
      ctx.beginPath(); ctx.moveTo(Math.round(cx) + 0.5, y(c.high)); ctx.lineTo(Math.round(cx) + 0.5, y(c.low)); ctx.stroke();
      const yo = y(c.open), yc = y(c.close);
      const top = Math.min(yo, yc), hgt = Math.max(1.2, Math.abs(yc - yo));
      ctx.fillStyle = up ? 'rgba(23,201,140,.85)' : 'rgba(255,77,106,.85)';
      ctx.fillRect(cx - bw / 2, top, bw, hgt);
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(cx - bw / 2) + 0.5, Math.round(top) + 0.5, Math.round(bw), Math.round(hgt));
      if (!c.confirmed) {   /* forming candle marker */
        ctx.fillStyle = 'rgba(240,160,32,.9)';
        ctx.fillRect(cx - bw / 2, top, bw, 2);
      }
    }
  }

  function line(arr, color, width = 1.2, dash = null) {
    if (!arr) return;
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    let started = false;
    for (let i = startIndex; i <= endIndex && i < candles.length; i++) {
      const v = arr[i];
      if (!isNum(v)) { started = false; continue }
      const xx = x(i), yy = y(v);
      if (!started) { ctx.moveTo(xx, yy); started = true } else ctx.lineTo(xx, yy);
    }
    ctx.stroke(); ctx.restore();
  }

  function drawEMA() {
    const s = snap.series;
    line(s.ema200, C.e200, 1);
    line(s.ema50, C.e50, 1.1);
    line(s.ema21, C.e21, 1.3);
    line(s.ema9, C.e9, 1.5);
    const legend = [['EMA9', C.e9, s.ema9], ['EMA21', C.e21, s.ema21], ['EMA50', C.e50, s.ema50], ['EMA200', C.e200, s.ema200]];
    ctx.save(); ctx.font = '9.5px Consolas, monospace'; ctx.textBaseline = 'top';
    let xx = plot.l + 6;
    legend.forEach(([n, col, v]) => {
      ctx.fillStyle = col; ctx.fillText(n, xx, plot.t + 4);
      xx += ctx.measureText(n).width + 5;
      ctx.fillStyle = C.text;
      const t = isNum(v) ? fmt(v, 2) : '—';
      ctx.fillText(t, xx, plot.t + 4); xx += ctx.measureText(t).width + 12;
    });
    ctx.restore();
  }

  function drawBB() {
    const b = snap.series.bb;
    ctx.save();
    ctx.fillStyle = 'rgba(63,169,245,.045)';
    ctx.beginPath();
    let started = false;
    for (let i = startIndex; i <= endIndex; i++) { const v = b.upper[i]; if (!isNum(v)) continue; started ? ctx.lineTo(x(i), y(v)) : (ctx.moveTo(x(i), y(v)), started = true) }
    for (let i = endIndex; i >= startIndex; i--) { const v = b.lower[i]; if (!isNum(v)) continue; ctx.lineTo(x(i), y(v)) }
    ctx.closePath(); ctx.fill();
    ctx.restore();
    line(b.upper, 'rgba(63,169,245,.55)', 1, [4, 3]);
    line(b.lower, 'rgba(63,169,245,.55)', 1, [4, 3]);
    line(b.mid, 'rgba(63,169,245,.8)', 1);
  }

  function drawVWAP() { line(snap.series.vwap, '#ff9f1c', 1.6, [6, 3]) }

  function drawSuper() {
    const st = snap.series.st;
    for (let i = startIndex; i <= endIndex; i++) {
      if (st.dir[i] === null || i === 0 || st.dir[i] === st.dir[i - 1]) continue;
      ctx.save();
      ctx.fillStyle = st.dir[i] === 1 ? 'rgba(23,201,140,.9)' : 'rgba(255,77,106,.9)';
      const yy = y(st.line[i]);
      ctx.beginPath();
      if (st.dir[i] === 1) { ctx.moveTo(x(i), yy + 5); ctx.lineTo(x(i) - 4, yy + 11); ctx.lineTo(x(i) + 4, yy + 11) }
      else { ctx.moveTo(x(i), yy - 5); ctx.lineTo(x(i) - 4, yy - 11); ctx.lineTo(x(i) + 4, yy - 11) }
      ctx.closePath(); ctx.fill(); ctx.restore();
    }
    line(st.line, 'rgba(169,123,255,.75)', 1.2);
  }

  function drawIchi() {
    const s = snap.series.ich;
    /* Kumo (displaced nothing at draw time — plotted at bar index) */
    ctx.save(); ctx.fillStyle = 'rgba(23,201,140,.10)';
    ctx.beginPath(); let go = false;
    for (let i = startIndex; i <= endIndex; i++) { const v = s.spanA[i]; if (!isNum(v)) continue; go ? ctx.lineTo(x(i), y(v)) : (ctx.moveTo(x(i), y(v)), go = true) }
    for (let i = endIndex; i >= startIndex; i--) { const v = s.spanB[i]; if (!isNum(v)) continue; ctx.lineTo(x(i), y(v)) }
    ctx.closePath(); ctx.fill(); ctx.restore();
    line(s.spanA, 'rgba(23,201,140,.7)', 1);
    line(s.spanB, 'rgba(255,77,106,.7)', 1);
    line(s.conv, 'rgba(63,169,245,.8)', 1);
    line(s.base, 'rgba(255,159,28,.8)', 1);
  }

  function drawPivots() {
    ctx.save();
    ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
    [['R3', C.dn], ['R2', C.dn], ['R1', C.dn], ['P', C.info], ['S1', C.up], ['S2', C.up], ['S3', C.up]].forEach(([k, col]) => {
      const p = pivots[k]; if (!isNum(p) || p < range.lo || p > range.hi) return;
      ctx.strokeStyle = col; ctx.globalAlpha = k === 'P' ? .85 : .5;
      const yy = Math.round(y(p)) + 0.5;
      ctx.beginPath(); ctx.moveTo(plot.l, yy); ctx.lineTo(plot.l + plot.w, yy); ctx.stroke();
      ctx.globalAlpha = 1; ctx.fillStyle = col; ctx.font = '9px Consolas, monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(`${k} ${fmt(p, 2)}`, plot.l + 4, yy - 2);
    });
    ctx.restore();
  }

  function drawProfile() {
    const pr = snap.profile; if (!pr) return;
    const bins = 34;
    const hist = new Array(bins).fill(0);
    const slice = candles.slice(Math.max(0, endIndex - 200), endIndex + 1);
    const lo = pr.lo, hi = pr.hi; if (!(hi > lo)) return;
    const step = (hi - lo) / bins;
    slice.forEach(c => {
      const a = Math.max(0, Math.floor((c.low - lo) / step)), b = Math.min(bins - 1, Math.floor((c.high - lo) / step));
      const span = b - a + 1; for (let k = a; k <= b; k++) hist[k] += c.volume / span;
    });
    const max = Math.max(...hist, 1);
    const pw = plot.w * 0.28;
    ctx.save();
    for (let i = 0; i < bins; i++) {
      const p = lo + step * (i + 0.5);
      const yy = y(p), hh = Math.max(1, (plot.h / bins) - 1);
      const w = hist[i] / max * pw;
      const inVA = p >= pr.val && p <= pr.vah;
      ctx.fillStyle = p === pr.poc ? 'rgba(240,160,32,.55)' : inVA ? 'rgba(63,169,245,.28)' : 'rgba(90,110,140,.16)';
      ctx.fillRect(plot.l + plot.w - w, yy - hh / 2, w, hh);
    }
    [['POC', pr.poc, C.amber], ['VAH', pr.vah, C.info], ['VAL', pr.val, C.info]].forEach(([n, p, col]) => {
      if (!isNum(p)) return;
      ctx.strokeStyle = col; ctx.globalAlpha = .6; ctx.setLineDash([3, 3]);
      const yy = Math.round(y(p)) + 0.5;
      ctx.beginPath(); ctx.moveTo(plot.l, yy); ctx.lineTo(plot.l + plot.w, yy); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.fillStyle = col; ctx.font = '9px Consolas, monospace';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(n, plot.l + plot.w - 4, yy - 7);
    });
    ctx.restore();
  }

  function drawVolume(sub) {
    /* drawn in the main panel as a faint baseline strip */
    if (sub) return;
    const max = Math.max(...candles.slice(startIndex, endIndex + 1).map(c => c.volume), 1);
    const h = plot.h * 0.14;
    ctx.save(); ctx.globalAlpha = .28;
    for (let i = startIndex; i <= endIndex && i < candles.length; i++) {
      const c = candles[i]; const hh = c.volume / max * h;
      ctx.fillStyle = c.close >= c.open ? C.up : C.dn;
      ctx.fillRect(x(i) - Math.max(1, barW * 0.35), plot.t + plot.h - hh, Math.max(1, barW * 0.7), hh);
    }
    ctx.restore();
  }

  function drawLastPrice() {
    const c = candles[candles.length - 1]; if (!c) return;
    const yy = y(c.close); if (yy < plot.t || yy > plot.t + plot.h) return;
    const up = c.close >= c.open;
    ctx.save();
    ctx.strokeStyle = up ? C.up : C.dn; ctx.globalAlpha = .55; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(plot.l, yy + 0.5); ctx.lineTo(plot.l + plot.w, yy + 0.5); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = up ? C.up : C.dn;
    const label = fmt(c.close, 2);
    ctx.font = 'bold 11px Consolas, monospace';
    const tw = ctx.measureText(label).width + 10;
    ctx.fillRect(plot.l + plot.w, yy - 8, tw, 16);
    ctx.fillStyle = '#06080b'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, plot.l + plot.w + 5, yy);
    /* countdown to bar close */
    const cfg = TF_MAP[tf];
    const closeAt = c.time + cfg.seconds * 1000;
    const left = closeAt - FEED.now();
    if (left > 0 && left < cfg.seconds * 1000) {
      ctx.fillStyle = C.info; ctx.font = '9.5px Consolas, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`▸ ${dur(left)}`, plot.l + plot.w - 4, yy - 9);
    }
    ctx.restore();
  }

  function drawAxis() {
    ctx.save();
    ctx.strokeStyle = C.gridStrong; ctx.beginPath();
    ctx.moveTo(plot.l + plot.w + 0.5, 0); ctx.lineTo(plot.l + plot.w + 0.5, plot.t + plot.h);
    ctx.moveTo(0, plot.t + plot.h + 0.5); ctx.lineTo(W, plot.t + plot.h + 0.5);
    ctx.stroke(); ctx.restore();
  }

  function drawLevels() {
    if (!lock) return;
    const L = lock, long = L.dir === 'LONG';
    const band = (a, b, fill) => {
      const y1 = y(a), y2 = y(b);
      ctx.fillStyle = fill; ctx.fillRect(plot.l, Math.min(y1, y2), plot.w, Math.abs(y2 - y1));
    };
    const hline = (p, col, dash, label) => {
      if (!isNum(p)) return;
      const yy = y(p); if (yy < plot.t - 2 || yy > plot.t + plot.h + 2) return;
      ctx.save();
      ctx.strokeStyle = col; ctx.lineWidth = 1.4; if (dash) ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(plot.l, yy + 0.5); ctx.lineTo(plot.l + plot.w, yy + 0.5); ctx.stroke();
      ctx.setLineDash([]);
      if (label) {
        ctx.font = 'bold 9.5px Consolas, monospace';
        const t = `${label} ${fmt(p, 2)}`;
        const w = ctx.measureText(t).width + 8;
        ctx.fillStyle = col; ctx.globalAlpha = .92;
        ctx.fillRect(plot.l + 4, yy - 14, w, 13);
        ctx.globalAlpha = 1; ctx.fillStyle = '#06080b'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(t, plot.l + 8, yy - 7.5);
      }
      ctx.restore();
    };
    band(L.zoneLow, L.zoneHigh, C.zone);
    band(L.entry, L.stop, long ? 'rgba(255,77,106,.07)' : 'rgba(23,201,140,.07)');
    band(L.entry, L.tp3, long ? 'rgba(23,201,140,.06)' : 'rgba(255,77,106,.06)');
    hline(L.zoneLow, 'rgba(63,169,245,.55)', [2, 4], 'ZONE L');
    hline(L.zoneHigh, 'rgba(63,169,245,.55)', [2, 4], 'ZONE H');
    hline(L.entry, C.info, [7, 4], 'ENTRY');
    hline(L.stop, C.dn, null, 'STOP');
    hline(L.tp1, C.up, [6, 4], 'TP1');
    hline(L.tp2, C.up, [6, 4], 'TP2');
    hline(L.tp3, C.up, [6, 4], 'TP3');
    /* lock label */
    ctx.save();
    ctx.font = 'bold 10px Consolas, monospace';
    const t = `⦿ ${L.id} · ${L.dir} · ${L.status}`;
    const w = ctx.measureText(t).width + 12;
    const col = L.status === 'STOPPED' ? C.dn : L.status.startsWith('TP') ? C.up : C.amber;
    ctx.fillStyle = 'rgba(6,8,11,.9)'; ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.fillRect(plot.l + plot.w - w - 6, plot.t + 6, w, 16);
    ctx.strokeRect(plot.l + plot.w - w - 6, plot.t + 6, w, 16);
    ctx.fillStyle = col; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(t, plot.l + plot.w - w, plot.t + 14);
    ctx.restore();
  }

  /* ── crosshair layer ────────────────────────────────────── */
  function drawFx() {
    const s = sizeOf(fx); fctx = s.x;
    fctx.clearRect(0, 0, s.w, s.h);
    if (!hover || !candles.length) return;
    const i = hover.index;
    const c = candles[i]; if (!c) return;
    fctx.save();
    fctx.strokeStyle = 'rgba(200,215,235,.42)'; fctx.lineWidth = 1; fctx.setLineDash([4, 4]);
    fctx.beginPath();
    fctx.moveTo(hover.px + 0.5, 0); fctx.lineTo(hover.px + 0.5, s.h - AXIS_H);
    fctx.moveTo(0, hover.py + 0.5); fctx.lineTo(plot.l + plot.w, hover.py + 0.5);
    fctx.stroke();
    fctx.setLineDash([]);
    /* price tag */
    const p = priceAt(hover.py);
    const lbl = fmt(p, 2);
    fctx.font = '10px Consolas, monospace';
    const tw = fctx.measureText(lbl).width + 10;
    fctx.fillStyle = '#1b2431'; fctx.fillRect(plot.l + plot.w, hover.py - 8, tw, 16);
    fctx.fillStyle = '#e6edf6'; fctx.textAlign = 'left'; fctx.textBaseline = 'middle';
    fctx.fillText(lbl, plot.l + plot.w + 5, hover.py);
    /* time tag */
    const tt = TF_MAP[tf].seconds >= 86400 ? new Date(c.time).toUTCString().slice(5, 16)
             : TF_MAP[tf].seconds >= 3600 ? `${hhmm(c.time)} UTC`
             : `${hhmmss(c.time)} UTC`;
    fctx.font = '10px Consolas, monospace';
    const tw2 = fctx.measureText(tt).width + 12;
    fctx.fillStyle = '#1b2431';
    fctx.fillRect(Math.min(Math.max(hover.px - tw2 / 2, 0), s.w - tw2), s.h - AXIS_H, tw2, AXIS_H);
    fctx.fillStyle = '#e6edf6'; fctx.textAlign = 'center';
    fctx.fillText(tt, Math.min(Math.max(hover.px, tw2 / 2), s.w - tw2 / 2), s.h - AXIS_H / 2);
    fctx.restore();
  }

  /* ── sub panels ─────────────────────────────────────────── */
  function drawSubs() {
    subs.forEach(sub => {
      const el = sub.el, cv = sub.canvas;
      const r = el.getBoundingClientRect();
      const w = Math.max(50, Math.floor(r.width)), h = Math.max(24, Math.floor(r.height));
      if (cv.width !== Math.floor(w * dpr) || cv.height !== Math.floor(h * dpr)) { cv.width = Math.floor(w * dpr); cv.height = Math.floor(h * dpr) }
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const pl = 4, pw = Math.max(30, w - PRICE_W - pl), pt = 12, ph = Math.max(8, h - pt - 4);
      const n = view.count;
      const bw = pw / n;
      const px = i => pl + (i - startIndex + 0.5) * bw;
      const slice = candles.slice(startIndex, endIndex + 1);
      if (!slice.length) return;

      if (sub.kind === 'vol') {
        const max = Math.max(...slice.map(c => c.volume), 1);
        const vs = snap?.series?.volSma;
        for (let i = startIndex; i <= endIndex && i < candles.length; i++) {
          const c = candles[i]; const hh = c.volume / max * ph;
          g.fillStyle = c.close >= c.open ? 'rgba(23,201,140,.7)' : 'rgba(255,77,106,.7)';
          g.fillRect(px(i) - Math.max(1, bw * 0.35), pt + ph - hh, Math.max(1, bw * 0.7), hh);
        }
        if (vs) {
          g.strokeStyle = C.amber; g.lineWidth = 1; g.beginPath(); let st = false;
          for (let i = startIndex; i <= endIndex && i < candles.length; i++) {
            const v = vs[i]; if (!isNum(v)) continue;
            const yy = pt + ph - v / max * ph;
            st ? g.lineTo(px(i), yy) : (g.moveTo(px(i), yy), st = true);
          }
          g.stroke();
        }
        const lv = slice[slice.length - 1].volume;
        g.font = '9.5px Consolas, monospace'; g.fillStyle = C.axis; g.textAlign = 'right'; g.textBaseline = 'top';
        g.fillText(`${fmt(lv, 2)} · avg ${isNum(vs?.[endIndex]) ? fmt(vs[endIndex], 2) : '—'}`, pl + pw - 4, pt);
      }

      if (sub.kind === 'rsi') {
        const arr = snap?.series?.rsi;
        const yy = v => pt + ph - (v / 100) * ph;
        g.strokeStyle = C.grid; g.lineWidth = 1;
        [70, 50, 30].forEach(lv => { g.beginPath(); g.moveTo(pl, yy(lv) + .5); g.lineTo(pl + pw, yy(lv) + .5); g.stroke() });
        g.fillStyle = 'rgba(255,77,106,.05)'; g.fillRect(pl, pt, pw, yy(70) - pt);
        g.fillStyle = 'rgba(23,201,140,.05)'; g.fillRect(pl, yy(30), pw, pt + ph - yy(30));
        if (arr) {
          g.strokeStyle = C.info; g.lineWidth = 1.4; g.beginPath(); let st = false;
          for (let i = startIndex; i <= endIndex && i < candles.length; i++) {
            const v = arr[i]; if (!isNum(v)) continue;
            st ? g.lineTo(px(i), yy(v)) : (g.moveTo(px(i), yy(v)), st = true);
          }
          g.stroke();
        }
        const v = arr?.[endIndex];
        g.font = '9.5px Consolas, monospace'; g.fillStyle = C.text; g.textAlign = 'right'; g.textBaseline = 'top';
        g.fillText(isNum(v) ? v.toFixed(1) : '—', pl + pw - 4, pt);
        g.fillStyle = C.axis; g.textAlign = 'left';
        g.fillText('70 / 50 / 30', pl + 4, pt);
      }

      if (sub.kind === 'macd') {
        const m = snap?.series?.macd;
        if (m) {
          let mx = 0;
          for (let i = startIndex; i <= endIndex && i < candles.length; i++) {
            mx = Math.max(mx, Math.abs(m.line[i] || 0), Math.abs(m.signal[i] || 0), Math.abs(m.hist[i] || 0));
          }
          mx = mx || 1;
          const yy = v => pt + ph / 2 - (v / mx) * (ph / 2) * 0.92;
          g.strokeStyle = C.grid; g.beginPath(); g.moveTo(pl, pt + ph / 2 + .5); g.lineTo(pl + pw, pt + ph / 2 + .5); g.stroke();
          for (let i = startIndex; i <= endIndex && i < candles.length; i++) {
            const h = m.hist[i]; if (!isNum(h)) continue;
            const zero = yy(0), hv = yy(h);
            g.fillStyle = h >= 0 ? 'rgba(23,201,140,.65)' : 'rgba(255,77,106,.65)';
            g.fillRect(px(i) - Math.max(1, bw * 0.3), Math.min(zero, hv), Math.max(1, bw * 0.6), Math.max(1, Math.abs(zero - hv)));
          }
          const drawL = (arr, col) => { g.strokeStyle = col; g.lineWidth = 1.3; g.beginPath(); let st = false;
            for (let i = startIndex; i <= endIndex && i < candles.length; i++) { const v = arr[i]; if (!isNum(v)) continue;
              st ? g.lineTo(px(i), yy(v)) : (g.moveTo(px(i), yy(v)), st = true) } g.stroke() };
          drawL(m.line, C.info); drawL(m.signal, '#ff9f1c');
          g.font = '9.5px Consolas, monospace'; g.fillStyle = C.text; g.textAlign = 'right'; g.textBaseline = 'top';
          g.fillText(`${(m.line[endIndex] || 0).toFixed(3)} / ${(m.signal[endIndex] || 0).toFixed(3)} / H ${(m.hist[endIndex] || 0).toFixed(3)}`, pl + pw - 4, pt);
        }
      }
      g.strokeStyle = C.gridStrong; g.beginPath(); g.moveTo(pl + pw + 0.5, 0); g.lineTo(pl + pw + 0.5, h); g.stroke();
    });
  }

  /* ── interaction ─────────────────────────────────────────── */
  function bind() {
    wrap.addEventListener('mousemove', e => {
      const r = wrap.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      if (px < plot.l || px > plot.l + plot.w) { hover = null; fxd = true; return }
      const i = clamp(Math.floor(startIndex + (px - plot.l) / barW), 0, candles.length - 1);
      hover = { index: i, px, py };
      fxd = true;
      busUpdateOhlc(i);
      if (dragging) {
        const dx = px - dragging.px;
        const bars = Math.round(dx / barW);
        if (bars !== 0) { view.right = clamp(dragging.right + bars, 0, Math.max(0, candles.length - 20)); dragging.px = px; dirty = true }
      }
    });
    wrap.addEventListener('mouseleave', () => { hover = null; fxd = true });
    let dragging = null;
    wrap.addEventListener('mousedown', e => { dragging = { px: e.offsetX, right: view.right }; wrap.style.cursor = 'grabbing' });
    window.addEventListener('mouseup', () => { dragging = null; wrap.style.cursor = 'crosshair' });
    wrap.addEventListener('wheel', e => {
      e.preventDefault();
      const f = e.deltaY > 0 ? 1.12 : 0.9;
      view.count = clamp(Math.round(view.count * f), 20, 480);
      dirty = true;
    }, { passive: false });
    wrap.addEventListener('dblclick', () => { view.count = 140; view.right = 0; dirty = true });
    let touchX = null;
    wrap.addEventListener('touchstart', e => { touchX = e.touches[0].clientX }, { passive: true });
    wrap.addEventListener('touchmove', e => {
      if (touchX === null) return;
      const dx = e.touches[0].clientX - touchX; touchX = e.touches[0].clientX;
      view.right = clamp(view.right + Math.round(dx / 6), 0, Math.max(0, candles.length - 20)); dirty = true;
    }, { passive: true });
  }

  function busUpdateOhlc(i) {
    const c = candles[i]; if (!c) return;
    CORE.bus.emit('hover-ohlc', c);
  }

  /* ── public API ──────────────────────────────────────────── */
  function init(wrapEl, mainCanvas, fxCanvas) {
    wrap = wrapEl; main = mainCanvas; fx = fxCanvas;
    ctx = main.getContext('2d');
    subs = [...document.querySelectorAll('.sub')].map(el => ({ el, canvas: el.querySelector('canvas'), kind: el.dataset.sub }));
    bind();
    const ro = new ResizeObserver(() => { dirty = true; fxd = true });
    ro.observe(wrap);
    requestAnimationFrame(loop);
  }
  function loop() {
    if (dirty) { draw(); dirty = false }
    if (fxd) { drawFx(); fxd = false }
    requestAnimationFrame(loop);
  }

  return {
    init, OVERLAYS,
    setData(next) { candles = next || []; dirty = true },
    setSnap(s) { snap = s; dirty = true },
    setLock(l) { lock = l; dirty = true },
    setPivots(p) { pivots = p; dirty = true },
    setTf(id) { tf = id; view.count = id === '1m' ? 160 : id === '4h' ? 90 : 130; view.right = 0; dirty = true },
    toggle(id) { const o = OVERLAYS.find(x => x.id === id); if (o) { o.on = !o.on; dirty = true; return o.on } },
    isOn: id => (OVERLAYS.find(o => o.id === id) || {}).on,
    refresh() { dirty = true; fxd = true },
    resetView() { view.count = 140; view.right = 0; dirty = true },
    get viewCount() { return view.count },
  };
})();
