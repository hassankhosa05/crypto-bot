const fs = require('fs');

const STATE_FILE = 'portfolio.json';
const UNIVERSE_FILE = 'active_universe.json';

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
            dailyDrawdownUSD: 0,
            lastLossDate: new Date().toDateString()
        };
        if (!this.state.initialBalance) this.state.initialBalance = 300;
        if (this.state.dailyLosses === undefined) this.state.dailyLosses = 0;
        if (this.state.dailyDrawdownUSD === undefined) this.state.dailyDrawdownUSD = 0;
        if (!this.state.lastLossDate) this.state.lastLossDate = new Date().toDateString();
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

    resetDailyLossesIfNewDay() {
        const today = new Date().toDateString();
        if (this.state.lastLossDate !== today) {
            this.state.dailyLosses = 0;
            this.state.dailyDrawdownUSD = 0;
            this.state.lastLossDate = today;
            this.saveState();
        }
    }

    async executeTrade(coinSymbol, action, currentPrice, strategyName, reason = '', atr = 0) {
        this.resetDailyLossesIfNewDay();

        if (action === 'BUY' && !this.state.positions[coinSymbol]) {
            if (this.state.dailyLosses >= 3 || this.state.dailyDrawdownUSD >= this.state.initialBalance * 0.05) {
                console.log(`Daily max losses (3) or drawdown (5%) reached. Skipping BUY for ${coinSymbol}.`);
                return;
            }

            // Dynamic Risk Sizing based on Universe Tiers and Regime
            const universe = this.loadUniverse();
            let riskPct = 0.02; // Default 2%
            let isChoppy = false;
            
            if (universe && universe.coins[coinSymbol]) {
                const tier = universe.coins[coinSymbol].tier;
                if (tier === 2) riskPct = 0.01; // 1.0% for Tier 2
            }
            if (universe && universe.regime === 'CHOPPY') {
                isChoppy = true;
                riskPct *= 0.5; // Halve risk again in choppy regimes
            }

            const riskUSD = this.state.balance * riskPct;
            const stopDistance = Math.max(atr * 1.5, currentPrice * 0.005);
            let tradeAmountUSD = (riskUSD / stopDistance) * currentPrice;
            const tradeLimitPerCoin = this.state.balance * 0.2;
            tradeAmountUSD = Math.min(tradeAmountUSD, tradeLimitPerCoin, this.state.balance);
            if(tradeAmountUSD < 5) {
                console.log(`Trade size for ${coinSymbol} under $5 limit (Choppy Regime? ${isChoppy}). Skipping.`);
                return;
            }
            
            // Apply 0.1% spot fee on entry
            const fee = tradeAmountUSD * 0.001;
            this.state.balance -= (tradeAmountUSD + fee);
            
            const coinAmount = tradeAmountUSD / currentPrice;

            // Risk sizing based on V2.2 rules
            const riskDist = atr * 1.5;
            const slPrice = currentPrice - riskDist;
            const tp1Price = currentPrice + (riskDist * 2); // 2R

            this.state.positions[coinSymbol] = {
                amount: coinAmount,
                totalSize: coinAmount,
                entryPrice: currentPrice,
                slPrice: slPrice,
                tp1Price: tp1Price,
                tp1Hit: false,
                riskDist: riskDist,
                entryAtr: atr,
                strategy: strategyName,
                timestamp: Date.now()
            };

            const logMsg = `Bought ${coinAmount.toFixed(4)} ${coinSymbol} at ${currentPrice.toFixed(4)}. SL: ${slPrice.toFixed(4)}, TP (2R): ${tp1Price.toFixed(4)}`;
            console.log(logMsg);
            this.state.tradeHistory.push({ action: 'BUY', coin: coinSymbol, price: currentPrice, amount: coinAmount, reason, timestamp: new Date().toISOString() });
            this.saveState();
            
            if (this.logger) await this.logger.logTrade('BUY', coinSymbol, currentPrice, null, strategyName, 0, reason);

        } else if (action === 'SELL' && this.state.positions[coinSymbol]) {
            // Used for full exits (Stop Loss or Emergency Exit)
            const position = this.state.positions[coinSymbol];
            const sellValueUSD = position.amount * currentPrice;
            const fee = sellValueUSD * 0.001;
            const netSellValue = sellValueUSD - fee;
            
            const profitLoss = netSellValue - (position.amount * position.entryPrice);
            const profitLossPct = profitLoss / (position.amount * position.entryPrice);

            if (profitLoss < 0) {
                this.state.dailyLosses += 1;
                this.state.dailyDrawdownUSD += Math.abs(profitLoss);
            }

            this.state.balance += netSellValue;
            delete this.state.positions[coinSymbol];

            const logMsg = `Sold ${position.amount.toFixed(4)} ${coinSymbol} at $${currentPrice.toFixed(4)}. P/L: $${profitLoss.toFixed(2)} (${(profitLossPct*100).toFixed(2)}%) - Reason: ${reason}`;
            console.log(logMsg);
            this.state.tradeHistory.push({ action: 'SELL', coin: coinSymbol, price: currentPrice, amount: position.amount, pnl: profitLoss, reason, timestamp: new Date().toISOString() });
            this.saveState();

            if (this.logger) await this.logger.logTrade('SELL', coinSymbol, position.entryPrice, currentPrice, position.strategy, profitLoss, reason);
        }
    }

    async executePartialSell(coinSymbol, currentPrice, fraction, reason) {
        const position = this.state.positions[coinSymbol];
        if (!position) return;
        
        const sellAmount = position.totalSize * fraction;
        const sellValueUSD = sellAmount * currentPrice;
        const fee = sellValueUSD * 0.001;
        const netSellValue = sellValueUSD - fee;
        
        const profitLoss = netSellValue - (sellAmount * position.entryPrice);
        
        this.state.balance += netSellValue;
        position.amount -= sellAmount;
        
        const logMsg = `Partial Sell (${(fraction*100).toFixed(0)}%) ${sellAmount.toFixed(4)} ${coinSymbol} at $${currentPrice.toFixed(4)}. P/L: $${profitLoss.toFixed(2)} - Reason: ${reason}`;
        console.log(logMsg);
        this.state.tradeHistory.push({ action: 'PARTIAL_SELL', coin: coinSymbol, price: currentPrice, amount: sellAmount, pnl: profitLoss, reason, timestamp: new Date().toISOString() });
        this.saveState();
    }

    async checkRiskManagement(coinSymbol, currentPrice, emergencyExitFlag = false) {
        if (!this.state.positions[coinSymbol]) return false;

        const position = this.state.positions[coinSymbol];
        this.resetDailyLossesIfNewDay();

        // 1. Update Trailing Stop (2.0 ATR trail from highest price)
        const newStop = currentPrice - (position.entryAtr * 2.0);
        if(newStop > position.slPrice){
            position.slPrice = newStop;
            this.saveState();
        }

        // 2. Partial TP1 (50% at 2R)
        if (!position.tp1Hit && currentPrice >= position.tp1Price) {
            position.tp1Hit = true;
            await this.executePartialSell(coinSymbol, currentPrice, 0.5, 'Take Profit (2R)');
            // Move SL to Entry Break-Even
            if (position.slPrice < position.entryPrice) {
                position.slPrice = position.entryPrice;
            }
            this.saveState();
        }

        // 4. Stop Loss / Trailing Stop
        if (currentPrice <= position.slPrice) {
            console.log(`Stop Loss / Trailing Stop triggered for ${coinSymbol}`);
            await this.executeTrade(coinSymbol, 'SELL', currentPrice, position.strategy, 'Stop Loss');
            return true;
        }

        // 5. Emergency Exit (EMA+VWAP+ROC weakness)
        if (emergencyExitFlag) {
            console.log(`Emergency Exit triggered for ${coinSymbol}`);
            await this.executeTrade(coinSymbol, 'SELL', currentPrice, position.strategy, 'Emergency Exit V2.2');
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
