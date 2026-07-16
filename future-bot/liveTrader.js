const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const api = require('./binanceApi');
const { checkMarketRegime } = require('./marketGate');
const { evaluateTrade, checkExitCriteria } = require('./strategyFutures');

const STATE_FILE = path.join(__dirname, 'live_state.json');
const LOG_FILE   = path.join(__dirname, 'futures_trades.csv');

// ─────────────────────────────────────────────────────────────────────────────
// Exit Architecture (mirrors paperFuturesTrader.js exactly):
//
// Entry
//   │
//   ├─ Initial SL placed on exchange (STOP_MARKET)
//   │
//   ├─ Last closed 15m candle closes above +1R
//   │   → Cancel SL → Replace with break-even STOP_MARKET at entry price
//   │
//   ├─ Live price reaches +1.5R
//   │   → Start ATR Trailing Stop: update SL every cycle
//   │
//   └─ Exit only when SL is triggered on exchange
//
// No TP1. No TP2. No fixed TIME_STOP.
//
// Cooldown:
//   • Only triggered when initial SL is hit (prevents revenge-trading).
//   • Break-even / trail exits → no cooldown (trend could continue).
// ─────────────────────────────────────────────────────────────────────────────

// Configurable constants (keep in sync with paperFuturesTrader.js)
const BREAKEVEN_TRIGGER_R  = 1.0; // Move SL to entry when candle CLOSES above +1R
const TRAIL_TRIGGER_R      = 1.5; // Start ATR trail when profit reaches +1.5R
const ATR_TRAIL_MULTIPLIER = 2.5; // Trail = peak ± (ATR_TRAIL_MULTIPLIER × ATR). Try 2.0/2.5/3.0
const ATR_PERIOD           = 14;  // ATR period used in trailing stop calculation
const SL_COOLDOWN_MS       = 4 * 60 * 60 * 1000; // 4 hours in ms
const RUNNER_TRIGGER_R     = 3.0; // Tighten trail when profit reaches +3R
const RUNNER_TRAIL_MULTIPLIER = 1.5; // Tighter trail multiplier for big runners
const GLOBAL_COOLDOWN_MS   = 2 * 60 * 60 * 1000; // 2 hours global exit cooldown

// Round to exchange step/tick size
function formatStep(value, stepSize) {
    const inv = 1.0 / parseFloat(stepSize);
    return (Math.floor(value * inv) / inv).toFixed(
        Math.max(0, -Math.floor(Math.log10(parseFloat(stepSize))))
    );
}

class LiveFuturesTrader {
    constructor() {
        this.state = this.loadState();
        this.maxPositions     = 3;
        this.riskPerTrade     = 0.01;  // 1% risk per live trade
        this.leverage         = 5;
        this.exchangeInfoCache = null;
    }

    loadState() {
        try {
            if (fs.existsSync(STATE_FILE)) {
                const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
                if (!loaded.lastEntryCandles) loaded.lastEntryCandles = {};
                if (!loaded.cooldowns)         loaded.cooldowns = {};
                return loaded;
            }
        } catch (e) { }
        return {
            positions:                {},
            dailyLosses:              0,
            dailyDrawdownPct:         0,
            lastTradeDate:            new Date().toISOString().split('T')[0],
            accountBalanceStartOfDay: 0,
            lastEntryCandles:         {},
            cooldowns:                {}
        };
    }

    saveState() {
        fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    }

    // ── Exchange info cache ──────────────────────────────────────────────────
    async initExchangeInfo() {
        if (!this.exchangeInfoCache) {
            const res = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
            this.exchangeInfoCache = {};
            for (const s of res.data.symbols) {
                const lotFilter   = s.filters.find(f => f.filterType === 'LOT_SIZE');
                const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
                this.exchangeInfoCache[s.symbol] = {
                    stepSize: lotFilter   ? lotFilter.stepSize   : '0.001',
                    tickSize: priceFilter ? priceFilter.tickSize : '0.0001'
                };
            }
        }
    }

    // ── Daily drawdown limit ─────────────────────────────────────────────────
    checkDailyLimits(currentBalance) {
        const today = new Date().toISOString().split('T')[0];
        if (this.state.lastTradeDate !== today) {
            this.state.lastTradeDate             = today;
            this.state.dailyLosses               = 0;
            this.state.dailyDrawdownPct          = 0;
            this.state.accountBalanceStartOfDay  = currentBalance;
            this.saveState();
            return true;
        }
        if (this.state.accountBalanceStartOfDay === 0) {
            this.state.accountBalanceStartOfDay = currentBalance;
            this.saveState();
        }
        const drawdown = (this.state.accountBalanceStartOfDay - currentBalance) /
                          this.state.accountBalanceStartOfDay;
        if (drawdown >= 0.03) {
            console.log(`Daily Limit: Drawdown ${(drawdown * 100).toFixed(2)}% >= 3%. Pausing new entries for today.`);
            return false;
        }
        return true;
    }

