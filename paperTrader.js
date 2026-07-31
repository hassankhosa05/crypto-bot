const fs = require('fs');
const { getExchangeInfo } = require('./exchangeInfo');
const { TRADING_CONFIG, getRiskDistance, getTakeProfitDistance, getTradeAmountUSD } = require('./tradingConfig');

const path = require('path');
const DATA_DIR = process.env.DATA_DIR || __dirname;
const STATE_FILE = path.join(DATA_DIR, 'portfolio.json');
const UNIVERSE_FILE = path.join(DATA_DIR, 'active_universe.json');

const TRADE_HISTORY_CAP = 500;
const SL_COOLDOWN_MS = 4 * 60 * 60 * 1000;     // 4 hours symbol SL cooldown
const GLOBAL_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours global exit cooldown

class PaperTrader {
    constructor(initialBalance = 500, googleSheetsLogger = null) {
        this.logger = googleSheetsLogger;
        this.state = this.loadState() || {
            initialBalance,
            balance: initialBalance,
            positions: {},
            tradeHistory: [],
            currentPrices: {},
            dailyLosses: 0,
            dailyDrawdownUSD: 0,
            lastLossDate: new Date().toDateString(),
            peakEquity: initialBalance,
            cooldowns: {},
            globalCooldownUntil: 0
        };
        if (!this.state.initialBalance)       this.state.initialBalance = 500;
        if (this.state.dailyLosses === undefined) this.state.dailyLosses = 0;
        if (this.state.dailyDrawdownUSD === undefined) this.state.dailyDrawdownUSD = 0;
        if (!this.state.lastLossDate)         this.state.lastLossDate = new Date().toDateString();
        if (!this.state.peakEquity)           this.state.peakEquity = this.state.balance;
        if (!this.state.cooldowns)            this.state.cooldowns = {};
        if (!this.state.globalCooldownUntil)   this.state.globalCooldownUntil = 0;
    }

