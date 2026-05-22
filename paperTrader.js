const fs = require('fs');

const STATE_FILE = 'portfolio.json';

class PaperTrader {
    constructor(initialBalance = 300, googleSheetsLogger = null) {
        this.logger = googleSheetsLogger;
        this.state = this.loadState() || {
            initialBalance: initialBalance,
            balance: initialBalance,
            positions: {}, 
            tradeHistory: [],
            currentPrices: {},
            dailyLosses: 0,
            lastLossDate: new Date().toDateString()
        };
        if (!this.state.initialBalance) this.state.initialBalance = 300;
        if (this.state.dailyLosses === undefined) this.state.dailyLosses = 0;
        if (!this.state.lastLossDate) this.state.lastLossDate = new Date().toDateString();
        
        this.tradeLimitPerCoin = this.state.initialBalance * 0.1; // Max 10% per trade
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

    resetDailyLossesIfNewDay() {
        const today = new Date().toDateString();
        if (this.state.lastLossDate !== today) {
            this.state.dailyLosses = 0;
            this.state.lastLossDate = today;
            this.saveState();
        }
    }

    async executeTrade(coinSymbol, action, currentPrice, strategyName, reason = '', atr = 0) {
        this.resetDailyLossesIfNewDay();

        if (action === 'BUY' && !this.state.positions[coinSymbol]) {
            if (this.state.dailyLosses >= 3) {
                console.log(`Daily max losses reached (3). Skipping BUY for ${coinSymbol}.`);
                return;
            }

            const tradeAmountUSD = Math.min(this.tradeLimitPerCoin, this.state.balance);
            if (tradeAmountUSD < 5) return; 

            const coinAmount = tradeAmountUSD / currentPrice;
            
            // Risk sizing based on ATR
            const riskPerCoin = atr * 1.2;
            const slPrice = currentPrice - riskPerCoin;
            const tpPrice = currentPrice + (riskPerCoin * 1.5); // 1.5R Take Profit
            const breakEvenTrigger = currentPrice + riskPerCoin; // +1R

            this.state.balance -= tradeAmountUSD;
            this.state.positions[coinSymbol] = {
                amount: coinAmount,
                entryPrice: currentPrice,
                slPrice: slPrice,
                tpPrice: tpPrice,
                breakEvenTrigger: breakEvenTrigger,
                strategy: strategyName,
                timestamp: Date.now()
            };

            const logMsg = `Bought ${coinAmount.toFixed(4)} ${coinSymbol} at $${currentPrice.toFixed(4)}. SL: $${slPrice.toFixed(4)}, TP: $${tpPrice.toFixed(4)}`;
            console.log(logMsg);
            this.state.tradeHistory.push({ action: 'BUY', coin: coinSymbol, price: currentPrice, amount: coinAmount, reason, timestamp: new Date().toISOString() });
            this.saveState();
            
            if (this.logger) await this.logger.logTrade('BUY', coinSymbol, currentPrice, null, strategyName, 0, reason);

        } else if (action === 'SELL' && this.state.positions[coinSymbol]) {
            const position = this.state.positions[coinSymbol];
            const sellValueUSD = position.amount * currentPrice;
            const profitLoss = sellValueUSD - (position.amount * position.entryPrice);
            const profitLossPct = profitLoss / (position.amount * position.entryPrice);

            // Check if it's a loss for daily protection
            if (profitLoss < 0) {
                this.state.dailyLosses += 1;
            }

            this.state.balance += sellValueUSD;
            delete this.state.positions[coinSymbol];

            const logMsg = `Sold ${position.amount.toFixed(4)} ${coinSymbol} at $${currentPrice.toFixed(4)}. P/L: $${profitLoss.toFixed(2)} (${(profitLossPct*100).toFixed(2)}%) - Reason: ${reason}`;
            console.log(logMsg);
            this.state.tradeHistory.push({ action: 'SELL', coin: coinSymbol, price: currentPrice, amount: position.amount, pnl: profitLoss, reason, timestamp: new Date().toISOString() });
            this.saveState();

            if (this.logger) await this.logger.logTrade('SELL', coinSymbol, position.entryPrice, currentPrice, position.strategy, profitLoss, reason);
        }
    }

    async checkRiskManagement(coinSymbol, currentPrice, emergencyExitFlag = false) {
        if (!this.state.positions[coinSymbol]) return false;

        const position = this.state.positions[coinSymbol];
        this.resetDailyLossesIfNewDay();

        // 1. Emergency Exit
        if (emergencyExitFlag) {
            console.log(`Emergency Exit triggered for ${coinSymbol}`);
            await this.executeTrade(coinSymbol, 'SELL', currentPrice, position.strategy, 'Emergency Exit (EMA cross down or MACD flip)');
            return true;
        }

        // 2. Take Profit (1.5R)
        if (currentPrice >= position.tpPrice) {
            console.log(`Take Profit triggered for ${coinSymbol}`);
            await this.executeTrade(coinSymbol, 'SELL', currentPrice, position.strategy, 'Take Profit');
            return true;
        }

        // 3. Stop Loss
        if (currentPrice <= position.slPrice) {
            console.log(`Stop Loss triggered for ${coinSymbol}`);
            await this.executeTrade(coinSymbol, 'SELL', currentPrice, position.strategy, 'Stop Loss');
            return true;
        }

        // 4. Trailing Break-Even Check (+1R)
        if (currentPrice >= position.breakEvenTrigger && position.slPrice < position.entryPrice) {
            console.log(`Break-Even triggered for ${coinSymbol}. Moving SL to Entry Price.`);
            position.slPrice = position.entryPrice;
            this.saveState();
        }

        return false;
    }

    getPortfolioValue(currentPrices) {
        let value = this.state.balance;
        for (const [symbol, position] of Object.entries(this.state.positions)) {
            const currentPrice = currentPrices[symbol] || position.entryPrice;
            value += position.amount * currentPrice;
        }
        return value;
    }
}

module.exports = PaperTrader;