    // ── Cooldown helpers ─────────────────────────────────────────────────────
    isOnCooldown(symbol) {
        if (!this.state.cooldowns) this.state.cooldowns = {};
        const until = this.state.cooldowns[symbol];
        if (!until) return false;
        if (Date.now() < until) {
            const minsLeft = Math.round((until - Date.now()) / 60000);
            console.log(`[${symbol}] On SL cooldown — ${minsLeft} min remaining.`);
            return true;
        }
        delete this.state.cooldowns[symbol];
        return false;
    }

    setCooldown(symbol) {
        if (!this.state.cooldowns) this.state.cooldowns = {};
        this.state.cooldowns[symbol] = Date.now() + SL_COOLDOWN_MS;
        console.log(`[${symbol}] 4-hour SL cooldown activated.`);
    }

    // ── Main cycle ───────────────────────────────────────────────────────────
    async runCycle() {
        console.log(`\n--- Futures Trader Cycle [${new Date().toISOString()}] ---`);
        try {
            await api.syncServerTime();
            await this.initExchangeInfo();

            const currentBalance = await api.getUSDTBalance();
            const limitsOk = this.checkDailyLimits(currentBalance);

            await this.managePositions(currentBalance);

            if (limitsOk) {
                const regime = await checkMarketRegime();
                console.log('Global Market Regime:', regime);
                await this.scanForEntries(regime, currentBalance);
            }
        } catch (error) {
            console.error('Cycle error:', error.message);
        }
    }