    loadUniverse() {
        if (fs.existsSync(UNIVERSE_FILE)) {
            try { return JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8')); }
            catch (e) { return null; }
        }
        return null;
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

    _capTradeHistory() {
        if (this.state.tradeHistory.length > TRADE_HISTORY_CAP) {
            this.state.tradeHistory = this.state.tradeHistory.slice(-TRADE_HISTORY_CAP);
        }
    }

    resetDailyLossesIfNewDay() {
        const today = new Date().toDateString();
        if (this.state.lastLossDate !== today) {
            this.state.dailyLosses = 0;
            this.state.dailyDrawdownUSD = 0;
            this.state.lastLossDate = today;
            this.saveState();
        }
    }

    _updatePeakEquity(currentPrices) {
        const portfolioValue = this.getPortfolioValue(currentPrices || this.state.currentPrices || {});
        if (portfolioValue > (this.state.peakEquity || 0)) {
            this.state.peakEquity = portfolioValue;
        }
    }

    isOnCooldown(symbol) {
        if (!this.state.cooldowns) this.state.cooldowns = {};
        const until = this.state.cooldowns[symbol];
        if (!until) return false;
        if (Date.now() < until) {
            const minsLeft = Math.round((until - Date.now()) / 60000);
            console.log(`[SPOT] [${symbol}] On SL cooldown — ${minsLeft} min remaining.`);
            return true;
        }
        delete this.state.cooldowns[symbol];
        return false;
    }

    setCooldown(symbol) {
        if (!this.state.cooldowns) this.state.cooldowns = {};
        this.state.cooldowns[symbol] = Date.now() + SL_COOLDOWN_MS;
        console.log(`[SPOT] [${symbol}] 4-hour SL cooldown activated.`);
    }

    async executeTrade(coinSymbol, action, currentPrice, strategyName, reason = '', atr = 0) {
        this.resetDailyLossesIfNewDay();

        if (action === 'BUY' && !this.state.positions[coinSymbol]) {
            // Global exit cooldown check
            if (this.state.globalCooldownUntil && Date.now() < this.state.globalCooldownUntil) {
                const minsLeft = Math.round((this.state.globalCooldownUntil - Date.now()) / 60000);
                console.log(`[SPOT] Skipping BUY for ${coinSymbol} due to Global Exit Cooldown (${minsLeft} mins left).`);
                return;
            }

            // Symbol SL cooldown check
            if (this.isOnCooldown(coinSymbol)) return;

            // Gate 1: portfolio-value daily drawdown
            const portfolioValue = this.getPortfolioValue(this.state.currentPrices || {});
            const maxDrawdownUSD = this.state.initialBalance * TRADING_CONFIG.dailyMaxDrawdownPct;
            if (this.state.dailyDrawdownUSD >= maxDrawdownUSD) {
                console.log(`Daily max drawdown (5%) reached ($${this.state.dailyDrawdownUSD.toFixed(2)}). Skipping BUY for ${coinSymbol}.`);
                return;
            }

            // Gate 2: daily loss count
            if (this.state.dailyLosses >= TRADING_CONFIG.dailyMaxLosses) {
                console.log(`Daily loss limit (${TRADING_CONFIG.dailyMaxLosses}) reached. Skipping BUY for ${coinSymbol}.`);
                return;
            }

            // Gate 3: max concurrent positions
            if (Object.keys(this.state.positions).length >= TRADING_CONFIG.maxConcurrentPositions) {
                console.log(`Max concurrent positions (${TRADING_CONFIG.maxConcurrentPositions}) reached. Skipping BUY for ${coinSymbol}.`);
                return;
            }

            const universe = this.loadUniverse();
            const tradeAmountUSD = getTradeAmountUSD(this.state.balance, currentPrice, atr, universe, coinSymbol);
            if (!tradeAmountUSD) {
                console.log(`Trade size for ${coinSymbol} under  limit. Skipping.`);
                return;
            }

            const fee = tradeAmountUSD * TRADING_CONFIG.feeRate;
            this.state.balance -= (tradeAmountUSD + fee);

            const coinAmount = tradeAmountUSD / currentPrice;
            const slPrice    = currentPrice - (atr * 1.2);

            this.state.positions[coinSymbol] = {
                amount: coinAmount,
                totalSize: coinAmount,
                entryPrice: currentPrice,
                slPrice: slPrice,
                initialSlPrice: slPrice,
                peakPrice: currentPrice,
                stage: 'INITIAL',
                entryAtr: atr,
                strategy: strategyName,
                timestamp: Date.now()
            };

            const logMsg = `[SPOT] Bought ${coinAmount.toFixed(4)} ${coinSymbol} at $${currentPrice.toFixed(4)}. SL: $${slPrice.toFixed(4)}`;
            console.log(logMsg);
            this.state.tradeHistory.push({ action: 'BUY', coin: coinSymbol, price: currentPrice, amount: coinAmount, strategy: strategyName, reason, timestamp: new Date().toISOString() });
            this._capTradeHistory();
            this._updatePeakEquity();
            this.saveState();

            if (this.logger) await this.logger.logTrade('BUY', coinSymbol, currentPrice, null, strategyName, 0, reason);

        } else if (action === 'SELL' && this.state.positions[coinSymbol]) {
            const position = this.state.positions[coinSymbol];
            const sellValueUSD = position.amount * currentPrice;
            const fee = sellValueUSD * TRADING_CONFIG.feeRate;
            const netSellValue = sellValueUSD - fee;
            const profitLoss = netSellValue - (position.amount * position.entryPrice);
            const profitLossPct = profitLoss / (position.amount * position.entryPrice);

            if (profitLoss < 0) {
                this.state.dailyLosses += 1;
                this.state.dailyDrawdownUSD += Math.abs(profitLoss);
            }

            // Set 4-hour symbol SL cooldown if it was an initial Stop Loss exit
            if (reason === 'Stop Loss') {
                this.setCooldown(coinSymbol);
            }

            // Set 2-hour Global Exit Cooldown on any full exit
            this.state.globalCooldownUntil = Date.now() + GLOBAL_COOLDOWN_MS;

            this.state.balance += netSellValue;
            delete this.state.positions[coinSymbol];

            const logMsg = `[SPOT] Sold ${position.amount.toFixed(4)} ${coinSymbol} at $${currentPrice.toFixed(4)}. P/L: $${profitLoss.toFixed(2)} (${(profitLossPct * 100).toFixed(2)}%) - Reason: ${reason}`;
            console.log(logMsg);
            this.state.tradeHistory.push({ action: 'SELL', coin: coinSymbol, price: currentPrice, entryPrice: position.entryPrice, exitPrice: currentPrice, amount: position.amount, strategy: position.strategy, pnl: profitLoss, pnlPct: profitLossPct, reason, timestamp: new Date().toISOString() });
            this._capTradeHistory();
            this.saveState();

            if (this.logger) await this.logger.logTrade('SELL', coinSymbol, position.entryPrice, currentPrice, position.strategy, profitLoss, reason);
        }
    }

    async checkRiskManagement(coinSymbol, currentPrice) {
        if (!this.state.positions[coinSymbol]) return false;

        const position = this.state.positions[coinSymbol];
        this.resetDailyLossesIfNewDay();

        const atr = position.entryAtr || ((position.entryPrice - position.initialSlPrice) / 1.2);
        const initialRisk = Math.abs(position.entryPrice - (position.initialSlPrice || (position.entryPrice - atr * 1.2)));

        // Track peak price
        position.peakPrice = Math.max(position.peakPrice || position.entryPrice, currentPrice);

        const profitDistance = currentPrice - position.entryPrice;
        const profitR = initialRisk > 0 ? profitDistance / initialRisk : 0;

        // Stage 1: INITIAL -> BREAKEVEN (at +1.0R)
        if (position.stage === 'INITIAL' && profitR >= 1.0) {
            position.slPrice = position.entryPrice;
            position.stage = 'BREAKEVEN';
            console.log(`[SPOT] [${coinSymbol}] +1.0R reached → SL moved to break-even ($${position.entryPrice.toFixed(4)})`);
        }

        // Stage 2: BREAKEVEN -> TRAILING (at +1.5R)
        if (position.stage === 'BREAKEVEN' && profitR >= 1.5) {
            position.stage = 'TRAILING';
            console.log(`[SPOT] [${coinSymbol}] +1.5R reached → ATR Trailing Stop activated`);
        }

        // Stage 3: TRAILING -> RUNNER (at +2.5R)
        if (position.stage === 'TRAILING' && profitR >= 2.5) {
            position.stage = 'RUNNER';
            console.log(`[SPOT] [${coinSymbol}] +2.5R reached → ATR Trailing Stop tightened (Accelerated Trail)`);
        }

        // Update ATR Trailing Stop
        if (position.stage === 'TRAILING' || position.stage === 'RUNNER') {
            const multiplier = position.stage === 'RUNNER' ? 1.5 : 2.5;
            const newTrailStop = position.peakPrice - (multiplier * atr);
            if (newTrailStop > position.slPrice) {
                position.slPrice = newTrailStop;
                console.log(`[SPOT] [${coinSymbol}] [${position.stage}] Trail SL → $${newTrailStop.toFixed(4)} (peak: $${position.peakPrice.toFixed(4)})`);
            }
        }

        // Check SL / Trail Stop execution
        if (currentPrice <= position.slPrice) {
            const isInitialSL = position.stage === 'INITIAL';
            const reason = isInitialSL 
                ? 'Stop Loss' 
                : (position.stage === 'RUNNER' ? 'Runner Trail Stop' : (position.stage === 'TRAILING' ? 'Trail Stop' : 'Breakeven Stop'));
            await this.executeTrade(coinSymbol, 'SELL', currentPrice, position.strategy, reason);
            return true;
        }

        this.saveState();
        return false;
    }

    async updateTrailingStops(coinSymbol, currentPrice, emergencyExitFlag = false) {
        if (emergencyExitFlag && this.state.positions[coinSymbol]) {
            const position = this.state.positions[coinSymbol];
            await this.executeTrade(coinSymbol, 'SELL', currentPrice, position.strategy, 'Emergency Exit V2.3');
            return true;
        }
        return false;
    }

    getPortfolioValue(currentPrices) {
        let value = this.state.balance;
        for (const [symbol, position] of Object.entries(this.state.positions)) {
            const price = (currentPrices && currentPrices[symbol]) || position.entryPrice;
            value += position.amount * price;
        }
        return value;
    }
}

module.exports = PaperTrader;
