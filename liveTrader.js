const fs = require('fs');
const chalk = require('chalk');
const { getAccountInfo, getUSDTBalance, placeMarketOrder, placeLimitOrder, placeOcoSellOrder, cancelOrder, cancelOrderList, getOrderStatus } = require('./binanceApi');
const { getExchangeInfo, roundStep, roundTick } = require('./exchangeInfo');
const { TRADING_CONFIG, getRiskDistance, getTakeProfitDistance, getTradeAmountUSD } = require('./tradingConfig');

const STATE_FILE = './live_state.json';
const delay = ms => new Promise(res => setTimeout(res, ms));

class LiveTrader {
    constructor() {
        this.state = this.loadState() || {
            balance: 0,
            initialBalance: 0,
            positions: {},
            tradeHistory: [],
            dailyLosses: 0,
            dailyDrawdownUSD: 0,
            lastLossDate: new Date().toDateString()
        };
        if (this.state.balance === undefined) this.state.balance = 0;
        if (this.state.initialBalance === undefined) this.state.initialBalance = 0;
        this.balance = this.state.balance;
        this.syncBalance(); 
        this.reconcilePositions();
        setInterval(() => this.reconcilePositions(), 30000);
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
            this.state.balance = this.balance;
            if (!this.state.initialBalance) this.state.initialBalance = this.balance;
            this.saveState();
        } catch(e) {
            console.error(chalk.red("Failed to fetch balance from Binance:", e.message));
        }
    }

    async reconcilePositions() {
        try {
            const account = await getAccountInfo();
            const balances = {};
            account.balances.forEach(b => {
                const total = parseFloat(b.free) + parseFloat(b.locked);
                if (total > 0) {
                    balances[b.asset] = total;
                }
            });

            const exInfo = await getExchangeInfo();

            for (const [coinSymbol, position] of Object.entries(this.state.positions)) {
                const baseAsset = coinSymbol.replace("USDT", "");
                const exchangeQty = balances[baseAsset] || 0;
                
                const symbolRules = exInfo[coinSymbol];
                const minQty = symbolRules ? parseFloat(symbolRules.stepSize) : 0.0001;

                if (exchangeQty < minQty) {
                    console.log(chalk.yellow("[RECONCILE] Position for " + coinSymbol + " not found on exchange (Exchange qty: " + exchangeQty + ", min: " + minQty + "). Removing from state."));
                    
                    if (position.protectionOrderListId) {
                        try {
                            await cancelOrderList(coinSymbol, position.protectionOrderListId);
                        } catch (err) {}
                    }

                    const lastPrice = (this.state.currentPrices && this.state.currentPrices[coinSymbol]) || position.entryPrice;
                    const profitLoss = (position.amount * lastPrice) - (position.amount * position.entryPrice);

                    this.state.tradeHistory.push({ 
                        action: "SELL", 
                        coin: coinSymbol, 
                        amount: position.amount, 
                        reason: "Exchange Reconciliation (OCO or Manual Exit)", 
                        timestamp: new Date().toISOString() 
                    });
                    
                    delete this.state.positions[coinSymbol];
                    this.saveState();
                } else {
                    const diffPct = Math.abs(position.amount - exchangeQty) / position.amount;
                    if (diffPct > 0.01 && diffPct < 0.90) {
                        console.log(chalk.blue("[RECONCILE] Aligning amount for " + coinSymbol + ": " + position.amount + " -> " + exchangeQty));
                        position.amount = exchangeQty;
                        this.saveState();
                    }
                }
            }
        } catch (e) {
            console.error(chalk.red("[RECONCILE] Failed to reconcile positions:", e.message));
        }
    }

    async executeHybridOrder(coinSymbol, side, amount, currentPrice, symbolRules) {
        let limitPrice = side === 'BUY'
            ? currentPrice * (1 + TRADING_CONFIG.entryLimitBufferPct)
            : currentPrice * (1 - TRADING_CONFIG.entryLimitBufferPct);
        limitPrice = roundTick(limitPrice, symbolRules.tickSize);
        amount = roundStep(amount, symbolRules.stepSize);

        try {
            console.log(chalk.yellow(`Placing Hybrid LIMIT ${side} for ${amount} ${coinSymbol} at ${limitPrice}...`));
            const limitOrder = await placeLimitOrder(coinSymbol, side, amount, limitPrice);
            const orderId = limitOrder.orderId;

            // Monitoring window
            await delay(TRADING_CONFIG.limitOrderWaitMs);

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

    async placeProtectionOco(coinSymbol, quantity, tpPrice, slPrice, symbolRules) {
        const roundedQty = roundStep(quantity, symbolRules.stepSize);
        const roundedTp = roundTick(tpPrice, symbolRules.tickSize);
        const roundedStop = roundTick(slPrice, symbolRules.tickSize);
        const roundedStopLimit = roundTick(slPrice * (1 - TRADING_CONFIG.stopLimitBufferPct), symbolRules.tickSize);

        if (roundedQty <= 0) return null;

        try {
            const oco = await placeOcoSellOrder(coinSymbol, roundedQty, roundedTp, roundedStop, roundedStopLimit);
            console.log(chalk.green(`Placed protective OCO for ${coinSymbol}. TP: ${roundedTp}, SL: ${roundedStop}`));
            return oco;
        } catch (e) {
            console.error(chalk.red(`FAILED to place protective OCO for ${coinSymbol}:`, e.response ? JSON.stringify(e.response.data) : e.message));
            return null;
        }
    }

    async cancelProtectionOco(coinSymbol) {
        const position = this.state.positions[coinSymbol];
        if (!position?.protectionOrderListId) return;

        try {
            await cancelOrderList(coinSymbol, position.protectionOrderListId);
            delete position.protectionOrderListId;
            this.saveState();
        } catch (e) {
            console.error(chalk.red(`FAILED to cancel protective OCO for ${coinSymbol}:`, e.response ? JSON.stringify(e.response.data) : e.message));
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
            if (this.state.dailyDrawdownUSD >= portfolioValue * TRADING_CONFIG.dailyMaxDrawdownPct) {
                console.log(`Daily max drawdown reached (Portfolio: $${portfolioValue.toFixed(2)}). Skipping BUY.`);
                return;
            }

            const universe = this.loadUniverse();
            let tradeAmountUSD = getTradeAmountUSD(this.balance, currentPrice, atr, universe, coinSymbol, symbolRules.minNotional);
            
            if (!tradeAmountUSD) {
                console.log(`Trade size under minimum for ${coinSymbol}. Skipping.`);
                return;
            }
            
            let coinAmount = tradeAmountUSD / currentPrice;

            try {
                const result = await this.executeHybridOrder(coinSymbol, 'BUY', coinAmount, currentPrice, symbolRules);
                const actualQty = result.executedQty;
                
                const riskDist = getRiskDistance(atr, currentPrice);
                const entryPrice = result.avgPrice || currentPrice;
                const slPrice = entryPrice - riskDist;
                const tp1Price = entryPrice + getTakeProfitDistance(atr);
                const oco = await this.placeProtectionOco(coinSymbol, actualQty, tp1Price, slPrice, symbolRules);

                this.state.positions[coinSymbol] = {
                    amount: actualQty,
                    totalSize: actualQty,
                    entryPrice,
                    slPrice: slPrice,
                    tp1Price: tp1Price,
                    tp1Hit: false,
                    riskDist: riskDist,
                    entryAtr: atr,
                    protectionOrderListId: oco?.orderListId,
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

            await this.cancelProtectionOco(coinSymbol);

            // Warn if the actual sell order is below minNotional itself
            if (symbolRules && (sellAmount * currentPrice < symbolRules.minNotional)) {
                console.warn(chalk.red(`[WARNING] Full exit amount for ${coinSymbol} ($${(sellAmount * currentPrice).toFixed(2)}) is below exchange minNotional ($${symbolRules.minNotional}). Order may fail on exchange.`));
            }

            try {
                const roundedQty = roundStep(sellAmount, symbolRules.stepSize);
                console.log(chalk.yellow("Executing direct MARKET SELL for " + roundedQty + " " + coinSymbol + "..."));
                const result = await placeMarketOrder(coinSymbol, "SELL", roundedQty);
                const actualSold = parseFloat(result.executedQty);
                
                const sellValueUSD = actualSold * currentPrice;
                const fee = sellValueUSD * TRADING_CONFIG.feeRate;
                const profitLoss = (sellValueUSD - fee) - (actualSold * position.entryPrice);
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
            const roundedQty = roundStep(sellAmount, symbolRules.stepSize);
            console.log(chalk.yellow("Executing direct MARKET PARTIAL SELL for " + roundedQty + " " + coinSymbol + "..."));
            const result = await placeMarketOrder(coinSymbol, "SELL", roundedQty);
            const actualSold = parseFloat(result.executedQty);
            
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

        // Stop-Limit Skip Protection: If the current price is significantly below our Stop Loss,
        // it means the exchange STOP_LOSS_LIMIT order was likely skipped during a high-volatility flash crash.
        // Force-cancel OCO and exit immediately via MARKET order.
        const triggerBuffer = position.entryAtr ? (position.entryAtr * 0.5) : (position.entryPrice * 0.01);
        if (currentPrice <= (position.slPrice - triggerBuffer)) {
            console.log(chalk.red("[ALERT] Price (" + currentPrice + ") is significantly below SL (" + position.slPrice + "). OCO stop-limit may have been skipped. Force-exiting at MARKET."));
            if (position.protectionOrderListId) {
                try {
                    await this.cancelProtectionOco(coinSymbol);
                } catch(e) {}
            }
            await this.executeTrade(coinSymbol, "SELL", currentPrice, position.strategy, "Stop Loss Skipped (Emergency Market Exit)");
            return true;
        }

        if (!position.tp1Hit && currentPrice >= position.tp1Price) {
            if (position.protectionOrderListId) return false;
            position.tp1Hit = true;
            await this.executePartialSell(coinSymbol, currentPrice, TRADING_CONFIG.takeProfitFraction, 'Take Profit');
            if (position.slPrice < position.entryPrice) {
                position.slPrice = position.entryPrice;
            }
            this.saveState();
        }

        if (currentPrice <= position.slPrice) {
            if (position.protectionOrderListId) return false;
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
        const newStop = currentPrice - (position.entryAtr * TRADING_CONFIG.trailingAtrMultiplier);
        if(newStop > position.slPrice){
            position.slPrice = newStop;
            if (position.protectionOrderListId) {
                await this.cancelProtectionOco(coinSymbol);
                const exInfo = await getExchangeInfo();
                const symbolRules = exInfo[coinSymbol];
                const oco = await this.placeProtectionOco(coinSymbol, position.amount, position.tp1Price, position.slPrice, symbolRules);
                position.protectionOrderListId = oco?.orderListId;
            }
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