    // ── Manage open positions ────────────────────────────────────────────────
    async managePositions(currentBalance) {
        const activePositions = await api.getPositionRisk();
        const myPositions     = activePositions.filter(p => parseFloat(p.positionAmt) !== 0);
        const currentSymbols  = myPositions.map(p => p.symbol);

        // Sync: detect positions closed externally (SL hit on exchange)
        for (const sym of Object.keys(this.state.positions)) {
            if (!currentSymbols.includes(sym)) {
                const pState = this.state.positions[sym];
                console.log(`[${sym}] Position closed externally. Stage was: ${pState.stage}`);
                // Apply cooldown only if it was an initial SL (not break-even or trail)
                if (pState.stage === 'INITIAL') {
                    this.setCooldown(sym);
                }
                // Set global cooldown of 2 hours on any exit
                this.state.globalCooldownUntil = Date.now() + GLOBAL_COOLDOWN_MS;
                console.log(`Global Exit Cooldown activated until ${new Date(this.state.globalCooldownUntil).toISOString()}`);
                delete this.state.positions[sym];
                this.saveState();
            }
        }

        if (myPositions.length === 0) return;

        // Fetch current prices for live positions
        const symbols = myPositions.map(p => p.symbol);
        const priceRes = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price');
        const priceMap = {};
        for (const t of priceRes.data) {
            if (symbols.includes(t.symbol)) priceMap[t.symbol] = parseFloat(t.price);
        }

        // Fetch last closed 15m candle for break-even confirmation
        const lastCandleCloses = {};
        await Promise.all(symbols.map(async (sym) => {
            try {
                const res = await axios.get(
                    `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=15m&limit=2`
                );
                // index 0 = second-to-last (fully closed), index 1 = current open candle
                lastCandleCloses[sym] = parseFloat(res.data[0][4]);
            } catch (e) {
                lastCandleCloses[sym] = null;
            }
        }));

        for (const position of myPositions) {
            const sym = position.symbol;
            let pState = this.state.positions[sym];

            // Skip if we have no local state (e.g. opened manually)
            if (!pState) continue;

            const currentPrice = priceMap[sym];
            const lastClose    = lastCandleCloses[sym];
            if (!currentPrice) continue;

            const isLong      = pState.direction === 'LONG';
            const info        = this.exchangeInfoCache[sym];
            const closeSide   = isLong ? 'SELL' : 'BUY';
            const atr         = pState.atr;
            const initialRisk = Math.abs(pState.entryPrice - pState.initialStopLoss);

            // ── Track peak price (for ATR trailing) ──────────────────────
            if (isLong) {
                pState.peakPrice = Math.max(pState.peakPrice || pState.entryPrice, currentPrice);
            } else {
                pState.peakPrice = Math.min(pState.peakPrice || pState.entryPrice, currentPrice);
            }

            // ── Profit in R-multiples ─────────────────────────────────────
            const profitDistance = isLong
                ? currentPrice - pState.entryPrice
                : pState.entryPrice - currentPrice;
            const profitR = initialRisk > 0 ? profitDistance / initialRisk : 0;

            // ── Stage: INITIAL → BREAKEVEN ────────────────────────────────
            // Requires the LAST CLOSED CANDLE to have closed above +1R.
            if (pState.stage === 'INITIAL' && lastClose !== null && initialRisk > 0) {
                const closedProfitR = isLong
                    ? (lastClose - pState.entryPrice) / initialRisk
                    : (pState.entryPrice - lastClose) / initialRisk;

                if (closedProfitR >= BREAKEVEN_TRIGGER_R) {
                    const bePrice = formatStep(pState.entryPrice, info.tickSize);
                    console.log(`[${sym}] Candle closed above +1R → Moving SL to break-even (${bePrice})`);

                    // Safety: place new SL FIRST, then cancel old one.
                    // This ensures there is always a stop on the exchange,
                    // even if the bot crashes during the transition.
                    await api.placeConditionalOrder(sym, closeSide, 'STOP_MARKET', 0, bePrice, true);
                    await api.cancelAllOpenOrders(sym);
                    // Re-place after cancel to ensure only one clean SL exists
                    await api.placeConditionalOrder(sym, closeSide, 'STOP_MARKET', 0, bePrice, true);

                    pState.stopLoss = pState.entryPrice;
                    pState.stage    = 'BREAKEVEN';
                    this.saveState();
                    continue;
                }
            }

            // ── Stage: BREAKEVEN → TRAILING (at +1.5R live price) ────────
            if (pState.stage === 'BREAKEVEN' && profitR >= TRAIL_TRIGGER_R) {
                pState.stage = 'TRAILING';
                console.log(`[${sym}] +1.5R reached → ATR Trailing Stop activated`);
                this.saveState();
            }

            // ── Stage: TRAILING → RUNNER (at +3.0R live price) ───────────
            if (pState.stage === 'TRAILING' && profitR >= RUNNER_TRIGGER_R) {
                pState.stage = 'RUNNER';
                console.log(`[${sym}] +3.0R reached → ATR Trailing Stop tightened (Accelerated Trail)`);
                this.saveState();
            }

            // ── Update ATR Trailing Stop on exchange ──────────────────────
            if (pState.stage === 'TRAILING' || pState.stage === 'RUNNER') {
                const multiplier = pState.stage === 'RUNNER' ? RUNNER_TRAIL_MULTIPLIER : ATR_TRAIL_MULTIPLIER;
                let newTrailStop;
                if (isLong) {
                    newTrailStop = pState.peakPrice - multiplier * atr;
                    if (newTrailStop <= pState.stopLoss) { this.saveState(); continue; } // no improvement
                } else {
                    newTrailStop = pState.peakPrice + multiplier * atr;
                    if (newTrailStop >= pState.stopLoss) { this.saveState(); continue; } // no improvement
                }

                const trailPrice = formatStep(newTrailStop, info.tickSize);
                console.log(`[${sym}] [${pState.stage}] Updating trail SL → ${trailPrice} (peak: ${pState.peakPrice.toFixed(6)})`);

                // Safety: place new trail SL FIRST, then cancel old one.
                // This ensures there is always a stop on the exchange.
                await api.placeConditionalOrder(sym, closeSide, 'STOP_MARKET', 0, trailPrice, true);
                await api.cancelAllOpenOrders(sym);
                // Re-place after cancel to ensure only one clean SL exists
                await api.placeConditionalOrder(sym, closeSide, 'STOP_MARKET', 0, trailPrice, true);

                pState.stopLoss = newTrailStop;
                this.saveState();
            }

            this.saveState();
        }
    }

