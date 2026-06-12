const fs = require('fs');
const { getExchangeInfo } = require('./exchangeInfo');
const { TRADING_CONFIG, getRiskDistance, getTakeProfitDistance, getTradeAmountUSD } = require('./tradingConfig');

const path = require('path');
const DATA_DIR = process.env.DATA_DIR || __dirname;
const STATE_FILE = path.join(DATA_DIR, 'portfolio.json');
const UNIVERSE_FILE = path.join(DATA_DIR, 'active_universe.json');

const TRADE_HISTORY_CAP = 500;

class PaperTrader {
    constructor(initialBalance = 300, googleSheetsLogger = null) {
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
            peakEquity: initialBalance
        };
        if (!this.state.initialBalance)       this.state.initialBalance = 300;
        if (this.state.dailyLosses === undefined) this.state.dailyLosses = 0;
        if (this.state.dailyDrawdownUSD === undefined) this.state.dailyDrawdownUSD = 0;
        if (!this.state.lastLossDate)         this.state.lastLossDate = new Date().toDateString();
        if (!this.state.peakEquity)           this.state.peakEquity = this.state.balance;
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

    // Track peak equity for portfolio-value drawdown calculations
    _updatePeakEquity(currentPrices) {
        const portfolioValue = this.getPortfolioValue(currentPrices || this.state.currentPrices || {});
        if (portfolioValue > (this.state.peakEquity || 0)) {
            this.state.peakEquity = portfolioValue;
        }
    }

    async executeTrade(coinSymbol, action, currentPrice, strategyName, reason = '', atr = 0) {
        this.resetDailyLossesIfNewDay();

        if (action === 'BUY' && !this.state.positions[coinSymbol]) {
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
                console.log(`Trade size for ${coinSymbol} under $5 limit. Skipping.`);
                return;
            }

            const fee = tradeAmountUSD * TRADING_CONFIG.feeRate;
            this.state.balance -= (tradeAmountUSD + fee);

            const coinAmount = tradeAmountUSD / currentPrice;
            const riskDist  = getRiskDistance(atr, currentPrice);
            const slPrice   = currentPrice - riskDist;
            const tp1Price  = currentPrice + getTakeProfitDistance(atr);

            this.state.positions[coinSymbol] = {
                amount: coinAmount,
                totalSize: coinAmount,
                entryPrice: currentPrice,
                slPrice,
                tp1Price,
                tp1Hit: false,
                riskDist,
                entryAtr: atr,
                strategy: strategyName,
                timestamp: Date.now()
            };

            const logMsg = `Bought ${coinAmount.toFixed(4)} ${coinSymbol} at ${currentPrice.toFixed(4)}. SL: ${slPrice.toFixed(4)}, TP: ${tp1Price.toFixed(4)}`;
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

            this.state.balance += netSellValue;
            delete this.state.positions[coinSymbol];

            const logMsg = `Sold ${position.amount.toFixed(4)} ${coinSymbol} at $${currentPrice.toFixed(4)}. P/L: $${profitLoss.toFixed(2)} (${(profitLossPct * 100).toFixed(2)}%) - Reason: ${reason}`;
            console.log(logMsg);
            this.state.tradeHistory.push({ action: 'SELL', coin: coinSymbol, price: currentPrice, amount: position.amount, strategy: position.strategy, pnl: profitLoss, reason, timestamp: new Date().toISOString() });
            this._capTradeHistory();
            this.saveState();

            if (this.logger) await this.logger.logTrade('SELL', coinSymbol, position.entryPrice, currentPrice, position.strategy, profitLoss, reason);
        }
    }

    async executePartialSell(coinSymbol, currentPrice, fraction, reason) {
        const position = this.state.positions[coinSymbol];
        if (!position) return;

        const exInfo = await getExchangeInfo();
        const symbolRules = exInfo[coinSymbol];

        const sellAmount = position.totalSize * fraction;
        const sellValueUSD = sellAmount * currentPrice;
        const remainingAmount = position.amount - sellAmount;
        const remainingValueUSD = remainingAmount * currentPrice;

        const minNotional = symbolRules ? symbolRules.minNotional : 5;
        if (sellValueUSD < minNotional || remainingValueUSD < minNotional) {
            console.log(require('chalk').yellow(`Paper partial sell or remaining size for ${coinSymbol} below MIN_NOTIONAL ($${minNotional}). Executing FULL sell.`));
            await this.executeTrade(coinSymbol, 'SELL', currentPrice, position.strategy, `${reason} (Full Sell due to MIN_NOTIONAL limit)`);
            return;
        }

        const fee = sellValueUSD * TRADING_CONFIG.feeRate;
        const netSellValue = sellValueUSD - fee;
        const profitLoss = netSellValue - (sellAmount * position.entryPrice);

        this.state.balance += netSellValue;
        position.amount -= sellAmount;

        console.log(`Partial Sell (${(fraction * 100).toFixed(0)}%) ${sellAmount.toFixed(4)} ${coinSymbol} at $${currentPrice.toFixed(4)}. P/L: $${profitLoss.toFixed(2)} - Reason: ${reason}`);
        this.state.tradeHistory.push({ action: 'PARTIAL_SELL', coin: coinSymbol, price: currentPrice, amount: sellAmount, strategy: position.strategy, pnl: profitLoss, reason, timestamp: new Date().toISOString() });
        this._capTradeHistory();
        this.saveState();
    }

    async checkRiskManagement(coinSymbol, currentPrice) {
        if (!this.state.positions[coinSymbol]) return false;

        const position = this.state.positions[coinSymbol];
        this.resetDailyLossesIfNewDay();

        if (!position.tp1Hit && currentPrice >= position.tp1Price) {
            position.tp1Hit = true;
            await this.executePartialSell(coinSymbol, currentPrice, TRADING_CONFIG.takeProfitFraction, 'Take Profit');
            // Move stop to breakeven after partial TP
            if (position.slPrice < position.entryPrice) {
                position.slPrice = position.entryPrice;
            }
            this.saveState();
        }

        if (this.state.positions[coinSymbol] && currentPrice <= position.slPrice) {
            await this.executeTrade(coinSymbol, 'SELL', currentPrice, position.strategy, 'Stop Loss');
            return true;
        }

        return false;
    }

    async updateTrailingStops(coinSymbol, currentPrice, emergencyExitFlag = false) {
        if (!this.state.positions[coinSymbol]) return false;

        const position = this.state.positions[coinSymbol];

        const newStop = currentPrice - (position.entryAtr * TRADING_CONFIG.trailingAtrMultiplier);
        if (newStop > position.slPrice) {
            position.slPrice = newStop;
            this.saveState();
            console.log(require('chalk').blue(`Trailing Stop moved up for ${coinSymbol} to ${newStop.toFixed(4)}`));
        }

        if (emergencyExitFlag) {
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
