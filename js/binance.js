/* ══════════════════════════════════════════════════════════════
   binance.js — Real-Time Binance Data Feed for XAU/USDT Scalping
   
   Direct connection to Binance Spot & Vision APIs for Physical Gold:
     - REST API  : data-api.binance.vision / api.binance.com
     - WebSocket : stream.binance.com:9443 / data-stream.binance.vision
     - Symbol    : PAXGUSDT (Binance 1:1 London Good Delivery Gold)
     - Peer      : XAUTUSDT (Tether Gold cross-market correlation)
   ══════════════════════════════════════════════════════════════ */
'use strict';

const FEED = (() => {
  const { SYMBOL, TIMEFRAMES, NATIVE_TF, TF_MAP, isNum, clamp, last, Latency, bus } = CORE;

  const BINANCE_PAIR = 'PAXGUSDT';
  const CROSS_PAIR = 'XAUTUSDT';

  const REST_HOSTS = [
    'data-api.binance.vision',
    'api.binance.com',
    'api1.binance.com',
    'api2.binance.com',
    'api3.binance.com',
  ];

  const WS_HOSTS = [
    'stream.binance.com:9443',
    'data-stream.binance.vision',
    'stream.binance.com:443',
  ];

  const KLINE_STREAMS = [...new Set([...NATIVE_TF, '1d'])];
  const WS_STALE_MS = 35000, WS_PING_MS = 25000, REST_TIMEOUT = 8000;

  const state = {
    restBase: REST_HOSTS[0],
    wsHost: WS_HOSTS[0],
    clockOffset: 0,
    ready: false,
    restOk: false,
    restCooldown: 0,
    filters: { tickSize: 0.01, stepSize: 0.0001, minQty: 0.0001, notional: 5, precision: 2, qtyPrecision: 4 },
    series: new Map(),
    daily: [],
    quote: null,
    ticker: null,
    book: null,
    mark: null,
    spot: {},
    inflight: 0,
    seq: 0,
    streamCount: {},
    lastEventE: 0,
    activeTf: '1m',
    wsLive: false,
    lastMsg: { quote: 0, book: 0, ticker: 0, mark: 0, trades: 0, kline: 0 },
    degraded: { quote: true, book: true, ticker: true, mark: true, trades: true, kline: true },
    announced: {},
    aggId: 0,
    aggSeeded: false,
  };

  TIMEFRAMES.forEach(t => state.series.set(t.id, []));

  const latency = Latency(240);
  const now = () => Date.now() + state.clockOffset;
  const serverNow = now;

  /* ═══════════ REST CLIENT ═══════════ */
  async function rest(path, params = {}) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
    if (state.restCooldown > Date.now()) throw new Error('REST paused (rate limit)');
    let lastErr = null;

    for (let attempt = 0; attempt < REST_HOSTS.length; attempt++) {
      const host = REST_HOSTS[attempt];
      const target = `https://${host}${path}${qs.toString() ? '?' + qs : ''}`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), REST_TIMEOUT);

      try {
        state.inflight++;
        const r = await fetch(target, { signal: ac.signal, cache: 'no-store' });
        if (r.status === 429 || r.status === 418) {
          const wait = Math.min(Number(r.headers.get('retry-after') || 5) * 1000, 15000);
          state.restCooldown = Date.now() + wait;
          lastErr = new Error(`Rate limited (${r.status})`);
          break;
        }
        if (!r.ok) {
          lastErr = new Error(`HTTP ${r.status} from ${host}`);
          continue;
        }
        const data = await r.json();
        state.restBase = host;
        state.restOk = true;
        return data;
      } catch (e) {
        lastErr = e;
      } finally {
        state.inflight--;
        clearTimeout(timer);
      }
    }
    state.restOk = false;
    throw lastErr || new Error('REST unreachable on Binance hosts');
  }

  const fetchTime    = () => rest('/api/v3/time').then(d => d.serverTime);
  const fetchTicker  = () => rest('/api/v3/ticker/24hr', { symbol: BINANCE_PAIR });
  const fetchBook    = () => rest('/api/v3/depth', { symbol: BINANCE_PAIR, limit: 20 });
  const fetchSpotPx  = s => rest('/api/v3/ticker/price', { symbol: s }).then(d => Number(d.price));
  const fetchSpot24  = s => rest('/api/v3/ticker/24hr', { symbol: s });

  async function fetchFilters() {
    try {
      const info = await rest('/api/v3/exchangeInfo', { symbol: BINANCE_PAIR });
      const s = info?.symbols?.find(x => x.symbol === BINANCE_PAIR);
      if (s) {
        const p = s.filters.find(f => f.filterType === 'PRICE_FILTER') || {};
        const l = s.filters.find(f => f.filterType === 'LOT_SIZE') || {};
        const n = s.filters.find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL') || {};
        const dec = v => (String(v).split('.')[1] || '').length;
        state.filters = {
          tickSize: Number(p.tickSize) || 0.01,
          stepSize: Number(l.stepSize) || 0.0001,
          minQty: Number(l.minQty) || 0.0001,
          notional: Number(n.minNotional || n.notional || 5),
          precision: dec(p.tickSize || 0.01),
          qtyPrecision: dec(l.stepSize || 0.0001),
          status: s.status,
        };
      }
    } catch (e) {
      // safe fallback
      state.filters = { tickSize: 0.01, stepSize: 0.0001, minQty: 0.0001, notional: 5, precision: 2, qtyPrecision: 4 };
    }
    state.precisionReady = true;
    return state.filters;
  }

  async function fetchKlines(interval, limit = 500) {
    const rows = await rest('/api/v3/klines', { symbol: BINANCE_PAIR, interval, limit });
    return rows.map(r => ({
      time: r[0],
      open: +r[1],
      high: +r[2],
      low: +r[3],
      close: +r[4],
      volume: +r[5],
      closeTime: r[6],
      quoteVol: +r[7],
      trades: r[8],
      takerBuy: +r[9],
      confirmed: r[6] <= now(),
    }));
  }

  /* ═══════════ CANDLE STORAGE ═══════════ */
  function put(tf, c) {
    if (!isNum(c.time) || !(c.close > 0) || !(c.high >= Math.max(c.open, c.close)) || !(c.low <= Math.min(c.open, c.close))) return false;
    const arr = state.series.get(tf);
    if (!arr) return false;
    const i = arr.length ? binarySearch(arr, c.time) : -1;
    if (i >= 0) {
      const prev = arr[i];
      if (prev.confirmed && !c.confirmed) return false;
      arr[i] = c;
    } else {
      const tail = arr[arr.length - 1];
      if (tail && c.time <= tail.time) return false;
      arr.push(c);
      if (arr.length > 900) arr.splice(0, arr.length - 900);
    }
    if (tf === '1h') rebuild3h();
    if (tf === '1d') state.daily = state.series.get('1d').slice();
    return true;
  }

  function binarySearch(arr, t) {
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (arr[m].time === t) return m;
      if (arr[m].time < t) lo = m + 1;
      else hi = m - 1;
    }
    return -1;
  }

  const H3 = 3 * 3600 * 1000;
  function rebuild3h() {
    const h1 = state.series.get('1h');
    if (!h1 || !h1.length) return;
    const buckets = new Map();
    for (const c of h1) {
      const key = Math.floor(c.time / H3) * H3;
      let b = buckets.get(key);
      if (!b) {
        b = { time: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, takerBuy: c.takerBuy, trades: c.trades, synthetic: true };
        buckets.set(key, b);
      } else {
        b.high = Math.max(b.high, c.high);
        b.low = Math.min(b.low, c.low);
        b.close = c.close;
        b.volume += c.volume;
        b.takerBuy += (c.takerBuy || 0);
        b.trades += (c.trades || 0);
      }
    }
    const out = [...buckets.values()].sort((a, b) => a.time - b.time);
    out.forEach(b => {
      b.confirmed = b.time + H3 <= now();
      b.closeTime = b.time + H3 - 1;
    });
    state.series.set('3h', out.slice(-900));
  }

  /* ═══════════ WEBSOCKET ═══════════ */
  let ws = null;
  let wsTimer = null;
  let stopped = false;
  let wsAttempt = 0;
  let lastWsActivity = Date.now();

  function buildStreamUrl() {
    const sym = BINANCE_PAIR.toLowerCase();
    const cross = CROSS_PAIR.toLowerCase();
    const streams = [
      `${sym}@ticker`,
      `${sym}@bookTicker`,
      `${sym}@trade`,
      `${sym}@depth20@100ms`,
      ...KLINE_STREAMS.map(k => `${sym}@kline_${k}`),
      `${cross}@ticker`,
    ];
    const host = state.wsHost || WS_HOSTS[0];
    return `wss://${host}/stream?streams=${streams.join('/')}`;
  }

  function openSocket() {
    if (stopped) return;
    try {
      if (ws) {
        ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
        ws.close();
      }
    } catch {}

    const url = buildStreamUrl();
    try {
      ws = new WebSocket(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    const t0 = performance.now();

    ws.onopen = () => {
      wsAttempt = 0;
      state.wsLive = true;
      lastWsActivity = Date.now();
      log('SYS', 'Binance Live Stream Attached', `host <b>${state.wsHost}</b> · Real-time feeds: ticker, depth, trade, klines`);
      bus.emit('status', status());
      bus.emit('boot-progress', { pct: 88, msg: 'Binance Live Streams connected' });

      clearInterval(wsTimer);
      wsTimer = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastWsActivity > WS_STALE_MS) {
          try { ws.close(); } catch {}
        }
      }, WS_PING_MS);
    };

    ws.onmessage = ev => {
      if (typeof ev.data !== 'string') return;
      lastWsActivity = Date.now();
      if (ev.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.result !== undefined || msg.error) return;
      const data = msg.data || msg;
      const stream = msg.stream || '';
      handleMessage(stream, data, performance.now(), t0);
    };

    ws.onerror = () => {
      try { ws.close(); } catch {}
    };

    ws.onclose = () => {
      state.wsLive = false;
      clearInterval(wsTimer);
      bus.emit('status', status());
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (stopped) return;
    wsAttempt++;
    if (wsAttempt % 2 === 0) {
      const idx = WS_HOSTS.indexOf(state.wsHost);
      state.wsHost = WS_HOSTS[(idx + 1) % WS_HOSTS.length];
    }
    const wait = Math.min(10000, 800 * Math.pow(1.5, wsAttempt)) + Math.random() * 400;
    setTimeout(openSocket, wait);
  }

  function handleMessage(stream, d, recvPerf, _t0) {
    if (!d) return;
    state.streamCount[stream] = (state.streamCount[stream] || 0) + 1;

    // Latency tracking
    if (isNum(d.E)) {
      state.lastEventE = Math.max(state.lastEventE || 0, d.E);
      const est = Date.now() - (d.E - state.clockOffset);
      if (est >= -5 && est < 60000) latency.push(est);
    }

    const cat = stream.endsWith('@bookTicker') ? 'quote'
      : stream.includes('@depth') ? 'book'
      : stream.endsWith('@ticker') ? 'ticker'
      : stream.endsWith('@trade') ? 'trades'
      : stream.includes('@kline_') ? 'kline' : null;

    if (cat) {
      state.lastMsg[cat] = Date.now();
      if (state.degraded[cat]) {
        state.degraded[cat] = false;
        bus.emit('status', status());
      }
    }

    // Cross-market ticker
    if (stream.startsWith(CROSS_PAIR.toLowerCase())) {
      const px = +d.c ?? +d.price;
      if (px > 0) {
        state.spot[CROSS_PAIR] = { price: px, changePct: +d.P ?? null, E: d.E ?? Date.now() };
        bus.emit('spot', state.spot);
      }
      return;
    }

    // @bookTicker
    if (stream.endsWith('@bookTicker')) {
      const bid = +d.b, ask = +d.a;
      if (bid > 0 && ask > 0 && ask >= bid) {
        state.quote = {
          bid, ask,
          bidQty: +d.B, askQty: +d.A,
          last: state.quote?.last ?? (bid + ask) / 2,
          E: d.E || Date.now(),
          T: d.T || Date.now(),
        };
        enrichActive((bid + ask) / 2);
        bus.emit('quote', state.quote);
      }
      return;
    }

    // @ticker
    if (stream.endsWith('@ticker')) {
      const t = {
        last: +d.c,
        open24: +d.o,
        high: +d.h,
        low: +d.l,
        vol: +d.v,
        quoteVol: +d.q,
        trades: d.n,
        changePct: +d.P,
        change: +d.p,
        E: d.E,
      };
      if (t.last > 0) {
        state.ticker = t;
        state.spot[BINANCE_PAIR] = { price: t.last, changePct: t.changePct, E: d.E };
        if (!state.quote) {
          state.quote = { bid: t.last - 0.05, ask: t.last + 0.05, last: t.last, E: d.E };
        } else {
          state.quote.last = t.last;
        }
        enrichActive(t.last);
        bus.emit('ticker', t);
        bus.emit('quote', state.quote);
        bus.emit('spot', state.spot);
      }
      return;
    }

    // @trade
    if (stream.endsWith('@trade')) {
      const tr = {
        price: +d.p,
        qty: +d.q,
        time: d.T,
        E: d.E,
        maker: d.m,
        id: d.t,
      };
      if (tr.price > 0) {
        bus.emit('trade', tr);
        enrichActive(tr.price);
      }
      return;
    }

    // @depth
    if (stream.includes('@depth')) {
      const book = {
        bids: (d.bids || d.b || []).map(x => [+x[0], +x[1]]).filter(x => x[0] > 0),
        asks: (d.asks || d.a || []).map(x => [+x[0], +x[1]]).filter(x => x[0] > 0),
        updateId: d.lastUpdateId ?? d.u,
        E: d.E ?? Date.now(),
      };
      if (book.bids.length && book.asks.length) {
        state.book = book;
        bus.emit('book', book);
        if (!state.quote || !state.quote.bid) {
          state.quote = {
            bid: book.bids[0][0],
            ask: book.asks[0][0],
            bidQty: book.bids[0][1],
            askQty: book.asks[0][1],
            last: (book.bids[0][0] + book.asks[0][0]) / 2,
            E: Date.now(),
          };
          bus.emit('quote', state.quote);
        }
      }
      return;
    }

    // @kline_
    if (stream.includes('@kline_')) {
      const k = d.k;
      if (!k) return;
      const tf = k.i;
      const mapped = TIMEFRAMES.find(t => t.kline === tf)?.id;
      const candle = {
        time: k.t,
        open: +k.o,
        high: +k.h,
        low: +k.l,
        close: +k.c,
        volume: +k.v,
        takerBuy: +k.V,
        trades: +k.n,
        closeTime: k.T,
        confirmed: !!k.x,
      };
      if (mapped) {
        if (put(mapped, candle)) bus.emit('kline', { tf: mapped, candle });
      } else if (tf === '1d') {
        if (put('1d', candle)) bus.emit('kline', { tf: '1d', candle });
      }
      return;
    }
  }

  function enrichActive(price) {
    if (!isNum(price) || price <= 0) return;
    const arr = state.series.get(state.activeTf);
    if (!arr || !arr.length) return;
    const c = arr[arr.length - 1];
    if (!c || c.confirmed || !isNum(c.open)) return;
    if (price > c.high) c.high = price;
    if (price < c.low) c.low = price;
    c.close = price;
    c.live = true;
  }

  /* ═══════════ REFRESHERS & REST FALLBACK ═══════════ */
  const klineIntervalFor = tf => (TF_MAP[tf]?.kline || TF_MAP[tf]?.synth || '1m');

  async function refreshTf(tf) {
    const iv = klineIntervalFor(tf);
    const rows = await fetchKlines(iv, iv === '1h' ? 300 : 250);
    const target = TIMEFRAMES.find(t => t.kline === iv);
    const id = target ? target.id : '1h';
    let changed = false;
    rows.forEach(r => { if (put(id, r)) changed = true; });
    if (id === '1h') rebuild3h();
    if (changed) bus.emit('kline', { tf: id, candle: rows[rows.length - 1] });
    if (tf === '3h') bus.emit('kline', { tf: '3h', candle: last(state.series.get('3h')) });
    return changed;
  }

  async function refreshTickerAndMark() {
    try {
      const t = await fetchTicker();
      state.ticker = {
        last: +t.lastPrice,
        open24: +t.openPrice,
        high: +t.highPrice,
        low: +t.lowPrice,
        vol: +t.volume,
        quoteVol: +t.quoteVolume,
        trades: +t.count,
        changePct: +t.priceChangePercent,
        change: +t.priceChange,
      };
      if (state.ticker.last > 0) {
        bus.emit('ticker', state.ticker);
        state.spot[BINANCE_PAIR] = { price: state.ticker.last, changePct: state.ticker.changePct, E: Date.now() };
        bus.emit('spot', state.spot);
      }
    } catch {}
  }

  async function refreshBook() {
    try {
      const b = await fetchBook();
      if (b && b.bids?.length && b.asks?.length) {
        state.book = {
          bids: b.bids.map(x => [+x[0], +x[1]]),
          asks: b.asks.map(x => [+x[0], +x[1]]),
          updateId: b.lastUpdateId,
          E: Date.now(),
        };
        bus.emit('book', state.book);
      }
    } catch {}
  }

  function startRefreshers() {
    const HEARTBEAT_MS = 18000;
    const due = { kline: 0, klines: 0, slow: 0, book: 0, clock: 0 };
    let rot = 0;

    async function tick() {
      if (stopped) return;
      const t = Date.now();
      const paused = state.restCooldown > t;

      // Heartbeat degradation check
      for (const cat of ['quote', 'book', 'ticker', 'trades', 'kline']) {
        const silent = t - (state.lastMsg[cat] || 0) > HEARTBEAT_MS;
        state.degraded[cat] = silent;
      }

      if (t >= due.clock) {
        due.clock = t + 60000;
        try {
          const st = await fetchTime();
          state.clockOffset = st - Date.now();
        } catch {}
      }

      // If kline stream is quiet, poll active timeframe
      if (!paused && state.degraded.kline && t >= due.kline) {
        due.kline = t + 2500;
        refreshTf(state.activeTf).catch(() => {});
      }

      // Rotate through timeframes
      if (!paused && t >= due.klines) {
        due.klines = t + 6000;
        const others = TIMEFRAMES.filter(x => x.id !== state.activeTf).map(x => x.id);
        const tf = others[rot++ % others.length];
        refreshTf(tf).catch(() => {});
      }

      if (!paused && state.degraded.ticker && t >= due.slow) {
        due.slow = t + 6000;
        refreshTickerAndMark().catch(() => {});
      }

      if (!paused && state.degraded.book && t >= due.book) {
        due.book = t + 2500;
        refreshBook().catch(() => {});
      }
    }

    setInterval(() => tick().catch(() => {}), 500);
  }

  /* ═══════════ INITIALIZATION ═══════════ */
  async function boot(log) {
    const step = (pct, msg) => bus.emit('boot-progress', { pct, msg });

    step(10, 'Synchronizing Binance exchange clock');
    try {
      const serverTime = await fetchTime();
      state.clockOffset = serverTime - Date.now();
    } catch (e) {
      state.clockOffset = 0;
    }

    step(22, 'Loading Gold specifications & filters');
    try {
      await fetchFilters();
    } catch (e) {
      log && log('WARN', 'Filters', e.message);
    }

    step(35, 'Pulling 9 timeframe histories (1M, 3M, 5M, 15M, 30M, 1H, 3H…)');
    const intervals = [...KLINE_STREAMS];
    let done = 0;
    for (const iv of intervals) {
      try {
        const rows = await fetchKlines(iv, 500);
        const tf = TIMEFRAMES.find(t => t.kline === iv);
        if (tf) state.series.set(tf.id, rows);
        if (iv === '1h') {
          state.series.set('1h', rows);
          rebuild3h();
        }
        if (iv === '1d') state.daily = rows;
      } catch (e) {
        log && log('WARN', `Klines ${iv}`, e.message);
      }
      done++;
      step(35 + Math.round(done / intervals.length * 35), `Loaded ${iv} · ${done}/${intervals.length} timeframes`);
    }

    step(72, 'Seeding ticker, depth & cross-market data');
    try {
      const [t, bookR, crossT] = await Promise.all([
        fetchTicker().catch(() => null),
        fetchBook().catch(() => null),
        fetchSpot24(CROSS_PAIR).catch(() => null),
      ]);
      if (t) {
        state.ticker = {
          last: +t.lastPrice,
          open24: +t.openPrice,
          high: +t.highPrice,
          low: +t.lowPrice,
          vol: +t.volume,
          quoteVol: +t.quoteVolume,
          trades: +t.count,
          changePct: +t.priceChangePercent,
          change: +t.priceChange,
        };
        state.quote = {
          bid: +t.lastPrice - 0.05,
          ask: +t.lastPrice + 0.05,
          last: +t.lastPrice,
          E: Date.now(),
        };
        state.spot[BINANCE_PAIR] = { price: +t.lastPrice, changePct: +t.priceChangePercent, E: Date.now() };
        bus.emit('ticker', state.ticker);
        bus.emit('quote', state.quote);
      }
      if (crossT) {
        state.spot[CROSS_PAIR] = { price: +crossT.lastPrice, changePct: +crossT.priceChangePercent, E: Date.now() };
        bus.emit('spot', state.spot);
      }
      if (bookR && bookR.bids?.length) {
        state.book = {
          bids: bookR.bids.map(x => [+x[0], +x[1]]),
          asks: bookR.asks.map(x => [+x[0], +x[1]]),
          updateId: bookR.lastUpdateId,
          E: Date.now(),
        };
        bus.emit('book', state.book);
      }
    } catch (e) {
      log && log('WARN', 'Snapshot', e.message);
    }

    step(82, 'Connecting real-time Binance WebSocket streams');
    stopped = false;
    openSocket();
    startRefreshers();

    state.ready = true;
    step(100, 'Terminal Online · Live Market Streaming');
    bus.emit('status', status());
    return true;
  }

  function setActiveTf(tf) {
    if (!TF_MAP[tf] || tf === state.activeTf) return;
    state.activeTf = tf;
    if (state.degraded.kline) refreshTf(tf).catch(() => {});
  }

  function log(kind, title, detail) {
    bus.emit('log', { kind, title, detail });
  }

  function status() {
    return {
      ready: state.ready,
      restOk: state.restOk,
      restBase: state.restBase,
      futWs: !!state.wsLive,
      spotWs: !!state.wsLive,
      futHost: state.wsHost,
      spotHost: state.wsHost,
      clockOffset: state.clockOffset,
      lastEventE: state.lastEventE,
      streamCount: state.streamCount,
      degraded: { ...state.degraded },
      latency: { now: latency.now, p50: latency.p50, p95: latency.p95, rate: latency.rate },
      bars: TIMEFRAMES.map(t => ({ tf: t.id, n: (state.series.get(t.id) || []).length })),
    };
  }

  function stop() {
    stopped = true;
    clearInterval(wsTimer);
    try { ws && ws.close(); } catch {}
  }

  window.addEventListener('pagehide', stop);

  return {
    SYMBOL,
    BINANCE_PAIR,
    CROSS_PAIR,
    state,
    latency,
    boot,
    startRefreshers,
    status,
    rest,
    fetchSpot24,
    fetchSpotPx,
    fetchKlines,
    fetchFilters,
    fetchTicker,
    fetchBook,
    stop,
    setActiveTf,
    getSeries: tf => state.series.get(tf) || [],
    now,
    serverNow,
  };
})();
