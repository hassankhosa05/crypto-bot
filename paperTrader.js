const fs = require('fs');
const path = require('path');
const { logTrade } = require('./tradeLogger');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const STATE_FILE = path.join(DATA_DIR, 'portfolio.json');

const TAKE_PROFIT_PCT = 0.05; // 5% profit target
const STOP_LOSS_PCT = 0.02;   // 2% stop loss
const TRADE_FRACTION = 0.1;   // max 10% of starting balance per trade
const MIN_TRADE_USD = 10;

class PaperTrader {
    constructor(initialBalance = 300) {
        const loaded = this.loadState();
        this.state = loaded || {
            balance: initialBalance,
            initialBalance,
            positions: {},
            tradeHistory: []
        };
        // Ensure initialBalance is always present even on older state files.
        if (this.state.initialBalance === undefined) {
            this.state.initialBalance = initialBalance;
            this.saveState();
        }
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

    tradeSizeUSD() {
        // Sized off initial balance so position sizing stays consistent as P/L moves balance around.
        return Math.min(this.state.initialBalance * TRADE_FRACTION, this.state.balance);
    }

    async executeTrade(coinSymbol, action, currentPrice, strategyName, reason = 'Strategy Signal') {
        if (action === 'BUY' && !this.state.positions[coinSymbol]) {
            const tradeAmountUSD = this.tradeSizeUSD();
            if (tradeAmountUSD < MIN_TRADE_USD) return;

            const coinAmount = tradeAmountUSD / currentPrice;
            this.state.balance -= tradeAmountUSD;
            this.state.positions[coinSymbol] = {
                amount: coinAmount,
                entryPrice: currentPrice,
                costBasis: tradeAmountUSD,
                strategy: strategyName,
                stopLoss: currentPrice * (1 - STOP_LOSS_PCT),
                takeProfit: currentPrice * (1 + TAKE_PROFIT_PCT),
                timestamp: Date.now()
            };

            const timestamp = new Date().toISOString();
            console.log(`BUY  ${coinSymbol.toUpperCase()} ${coinAmount.toFixed(4)} @ $${currentPrice.toFixed(6)} (${strategyName}, ${reason})`);
            const historyEntry = {
                action: 'BUY',
                coin: coinSymbol,
                price: currentPrice,
                entryPrice: currentPrice,
                amount: coinAmount,
                strategy: strategyName,
                reason,
                timestamp
            };
            this.state.tradeHistory.push(historyEntry);
            this.saveState();
            logTrade({
                timestamp,
                action: 'BUY',
                coin: coinSymbol,
                entryPrice: currentPrice,
                exitPrice: null,
                amount: coinAmount,
                strategy: strategyName,
                pnl: null,
                pnlPct: null,
                reason
            });
            return;
        }

        if (action === 'SELL' && this.state.positions[coinSymbol]) {
            const position = this.state.positions[coinSymbol];
            const sellValueUSD = position.amount * currentPrice;
            const pnl = sellValueUSD - position.costBasis;
            const pnlPct = pnl / position.costBasis;

            this.state.balance += sellValueUSD;
            delete this.state.positions[coinSymbol];

            const timestamp = new Date().toISOString();
            console.log(`SELL ${coinSymbol.toUpperCase()} ${position.amount.toFixed(4)} @ $${currentPrice.toFixed(6)} | P/L $${pnl.toFixed(2)} (${(pnlPct * 100).toFixed(2)}%) [${reason}]`);
            const historyEntry = {
                action: 'SELL',
                coin: coinSymbol,
                price: currentPrice,
                entryPrice: position.entryPrice,
                exitPrice: currentPrice,
                amount: position.amount,
                strategy: position.strategy,
                pnl,
                pnlPct,
                reason,
                timestamp
            };
            this.state.tradeHistory.push(historyEntry);
            this.saveState();
            logTrade({
                timestamp,
                action: 'SELL',
                coin: coinSymbol,
                entryPrice: position.entryPrice,
                exitPrice: currentPrice,
                amount: position.amount,
                strategy: position.strategy,
                pnl,
                pnlPct,
                reason
            });
        }
    }

    async checkRiskManagement(coinSymbol, currentPrice) {
        const position = this.state.positions[coinSymbol];
        if (!position) return false;

        const profitLossPct = (currentPrice - position.entryPrice) / position.entryPrice;

        if (profitLossPct >= TAKE_PROFIT_PCT) {
            await this.executeTrade(coinSymbol, 'SELL', currentPrice, position.strategy, 'Take Profit');
            return true;
        }
        if (profitLossPct <= -STOP_LOSS_PCT) {
            await this.executeTrade(coinSymbol, 'SELL', currentPrice, position.strategy, 'Stop Loss');
            return true;
        }
        return false;
    }

    getPortfolioValue(currentPrices) {
        let value = this.state.balance;
        for (const [symbol, position] of Object.entries(this.state.positions)) {
            const price = currentPrices[symbol] || position.entryPrice;
            value += position.amount * price;
        }
        return value;
    }
}

module.exports = PaperTrader;
module.exports.TAKE_PROFIT_PCT = TAKE_PROFIT_PCT;
module.exports.STOP_LOSS_PCT = STOP_LOSS_PCT;
