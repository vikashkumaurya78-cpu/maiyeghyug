/* ══════════════════════════════════════════════════════════════
   panels.js — every readout panel in the terminal
   ══════════════════════════════════════════════════════════════ */
'use strict';

const PANELS = (() => {
  const { $, el, fmt, fmtQty, compact, pct, clamp, isNum, hhmmss, hhmm, dur, TIMEFRAMES, TF_MAP, bus, tickRound } = CORE;

  let activeTf = '1m';
  const scoreBars = new Map();

  /* ═════════ MTF CONFLUENCE MATRIX ═════════ */
  function buildMtf() {
    const host = $('mtfRows'); host.innerHTML = '';
    TIMEFRAMES.forEach(t => {
      const row = el('div', 'mrow');
      row.dataset.tf = t.id;
      row.innerHTML = `
        <span class="tf">${t.label}<small>${t.kline ? 'BINANCE' : 'DERIVED'}</small></span>
        <span class="bias NEUTRAL">—</span>
        <span class="sc"><u></u><i></i><span>0</span></span>
        <span class="num">—</span>
        <span class="num">—</span>
        <span class="num">—</span>
        <span class="state clear">IDLE</span>`;
      row.addEventListener('click', () => bus.emit('tf-switch', t.id));
      host.appendChild(row);
      scoreBars.set(t.id, row);
    });
  }

  function renderMtf() {
    TIMEFRAMES.forEach(t => {
      const row = scoreBars.get(t.id); if (!row) return;
      const s = ENGINE.state[t.id];
      const bias = row.querySelector('.bias');
      bias.textContent = s.snap ? s.bias : '—';
      bias.className = `bias ${s.snap ? s.bias : 'NEUTRAL'}`;
      const sc = row.querySelector('.sc'), i = sc.querySelector('i'), sp = sc.querySelector('span');
      const v = s.snap ? clamp(s.score, -100, 100) : 0;
      const w = Math.abs(v) / 2;
      i.className = v >= 0 ? 'pos' : 'neg';
      i.style.width = w + '%';
      i.style.left = (v >= 0 ? 50 : 50 - w) + '%';
      sp.textContent = v.toFixed(0);
      const nums = row.querySelectorAll('.num');
      nums[0].textContent = s.snap && isNum(s.snap.rsi) ? s.snap.rsi.toFixed(1) : '—';
      nums[1].textContent = s.snap && isNum(s.snap.adx) ? s.snap.adx.toFixed(0) : '—';
      nums[2].textContent = s.snap && isNum(s.snap.atrPct) ? s.snap.atrPct.toFixed(3) : '—';
      const st = row.querySelector('.state');
      if (s.lock) { st.className = 'state locked'; st.textContent = `● ${s.lock.dir}` }
      else if (s.cooldown > 0 && s.lastResolved && FEED.now() - s.lastResolved.at < 60000) {
        st.className = 'state ' + (s.lastResolved.type === 'STOP' ? 'stop' : s.lastResolved.type === 'TP' ? 'done' : 'clear');
        st.textContent = s.lastResolved.type === 'TP' ? '✓ TP' : s.lastResolved.type === 'STOP' ? '✕ SL' : 'REL';
      }
      else if (Math.abs(s.score) >= ENGINE.LOCK_SCORE - 12 && s.bias !== 'NEUTRAL') { st.className = 'state watch'; st.textContent = 'ARMING' }
      else if (s.snap) { st.className = 'state clear'; st.textContent = 'SCANNING' }
      else { st.className = 'state clear'; st.textContent = 'IDLE' }
      row.classList.toggle('on', t.id === activeTf);
    });
    const c = ENGINE.composite;
    $('mtfSync').innerHTML = `COMPOSITE <b style="color:${c.score >= 0 ? 'var(--up)' : 'var(--dn)'}">${c.score >= 0 ? '+' : ''}${c.score.toFixed(1)}</b> · ▲${c.htfLong} ▼${c.htfShort}`;
    $('mtfFoot').innerHTML = `5-axis agreement ▲${c.agree} ▼${c.oppose} · weighted composite <b style="color:var(--amber2)">${c.bias}</b> · higher-timeframe bias filters every lock`;
  }

  /* ═════════ INDICATOR MATRIX ═════════ */
  function indicatorRows(tf) {
    const s = ENGINE.state[tf]?.snap;
    if (!s) return [];
    const st = ENGINE.state[tf];
    const f = k => (st.factors.find(x => x.key === k) || {}).direction || 'NEUTRAL';
    const num = (v, d = 2) => isNum(v) ? fmt(v, d) : '—';
    return [
      { n: 'ORDER FLOW DELTA', d: 'CVD taker buy/sell ratio',v: `${isNum(s.cvdDelta) ? (s.cvdDelta >= 0 ? '+' : '') + s.cvdDelta.toFixed(1) : '—'} · ${isNum(s.cvdRatio) ? (s.cvdRatio * 100).toFixed(0) + '%' : '—'}`, s: f('cvd') },
      { n: 'CHAIKIN FLOW',   d: 'CMF 20 accumulation',  v: isNum(s.cmf) ? (s.cmf >= 0 ? '+' : '') + s.cmf.toFixed(3) : '—', s: f('cmf') },
      { n: 'SQUEEZE PRO',    d: 'TTM volatility state',  v: s.sqOn ? 'COMPRESSED 🔒' : 'EXPANDING ⚡', s: f('sq') },
      { n: 'FAIR VALUE GAP', d: 'SMC 3-bar imbalance',   v: s.fvg ? `${s.fvg.type} · ${num(s.fvg.size)}` : 'BALANCED', s: f('fvg') },
      { n: 'EMA STACK',      d: '9 / 21 / 50 / 200',     v: `${num(s.ema9)} · ${num(s.ema50)}`, s: f('ema') },
      { n: 'RSI',            d: '14 period',             v: isNum(s.rsi) ? s.rsi.toFixed(1) : '—', s: f('rsi') },
      { n: 'STOCHASTIC',     d: '%K / %D',               v: `${isNum(s.stochK) ? s.stochK.toFixed(0) : '—'} / ${isNum(s.stochD) ? s.stochD.toFixed(0) : '—'}`, s: f('stoch') },
      { n: 'MACD',           d: '12 / 26 / 9 histogram', v: isNum(s.macdHist) ? (s.macdHist >= 0 ? '+' : '') + s.macdHist.toFixed(3) : '—', s: f('macd') },
      { n: 'ADX / DMI',      d: '+DI vs −DI',            v: `${isNum(s.adx) ? s.adx.toFixed(1) : '—'} · ${isNum(s.plusDI) ? s.plusDI.toFixed(0) : '—'}${isNum(s.minusDI) ? '/' + s.minusDI.toFixed(0) : ''}`, s: f('dmi') },
      { n: 'BOLLINGER %B',   d: '20 / 2 bands · width',  v: `${isNum(s.bbPctB) ? (s.bbPctB * 100).toFixed(0) + '%' : '—'} · ${isNum(s.bbW) ? s.bbW.toFixed(3) + '%' : '—'}`, s: f('bb') },
      { n: 'ATR',            d: '14 · % of price',       v: `${num(s.atr)} · ${isNum(s.atrPct) ? s.atrPct.toFixed(3) + '%' : '—'}`, s: Math.abs(s.atrPct) > 0 ? 'NEUTRAL' : 'NEUTRAL' },
      { n: 'SUPERTREND',     d: '10 / 3 multiplier',     v: num(s.stLine), s: f('super') },
      { n: 'ICHIMOKU',       d: 'Tenkan / Kijun / Kumo', v: `${num(s.tenkan)} · ${num(s.kijun)}`, s: f('ich') },
      { n: 'SESSION VWAP',   d: 'UTC day anchored',      v: num(s.vwap), s: f('vwap') },
      { n: 'MOMENTUM',       d: 'CMO 14 / ROC 12',       v: `${isNum(s.cmo) ? s.cmo.toFixed(1) : '—'} / ${isNum(s.roc) ? s.roc.toFixed(3) + '%' : '—'}`, s: f('mom') },
      { n: 'VOLUME FLOW',    d: 'bar vs 20-bar average', v: `${num(s.vol)} · ${s.volAvg ? (s.vol / s.volAvg).toFixed(2) + '×' : '—'}`, s: f('vol') },
      { n: 'STRUCTURE',      d: 'last swing high / low', v: `${num(s.swHi)} · ${num(s.swLo)}`, s: f('struct') },
      { n: 'OBV',            d: 'on-balance volume',     v: compact(s.obv), s: 'NEUTRAL' },
      { n: 'VOLUME PROFILE', d: 'POC / VAL / VAH',       v: s.profile ? `${num(s.profile.poc)} · ${num(s.profile.val)}/${num(s.profile.vah)}` : '—', s: 'NEUTRAL' },
    ];
  }

  function renderIndicators() {
    const rows = indicatorRows(activeTf);
    $('indTf').textContent = TF_MAP[activeTf].label + ' · ' + (TF_MAP[activeTf].kline || 'DERIVED');
    const host = $('indRows');
    if (!rows.length) { host.innerHTML = '<div class="irow"><span class="in">WARMING UP…</span></div>'; return }
    host.innerHTML = rows.map(r => `
      <div class="irow">
        <span class="in">${r.n}<em>${r.d}</em></span>
        <span class="iv">${r.v}</span>
        <span class="isig ${r.s}">${r.s}</span>
      </div>`).join('');
  }

  /* ═════════ SIGNAL LOCK CARD ═════════ */
  function renderGatesMini() {
    const st = ENGINE.state[activeTf];
    const host = $('gatesMini');
    if (!st || !st.pending || !st.pending.length) { host.innerHTML = ''; return }
    host.innerHTML = st.pending.slice(0, 8).map(g => `
      <div class="gate ${g.ok ? 'ok' : 'no'}">${g.label}<b>${g.ok ? 'PASS' : g.detail}</b></div>`).join('');
  }

  function renderSignalSwitcher() {
    const host = $('ltsPills');
    if (!host) return;
    host.innerHTML = TIMEFRAMES.map(t => {
      const st = ENGINE.state[t.id];
      const hasLock = !!st?.lock;
      const isLong = st?.lock?.dir === 'LONG';
      const isShort = st?.lock?.dir === 'SHORT';
      const isArming = !hasLock && Math.abs(st?.score || 0) >= ENGINE.LOCK_SCORE - 12 && st?.bias !== 'NEUTRAL';
      const cls = ['lts-pill'];
      if (t.id === activeTf) cls.push('active');
      if (hasLock) cls.push(isLong ? 'locked-long' : 'locked-short');
      else if (isArming) cls.push('arming');
      return `<button class="${cls.join(' ')}" data-tf="${t.id}" title="${t.label} signal state: ${hasLock ? st.lock.dir + ' LOCK' : isArming ? 'ARMING' : 'SCANNING'}">
        <span class="lts-dot"></span>${t.label}
      </button>`;
    }).join('');
    host.querySelectorAll('.lts-pill').forEach(btn => {
      btn.addEventListener('click', () => bus.emit('tf-switch', btn.dataset.tf));
    });
  }

  function renderLock() {
    const st = ENGINE.state[activeTf];
    $('lockTf').textContent = TF_MAP[activeTf].label;
    $('lockEmptyTf').textContent = TF_MAP[activeTf].label;
    renderSignalSwitcher();
    const lock = st?.lock;
    $('lockEmpty').classList.toggle('hidden', !!lock);
    $('lockLive').classList.toggle('hidden', !lock);

    if (!lock) { renderGatesMini(); renderLockHistory(); $('riskSide').textContent = st?.bias || '—'; return }

    const long = lock.dir === 'LONG';
    const live = FEED.state.quote ? (FEED.state.quote.bid + FEED.state.quote.ask) / 2 : null;
    const set = (id, v) => { const n = $(id); if (n) n.textContent = v };

    const dirEl = $('lkDir'); dirEl.textContent = lock.dir;
    dirEl.className = `lh-dir ${lock.dir}`;

    set('lkConf', lock.confidence.toFixed(0) + '%');
    $('lkConfBar').style.width = lock.confidence + '%';
    const badge = $('lkBadge');
    if (badge) {
      badge.textContent = lock.confidence >= 90 ? '100% CONFIDENCE' : lock.confidence >= 75 ? 'HIGH CONFLUENCE' : 'SCALP LOCK';
      badge.style.color = lock.confidence >= 90 ? 'var(--up)' : 'var(--amber2)';
      badge.style.borderColor = lock.confidence >= 90 ? 'rgba(23,201,140,.5)' : 'rgba(240,160,32,.5)';
    }
    const statusEl = $('lkStatus');
    statusEl.textContent = lock.status; statusEl.dataset.s = lock.status;

    set('lkEntry', fmt(lock.entry));
    set('lkZone', `${fmt(lock.zoneLow)} – ${fmt(lock.zoneHigh)}`);
    set('lkStop', fmt(lock.stop));
    set('lkRisk', `${fmt(lock.risk)} (${'$' + (lock.risk).toFixed(2)})`);
    set('lkTp1', fmt(lock.tp1)); set('lkTp1r', '1.5R');
    set('lkTp2', fmt(lock.tp2)); set('lkTp2r', '2.5R');
    set('lkTp3', fmt(lock.tp3)); set('lkTp3r', '4.0R');
    set('lkRR', `1 : ${lock.rr3.toFixed(1)}`);
    set('lkId', lock.id);
    set('lkAt', hhmmss(lock.lockedAt));
    set('lkExp', `${hhmmss(lock.expires)} · ${dur(lock.expires - FEED.now())}`);

    const openR = isNum(live) ? (long ? live - lock.entry : lock.entry - live) / lock.risk : 0;
    const pnl = $('lkPnl');
    if (lock.status !== 'ACTIVE') { pnl.textContent = `${(lock.pnlR ?? 0) >= 0 ? '+' : ''}${(lock.pnlR ?? 0).toFixed(2)}R`; pnl.className = (lock.pnlR ?? 0) >= 0 ? 'pos' : 'neg' }
    else { pnl.textContent = `${openR >= 0 ? '+' : ''}${openR.toFixed(2)}R`; pnl.className = openR >= 0 ? 'pos' : 'neg' }

    /* progress rail: stop … entry … tp3 */
    const span = Math.max(1e-9, lock.tp3 - lock.stop);
    const pos = v => clamp((v - lock.stop) / span * 100, 0, 100);
    $('ltStop').style.left = pos(lock.stop) + '%';
    $('ltFill').style.width = isNum(live) ? clamp((long ? live - lock.stop : lock.stop - live) / span * 100, 0, 100) + '%' : '0%';
    set('ltStopLbl', `SL ${fmt(lock.stop)}`);
    set('ltTpLbl', `TP3 ${fmt(lock.tp3)}`);

    $('lkWhy').innerHTML = lock.why.map(w => `<li>${w}</li>`).join('');
    document.querySelectorAll('.lg-tp').forEach((n, i) => {
      const hit = lock.status === 'TP1 HIT' || lock.status === 'TP2 HIT' || lock.status === 'TP3 HIT';
      const reached = i === 0 ? (lock.status !== 'ACTIVE' ? hit : false) : false;
      n.classList.toggle('hit', lock.status.startsWith('TP') && (lock.status === 'TP3 HIT' ? i <= 2 : lock.status === 'TP2 HIT' ? i <= 1 : i <= 0));
    });

    $('riskSide').textContent = lock.dir;
    renderLockHistory();
  }

  function renderLockHistory() {
    const st = ENGINE.state[activeTf];
    const all = [...(st?.lock ? [st.lock] : []), ...(st?.history || [])];
    $('lkHistN').textContent = String((st?.history || []).length);
    const host = $('lockHist');
    if (!all.length) { host.innerHTML = '<div class="lh-item"><span class="t">no locks yet this session</span></div>'; return }
    host.innerHTML = all.slice(0, 14).map(l => {
      const open = l === st.lock;
      const r = open ? (l.liveR ?? 0) : (l.pnlR ?? 0);
      const cls = open ? 'open' : l.status === 'STOPPED' ? 'loss' : l.status === 'EXPIRED' || l.status === 'RELEASED' ? 'flat' : 'win';
      return `<div class="lh-item">
        <span class="d ${l.dir}">${l.dir[0]}${l.dir === 'LONG' ? 'L' : 'S'}</span>
        <span class="t">${TF_MAP[l.tf].label} ${hhmmss(l.lockedAt)}</span>
        <span class="p">${fmt(l.entry)} → ${open ? (FEED.state.quote ? fmt((FEED.state.quote.bid + FEED.state.quote.ask) / 2) : '—') : fmt(l.exitPrice)}</span>
        <span class="r ${cls}">${open ? 'OPEN' : l.status} ${r >= 0 ? '+' : ''}${r.toFixed(2)}R</span>
      </div>`;
    }).join('');
  }

  /* ═════════ ORDER BOOK ═════════ */
  function renderBook() {
    const b = FEED.state.book;
    if (!b || !b.bids.length) return;
    const LEVELS = 11;
    const asks = b.asks.slice(0, LEVELS), bids = b.bids.slice(0, LEVELS);
    const askSum = [], bidSum = [];
    asks.reduce((s, r) => (askSum.push(s + r[1]), s + r[1]), 0);
    bids.reduce((s, r) => (bidSum.push(s + r[1]), s + r[1]), 0);
    const maxAsk = Math.max(...askSum, 1e-9), maxBid = Math.max(...bidSum, 1e-9);
    const mx = Math.max(maxAsk, maxBid);

    const row = (r, sum, cls, best) => `<div class="row ${cls} ${best ? 'best' : ''}">
      <span>${fmt(r[0])}</span><span>${fmtQty(r[1])}</span><span>${fmtQty(sum)}</span>
      <span class="szbar">${(r[1] / mx * 100).toFixed(0)}%</span>
      <i class="bar" style="width:${(sum / mx * 100).toFixed(1)}%"></i></div>`;

    $('bkAsks').innerHTML = asks.slice().reverse().map((r, i) => row(r, askSum[asks.length - 1 - i], 'ask', i === asks.length - 1)).join('');
    $('bkBids').innerHTML = bids.map((r, i) => row(r, bidSum[i], 'bid', i === 0)).join('');

    const bestAsk = b.asks[0][0], bestBid = b.bids[0][0];
    const spread = bestAsk - bestBid;
    const mid = (bestAsk + bestBid) / 2;
    $('bkMid').textContent = fmt(mid);
    const t = FEED.state.ticker;
    $('bkMidChg').textContent = t ? `${pct(t.changePct)} · spread ${spread.toFixed(2)}` : `spread ${spread.toFixed(2)}`;
    $('bookSpread').textContent = `SPREAD ${spread.toFixed(2)} · ${(spread / mid * 100).toFixed(4)}%`;

    const totalAsk = askSum[askSum.length - 1] || 0, totalBid = bidSum[bidSum.length - 1] || 0;
    const imb = totalBid + totalAsk > 0 ? totalBid / (totalBid + totalAsk) * 100 : 50;
    $('bookImb').innerHTML = `BID DEPTH <b style="color:var(--up)">${imb.toFixed(1)}%</b> vs ASK <b style="color:var(--dn)">${(100 - imb).toFixed(1)}%</b> over ${LEVELS} levels · imbalance ${imb > 55 ? 'BUYERS' : imb < 45 ? 'SELLERS' : 'BALANCED'}`;
  }

  /* ═════════ TIME & SALES ═════════ */
  let tapeBuf = [], tapeFlush = 0, bigNotional = 0, tapeCount = 0, tapeWindow = performance.now(), tapeRate = 0;
  function pushTrade(tr) {
    tapeBuf.push(tr); tapeCount++;
    const now = performance.now();
    if (now - tapeWindow >= 1000) { tapeRate = tapeCount; tapeCount = 0; tapeWindow = now }
    if (now - tapeFlush < 110 || !tapeBuf.length) return;
    tapeFlush = now;
    const rows = tapeBuf.splice(0, tapeBuf.length);
    const host = $('tape');
    const frag = document.createDocumentFragment();
    rows.slice(-14).reverse().forEach(t => {
      const notional = t.price * t.qty;
      if (notional > bigNotional) bigNotional = notional;
      const isBig = notional > 250000;
      const d = el('div', `trow ${t.maker ? 'sell' : 'buy'} ${isBig ? 'big' : ''}`);
      d.innerHTML = `<span class="tt">${hhmmss(t.time)}.${String(new Date(t.time).getUTCMilliseconds()).padStart(3, '0')}</span>
        <span class="tp">${fmt(t.price)}</span>
        <span class="tq">${fmtQty(t.qty)}</span>
        <span class="ts">${t.maker ? 'SELL' : 'BUY'}</span>`;
      frag.appendChild(d);
    });
    host.insertBefore(frag, host.firstChild);
    while (host.children.length > 60) host.removeChild(host.lastChild);
    $('tapeRate').textContent = `${tapeRate}/s`;
  }

  /* ═════════ EVENT LOG ═════════ */
  let logN = 0;
  function pushLog(e) {
    logN++;
    const host = $('log');
    const d = el('div', 'lrow');
    d.innerHTML = `<span class="lt">${hhmmss(FEED.now())}</span><span class="lk ${e.kind}">${e.kind}</span><span class="lm"><b>${e.title}</b> · ${e.detail}</span>`;
    host.prepend(d);
    while (host.children.length > 180) host.removeChild(host.lastChild);
  }
  function clearLog() { $('log').innerHTML = ''; logN = 0 }

  /* ═════════ RISK ═════════ */
  function renderRisk() {
    const lock = ENGINE.state[activeTf]?.lock;
    const acc = Number($('rAcc').value) || 0;
    const riskPct = Number($('rRisk').value) || 0;
    const f = FEED.state.filters;
    const set = (id, v) => $(id).textContent = v;
    if (!lock) {
      ['rStop', 'rSize', 'rNotional', 'rMoney', 'rR1', 'rR2', 'rR3', 'rMax'].forEach(id => set(id, '—'));
      return;
    }
    const risk = lock.risk;
    const money = acc * riskPct / 100;
    const qty = Math.max(0, stepRound(money / risk, f.stepSize || 0.001));
    const notional = qty * lock.entry;
    set('rStop', `${fmt(risk)} pts`);
    set('rSize', `${qty.toFixed(3)} XAU`);
    set('rNotional', notional > 0 ? `$${compact(notional)}` : '—');
    set('rMoney', `$${money.toFixed(2)}`);
    set('rR1', `+$${(money * lock.rr1).toFixed(0)}`);
    set('rR2', `+$${(money * lock.rr2).toFixed(0)}`);
    set('rR3', `+$${(money * lock.rr3).toFixed(0)}`);
    set('rMax', `−$${money.toFixed(2)}`);
    if (qty * lock.entry < (f.notional || 5)) set('rSize', 'BELOW MIN');
  }
  function stepRound(v, step) { if (!(step > 0)) return v; return Math.floor(v / step + 1e-9) * step }

  /* ═════════ CROSS MARKET ═════════ */
  function renderXmkt() {
    const goldPx = FEED.state.ticker?.last || FEED.state.quote?.bid;
    const paxg = FEED.state.spot?.PAXGUSDT?.price || goldPx;
    const xaut = FEED.state.spot?.XAUTUSDT?.price;
    const rows = [
      { n: 'XAU/USDT', s: 'Physical Gold · Binance Spot', px: goldPx, dev: null },
      { n: 'PAXG/USDT', s: 'Paxos Gold · 1:1 London Delivery', px: paxg, dev: false },
      { n: 'XAUT/USDT', s: 'Tether Gold · 1:1 Troy Oz Bar', px: xaut, dev: true },
    ];
    $('xmktRows').innerHTML = rows.map(r => {
      const d = (r.dev && isNum(r.px) && isNum(goldPx)) ? goldPx - r.px : null;
      return `<div class="xrow">
        <span class="xn">${r.n}<em>${r.s}</em></span>
        <span class="xp">${fmt(r.px)}</span>
        <span class="xd ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}">${d === null ? '—' : (d >= 0 ? '+' : '') + d.toFixed(2)}</span>
      </div>`;
    }).join('');
    if (isNum(goldPx) && isNum(xaut)) $('qXdev').textContent = `${(goldPx - xaut >= 0 ? '+' : '')}${(goldPx - xaut).toFixed(2)}`;
    else $('qXdev').textContent = '—';
  }

  /* ═════════ STRAP ═════════ */
  function renderStrap(session) {
    const st = ENGINE.state[activeTf];
    const set = (id, v, cls) => { const n = $(id); n.textContent = v; n.className = cls || '' };
    if (!st?.snap) { ['sScore', 'sBias', 'sConf', 'sHtf', 'sVol', 'sAtr', 'sSession', 'sBars'].forEach(id => set(id, '—')); return }
    set('sScore', `${st.score >= 0 ? '+' : ''}${st.score.toFixed(1)}`, st.score >= 22 ? 'up' : st.score <= -22 ? 'dn' : 'amber');
    set('sBias', st.bias, st.bias === 'LONG' ? 'up' : st.bias === 'SHORT' ? 'dn' : 'amber');
    set('sConf', `${st.confirm} / ${ENGINE.CONFIRM_BARS}`, st.confirm >= ENGINE.CONFIRM_BARS ? 'amber' : '');
    const hi = [];
    for (let id = CORE.HIGHER_OF[activeTf]; id; id = CORE.HIGHER_OF[id]) if (ENGINE.state[id]?.snap) hi.push(ENGINE.state[id]);
    if (hi.length) {
      const same = hi.filter(h => h.bias === st.bias).length, opp = hi.filter(h => h.bias !== 'NEUTRAL' && h.bias !== st.bias).length;
      set('sHtf', `▲${same} ▼${opp}`, opp && same <= opp ? 'dn' : 'up');
    } else set('sHtf', 'TOP TF', 'amber');
    const a = st.snap.atrPct;
    set('sVol', st.medAtrPct && a ? (a > st.medAtrPct * 1.8 ? 'EXPANDED' : a < st.medAtrPct * 0.6 ? 'COMPRESSED' : 'NORMAL') : '—',
        st.medAtrPct && a > st.medAtrPct * 1.8 ? 'dn' : 'amber');
    set('sAtr', fmt(st.snap.atr), '');
    set('sSession', session || '—', '');
    const series = FEED.getSeries(activeTf);
    const day = Math.floor(FEED.now() / 86400000) * 86400000;
    set('sBars', String(series.filter(c => c.time >= day).length), '');
  }

  /* ═════════ METHODOLOGY ═════════ */
  function renderMethod() {
    const rows = ENGINE.WEIGHTS.map(w => `<tr><td><b>${w.name}</b></td><td>${w.detail}</td><td>${w.w}</td><td>${(w.w / ENGINE.TOTAL_W * 100).toFixed(1)}%</td></tr>`).join('');
    $('methodBody').innerHTML = `
      <h3>DATA SOURCE</h3>
      <ul>
        <li><b>Instrument:</b> <code>XAUUSDT</code> — Binance Futures <b>TRADIFI_PERPETUAL</b>, underlying <code>COMMODITY</code>, status <code>TRADING</code>. Real exchange instrument, real order flow.</li>
        <li><b>Stream:</b> <code>wss://fstream.binance.com</code> — <code>bookTicker</code>, <code>aggTrade</code>, <code>depth20@100ms</code>, <code>ticker</code>, <code>markPrice@1s</code>, <code>forceOrder</code> and klines for every timeframe.</li>
        <li><b>REST:</b> <code>fapi.binance.com</code> (+ <code>fapi1/2/3</code> failover) for history, filters, funding and open interest.</li>
        <li><b>TRANSPORT AUTODETECT — read the footer.</b> Some networks accept a Binance futures subscription, ACK it, and then never deliver a single frame for certain channels. Every category (<i>quote, book, ticker, mark, trades, kline</i>) is therefore proven empirically: if a channel stays silent for 20 seconds it is flagged and the terminal pulls <b>exactly that data from the Binance REST API</b> instead — active timeframe every 1s, the other timeframes rotating every 2.5s, trades every 2s, ticker/funding every 5s. If the socket later recovers, REST polling stops automatically. The footer prints <code>tick N / rest M</code> plus the names of any channel currently carried by REST, so the transport you are actually on is never hidden.</li>
        <li><b>Cross-check:</b> Binance spot <code>PAXGUSDT</code> and <code>XAUTUSDT</code> (tokenised physical gold) are polled to expose any perp-vs-spot deviation.</li>
        <li><b>Timeframes:</b> 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h are native Binance intervals. <b>3h does not exist on Binance</b> — it is aggregated from three real 1h candles (UTC 00/03/06…), marked <code>DERIVED</code> in the toolbar. No price is ever invented.</li>
        <li><b>Forming bar:</b> while a candle is still open its high/low/close are extended with the real last price from the live <code>bookTicker</code> feed (volume is never synthesised). A closed bar is never modified and the next authoritative kline overwrites it.</li>
      </ul>

      <h3>SCORING MODEL · 13 WEIGHTED FACTORS (Σ = ${ENGINE.TOTAL_W})</h3>
      <table><thead><tr><th>FACTOR</th><th>METHOD</th><th>WEIGHT</th><th>SHARE</th></tr></thead><tbody>${rows}</tbody></table>
      <p style="margin-top:8px">Each factor returns a normalised strength in <code>−1 … +1</code>. The timeframe score is
      <code>Σ(weight × strength) ÷ Σ(weight) × 100</code>, so it always lives in <b>−100 … +100</b>.
      Bias flips at <b>±22</b>.</p>

      <h3>SIGNAL LOCK — ARM GATES</h3>
      <p>A lock can only be created when <b>every</b> gate below passes. The gates are evaluated on each timeframe independently.</p>
      <ul>
        <li><b>Live Binance feed</b> — futures socket connected and the last closed bar arrived on time.</li>
        <li><b>History depth</b> — ≥ ${210} closed candles so EMA200 and all oscillators are fully warmed up.</li>
        <li><b>Engine score</b> — |score| ≥ ${ENGINE.LOCK_SCORE}.</li>
        <li><b>Confirmation</b> — ≥ ${ENGINE.CONFIRM_BARS} consecutive <em>closed</em> bars holding the same bias (the forming bar never counts).</li>
        <li><b>Higher-TF filter</b> — higher timeframes may not be net-opposed; agreement is shown as ▲/▼ in the matrix.</li>
        <li><b>ADX ≥ 18</b> — the move must be a real trend, not chop.</li>
        <li><b>Opposing factors ≤ 1</b> — blocks locks while the model is internally split.</li>
        <li><b>Volatility regime</b> — current ATR% within 0.45×–2.6× of its 120-bar median.</li>
        <li><b>Spread ≤ 6% of ATR</b> — execution cost must be materially smaller than the trade.</li>
        <li><b>Volume confirmation</b> — current bar ≥ the 20-bar average volume.</li>
        <li><b>Lock slot free</b> — one lock per timeframe, then a ${2}-bar cooldown.</li>
      </ul>

      <h3>LOCKED LEVELS</h3>
      <ul>
        <li><b>Ideal entry</b> — mid-point of a zone that runs from the nearest structural level (EMA9 or session VWAP) to just under the market, rounded to the exchange tick of <b>0.01</b>. A limit resting in that zone fills on any pullback.</li>
        <li><b>Stop loss</b> — beyond the last 5-bar structure <em>plus</em> 1.15 × ATR, then clamped so risk stays inside 0.6×–2.2× ATR.</li>
        <li><b>Targets</b> — TP1 at 1.5R, TP2 at 2.5R, TP3 at 4.0R (reward:risk <b>1:4</b> at the final target).</li>
        <li><b>Validity</b> — the lock expires after ${ENGINE.LOCK_BARS} bars of its own timeframe if no target and no stop is touched.</li>
      </ul>

      <h3>CONFIDENCE SCORE</h3>
      <p>Confidence starts from |engine score| (capped at 74) and then adds <b>+10</b> full higher-timeframe alignment,
      <b>+6</b> extra confirming closes, <b>+5</b> volume 1.4× average, <b>+5</b> normal volatility regime,
      <b>+3</b> tight spread and <b>+4</b> ADX ≥ 25. It subtracts <b>−9</b> for a opposed higher timeframe,
      <b>−6</b> for conflicting factors and <b>−4</b> for weak volume or a wide spread. The result is clamped to
      <b>5–96%</b>. Every addition and deduction is listed in the lock card so the number is auditable.</p>

      <h3>LEVELS OF TIME</h3>
      <p><b>EXCHANGE EVT</b> is the millisecond event timestamp carried by Binance inside every payload.
      <b>LOCAL RENDER</b> is the terminal's own high-resolution wall clock, rendered to microsecond precision.
      <b>LAT</b> is measured locally as <code>receive time − (event time − server clock offset)</code>, reported as
      current and 95th-percentile. Binance publishes millisecond-resolution timestamps — no public feed exposes
      sub-millisecond exchange time, and this terminal does not pretend otherwise.</p>

      <div class="warn"><b>NOT FINANCIAL ADVICE.</b> No model can guarantee outcomes, and no confidence figure —
      however high — is a promise of profit. Signals are decision support for a disciplined trader: always size the
      position from the stop distance, never risk money you cannot afford to lose, and check that the levels still
      match your own analysis before acting.</div>`;
  }

  /* ═════════ TOP BAR QUOTES ═════════ */
  let lastPrice = null;
  function renderQuote() {
    const q = FEED.state.quote, t = FEED.state.ticker, m = FEED.state.mark;
    const price = t?.last || q?.last || null;
    const node = $('qLast');
    if (isNum(price)) {
      node.textContent = fmt(price);
      if (lastPrice !== null && price !== lastPrice) { node.className = 'last ' + (price > lastPrice ? 'up' : 'dn') }
      lastPrice = price;
    }
    const chg = t ? t.changePct : null;
    const cn = $('qChg');
    if (isNum(chg)) { cn.textContent = `${pct(chg)}  ${t.change >= 0 ? '+' : ''}${fmt(t.change)}`; cn.className = 'chg ' + (chg >= 0 ? 'up' : 'dn') }
    if (q) {
      $('qBid').textContent = fmt(q.bid);
      $('qAsk').textContent = fmt(q.ask);
      $('qSpread').textContent = fmt(q.ask - q.bid);
      $('qMark').textContent = fmt((q.bid + q.ask) / 2);
    }
    const xaut = FEED.state.spot?.XAUTUSDT?.price;
    if (isNum(price) && isNum(xaut)) {
      const diff = price - xaut;
      const f = $('qFunding');
      f.textContent = `${diff >= 0 ? '+' : ''}${diff.toFixed(2)}`;
      f.className = diff >= 0 ? 'up' : 'dn';
    } else if (m) {
      $('qMark').textContent = fmt(m.mark);
      const f = $('qFunding');
      f.textContent = pct(m.rate * 100, 4);
      f.className = m.rate >= 0 ? 'up' : 'dn';
    }
    if (t) {
      $('qHigh').textContent = fmt(t.high); $('qLow').textContent = fmt(t.low);
      $('qVol').textContent = compact(t.vol) + ' XAU'; $('qTrades').textContent = compact(t.trades);
    }
  }

  function renderStatus(s) {
    const dot = $('feedDot'), st = $('feedState');
    const live = s.futWs;
    const healthy = live && s.spotWs;
    dot.className = 'dot ' + (live && s.spotWs ? 'on' : live ? 'warn' : 'off');
    st.textContent = live ? (s.spotWs ? 'LIVE · STREAMING' : 'LIVE · SPOT RECONNECT') : 'RECONNECTING';
    $('latNow').textContent = s.latency.now !== null ? s.latency.now.toFixed(1) + 'ms' : '—';
    $('latP95').textContent = s.latency.p95 !== null ? s.latency.p95.toFixed(1) + 'ms' : '—';
    $('evtCount').textContent = String(s.latency.rate || 0);
    $('fSrc').innerHTML = `SRC: <b>BINANCE</b> ${s.restBase || '…'} · ${s.futHost}`;
    const sc = s.streamCount || {};
    const total = Object.values(sc).reduce((a, b) => a + b, 0);
    const d = s.degraded || {};
    const viaWs = Object.keys(d).filter(k => !d[k]);
    const viaRest = Object.keys(d).filter(k => d[k]);
    $('fStreams').innerHTML = `WS <b>${s.futWs ? 'OK' : 'DOWN'}</b>/spot ${s.spotWs ? 'OK' : 'DOWN'}` +
      ` · tick <b>${viaWs.length}</b> / rest <b>${viaRest.length}</b>` +
      (viaRest.length ? ` <span style="color:var(--amber)">[${viaRest.join(' ')}]</span>` : '') +
      ` · ${total} msg`;
    const bars = s.bars.map(b => `${b.tf}:${b.n}`).join(' ');
    $('fBars').textContent = `BARS ${bars}`;
    $('fClock').innerHTML = `SERVER TIME Δ <b>${s.clockOffset >= 0 ? '+' : ''}${s.clockOffset}ms</b>`;
  }

  function renderHover(c) {
    if (!c) return;
    const d = c.close - c.open;
    const set = (id, v, cls) => { const n = $(id); n.textContent = v; n.className = cls || '' };
    set('cO', fmt(c.open)); set('cH', fmt(c.high)); set('cL', fmt(c.low)); set('cC', fmt(c.close));
    set('cV', fmtQty(c.volume));
    set('cD', `${d >= 0 ? '+' : ''}${fmt(d)} ${((d / c.open) * 100).toFixed(3)}%`, d >= 0 ? 'up' : 'dn');
  }

  return {
    buildMtf, renderMtf, renderIndicators, renderLock, renderBook, pushTrade, pushLog, clearLog,
    renderRisk, renderXmkt, renderStrap, renderMethod, renderQuote, renderStatus, renderHover,
    renderGatesMini,
    set activeTf(v) { activeTf = v },
    get activeTf() { return activeTf },
  };
})();
