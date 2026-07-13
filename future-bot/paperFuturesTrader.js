const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const { checkMarketRegime } = require('./marketGate');
const { evaluateTrade, checkExitCriteria } = require('./strategyFutures');

const STATE_FILE = path.join(__dirname, 'paper_futures_state.json');
const TAKER_FEE  = 0.0004; // Binance futures taker fee 0.04%

// ─────────────────────────────────────────────────────────────────────────────
// Exit Architecture (Boss-approved):
//
// Entry
//   │
//   ├─ Initial SL (1.2 × ATR below entry)
//   │
//   ├─ +1R reached → Move SL to break-even (entry price)
//   │
//   ├─ +1.5R reached → Start ATR Trailing Stop (2.5 × ATR from peak)
//   │
//   └─ Exit only when ATR trail or initial SL is hit
//
// No TP1. No TP2. No fixed TIME_STOP.
//
// Cooldown:
//   • Only triggered when initial SL is hit (prevents revenge-trading).
//   • ATR trail exit or break-even exit → no cooldown (trend could continue).
// ─────────────────────────────────────────────────────────────────────────────

const BREAKEVEN_TRIGGER_R  = 1.0; // Move SL to entry when candle CLOSES above +1R
const TRAIL_TRIGGER_R      = 1.5; // Start ATR trail when profit reaches +1.5R
const ATR_TRAIL_MULTIPLIER = 2.5; // Trail = peak ± (ATR_TRAIL_MULTIPLIER × ATR). Try 2.0/2.5/3.0
const ATR_PERIOD           = 14;  // ATR period used in trailing stop calculation
const SL_COOLDOWN_MS       = 4 * 60 * 60 * 1000; // 4 hours in ms

class PaperFuturesTrader {
    constructor(initialBalance = 500) {
        this.initialBalance = initialBalance;
        this.state = this.loadState();
        this.maxPositions   = 3;
        this.riskPerTrade   = 0.003; // 0.3% risk per trade
        this.leverage       = 5;
    }

    loadState() {
        try {
            if (fs.existsSync(STATE_FILE)) {
                const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
                if (!loaded.lastEntryCandles) loaded.lastEntryCandles = {};
                if (!loaded.totalFeesPaid)    loaded.totalFeesPaid = 0;
                if (!loaded.cooldowns)         loaded.cooldowns = {};
                return loaded;
            }
        } catch (e) { }
        return {
            balance:                this.initialBalance,
            initialBalance:         this.initialBalance,
            positions:              {},
            tradeHistory:           [],
            dailyLosses:            0,
            dailyDrawdownPct:       0,
            lastTradeDate:          new Date().toISOString().split('T')[0],
            accountBalanceStartOfDay: this.initialBalance,
            lastEntryCandles:       {},
            cooldowns:              {},
            totalFeesPaid:          0
        };
    }

    saveState() {
        fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    }

    checkDailyLimits() {
        const today = new Date().toISOString().split('T')[0];
        if (this.state.lastTradeDate !== today) {
            this.state.lastTradeDate             = today;
            this.state.dailyLosses               = 0;
            this.state.dailyDrawdownPct          = 0;
            this.state.accountBalanceStartOfDay  = this.state.balance;
            this.saveState();
            return true;
        }
        const drawdown = (this.state.accountBalanceStartOfDay - this.state.balance) /
                          this.state.accountBalanceStartOfDay;
        if (drawdown >= 0.03) {
            console.log(`Daily Limit: Drawdown ${(drawdown * 100).toFixed(2)}% >= 3%. Pausing new entries for today.`);
            return false;
        }
        return true;
    }

    // Returns true if symbol is currently on cooldown (only applied after SL-hit)
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

    async runCycle() {
        console.log(`\n--- Paper Futures Trader Cycle [${new Date().toISOString()}] ---`);
        try {
            const limitsOk = this.checkDailyLimits();

            await this.managePositions();

            if (limitsOk) {
                const regime = await checkMarketRegime();
                console.log('Global Market Regime:', regime);
                await this.scanForEntries(regime);
            }
        } catch (error) {
            console.error('Paper Cycle error:', error.message);
        }
    }

