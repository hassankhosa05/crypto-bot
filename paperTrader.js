const fs = require('fs');

const STATE_FILE = 'portfolio.json';

class PaperTrader {
    constructor(initialBalance = 10000, googleSheetsLogger = null) {
        this.logger = googleSheetsLogger;
        this.state = this.loadState() || {
            balance: initialBalance,
            positions: {}, // { 'BTC': { amount: 1, entryPrice: 50000, strategy: 'RSI' } }
            tradeHistory: []
        };
        this.tradeLimitPerCoin = this.state.balance * 0.1; // Max 10% of balance per trade
        this.takeProfitPercentage = 0.05; // 5% profit target
        this.stopLossPercentage = 0.02; // 2% stop loss
    }

    loadState() {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        }
        return null;
    }

    saveState() {
        fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    }

    async executeTrade(coinSymbol, action, currentPrice, strategyName) {
        if (action === 'BUY' && !this.state.positions[coinSymbol]) {
            // Check if we have enough balance
            const tradeAmountUSD = Math.min(this.tradeLimitPerCoin, this.state.balance);
            if (tradeAmountUSD < 10) return; // Minimum trade size

            const coinAmount = tradeAmountUSD / currentPrice;
            
            this.state.balance -= tradeAmountUSD;
            this.state.positions[coinSymbol] = {
                amount: coinAmount,
                entryPrice: currentPrice,
                strategy: strategyName,
                timestamp: Date.now()
            };

            const logMsg = `Bought ${coinAmount.toFixed(4)} ${coinSymbol} at $${currentPrice.toFixed(4)} using ${strategyName}`;
            console.log(logMsg);
            this.state.tradeHistory.push({ action: 'BUY', coin: coinSymbol, price: currentPrice, amount: coinAmount, strategy: strategyName, timestamp: new Date().toISOString() });
            this.saveState();
            
            if (this.logger) {
                 await this.logger.logTrade('BUY', coinSymbol, currentPrice, null, strategyName, 0, 'Signal');
            }

        } else if (action === 'SELL' && this.state.positions[coinSymbol]) {
            const position = this.state.positions[coinSymbol];
            const sellValueUSD = position.amount * currentPrice;
            const profitLoss = sellValueUSD - (position.amount * position.entryPrice);
            const profitLossPct = profitLoss / (position.amount * position.entryPrice);

            this.state.balance += sellValueUSD;
            delete this.state.positions[coinSymbol];

            const logMsg = `Sold ${position.amount.toFixed(4)} ${coinSymbol} at $${currentPrice.toFixed(4)}. P/L: $${profitLoss.toFixed(2)} (${(profitLossPct*100).toFixed(2)}%)`;
            console.log(logMsg);
            this.state.tradeHistory.push({ action: 'SELL', coin: coinSymbol, price: currentPrice, amount: position.amount, pnl: profitLoss, strategy: position.strategy, timestamp: new Date().toISOString() });
            this.saveState();

            if (this.logger) {
                await this.logger.logTrade('SELL', coinSymbol, position.entryPrice, currentPrice, position.strategy, profitLoss, 'Signal');
            }
        }
    }

    async checkRiskManagement(coinSymbol, currentPrice) {
        if (!this.state.positions[coinSymbol]) return;

        const position = this.state.positions[coinSymbol];
        const profitLossPct = (currentPrice - position.entryPrice) / position.entryPrice;

        if (profitLossPct >= this.takeProfitPercentage) {
            console.log(`Take Profit triggered for ${coinSymbol}`);
            await this.executeTrade(coinSymbol, 'SELL', currentPrice, position.strategy);
            if(this.logger && this.state.tradeHistory.length > 0) {
                 // Update the last logged reason (hacky but works for this simple flow)
                 // A better way is to pass reason to executeTrade
            }
            return true;
        }

        if (profitLossPct <= -this.stopLossPercentage) {
            console.log(`Stop Loss triggered for ${coinSymbol}`);
            await this.executeTrade(coinSymbol, 'SELL', currentPrice, position.strategy);
            return true;
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
