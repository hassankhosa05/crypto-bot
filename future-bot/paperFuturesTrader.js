const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { evaluateTrade } = require('./strategyFutures');

const STATE_FILE = path.join(__dirname, 'paper_futures_state.json');
const EVALUATIONS_FILE = path.join(__dirname, 'trade_evaluations.jsonl');
const COMPLETED_TRADES_FILE = path.join(__dirname, 'completed_trades_dataset.jsonl');
const COOLDOWN_BLOCKED_FILE = path.join(__dirname, 'cooldown_blocked_setups.jsonl');

const TAKER_FEE = 0.0004; // 0.04% taker fee on Binance Futures
const ATR_TRAIL_MULTIPLIER = 2.5;
const RUNNER_TRAIL_MULTIPLIER = 1.5;
const SL_COOLDOWN_MS = 4 * 60 * 60 * 1000;      // 4 hours on initial SL
const GLOBAL_COOLDOWN_MS = 2 * 60 * 60 * 1000;  // 2 hours global exit cooldown (measured for opportunity cost)

class PaperFuturesTrader {
    constructor(initialBalance = 500, riskPerTrade = 0.003, maxPositions = 3, leverage = 5) {
        this.riskPerTrade = riskPerTrade;
        this.maxPositions = maxPositions;
        this.leverage     = leverage;
        this.state = this.loadState() || {
            balance: initialBalance,
            initialBalance: initialBalance,
            positions: {},
            tradeHistory: [],
            cooldowns: {},
            globalCooldownUntil: 0,
            totalFeesPaid: 0,
            dailyLosses: 0,
            lastLossDate: new Date().toDateString(),
            lastEntryCandles: {}
        };
        if (!this.state.initialBalance) this.state.initialBalance = initialBalance;
        if (!this.state.cooldowns) this.state.cooldowns = {};
        if (!this.state.globalCooldownUntil) this.state.globalCooldownUntil = 0;
        if (!this.state.totalFeesPaid) this.state.totalFeesPaid = 0;
        if (!this.state.lastEntryCandles) this.state.lastEntryCandles = {};
    }

    loadState() {
        if (fs.existsSync(STATE_FILE)) {
            try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
            catch (e) { return null; }
        }
        return null;
    }

    saveState() {
        fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    }

    isOnCooldown(symbol) {
        const until = this.state.cooldowns[symbol];
        if (!until) return false;
        if (Date.now() < until) {
            const minsLeft = Math.round((until - Date.now()) / 60000);
            return true;
        }
        delete this.state.cooldowns[symbol];
        return false;
    }

    setCooldown(symbol) {
        this.state.cooldowns[symbol] = Date.now() + SL_COOLDOWN_MS;
        console.log(`[${symbol}] 4-hour SL cooldown activated.`);
    }

