const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { checkMarketRegime } = require('./marketGate');
const { evaluateTrade, checkExitCriteria } = require('./strategyFutures');

const STATE_FILE = path.join(__dirname, 'paper_futures_state.json');
const TAKER_FEE = 0.0004; // Binance futures taker fee 0.04%

class PaperFuturesTrader {
    constructor(initialBalance = 500) {
        this.initialBalance = initialBalance;
        this.state = this.loadState();
        this.maxPositions = 2;
        this.riskPerTrade = 0.003; // 0.3% risk per trade
        this.leverage = 5;
    }

    loadState() {
        try {
            if (fs.existsSync(STATE_FILE)) {
                const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
                if (!loaded.lastEntryCandles) loaded.lastEntryCandles = {};
                if (!loaded.totalFeesPaid) loaded.totalFeesPaid = 0;
                return loaded;
            }
        } catch (e) { }
        return {
            balance: this.initialBalance,
            initialBalance: this.initialBalance,
            positions: {},
            tradeHistory: [],
            dailyLosses: 0,
            dailyDrawdownPct: 0,
            lastTradeDate: new Date().toISOString().split('T')[0],
            accountBalanceStartOfDay: this.initialBalance,
            lastEntryCandles: {},
            totalFeesPaid: 0
        };
    }

    saveState() {
        fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    }

    checkDailyLimits() {
        const today = new Date().toISOString().split('T')[0];
        if (this.state.lastTradeDate !== today) {
            this.state.lastTradeDate = today;
            this.state.dailyLosses = 0;
            this.state.dailyDrawdownPct = 0;
            this.state.accountBalanceStartOfDay = this.state.balance;
            this.saveState();
            return true;
        }

        const drawdown = (this.state.accountBalanceStartOfDay - this.state.balance) / this.state.accountBalanceStartOfDay;
        
        if (drawdown >= 0.03) {
            console.log(`Daily Limit: Drawdown ${(drawdown*100).toFixed(2)}% >= 3%. Pausing new entries for today.`);
            return false;
        }
        return true;
    }