    async getCurrentPrices(symbols) {
        if (symbols.length === 0) return {};
        const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/price');
        const priceMap = {};
        for (const t of res.data) {
            if (symbols.includes(t.symbol)) {
                priceMap[t.symbol] = parseFloat(t.price);
            }
        }
        this.state.currentPrices = priceMap;
        return priceMap;
    }

    async managePositions() {
        const symbols = Object.keys(this.state.positions);
        if (symbols.length === 0) return;

        const currentPrices = await this.getCurrentPrices(symbols);

        // Fetch last CLOSED 15m candle for each position.
        // Break-even is triggered only when a candle CLOSES above +1R,
        // not just a wick, to avoid moving SL on brief spikes.
        const lastCandleCloses = {};
        await Promise.all(symbols.map(async (sym) => {
            try {
                const res = await axios.get(
                    `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=15m&limit=2`
                );
                // index 0 = second-to-last (fully closed), index 1 = current (open candle)
                lastCandleCloses[sym] = parseFloat(res.data[0][4]);
            } catch (e) {
                lastCandleCloses[sym] = null;
            }
        }));

        for (const sym of symbols) {
            let pState = this.state.positions[sym];
            const currentPrice = currentPrices[sym];
            const lastClose    = lastCandleCloses[sym]; // last fully-closed candle close
            if (!currentPrice) continue;

            const isLong      = pState.direction === 'LONG';
            const atr         = pState.atr;
            const initialRisk = Math.abs(pState.entryPrice - pState.initialStopLoss); // 1R in price

            // ── Track peak price using live price (for ATR trailing) ──────
            if (isLong) {
                pState.peakPrice = Math.max(pState.peakPrice || pState.entryPrice, currentPrice);
            } else {
                pState.peakPrice = Math.min(pState.peakPrice || pState.entryPrice, currentPrice);
            }

            // ── Profit in R-multiples (live price, used for trail trigger) ─
            const profitDistance = isLong
                ? currentPrice - pState.entryPrice
                : pState.entryPrice - currentPrice;
            const profitR = initialRisk > 0 ? profitDistance / initialRisk : 0;

            // ── Stage: INITIAL → BREAKEVEN ────────────────────────────────
            // Uses the LAST CLOSED CANDLE's close price — not the live tick.
            // This prevents moving SL on a wick that immediately retraces.
            if (pState.stage === 'INITIAL' && lastClose !== null && initialRisk > 0) {
                const closedProfitR = isLong
                    ? (lastClose - pState.entryPrice) / initialRisk
                    : (pState.entryPrice - lastClose) / initialRisk;
                if (closedProfitR >= BREAKEVEN_TRIGGER_R) {
                    pState.stopLoss = pState.entryPrice;
                    pState.stage    = 'BREAKEVEN';
                    console.log(`[${sym}] Candle closed above +1R (closedR=${closedProfitR.toFixed(2)}) → SL → break-even`);
                }
            }

            // ── Stage: BREAKEVEN → TRAILING (at +1.5R live price) ────────
            if (pState.stage === 'BREAKEVEN' && profitR >= TRAIL_TRIGGER_R) {
                pState.stage = 'TRAILING';
                console.log(`[${sym}] +1.5R reached → ATR Trailing Stop activated`);
            }

            // ── Update ATR Trailing Stop ──────────────────────────────────
            if (pState.stage === 'TRAILING') {
                if (isLong) {
                    const trailStop = pState.peakPrice - ATR_TRAIL_MULTIPLIER * atr;
                    if (trailStop > pState.stopLoss) {
                        pState.stopLoss = trailStop;
                        console.log(`[${sym}] Trail SL → ${trailStop.toFixed(6)} (peak: ${pState.peakPrice.toFixed(6)})`);
                    }
                } else {
                    const trailStop = pState.peakPrice + ATR_TRAIL_MULTIPLIER * atr;
                    if (trailStop < pState.stopLoss) {
                        pState.stopLoss = trailStop;
                        console.log(`[${sym}] Trail SL → ${trailStop.toFixed(6)} (peak: ${pState.peakPrice.toFixed(6)})`);
                    }
                }
            }

            // ── Stop Loss Hit ─────────────────────────────────────────────
            const hitSL = isLong
                ? currentPrice <= pState.stopLoss
                : currentPrice >= pState.stopLoss;

            if (hitSL) {
                const isInitialSL = pState.stage === 'INITIAL';
                const reason = isInitialSL ? 'STOP_LOSS' : (pState.stage === 'TRAILING' ? 'TRAIL_STOP' : 'BREAKEVEN_STOP');
                console.log(`[${sym}] ${reason} hit at ${pState.stopLoss.toFixed(6)}`);
                this.closePosition(sym, pState.stopLoss, reason);

                // Only apply cooldown when the initial SL is hit (prevents revenge trading)
                if (isInitialSL) {
                    this.setCooldown(sym);
                }
                continue;
            }

            this.saveState();
        }
    }

