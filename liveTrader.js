const fs = require('fs');
const chalk = require('chalk');
const { getUSDTBalance, placeMarketOrder, placeLimitOrder, cancelOrder, getOrderStatus } = require('./binanceApi');
const { getExchangeInfo, roundStep, roundTick } = require('./exchangeInfo');

const STATE_FILE = './live_state.json';
const delay = ms => new Promise(res => setTimeout(res, ms));

class LiveTrader {
    constructor() {
        this.state = this.loadState() || {
            positions: {},
            tradeHistory: [],
            dailyLosses: 0,
            dailyDrawdownUSD: 0,
            lastLossDate: new Date().toDateString()
        };
        this.balance = 0;
        this.syncBalance(); 
    }

    loadUniverse() {
        if (fs.existsSync('./active_universe.json')) {
            try { return JSON.parse(fs.readFileSync('./active_universe.json', 'utf8')); } 
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

    async syncBalance() {
        try {
            this.balance = await getUSDTBalance();
            this.saveState();
        } catch(e) {
            console.error(chalk.red("Failed to fetch balance from Binance:", e.message));
        }
    }

    async executeHybridOrder(coinSymbol, side, amount, currentPrice, symbolRules) {
        // Aggressive limit: 0.1% buffer
        let limitPrice = side === 'BUY' ? currentPrice * 1.001 : currentPrice * 0.999;
        limitPrice = roundTick(limitPrice, symbolRules.tickSize);
        amount = roundStep(amount, symbolRules.stepSize);

        try {
            console.log(chalk.yellow(`Placing Hybrid LIMIT ${side} for ${amount} ${coinSymbol} at ${limitPrice}...`));
            const limitOrder = await placeLimitOrder(coinSymbol, side, amount, limitPrice);
            const orderId = limitOrder.orderId;

            // Monitoring window
            await delay(3000);

            const statusRes = await getOrderStatus(coinSymbol, orderId);
            
            if (statusRes.status === 'FILLED') {
                console.log(chalk.green(`Limit ${side} FILLED successfully at ${statusRes.price || limitPrice}`));
                return { status: 'FILLED', executedQty: parseFloat(statusRes.executedQty), avgPrice: parseFloat(statusRes.price) || limitPrice };
            } else {
                console.log(chalk.yellow(`Limit ${side} not fully filled (${statusRes.status}). Cancelling and falling back to MARKET...`));
                try {
                    await cancelOrder(coinSymbol, orderId);
                } catch(cancelErr) {
                    // Order might have filled exactly when we tried to cancel
                    if(cancelErr.response && cancelErr.response.data.code === -2011) {
                        const finalCheck = await getOrderStatus(coinSymbol, orderId);
                        if (finalCheck.status === 'FILLED') {
                            return { status: 'FILLED', executedQty: parseFloat(finalCheck.executedQty), avgPrice: parseFloat(finalCheck.price) || limitPrice };
                        }
                    }
                }
                
                const cancelRes = await getOrderStatus(coinSymbol, orderId); 
                const filledSoFar = parseFloat(cancelRes.executedQty);
                const remaining = amount - filledSoFar;

                if (remaining > 0) {
                    const roundedRemaining = roundStep(remaining, symbolRules.stepSize);
                    if (roundedRemaining > 0) {
                        console.log(chalk.magenta(`Firing MARKET fallback for remaining ${roundedRemaining}...`));
                        const marketOrder = await placeMarketOrder(coinSymbol, side, roundedRemaining);
                        return { 
                            status: 'HYBRID_FILLED', 
                            executedQty: filledSoFar + parseFloat(marketOrder.executedQty),
                            avgPrice: currentPrice 
                        };
                    }
                }
                return { status: 'PARTIAL_FILLED', executedQty: filledSoFar, avgPrice: limitPrice };
            }

        } catch (e) {
            console.error(chalk.red(`Limit order failed, falling back immediately to MARKET:`, e.response ? JSON.stringify(e.response.data) : e.message));
            try {
                const marketOrder = await placeMarketOrder(coinSymbol, side, amount);
                return { status: 'MARKET_FILLED', executedQty: parseFloat(marketOrder.executedQty), avgPrice: currentPrice };
            } catch (fallbackErr) {
                console.error(chalk.red(`MARKET fallback also failed:`, fallbackErr.response ? JSON.stringify(fallbackErr.response.data) : fallbackErr.message));
                throw fallbackErr;
            }
        }
    }

    async executeTrade(coinSymbol, action, currentPrice, strategyName, reason = '', atr = 0) {
        this.resetDailyLossesIfNewDay();
        await this.syncBalance();

        const exInfo = await getExchangeInfo();
        const symbolRules = exInfo[coinSymbol];
        if (!symbolRules) {
            console.log("No symbol rules found for", coinSymbol);
            return;
        }

        if (action === 'BUY' && !this.state.positions[coinSymbol]) {
            // Drawdown logic based on total portfolio value instead of free USDT balance
            const portfolioValue = this.getPortfolioValue(this.state.currentPrices || {});
            if (this.state.dailyDrawdownUSD >= portfolioValue * 0.05) {
                console.log(`Daily max drawdown reached (Portfolio: $${portfolioValue.toFixed(2)}). Skipping BUY.`);
                return;
            }

            const universe = this.loadUniverse();
            let riskPct = 0.02; 
            if (universe && universe.coins[coinSymbol]) {
                if (universe.coins[coinSymbol].tier === 2) riskPct = 0.01;
            }
            if (universe && universe.regime === 'CHOPPY') {
                riskPct *= 0.5;
            }

            const riskUSD = this.balance * riskPct;
            const stopDistance = Math.max(atr * 2.0, currentPrice * 0.005);
            let tradeAmountUSD = (riskUSD / stopDistance) * currentPrice;
            const tradeLimitPerCoin = this.balance * 0.2;
            tradeAmountUSD = Math.min(tradeAmountUSD, tradeLimitPerCoin, this.balance * 0.95);
            
            if (tradeAmountUSD < Math.max(5, symbolRules.minNotional)) {
                console.log(`Trade size under minimum for ${coinSymbol}. Skipping.`);
                return;
            }
            
            let coinAmount = tradeAmountUSD / currentPrice;

            try {
                const result = await this.executeHybridOrder(coinSymbol, 'BUY', coinAmount, currentPrice, symbolRules);
                const actualQty = result.executedQty;
                
                const riskDist = atr * 2.0;
                const slPrice = currentPrice - riskDist;
                const tp1Price = currentPrice + (riskDist * 3);

                this.state.positions[coinSymbol] = {
                    amount: actualQty,
                    totalSize: actualQty,
                    entryPrice: result.avgPrice || currentPrice,
                    slPrice: slPrice,
                    tp1Price: tp1Price,
                    tp1Hit: false,
                    riskDist: riskDist,
                    entryAtr: atr,
                    strategy: strategyName,
                    timestamp: Date.now()
                };

                console.log(chalk.green(`LIVE BOUGHT ${actualQty} ${coinSymbol}. SL: ${slPrice.toFixed(4)}`));
                this.state.tradeHistory.push({ action: 'BUY', coin: coinSymbol, amount: actualQty, reason, timestamp: new Date().toISOString() });
                this.saveState();
            } catch (e) {
                console.error(chalk.red(`LIVE BUY FAILED`, e.message));
            }

        } else if (action === 'SELL' && this.state.positions[coinSymbol]) {
            const position = this.state.positions[coinSymbol];
            let sellAmount = position.amount;

            // Warn if the actual sell order is below minNotional itself
            if (symbolRules && (sellAmount * currentPrice < symbolRules.minNotional)) {
                console.warn(chalk.red(`[WARNING] Full exit amount for ${coinSymbol} ($${(sellAmount * currentPrice).toFixed(2)}) is below exchange minNotional ($${symbolRules.minNotional}). Order may fail on exchange.`));
            }

            try {
                const result = await this.executeHybridOrder(coinSymbol, 'SELL', sellAmount, currentPrice, symbolRules);
                const actualSold = result.executedQty;
                
                const sellValueUSD = actualSold * currentPrice;
                const profitLoss = sellValueUSD - (actualSold * position.entryPrice);
                if (profitLoss < 0) {
                    this.state.dailyLosses += 1;
                    this.state.dailyDrawdownUSD += Math.abs(profitLoss);
                }

                // If fully sold or very close
                if (actualSold >= sellAmount * 0.99) {
                    delete this.state.positions[coinSymbol];
                } else {
                    this.state.positions[coinSymbol].amount -= actualSold;
                }
                
                console.log(chalk.green(`LIVE SOLD ${actualSold} ${coinSymbol}. Reason: ${reason}`));
                this.state.tradeHistory.push({ action: 'SELL', coin: coinSymbol, amount: actualSold, reason, timestamp: new Date().toISOString() });
                this.saveState();
                await this.syncBalance();
            } catch(e) {
                console.error(chalk.red(`LIVE SELL FAILED for ${coinSymbol}:`, e.message));
                // Set lastAttemptTime cooldown to avoid API spamming on next ticks
                if (this.state.positions[coinSymbol]) {
                    this.state.positions[coinSymbol].lastAttemptTime = Date.now();
                    this.saveState();
                }
            }
        }
    }

    async executePartialSell(coinSymbol, currentPrice, fraction, reason) {
        const position = this.state.positions[coinSymbol];
        if (!position) return;
        
        const exInfo = await getExchangeInfo();
        const symbolRules = exInfo[coinSymbol];
        
        let sellAmount = position.totalSize * fraction;
        const sellValueUSD = sellAmount * currentPrice;
        const remainingAmount = position.amount - sellAmount;
        const remainingValueUSD = remainingAmount * currentPrice;

        // Dust/MIN_NOTIONAL check: If either the partial sell amount or the remaining position is under minNotional, execute a FULL SELL instead to prevent locked assets.
        if (symbolRules && (sellValueUSD < symbolRules.minNotional || remainingValueUSD < symbolRules.minNotional)) {
            console.log(chalk.yellow(`Partial sell or remaining size for ${coinSymbol} falls below MIN_NOTIONAL limit ($${symbolRules.minNotional}). Executing FULL sell instead.`));
            await this.executeTrade(coinSymbol, 'SELL', currentPrice, position.strategy, `${reason} (Full Sell due to MIN_NOTIONAL limit)`);
            return;
        }

        try {
            const result = await this.executeHybridOrder(coinSymbol, 'SELL', sellAmount, currentPrice, symbolRules);
            const actualSold = result.executedQty;
            
            position.amount -= actualSold;
            console.log(chalk.green(`LIVE PARTIAL SOLD ${actualSold} ${coinSymbol}. Reason: ${reason}`));
            this.state.tradeHistory.push({ action: 'PARTIAL_SELL', coin: coinSymbol, amount: actualSold, reason, timestamp: new Date().toISOString() });
            this.saveState();
            await this.syncBalance();
        } catch (e) {
            console.error(chalk.red(`LIVE PARTIAL SELL FAILED for ${coinSymbol}:`, e.message));
            if (this.state.positions[coinSymbol]) {
                this.state.positions[coinSymbol].lastAttemptTime = Date.now();
                this.saveState();
            }
        }
    }

    
    async checkRiskManagement(coinSymbol, currentPrice) {
        if (!this.state.positions[coinSymbol]) return false;

        const position = this.state.positions[coinSymbol];

        // Cooldown check (e.g. 10 seconds since last failed order attempt) to avoid high-frequency API spamming
        if (position.lastAttemptTime && Date.now() - position.lastAttemptTime < 10000) {
            return false;
        }

        this.resetDailyLossesIfNewDay();

        if (!position.tp1Hit && currentPrice >= position.tp1Price) {
            position.tp1Hit = true;
            await this.executePartialSell(coinSymbol, currentPrice, 0.5, 'Take Profit (3R)');
            if (position.slPrice < position.entryPrice) {
                position.slPrice = position.entryPrice;
            }
            this.saveState();
        }

        if (currentPrice <= position.slPrice) {
            await this.executeTrade(coinSymbol, 'SELL', currentPrice, position.strategy, 'Stop Loss');
            return true;
        }

        return false;
    }

    async updateTrailingStops(coinSymbol, currentPrice, emergencyExitFlag = false) {
        if (!this.state.positions[coinSymbol]) return false;

        const position = this.state.positions[coinSymbol];

        // Cooldown check (e.g. 10 seconds since last failed order attempt) to avoid high-frequency API spamming
        if (position.lastAttemptTime && Date.now() - position.lastAttemptTime < 10000) {
            return false;
        }
        
        // Trailing Stop logic: trail by 2.5 ATR (up from 2.0)
        const newStop = currentPrice - (position.entryAtr * 2.5);
        if(newStop > position.slPrice){
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
        let value = this.balance;
        for (const [symbol, position] of Object.entries(this.state.positions)) {
            const currentPrice = currentPrices[symbol] || position.entryPrice;
            value += position.amount * currentPrice;
        }
        return value;
    }
}

module.exports = LiveTrader;