    async updateTrailingStops(currentPrices) {
        for (const [sym, pState] of Object.entries(this.state.positions)) {
            const currentPrice = currentPrices[sym];
            if (!currentPrice) continue;

            const isLong = pState.direction === 'LONG';
            const atr = pState.atr || Math.abs(pState.entryPrice - pState.initialStopLoss) / 1.5;
            const initialRisk = Math.abs(pState.entryPrice - pState.initialStopLoss);

            // ── Track Peak / Trough & MFE / MAE ─────────────────────────────
            if (isLong) {
                pState.peakPrice = Math.max(pState.peakPrice || pState.entryPrice, currentPrice);
                pState.troughPrice = Math.min(pState.troughPrice || pState.entryPrice, currentPrice);
            } else {
                pState.peakPrice = Math.min(pState.peakPrice || pState.entryPrice, currentPrice);
                pState.troughPrice = Math.max(pState.troughPrice || pState.entryPrice, currentPrice);
            }

            // Calculate Max Favorable Excursion (MFE) in R
            const favorableDistance = isLong
                ? (pState.peakPrice - pState.entryPrice)
                : (pState.entryPrice - pState.peakPrice);
            const mfeR = initialRisk > 0 ? favorableDistance / initialRisk : 0;
            pState.maxFavorableExcursionR = Math.max(pState.maxFavorableExcursionR || 0, mfeR);

            // Calculate Max Adverse Excursion (MAE) in R
            const adverseDistance = isLong
                ? (pState.entryPrice - pState.troughPrice)
                : (pState.troughPrice - pState.entryPrice);
            const maeR = initialRisk > 0 ? adverseDistance / initialRisk : 0;
            pState.maxAdverseExcursionR = Math.max(pState.maxAdverseExcursionR || 0, maeR);

            // Current R
            const currentProfitDist = isLong
                ? (currentPrice - pState.entryPrice)
                : (pState.entryPrice - currentPrice);
            const currentR = initialRisk > 0 ? currentProfitDist / initialRisk : 0;

            // ── Stage 1: +1.0R Reached → Move SL to Break-even ─────────────
            if (pState.stage === 'INITIAL' && currentR >= 1.0) {
                pState.stopLoss = pState.entryPrice;
                pState.stage = 'BREAKEVEN';
                pState.reached1R = true;
                pState.breakevenTriggered = true;
                console.log(`[${sym}] +1.0R reached → SL moved to break-even (${pState.entryPrice.toFixed(4)})`);
            }

            // ── Stage 2: +1.5R Reached → Activate ATR Trailing Stop ─────────
            if (pState.stage === 'BREAKEVEN' && currentR >= 1.5) {
                pState.stage = 'TRAILING';
                pState.reached1_5R = true;
                pState.atrTrailTriggered = true;
                console.log(`[${sym}] +1.5R reached → ATR Trailing Stop activated (${ATR_TRAIL_MULTIPLIER}x ATR)`);
            }

            // ── Stage 3: +2.5R Reached → Tighten to Accelerated Runner Trail
            if (pState.stage === 'TRAILING' && currentR >= 2.5) {
                pState.stage = 'RUNNER';
                pState.reached2_5R = true;
                console.log(`[${sym}] +2.5R reached → Accelerated Runner Trail tightened (${RUNNER_TRAIL_MULTIPLIER}x ATR)`);
            }

            // ── Update Trailing Stop Price ──────────────────────────────────
            if (pState.stage === 'TRAILING' || pState.stage === 'RUNNER') {
                const multiplier = pState.stage === 'RUNNER' ? RUNNER_TRAIL_MULTIPLIER : ATR_TRAIL_MULTIPLIER;
                if (isLong) {
                    const trailStop = pState.peakPrice - multiplier * atr;
                    if (trailStop > pState.stopLoss) {
                        pState.stopLoss = trailStop;
                        console.log(`[${sym}] [${pState.stage}] Trail SL → ${trailStop.toFixed(6)} (peak: ${pState.peakPrice.toFixed(6)})`);
                    }
                } else {
                    const trailStop = pState.peakPrice + multiplier * atr;
                    if (trailStop < pState.stopLoss) {
                        pState.stopLoss = trailStop;
                        console.log(`[${sym}] [${pState.stage}] Trail SL → ${trailStop.toFixed(6)} (peak: ${pState.peakPrice.toFixed(6)})`);
                    }
                }
            }

            // ── Stop Loss / Trailing Stop Hit Check ────────────────────────
            const hitSL = isLong
                ? currentPrice <= pState.stopLoss
                : currentPrice >= pState.stopLoss;

            if (hitSL) {
                const isInitialSL = pState.stage === 'INITIAL';
                const reason = isInitialSL 
                    ? 'STOP_LOSS' 
                    : (pState.stage === 'RUNNER' ? 'RUNNER_TRAIL_STOP' : (pState.stage === 'TRAILING' ? 'TRAIL_STOP' : 'BREAKEVEN_STOP'));
                console.log(`[${sym}] ${reason} hit at ${pState.stopLoss.toFixed(6)}`);
                this.closePosition(sym, pState.stopLoss, reason);

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

        const initialRisk = Math.abs(pState.entryPrice - pState.initialStopLoss);
        const realizedR = initialRisk > 0 ? (isLong ? (exitPrice - pState.entryPrice) : (pState.entryPrice - exitPrice)) / initialRisk : 0;

        const tradeRecord = {
            action:                  'CLOSE_' + pState.direction,
            symbol:                  symbol,
            direction:               pState.direction,
            entryPrice:              pState.entryPrice,
            exitPrice:               exitPrice,
            qty:                     pState.qty,
            amount:                  pState.qty,
            grossPnl:                parseFloat(rawPnl.toFixed(4)),
            feePaid:                 parseFloat(fee.toFixed(4)),
            pnl:                     parseFloat(pnl.toFixed(4)),
            pnlPct:                  parseFloat((pnl / (pState.costBasis || (pState.entryPrice * pState.qty / this.leverage))).toFixed(6)),
            reason:                  reason,
            openedAt:                pState.openedAt,
            closedAt:                new Date().toISOString(),
            initialRiskDollars:      parseFloat((initialRisk * pState.qty).toFixed(4)),
            initialStopLoss:         pState.initialStopLoss,
            maxFavorableExcursionR:  parseFloat((pState.maxFavorableExcursionR || 0).toFixed(2)),
            maxAdverseExcursionR:    parseFloat((pState.maxAdverseExcursionR || 0).toFixed(2)),
            reached1R:               !!pState.reached1R,
            reached1_5R:             !!pState.reached1_5R,
            reached2_5R:             !!pState.reached2_5R,
            breakevenTriggered:      !!pState.breakevenTriggered,
            atrTrailTriggered:       !!pState.atrTrailTriggered,
            finalRealizedR:          parseFloat(realizedR.toFixed(2)),
            globalRegimeAtEntry:     pState.globalRegimeAtEntry || 'UNKNOWN',
            entryMeta:               pState.entryMeta || {}
        };

        this.state.tradeHistory.push(tradeRecord);

        // Append to full diagnostic dataset
        try {
            fs.appendFileSync(COMPLETED_TRADES_FILE, JSON.stringify(tradeRecord) + "\n");
        } catch(e) {}

        delete this.state.positions[symbol];
        this.state.globalCooldownUntil = Date.now() + GLOBAL_COOLDOWN_MS;
        console.log(`Global Exit Cooldown active until ${new Date(this.state.globalCooldownUntil).toISOString()}`);
        this.saveState();
    }

    async scanForEntries(regime) {
        const universePath = path.join(__dirname, 'active_universe.json');
        if (!fs.existsSync(universePath)) return;
        const universe = JSON.parse(fs.readFileSync(universePath, 'utf8'));

        const isGlobalCooldownActive = this.state.globalCooldownUntil && Date.now() < this.state.globalCooldownUntil;
        const minsLeftCooldown = isGlobalCooldownActive ? Math.round((this.state.globalCooldownUntil - Date.now()) / 60000) : 0;

        let validSetups = [];

        for (const sym of Object.keys(universe.coins)) {
            if (this.state.positions[sym]) continue;
            if (this.isOnCooldown(sym)) continue;

            const currentCandleStart = Math.floor(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000);
            if (this.state.lastEntryCandles?.[sym] === currentCandleStart) continue;

            const metrics  = universe.coins[sym];
            const tradeRes = await evaluateTrade(sym, regime, metrics.fundingRate);

            // Log diagnostic evaluation on EVERY candidate setup
            const evalRecord = tradeRes.diag || {
                timestamp:    new Date().toISOString(),
                symbol:       sym,
                globalRegime: regime,
                signal:       tradeRes.signal,
                failedReason: tradeRes.reason
            };
            fs.appendFile(EVALUATIONS_FILE, JSON.stringify(evalRecord) + "\n", (err) => { if (err) console.error(err); });

            if (tradeRes.signal !== 'NONE') {
                // If global cooldown is active, measure opportunity cost!
                if (isGlobalCooldownActive) {
                    const blockedRecord = {
                        timestamp:              new Date().toISOString(),
                        symbol:                 sym,
                        signal:                 tradeRes.signal,
                        price:                  tradeRes.price,
                        score:                  tradeRes.score,
                        atr:                    tradeRes.atr,
                        globalCooldownMinsLeft: minsLeftCooldown,
                        wouldHaveEntered:       Object.keys(this.state.positions).length < this.maxPositions,
                        reason:                 tradeRes.reason
                    };
                    console.log(`[Opportunity Cost] Global Cooldown BLOCKED valid ${tradeRes.signal} on ${sym} (Score: ${tradeRes.score}, ${minsLeftCooldown}m left)`);
                    fs.appendFile(COOLDOWN_BLOCKED_FILE, JSON.stringify(blockedRecord) + "\n", (err) => { if (err) console.error(err); });
                } else {
                    validSetups.push({ symbol: sym, ...tradeRes });
                }
            }
        }

        if (isGlobalCooldownActive) {
            return;
        }

        if (Object.keys(this.state.positions).length >= this.maxPositions) return;

        validSetups.sort((a, b) => b.score - a.score || b.adx - a.adx);

        for (const setup of validSetups) {
            if (Object.keys(this.state.positions).length >= this.maxPositions) break;
            console.log(`[PAPER] Executing ${setup.signal} on ${setup.symbol}. Score: ${setup.score}`);
            this.executeTrade(setup, regime);
        }
    }

    executeTrade(setup, globalRegime = 'UNKNOWN') {
        const currentCandleStart = Math.floor(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000);
        if (!this.state.lastEntryCandles) this.state.lastEntryCandles = {};
        this.state.lastEntryCandles[setup.symbol] = currentCandleStart;

        const riskAmount   = this.state.balance * this.riskPerTrade;
        const distanceToSl = Math.abs(setup.price - setup.stopLoss);
        let positionSize   = riskAmount / distanceToSl;

        const maxNotional = this.state.balance * this.leverage;
        if (positionSize * setup.price > maxNotional) {
            positionSize = maxNotional / setup.price;
        }

        const notional = positionSize * setup.price;
        const openFee  = notional * TAKER_FEE;
        this.state.totalFeesPaid = (this.state.totalFeesPaid || 0) + openFee;
        this.state.balance -= openFee;

        const atr = setup.atr || distanceToSl / 1.5;

        this.state.positions[setup.symbol] = {
            direction:               setup.signal,
            entryPrice:              setup.price,
            qty:                     positionSize,
            originalQty:             positionSize,
            amount:                  positionSize,
            costBasis:               notional / this.leverage,
            stopLoss:                setup.stopLoss,
            initialStopLoss:         setup.stopLoss,
            peakPrice:               setup.price,
            troughPrice:             setup.price,
            atr:                     atr,
            stage:                   'INITIAL',
            openedAt:                new Date().toISOString(),
            globalRegimeAtEntry:     globalRegime,
            maxFavorableExcursionR:  0,
            maxAdverseExcursionR:    0,
            reached1R:               false,
            reached1_5R:             false,
            reached2_5R:             false,
            breakevenTriggered:      false,
            atrTrailTriggered:       false,
            entryMeta:               setup.diag || {}
        };

        this.saveState();
    }

    async runCycle() {
        try {
            const { checkMarketRegime } = require('./marketGate');
            const regime = await checkMarketRegime();
            console.log(`
--- Paper Futures Trader Cycle [${new Date().toISOString()}] ---`);
            console.log(`Global Market Regime: ${regime}`);

            // Fetch current mark prices for open positions
            const openSymbols = Object.keys(this.state.positions);
            if (openSymbols.length > 0) {
                const currentPrices = {};
                for (const sym of openSymbols) {
                    try {
                        const res = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`);
                        currentPrices[sym] = parseFloat(res.data.price);
                    } catch (e) {}
                }
                await this.updateTrailingStops(currentPrices);
            }

            // Scan for new entries
            await this.scanForEntries(regime);
        } catch (e) {
            console.error('Error in runCycle:', e.message);
        }
    }
}

module.exports = { PaperFuturesTrader };