    closePosition(symbol, exitPrice, reason) {
        const pState = this.state.positions[symbol];
        if (!pState) return;
        const isLong = pState.direction === 'LONG';

        const rawPnl = isLong
            ? (exitPrice - pState.entryPrice) * pState.qty
            : (pState.entryPrice - exitPrice) * pState.qty;

        const fee = pState.qty * exitPrice * TAKER_FEE;
        const pnl = rawPnl - fee;

        this.state.totalFeesPaid = (this.state.totalFeesPaid || 0) + fee;
        this.state.balance += pnl;

        if (pnl < 0) this.state.dailyLosses++;

        this.state.tradeHistory.push({
            action:     'CLOSE_' + pState.direction,
            coin:       symbol,
            entryPrice: pState.entryPrice,
            exitPrice:  exitPrice,
            qty:        pState.qty,
            amount:     pState.qty,
            grossPnl:   parseFloat(rawPnl.toFixed(4)),
            feePaid:    parseFloat(fee.toFixed(4)),
            pnl:        parseFloat(pnl.toFixed(4)),
            pnlPct:     parseFloat((pnl / (pState.costBasis || (pState.entryPrice * pState.qty / this.leverage))).toFixed(6)),
            reason:     reason,
            timestamp:  new Date().toISOString()
        });

        delete this.state.positions[symbol];
        this.saveState();
    }

    async scanForEntries(regime) {
        if (Object.keys(this.state.positions).length >= this.maxPositions) return;

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
            console.log(`[PAPER] Executing ${setup.signal} on ${setup.symbol}. Score: ${setup.score}`);
            this.executeTrade(setup);
        }
    }

    executeTrade(setup) {
        const currentCandleStart = Math.floor(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000);
        if (!this.state.lastEntryCandles) this.state.lastEntryCandles = {};
        this.state.lastEntryCandles[setup.symbol] = currentCandleStart;

        const riskAmount   = this.state.balance * this.riskPerTrade;
        const distanceToSl = Math.abs(setup.price - setup.stopLoss);
        let positionSize   = riskAmount / distanceToSl;

        // Max leverage cap
        const maxNotional = this.state.balance * this.leverage;
        if (positionSize * setup.price > maxNotional) {
            positionSize = maxNotional / setup.price;
        }

        // Open fee (taker)
        const notional = positionSize * setup.price;
        const openFee  = notional * TAKER_FEE;
        this.state.totalFeesPaid = (this.state.totalFeesPaid || 0) + openFee;
        this.state.balance -= openFee;

        const atr = setup.atr || distanceToSl / 1.2;

        this.state.positions[setup.symbol] = {
            direction:      setup.signal,
            entryPrice:     setup.price,
            qty:            positionSize,
            originalQty:    positionSize,
            amount:         positionSize,               // for dashboard
            costBasis:      notional / this.leverage,   // margin used
            stopLoss:       setup.stopLoss,
            initialStopLoss: setup.stopLoss,            // kept for +1R calculation
            peakPrice:      setup.price,               // tracks best price for trailing
            atr:            atr,
            stage:          'INITIAL',                 // INITIAL → BREAKEVEN → TRAILING
            openedAt:       new Date().toISOString()
        };

        this.state.tradeHistory.push({
            action:     setup.signal,
            coin:       setup.symbol,
            entryPrice: setup.price,
            qty:        positionSize,
            amount:     positionSize,
            costBasis:  notional / this.leverage,
            feePaid:    parseFloat(openFee.toFixed(4)),
            pnl:        0,
            pnlPct:     0,
            reason:     setup.reason,
            timestamp:  new Date().toISOString()
        });

        this.saveState();
    }
}

module.exports = { PaperFuturesTrader };
