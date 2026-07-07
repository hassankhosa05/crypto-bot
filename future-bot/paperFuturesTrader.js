const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { checkMarketRegime } = require('./marketGate');
const { evaluateTrade, checkExitCriteria } = require('./strategyFutures');

const STATE_FILE = path.join(__dirname, 'paper_futures_state.json');

class PaperFuturesTrader {
    constructor(initialBalance = 1000) {
        this.initialBalance = initialBalance;
        this.state = this.loadState();
        this.maxPositions = 2;
        this.riskPerTrade = 0.003;
        this.leverage = 5;
    }

    loadState() {
        try {
            if (fs.existsSync(STATE_FILE)) {
                return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
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
            accountBalanceStartOfDay: this.initialBalance
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
        
        if (this.state.dailyLosses >= 3) {
            console.log("Daily Limit: 3 Consecutive Losses.");
            return false;
        }
        if (drawdown >= 0.03) {
            console.log(`Daily Limit: Drawdown ${(drawdown*100).toFixed(2)}%`);
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

            // Check SL
            const hitSL = isLong ? (currentPrice <= pState.stopLoss) : (currentPrice >= pState.stopLoss);
            if (hitSL) {
                console.log(`Stop Loss hit for ${sym}.`);
                this.closePosition(sym, currentPrice, 'STOP_LOSS');
                continue;
            }

            // Check Time Stop
            if (pState.candlesHeld >= 180 && pState.stage === 'INITIAL') {
                console.log(`Time Stop (180 mins) for ${sym}. Closing.`);
                this.closePosition(sym, currentPrice, 'TIME_STOP');
                continue;
            }

            // Check TP1
            if (pState.stage === 'INITIAL') {
                const hitTP1 = isLong ? (currentPrice >= pState.tp1) : (currentPrice <= pState.tp1);
                if (hitTP1) {
                    console.log(`TP1 HIT for ${sym}. Closing 50%, SL to breakeven.`);
                    const closeQty = pState.qty * 0.5;
                    this.executePartialClose(sym, currentPrice, closeQty, 'TP1');
                    pState.stopLoss = pState.entryPrice;
                    pState.stage = 'TP1';
                    this.saveState();
                    continue;
                }
            }

            // Check TP2
            if (pState.stage === 'TP1') {
                const hitTP2 = isLong ? (currentPrice >= pState.tp2) : (currentPrice <= pState.tp2);
                if (hitTP2) {
                    console.log(`TP2 HIT for ${sym}. Closing 30% of original.`);
                    const closeQty = pState.originalQty * 0.3;
                    this.executePartialClose(sym, currentPrice, closeQty, 'TP2');
                    pState.stage = 'TP2';
                    this.saveState();
                    continue;
                }
            }

            // Check Strategy Exit
            const exitCheck = await checkExitCriteria(sym, pState.direction);
            if (exitCheck.exit) {
                console.log(`Strategy Exit for ${sym}: ${exitCheck.reason}`);
                this.closePosition(sym, currentPrice, 'STRATEGY_EXIT');
                continue;
            }
            
            this.saveState();
        }
    }

    closePosition(symbol, exitPrice, reason) {
        const pState = this.state.positions[symbol];
        const isLong = pState.direction === 'LONG';
        
        let pnl = 0;
        if (isLong) {
            pnl = (exitPrice - pState.entryPrice) * pState.qty;
        } else {
            pnl = (pState.entryPrice - exitPrice) * pState.qty;
        }
        
        // Subtract 0.05% fee for market close
        const notional = pState.qty * exitPrice;
        const fee = notional * 0.0005;
        pnl -= fee;

        this.state.balance += pnl;
        
        if (pnl < 0) this.state.dailyLosses++;

        this.state.tradeHistory.push({
            action: 'CLOSE_' + pState.direction,
            coin: symbol,
            entryPrice: pState.entryPrice,
            exitPrice: exitPrice,
            amount: pState.qty,
            pnl: pnl,
            pnlPct: pnl / (pState.entryPrice * pState.qty),
            reason: reason,
            timestamp: new Date().toISOString()
        });

        delete this.state.positions[symbol];
        this.saveState();
    }

    executePartialClose(symbol, exitPrice, closeQty, reason) {
        const pState = this.state.positions[symbol];
        const isLong = pState.direction === 'LONG';
        
        let pnl = 0;
        if (isLong) {
            pnl = (exitPrice - pState.entryPrice) * closeQty;
        } else {
            pnl = (pState.entryPrice - exitPrice) * closeQty;
        }

        const fee = closeQty * exitPrice * 0.0005;
        pnl -= fee;

        this.state.balance += pnl;
        pState.qty -= closeQty;
        
        this.state.tradeHistory.push({
            action: 'PARTIAL_CLOSE',
            coin: symbol,
            entryPrice: pState.entryPrice,
            exitPrice: exitPrice,
            amount: closeQty,
            pnl: pnl,
            pnlPct: pnl / (pState.entryPrice * closeQty),
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
            
            const metrics = universe.coins[sym];
            const tradeRes = await evaluateTrade(sym, regime, metrics.fundingRate);
            
            if (tradeRes.signal !== 'NONE') {
                validSetups.push({ symbol: sym, ...tradeRes });
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
        const riskAmount = this.state.balance * this.riskPerTrade;
        const distanceToSl = Math.abs(setup.price - setup.stopLoss);
        let positionSize = riskAmount / distanceToSl;
        
        // Max leverage limit
        if (positionSize * setup.price > (this.state.balance * this.leverage)) {
             positionSize = (this.state.balance * this.leverage) / setup.price;
        }

        // Open fee
        const notional = positionSize * setup.price;
        const fee = notional * 0.0005;
        this.state.balance -= fee;

        this.state.positions[setup.symbol] = {
            direction: setup.signal,
            entryPrice: setup.price,
            qty: positionSize,
            originalQty: positionSize,
            stopLoss: setup.stopLoss,
            tp1: setup.tp1,
            tp2: setup.tp2,
            stage: 'INITIAL',
            candlesHeld: 0,
            openedAt: new Date().toISOString()
        };
        
        this.state.tradeHistory.push({
            action: setup.signal,
            coin: setup.symbol,
            entryPrice: setup.price,
            amount: positionSize,
            pnl: 0,
            reason: setup.reason,
            timestamp: new Date().toISOString()
        });

        this.saveState();
    }
}

module.exports = { PaperFuturesTrader };