    async runCycle() {
        console.log(`\n--- Paper Futures Trader Cycle [${new Date().toISOString()}] ---`);
        try {
            const limitsOk = this.checkDailyLimits();

            await this.managePositions();

            if (limitsOk) {
                const regime = await checkMarketRegime();
                console.log("Global Market Regime:", regime);
                await this.scanForEntries(regime);
            }
        } catch (error) {
            console.error("Paper Cycle error:", error.message);
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

        for (const sym of symbols) {
            let pState = this.state.positions[sym];
            pState.candlesHeld = (pState.candlesHeld || 0) + 1;

            const currentPrice = currentPrices[sym];
            if (!currentPrice) continue;

            const isLong = pState.direction === 'LONG';

            // ── Trailing Stop (active after TP1) ────────────────────────
            if (pState.stage === 'TP1' || pState.stage === 'TP2') {
                const atr = pState.atr || Math.abs(pState.tp1 - pState.entryPrice) / 1.0;
                if (isLong) {
                    const trailStop = currentPrice - atr;
                    if (trailStop > pState.stopLoss) {
                        pState.stopLoss = trailStop;
                        console.log(`[${sym}] Trailing SL moved up to ${trailStop.toFixed(6)}`);
                    }
                } else {
                    const trailStop = currentPrice + atr;
                    if (trailStop < pState.stopLoss) {
                        pState.stopLoss = trailStop;
                        console.log(`[${sym}] Trailing SL moved down to ${trailStop.toFixed(6)}`);
                    }
                }
            }

            // ── Stop Loss ───────────────────────────────────────────────
            const hitSL = isLong ? (currentPrice <= pState.stopLoss) : (currentPrice >= pState.stopLoss);
            if (hitSL) {
                console.log(`Stop Loss hit for ${sym} at ${pState.stopLoss}.`);
                this.closePosition(sym, pState.stopLoss, 'STOP_LOSS');
                continue;
            }

            // ── Time Stop: 3 hours ──────────────────────────────────────
            if (pState.candlesHeld >= 180 && pState.stage === 'INITIAL') {
                console.log(`Time Stop (3h) for ${sym}. Closing.`);
                this.closePosition(sym, currentPrice, 'TIME_STOP');
                continue;
            }

            // ── TP1: close 50%, move SL to entry breakeven ──────────────
            if (pState.stage === 'INITIAL') {
                const hitTP1 = isLong ? (currentPrice >= pState.tp1) : (currentPrice <= pState.tp1);
                if (hitTP1) {
                    console.log(`TP1 HIT for ${sym} at ${pState.tp1}. Closing 50%, SL -> breakeven.`);
                    const closeQty = pState.originalQty * 0.5;
                    this.executePartialClose(sym, pState.tp1, closeQty, 'TP1');
                    pState.stopLoss = pState.entryPrice; // breakeven
                    pState.stage = 'TP1';
                    this.saveState();
                    continue;
                }
            }

            // ── TP2: close 30% of original qty ──────────────────────────
            if (pState.stage === 'TP1') {
                const hitTP2 = isLong ? (currentPrice >= pState.tp2) : (currentPrice <= pState.tp2);
                if (hitTP2) {
                    console.log(`TP2 HIT for ${sym} at ${pState.tp2}. Closing 30% of original.`);
                    const closeQty = pState.originalQty * 0.3;
                    this.executePartialClose(sym, pState.tp2, closeQty, 'TP2');
                    // Remaining 20% runner — let trailing stop take it
                    pState.stage = 'TP2';
                    this.saveState();
                    continue;
                }
            }

            // ── Dust cleanup after TP2 ───────────────────────────────────
            if (pState.stage === 'TP2' && pState.qty <= 0.0001) {
                this.closePosition(sym, currentPrice, 'FULLY_CLOSED');
                continue;
            }

            this.saveState();
        }
    }

    closePosition(symbol, exitPrice, reason) {
        const pState = this.state.positions[symbol];
        if (!pState) return;
        const isLong = pState.direction === 'LONG';

        let rawPnl = isLong
            ? (exitPrice - pState.entryPrice) * pState.qty
            : (pState.entryPrice - exitPrice) * pState.qty;

        const fee = pState.qty * exitPrice * TAKER_FEE;
        const pnl = rawPnl - fee;

        this.state.totalFeesPaid = (this.state.totalFeesPaid || 0) + fee;
        this.state.balance += pnl;

        if (pnl < 0) this.state.dailyLosses++;

        this.state.tradeHistory.push({
            action: 'CLOSE_' + pState.direction,
            coin: symbol,
            entryPrice: pState.entryPrice,
            exitPrice: exitPrice,
            qty: pState.qty,
            amount: pState.qty,
            grossPnl: parseFloat(rawPnl.toFixed(4)),
            feePaid: parseFloat(fee.toFixed(4)),
            pnl: parseFloat(pnl.toFixed(4)),
            pnlPct: parseFloat((pnl / (pState.costBasis || (pState.entryPrice * pState.qty / this.leverage))).toFixed(6)),
            reason: reason,
            timestamp: new Date().toISOString()
        });

        delete this.state.positions[symbol];
        this.saveState();
    }

    executePartialClose(symbol, exitPrice, closeQty, reason) {
        const pState = this.state.positions[symbol];
        if (!pState) return;
        const isLong = pState.direction === 'LONG';

        let rawPnl = isLong
            ? (exitPrice - pState.entryPrice) * closeQty
            : (pState.entryPrice - exitPrice) * closeQty;

        const fee = closeQty * exitPrice * TAKER_FEE;
        const pnl = rawPnl - fee;

        this.state.totalFeesPaid = (this.state.totalFeesPaid || 0) + fee;
        this.state.balance += pnl;
        pState.qty -= closeQty;
        // keep amount in sync for dashboard
        pState.amount = pState.qty;

        this.state.tradeHistory.push({
            action: 'PARTIAL_CLOSE',
            coin: symbol,
            entryPrice: pState.entryPrice,
            exitPrice: exitPrice,
            qty: closeQty,
            amount: closeQty,
            grossPnl: parseFloat(rawPnl.toFixed(4)),
            feePaid: parseFloat(fee.toFixed(4)),
            pnl: parseFloat(pnl.toFixed(4)),
            pnlPct: parseFloat((pnl / (pState.costBasis || (pState.entryPrice * closeQty / this.leverage))).toFixed(6)),
            reason: reason,
            timestamp: new Date().toISOString()
        });
    }

    async scanForEntries(regime) {
        if (Object.keys(this.state.positions).length >= this.maxPositions) return;

        const universePath = path.join(__dirname, 'active_universe.json');
        if (!fs.existsSync(universePath)) return;
        const universe = JSON.parse(fs.readFileSync(universePath, 'utf8'));

        let validSetups = [];
        for (const sym of Object.keys(universe.coins)) {
            if (this.state.positions[sym]) continue;
            
            // One entry per 15m candle guard
            const currentCandleStart = Math.floor(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000);
            if (this.state.lastEntryCandles && this.state.lastEntryCandles[sym] === currentCandleStart) {
                continue;
            }

            const metrics = universe.coins[sym];
            const tradeRes = await evaluateTrade(sym, regime, metrics.fundingRate);
            
            if (tradeRes.signal !== 'NONE') {
                validSetups.push({ symbol: sym, ...tradeRes });
            } else {
                const logObj = {
                    timestamp: new Date().toISOString(),
                    symbol: sym,
                    signal: 'NONE',
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

        const riskAmount = this.state.balance * this.riskPerTrade;
        const distanceToSl = Math.abs(setup.price - setup.stopLoss);
        let positionSize = riskAmount / distanceToSl;

        // Max leverage cap
        const maxNotional = this.state.balance * this.leverage;
        if (positionSize * setup.price > maxNotional) {
            positionSize = maxNotional / setup.price;
        }

        // Open fee (taker)
        const notional = positionSize * setup.price;
        const openFee = notional * TAKER_FEE;
        this.state.totalFeesPaid = (this.state.totalFeesPaid || 0) + openFee;
        this.state.balance -= openFee;

        const atr = setup.atr || distanceToSl / 1.2;

        this.state.positions[setup.symbol] = {
            direction: setup.signal,
            entryPrice: setup.price,
            qty: positionSize,
            originalQty: positionSize,
            amount: positionSize,           // for dashboard
            costBasis: notional / this.leverage, // margin used
            stopLoss: setup.stopLoss,
            tp1: setup.tp1,
            tp2: setup.tp2,
            atr: atr,
            stage: 'INITIAL',
            candlesHeld: 0,
            openedAt: new Date().toISOString()
        };

        this.state.tradeHistory.push({
            action: setup.signal,
            coin: setup.symbol,
            entryPrice: setup.price,
            qty: positionSize,
            amount: positionSize,
            costBasis: notional / this.leverage,
            feePaid: parseFloat(openFee.toFixed(4)),
            pnl: 0,
            pnlPct: 0,
            reason: setup.reason,
            timestamp: new Date().toISOString()
        });

        this.saveState();
    }
}

module.exports = { PaperFuturesTrader };