    // ── Scan universe for new entries ────────────────────────────────────────
    async scanForEntries(regime, currentBalance) {
        if (Object.keys(this.state.positions).length >= this.maxPositions) return;

        // Global exit cooldown check
        if (this.state.globalCooldownUntil && Date.now() < this.state.globalCooldownUntil) {
            const minsLeft = Math.round((this.state.globalCooldownUntil - Date.now()) / 60000);
            console.log(`[Scan] Skipping entries due to Global Exit Cooldown (${minsLeft} mins left).`);
            return;
        }

        const universePath = path.join(__dirname, 'active_universe.json');
        if (!fs.existsSync(universePath)) return;
        const universe = JSON.parse(fs.readFileSync(universePath, 'utf8'));

        let validSetups = [];
        for (const sym of Object.keys(universe.coins)) {
            if (this.state.positions[sym]) continue;
            if (this.isOnCooldown(sym)) continue;

            // One entry per 15m candle guard
            const currentCandleStart = Math.floor(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000);
            if (this.state.lastEntryCandles?.[sym] === currentCandleStart) continue;

            const metrics  = universe.coins[sym];
            const tradeRes = await evaluateTrade(sym, regime, metrics.fundingRate);

            if (tradeRes.signal !== 'NONE') {
                validSetups.push({ symbol: sym, ...tradeRes });
            } else {
                const logObj = {
                    timestamp:    new Date().toISOString(),
                    symbol:       sym,
                    signal:       'NONE',
                    failedReason: tradeRes.reason
                };
                const logPath = path.join(__dirname, 'trade_evaluations.jsonl');
                fs.appendFile(logPath, JSON.stringify(logObj) + '\n', (err) => { if (err) console.error(err); });
            }
        }

        validSetups.sort((a, b) => b.score - a.score || b.adx - a.adx);

        for (const setup of validSetups) {
            if (Object.keys(this.state.positions).length >= this.maxPositions) break;
            console.log(`Executing ${setup.signal} on ${setup.symbol}. Score: ${setup.score}`);
            await this.executeTrade(setup, currentBalance);
        }
    }

    // ── Execute a new trade on exchange ─────────────────────────────────────
    async executeTrade(setup, balance) {
        try {
            const currentCandleStart = Math.floor(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000);
            if (!this.state.lastEntryCandles) this.state.lastEntryCandles = {};
            this.state.lastEntryCandles[setup.symbol] = currentCandleStart;

            await api.changeMarginType(setup.symbol, 'ISOLATED');
            await api.changeLeverage(setup.symbol, this.leverage);

            const info = this.exchangeInfoCache[setup.symbol];
            if (!info) return;

            const riskAmount   = balance * this.riskPerTrade;
            const distanceToSl = Math.abs(setup.price - setup.stopLoss);
            let positionSize   = riskAmount / distanceToSl;

            // Max leverage cap
            if (positionSize * setup.price > balance * this.leverage) {
                positionSize = (balance * this.leverage) / setup.price;
            }

            const qty     = formatStep(positionSize, info.stepSize);
            const side    = setup.signal === 'LONG' ? 'BUY' : 'SELL';
            const slSide  = side === 'BUY' ? 'SELL' : 'BUY';
            const slPrice = formatStep(setup.stopLoss, info.tickSize);

            // ── Place market entry order ──────────────────────────────────
            await api.placeMarketOrder(setup.symbol, side, qty);

            // ── Place initial Stop Loss only (no TP1/TP2 limit orders) ───
            // Exits are managed in-cycle via break-even + ATR trail logic.
            await api.placeConditionalOrder(setup.symbol, slSide, 'STOP_MARKET', 0, slPrice, true);

            const atr = setup.atr || distanceToSl / 1.2;

            this.state.positions[setup.symbol] = {
                direction:       setup.signal,
                entryPrice:      setup.price,
                originalQty:     parseFloat(qty),
                stopLoss:        parseFloat(slPrice),
                initialStopLoss: parseFloat(slPrice),  // kept for R-multiple calculation
                peakPrice:       setup.price,           // tracks best price for trailing
                atr:             atr,
                stage:           'INITIAL',             // INITIAL → BREAKEVEN → TRAILING
                openedAt:        new Date().toISOString()
            };
            this.saveState();

            console.log(`[${setup.symbol}] Trade opened. Direction: ${setup.signal}, Entry: ${setup.price}, SL: ${slPrice}`);

        } catch (e) {
            console.error(`Failed to execute trade for ${setup.symbol}:`, e.message);
        }
    }

    // ── Emergency full close (used internally if needed) ─────────────────────
    async closePositionFull(symbol) {
        try {
            const positions = await api.getPositionRisk();
            const position  = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);
            if (!position) return;
            const side = parseFloat(position.positionAmt) > 0 ? 'SELL' : 'BUY';
            const qty  = Math.abs(parseFloat(position.positionAmt));
            await api.cancelAllOpenOrders(symbol);
            await api.placeMarketOrder(symbol, side, qty);
        } catch (e) {
            console.error(`Failed to close ${symbol}:`, e.message);
        }
    }
}

module.exports = { LiveFuturesTrader };
