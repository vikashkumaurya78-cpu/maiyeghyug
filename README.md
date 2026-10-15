# 🪙 AURUMX — Advanced Bloomberg-Style XAU/USDT Scalping Terminal

An institutional-grade, Bloomberg-inspired scalping terminal for **XAU/USDT** (Physical Gold pegged 1:1 on Binance). Built for precision scalpers requiring real-time sub-second market data, multi-timeframe confluence, order flow analytics, and a **100% Full-Confidence Signal Lock** execution system.

---

## 🌟 Key Architecture & Highlights

### 1. 100% Real Binance Market Data (Zero Simulation)
- **Direct Real-Time REST APIs**:
  - Primary: `https://data-api.binance.vision/api/v3` (high throughput, dedicated market-data mirror, zero geo-bans)
  - Failover: `https://api.binance.com/api/v3`
- **Sub-100ms Combined WebSocket Stream**:
  - `wss://stream.binance.com:9443/stream?streams=...`
  - Streams: `@ticker`, `@bookTicker`, `@trade`, `@depth20@100ms`, `@kline_{1m,3m,5m,15m,30m,1h,2h,4h,1d}`
- **Physical Gold Peg**:
  - Primary: `PAXGUSDT` (Paxos Gold backed 1:1 by one fine troy ounce of London Good Delivery physical gold in Brink's vaults)
  - Cross-Market Arbitrage Peer: `XAUTUSDT` (Tether Gold)

---

### 2. Multi-Timeframe Signal Confluence Matrix
- Supports all key scalping & swing intervals:
  - **1M, 3M, 5M, 15M, 30M, 1 HOUR, 3 HOUR** (synthesized directly from 1H candles, never invented)
- **Click-to-Switch Navigation**: Click any row in the MTF Confluence Matrix to switch chart, indicators, and signal locks instantly.
- **Top Timeframe Bar**: Keyboard shortcuts `1` through `9` and `0` for instantaneous timeframe switching.

---

### 3. 17 Institutional Technical & Order Flow Indicators
1. **Order Flow CVD (Cumulative Volume Delta)**: Real-time taker buy vs taker sell pressure.
2. **Chaikin Money Flow (CMF 20)**: Institutional accumulation/distribution volume.
3. **TTM Squeeze Pro**: Volatility compression (Bollinger inside Keltner) & directional momentum expansion.
4. **Fair Value Gap (FVG) / SMC**: Smart money 3-bar imbalance detector for optimal retest entries.
5. **EMA Stack (9 / 21 / 50 / 200)**: Trend alignment and dynamic support/resistance.
6. **RSI (14)**: Relative Strength Index with 50-centerline scaling.
7. **Stochastic (14, 3, 3)**: Fast momentum oscillator with overbought/oversold brakes.
8. **MACD (12, 26, 9)**: Histogram momentum and zero-line crossovers.
9. **ADX & DMI (14)**: Directional movement index and trend strength filter.
10. **Bollinger Bands (20, 2)**: %B and bandwidth volatility.
11. **ATR (14)**: Average True Range in price points and % of price.
12. **Supertrend (10, 3)**: Volatility trailing stop flip.
13. **Ichimoku Kinko Hyo**: Tenkan-sen, Kijun-sen, Senkou Span B cloud.
14. **Session VWAP**: Anchored to UTC 00:00:00 session start.
15. **Rolling VWAP**: 50-period volume weighted average price.
16. **Market Structure Swings**: Dynamic pivot highs and swing lows.
17. **Volume Profile**: Point of Control (POC), Value Area Low (VAL), Value Area High (VAH).

---

### 4. 100% Full-Confidence Signal Lock Engine
- **Multi-Gate Validation Filter**:
  - `Live Binance Feed`: Streaming WebSocket active
  - `History Depth`: 210+ closed candles validated
  - `Directional Consensus`: Clear trend bias
  - `Higher-Timeframe Alignment`: 15M/1H confirms 1M/5M scalp
  - `Order Flow Delta & CMF`: Aggressive market orders confirm move
  - `TTM Squeeze Breakout`: Volatility expansion confirms direction
  - `Volatility Regime`: ATR in optimal non-choppy zone
  - `Spread Filter`: Exchange spread within 6% of ATR
- **Locked Scalp Output**:
  - **Ideal Entry Price**: Tick-rounded structural pullback price
  - **Entry Zone**: High-probability entry bracket
  - **Stop Loss**: Structural swing + volatility buffer
  - **Target 1 (TP1)**: 1.5R (high-probability scalp exit)
  - **Target 2 (TP2)**: 2.5R (swing profit target)
  - **Target 3 (TP3)**: 4.0R (runner target with 1 : 4.0 Risk-to-Reward)
  - **Live P/L & Visual Rail**: Real-time position tracking between SL and TP
  - **One-Click Operator Arm**: `⚡ ARM SIGNAL LOCK NOW` button for instant precision execution

---

## 🚀 Running Locally

The terminal is served locally via PowerShell:
```powershell
powershell -ExecutionPolicy Bypass -File "server.ps1" -Port 8080
```
Open **`http://localhost:8080`** in Google Chrome, Microsoft Edge, Brave, or Firefox.

### ⌨️ Keyboard Shortcuts
- `1` – `9`: Switch timeframe (1M, 3M, 5M, 15M, 30M, 1H, 2H, 3H, 4H)
- `0`: Switch to 6H
- `L`: Force arm / release Signal Lock on active timeframe
- `M`: Toggle Methodology modal
- `ESC`: Close open modals
