/* ══════════════════════════════════════════════════════════════
   app.js — bootstrap, wiring, render loop
   ══════════════════════════════════════════════════════════════ */
'use strict';

(() => {
  const { $, el, bus, TF_MAP, TIMEFRAMES, isNum, fmt, hhmmss, hmsMs, usTime, dur, beep, clamp, tickRound, SYMBOL } = CORE;

  let activeTf = '1m';
  let soundOn = true;
  let autoSwitch = false;
  let booted = false;
  let chartKey = '';

  /* honour the SOUND toggle for every alert the engine raises */
  const rawBeep = beep;
  CORE.beep = k => { if (soundOn) rawBeep(k) };

  /* local clock on the EXCHANGE timeline with sub-millisecond precision:
     the anchor is refreshed from Binance time every frame, and the high
     resolution timer supplies the microsecond remainder. */
  let anchor = { ex: 0, perf: 0 };
  const localNow = () => anchor.ex + (performance.now() - anchor.perf);

  /* ═════════ build toolbar & overlay toggles ═════════ */
  function buildToolbar() {
    const host = $('tfBtns');
    TIMEFRAMES.forEach((t, i) => {
      const b = el('button', 'tf-btn' + (t.kline ? '' : ' synth'), t.label);
      b.dataset.tf = t.id;
      b.title = t.kline
        ? `Binance native ${t.kline} interval`
        : 'Binance has no 3h interval — aggregated from three real 1h candles';
      b.addEventListener('click', () => setTf(t.id));
      host.appendChild(b);
      if (i < 9) b.dataset.key = String(i + 1);
    });
    markTf();

    const ovHost = $('ovToggles');
    CHART.OVERLAYS.forEach(o => {
      const b = el('button', 'ov' + (o.on ? ' on' : ''), o.label);
      b.title = `Toggle ${o.label}`;
      b.addEventListener('click', () => {
        const on = CHART.toggle(o.id);
        b.classList.toggle('on', on);
        b.style.background = on ? CHART.colorFor ? CHART.colorFor(o.id) : '' : '';
        if (on) { const c = overlayColor(o.id); b.style.background = c; b.style.color = '#06080b' }
        else { b.style.background = ''; b.style.color = '' }
      });
      if (o.on) { b.style.background = overlayColor(o.id); b.style.color = '#06080b' }
      ovHost.appendChild(b);
    });
  }
  function overlayColor(id) {
    return { ema: '#f0a020', bb: '#3fa9f5', vwap: '#ff9f1c', super: '#a97bff', ichi: '#17c98c', pivot: '#5c6a7d', profile: '#ffc358', levels: '#3fa9f5' }[id] || '#f0a020';
  }
  function markTf() {
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.toggle('on', b.dataset.tf === activeTf));
  }

  /* ═════════ timeframe switching ═════════ */
  function setTf(id) {
    if (!TF_MAP[id]) return;
    activeTf = id;
    PANELS.activeTf = id;
    FEED.setActiveTf(id);
    markTf();
    CHART.setTf(id);
    $('chartTitle').textContent = `${SYMBOL} · ${TF_MAP[id].label}${TF_MAP[id].kline ? '' : ' (DERIVED)'} · BINANCE FUTURES`;
    chartKey = '';
    CHART.refresh();
    PANELS.renderMtf(); PANELS.renderIndicators(); PANELS.renderLock(); PANELS.renderRisk(); PANELS.renderStrap('');
    bus.emit('log', { kind: 'SYS', title: 'TIMEFRAME', detail: `Active timeframe set to <b>${TF_MAP[id].label}</b> · ${TF_MAP[id].kline ? 'native Binance interval' : 'aggregated from 1h candles'}` });
  }

  /* ═════════ chart data push ═════════ */
  function pushChart() {
    const series = FEED.getSeries(activeTf);
    const key = `${activeTf}:${series.length}:${series.length ? series[series.length - 1].close + '|' + series[series.length - 1].time : 0}`;
    if (key !== chartKey) {
      chartKey = key;
      CHART.setData(series);
      const closed = series.filter(c => c.confirmed).length;
      const badge = $('chartBadge');
      if (closed >= 210) { badge.classList.add('hidden') }
      else { badge.classList.remove('hidden'); badge.textContent = `WARMING UP · ${closed}/210 CLOSED BARS` }
    }
    const st = ENGINE.state[activeTf];
    CHART.setSnap(st?.snap || null);
    CHART.setLock(st?.lock || null);

    /* daily pivots from the last COMPLETED 1d candle */
    const daily = FEED.state.daily || [];
    const prev = [...daily].reverse().find(c => c.confirmed && c.time + 86400000 < FEED.now());
    CHART.setPivots(prev ? TA.pivots(prev) : null);
  }

  /* ═════════ event wiring ═════════ */
  function wire() {
    bus.on('boot-progress', ({ pct, msg }) => {
      $('bootBar').style.width = pct + '%';
      $('bootMsg').textContent = msg;
    });

    bus.on('log', pushLogSafe);
    bus.on('kline', ({ tf }) => {
      if (tf === activeTf) ENGINE.evaluate(tf);
      else if (TF_MAP[tf]) ENGINE.evaluate(tf);
      PANELS.renderMtf();
    });
    bus.on('quote', () => { ENGINE.evaluateAll(); });
    bus.on('ticker', () => PANELS.renderQuote());
    bus.on('mark', () => PANELS.renderQuote());
    bus.on('book', () => PANELS.renderBook());
    bus.on('trade', tr => PANELS.pushTrade(tr));
    bus.on('spot', () => PANELS.renderXmkt());
    bus.on('status', s => PANELS.renderStatus(s));

    bus.on('liquidation', l => {
      bus.emit('log', { kind: 'WARN', title: 'LIQUIDATION',
        detail: `${l.side === 'SELL' ? 'SHORT' : 'LONG'} force-closed <b>${fmt(l.qty)} XAU</b> @ <b>${fmt(l.price)}</b>` });
      rawBeep('stop');
    });

    bus.on('lock-fired', lock => {
      const fly = $('lockFly');
      fly.textContent = `⦿ SIGNAL LOCK · ${lock.tf.toUpperCase()} · ${lock.dir} · ${lock.confidence.toFixed(0)}%`;
      fly.classList.add('show');
      setTimeout(() => fly.classList.remove('show'), 5200);
      const btn = document.querySelector(`.tf-btn[data-tf="${lock.tf}"]`);
      if (btn) { btn.classList.remove('fire'); void btn.offsetWidth; btn.classList.add('fire') }
      if (autoSwitch && lock.tf !== activeTf) { setTf(lock.tf); flash('LOCK AUTO-SWITCH') }
    });

    bus.on('lock-resolved', lock => { if (autoSwitch && lock.tf !== activeTf && lock.status !== 'ACTIVE') setTf(lock.tf) });
    bus.on('tf-switch', id => setTf(id));
    bus.on('hover-ohlc', c => PANELS.renderHover(c));

    /* buttons */
    $('btnRelease')?.addEventListener('click', () => ENGINE.release(activeTf, 'operator'));
    $('btnNewScan')?.addEventListener('click', () => {
      const st = ENGINE.evaluate(activeTf, { force: true });
      const gs = st.gates || ENGINE.gates(activeTf, { score: st.score, factors: st.factors, snap: st.snap, confirm: st.confirm, dir: st.bias, medAtrPct: st.medAtrPct, lastCloseAge: st.lastCloseAge });
      const failed = gs.filter(g => !g.ok);
      bus.emit('log', failed.length
        ? { kind: 'SYS', title: 'RESCAN', detail: `<b>${failed.length}</b> gate${failed.length > 1 ? 's' : ''} still open: ${failed.map(f => f.label).join(', ')}` }
        : { kind: 'LOCK', title: 'RESCAN', detail: 'All gates pass — signal lock armed' });
      PANELS.renderLock();
    });
    $('btnArmNow')?.addEventListener('click', () => {
      const r = ENGINE.forceLock(activeTf);
      flash(r.ok ? `⚡ ${activeTf.toUpperCase()} SIGNAL LOCK ARMED` : r.why.toUpperCase());
      PANELS.renderLock();
    });
    $('btnRescanEmpty')?.addEventListener('click', () => {
      $('btnNewScan')?.click();
    });
    $('btnClearLog')?.addEventListener('click', () => PANELS.clearLog());
    $('rAcc')?.addEventListener('input', () => PANELS.renderRisk());
    $('rRisk')?.addEventListener('input', () => PANELS.renderRisk());

    /* toggles */
    $('tglSound')?.addEventListener('click', e => {
      soundOn = !soundOn;
      e.currentTarget.setAttribute('aria-pressed', String(soundOn));
      if (soundOn) rawBeep('tick');
      bus.emit('log', { kind: 'SYS', title: 'AUDIO', detail: soundOn ? 'Alerts enabled' : 'Alerts muted' });
    });
    $('tglAutoSwitch')?.addEventListener('click', e => {
      autoSwitch = !autoSwitch;
      e.currentTarget.setAttribute('aria-pressed', String(autoSwitch));
      bus.emit('log', { kind: 'SYS', title: 'AUTO-SWITCH', detail: autoSwitch ? 'Chart will jump to the timeframe that fires a lock' : 'Chart stays on the selected timeframe' });
    });
    $('tglMethod')?.addEventListener('click', () => $('method').classList.remove('hidden'));
    document.querySelector('#method .x')?.addEventListener('click', () => $('method').classList.add('hidden'));
    $('method')?.addEventListener('click', e => { if (e.target.id === 'method') $('method').classList.add('hidden') });

    /* keyboard: 1-9 & 0 timeframe, L lock, M methodology, ESC close */
    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === '0') {
        const t = TIMEFRAMES.find(x => x.id === '6h') || TIMEFRAMES[TIMEFRAMES.length - 1];
        if (t) setTf(t.id);
        return;
      }
      const n = Number(e.key);
      if (n >= 1 && n <= 9) { const t = TIMEFRAMES[n - 1]; if (t) setTf(t.id) }
      else if (e.key === 'l' || e.key === 'L') { const r = ENGINE.forceLock(activeTf); flash(r.ok ? 'MANUAL LOCK ARMED' : r.why.toUpperCase()) }
      else if (e.key === 'm' || e.key === 'M') $('method').classList.toggle('hidden');
      else if (e.key === 'Escape') $('method').classList.add('hidden');
    });
  }

  function pushLogSafe(e) { try { PANELS.pushLog(e) } catch (err) { console.error(err) } }
  /* FEED.boot()/startRefreshers() call back as (kind, title, detail) */
  const bootLog = (kind, title, detail) => bus.emit('log', { kind, title, detail });

  let flashT = null;
  function flash(text) {
    const fly = $('lockFly');
    fly.textContent = text; fly.classList.add('show');
    clearTimeout(flashT);
    flashT = setTimeout(() => fly.classList.remove('show'), 2600);
  }

  /* ═════════ render cadence ═════════ */
  function startLoop() {
    let panelAcc = 0, chartAcc = 0, slowAcc = 0;
    let lastFrame = performance.now();

    (function frame() {
      const nowPerf = performance.now();
      const dt = nowPerf - lastFrame; lastFrame = nowPerf;

      /* clocks every frame — exchange event time vs µs render clock */
      const ex = FEED.now();
      anchor.ex = ex; anchor.perf = performance.now();
      const cEx = $('clockEx'), cLo = $('clockLocal'), cB = $('barCountdown');
      cEx.textContent = hmsMs(FEED.state.lastEventE || ex);
      cLo.textContent = usTime(localNow());
      const cfg = TF_MAP[activeTf];
      const series = FEED.getSeries(activeTf);
      const cur = series[series.length - 1];
      if (cur) {
        const left = cur.time + cfg.seconds * 1000 - ex;
        cB.textContent = left > 0 ? dur(left) : 'CLOSED';
      }

      chartAcc += dt;
      if (chartAcc >= 140) { chartAcc = 0; pushChart(); PANELS.renderQuote() }

      panelAcc += dt;
      if (panelAcc >= 480) {
        panelAcc = 0;
        PANELS.renderMtf();
        PANELS.renderIndicators();
        PANELS.renderLock();
        PANELS.renderRisk();
        PANELS.renderStrap(sessionLabel(ex));
        PANELS.renderStatus(FEED.status());
      }

      slowAcc += dt;
      if (slowAcc >= 2500) {
        slowAcc = 0;
        const st = ENGINE.state[activeTf];
        if (st?.snap && !document.querySelector('.ohlc b.up, .ohlc b.dn')) PANELS.renderHover(series[series.length - 1]);
      }
      requestAnimationFrame(frame);
    })();

    /* engine cadence: every timeframe keeps scoring */
    setInterval(() => { ENGINE.evaluateAll(); }, 1400);
    setInterval(() => { ENGINE.evaluate(activeTf, { force: false }) }, 600);
  }

  function sessionLabel(now) {
    const h = new Date(now).getUTCHours();
    if (h >= 0 && h < 7) return 'ASIA';
    if (h >= 7 && h < 12) return 'LONDON AM';
    if (h >= 12 && h < 16) return 'LONDON/NY';
    if (h >= 16 && h < 21) return 'NEW YORK';
    return 'LATE NY';
  }

  /* ═════════ boot ═════════ */
  async function start() {
    CHART.init(document.querySelector('.chart-wrap'), $('chart'), $('chartFx'));
    PANELS.buildMtf();
    PANELS.renderMethod();
    buildToolbar();
    wire();
    PANELS.renderBook();

    bus.emit('boot-progress', { pct: 4, msg: 'Loading Binance instruments' });
    bus.emit('log', { kind: 'SYS', title: 'TERMINAL', detail: `Booting XAU/USDT scalping terminal · data source <b>Binance</b>` });

    try {
      await FEED.boot(bootLog);
    } catch (e) {
      bus.emit('log', { kind: 'WARN', title: 'BOOT', detail: e.message });
    }
    FEED.startRefreshers(bootLog);

    ENGINE.evaluateAll();
    PANELS.renderQuote(); PANELS.renderXmkt(); PANELS.renderBook();
    PANELS.renderMtf(); PANELS.renderIndicators(); PANELS.renderLock(); PANELS.renderRisk();
    pushChart();
    startLoop();

    setTimeout(() => {
      $('boot').classList.add('gone');
      setTimeout(() => $('boot').remove(), 600);
    }, 420);
    booted = true;

    bus.emit('log', { kind: 'SYS', title: 'FEED READY',
      detail: `<b>${SYMBOL}</b> · 9 timeframes armed · tick ${FEED.state.filters.tickSize} · step ${FEED.state.filters.stepSize}` });
  }

  document.addEventListener('DOMContentLoaded', start);
  if (document.readyState !== 'loading') start();
})();
