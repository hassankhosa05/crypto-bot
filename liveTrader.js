const fs = require('fs');
const chalk = require('chalk');
const { getAccountInfo, getUSDTBalance, placeMarketOrder, placeLimitOrder, placeOcoSellOrder, cancelOrder, cancelOrderList, getOrderStatus } = require('./binanceApi');
const { getExchangeInfo, roundStep, roundTick } = require('./exchangeInfo');
const { TRADING_CONFIG, getRiskDistance, getTakeProfitDistance, getTradeAmountUSD } = require('./tradingConfig');

const STATE_FILE = './live_state.json';
const BAK_FILE   = STATE_FILE + '.bak';
const TRADE_HISTORY_CAP = 500;
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
        if (this.state.balance === undefined)        this.state.balance = 0;
        if (this.state.initialBalance === undefined) this.state.initialBalance = 0;
        this.balance = this.state.balance;

        // Per-symbol async mutex map — prevents concurrent order mutations on the same coin
        this._symbolLocks = {};

        // Register graceful-shutdown flush once per process
        if (!LiveTrader._shutdownRegistered) {
            LiveTrader._shutdownRegistered = true;
            const flush = () => { try { this.saveState(); } catch (_) {} process.exit(0); };
            process.on('SIGTERM', flush);
            process.on('SIGINT',  flush);
        }

        this.syncBalance();
        this.reconcilePositions();
        setInterval(() => this.reconcilePositions(), 30000);
    }

    // ─────────────────────────────────────────────────────────────────
    // Mutex: serialise all mutations for a given coin symbol
    // ─────────────────────────────────────────────────────────────────
    async withSymbolLock(symbol, fn) {
        if (!this._symbolLocks[symbol]) this._symbolLocks[symbol] = Promise.resolve();
        const prev = this._symbolLocks[symbol];
        let release;
        this._symbolLocks[symbol] = new Promise(r => { release = r; });
        await prev;
        try {
            return await fn();
        } finally {
            release();
        }
    }

    loadUniverse() {
        if (fs.existsSync('./active_universe.json')) {
            try { return JSON.parse(fs.readFileSync('./active_universe.json', 'utf8')); }
            catch (e) { return null; }
        }
        return null;
    }

    loadState() {
        // Try primary, then .bak
        for (const file of [STATE_FILE, BAK_FILE]) {
            if (fs.existsSync(file)) {
                try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
                catch (e) { /* try next */ }
            }
        }
        return null;
    }

    // Atomic write: tmp → rename. Keeps a .bak of the previous good state.
    saveState() {
        const tmp = STATE_FILE + '.tmp';
        try {
            fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
            // Promote current good file to .bak before replacing
            if (fs.existsSync(STATE_FILE)) {
                try { fs.copyFileSync(STATE_FILE, BAK_FILE); } catch (_) {}
            }
            fs.renameSync(tmp, STATE_FILE);
        } catch (e) {
            console.error(chalk.red('[STATE] Atomic save failed, falling back to direct write:', e.message));
            try { fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2)); } catch (_) {}
        }
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

    async syncBalance() {
        try {
            this.balance = await getUSDTBalance();
            this.state.balance = this.balance;
            if (!this.state.initialBalance) this.state.initialBalance = this.balance;
            this.saveState();
        } catch (e) {
            console.error(chalk.red("Failed to fetch balance from Binance:", e.message));
        }
    }

    async reconcilePositions() {
        // Runs under no per-symbol lock intentionally — it serialises internally per symbol
        try {
            const account = await getAccountInfo();
            const balances = {};
            account.balances.forEach(b => {
                const total = parseFloat(b.free) + parseFloat(b.locked);
                if (total > 0) balances[b.asset] = { total, free: parseFloat(b.free) };
            });

            const exInfo = await getExchangeInfo();

            // 1. Prune or align known positions
            for (const [coinSymbol, position] of Object.entries(this.state.positions)) {
                await this.withSymbolLock(coinSymbol, async () => {
                    if (!this.state.positions[coinSymbol]) return; // already removed by a concurrent op
                    const baseAsset = coinSymbol.replace('USDT', '');
                    const exchangeQty = balances[baseAsset]?.total || 0;
                    const symbolRules = exInfo[coinSymbol];
                    const minQty = symbolRules ? parseFloat(symbolRules.stepSize) : 0.0001;

                    if (exchangeQty < minQty) {
                        console.log(chalk.yellow(`[RECONCILE] ${coinSymbol} not found on exchange (qty: ${exchangeQty}). Removing from state.`));

                        if (position.protectionOrderListId) {
                            try { await cancelOrderList(coinSymbol, position.protectionOrderListId); } catch (_) {}
                        }

                        const lastPrice = (this.state.currentPrices && this.state.currentPrices[coinSymbol]) || position.entryPrice;
                        const grossPnL = (position.amount * lastPrice) - (position.amount * position.entryPrice);
                        const fee = position.amount * lastPrice * TRADING_CONFIG.feeRate;
                        const profitLoss = grossPnL - fee;

                        // Feed into drawdown gate so OCO exits count
                        if (profitLoss < 0) {
                            this.state.dailyLosses += 1;
                            this.state.dailyDrawdownUSD += Math.abs(profitLoss);
                        }

                        this.state.tradeHistory.push({
                            action: 'SELL',
                            coin: coinSymbol,
                            amount: position.amount,
                            strategy: position.strategy,
                            pnl: profitLoss,
                            reason: 'Exchange Reconciliation (OCO or Manual Exit)',
                            timestamp: new Date().toISOString()
                        });
                        this._capTradeHistory();
                        delete this.state.positions[coinSymbol];
                        this.saveState();
                    } else {
                        const diffPct = Math.abs(position.amount - exchangeQty) / position.amount;
                        if (diffPct > 0.01 && diffPct < 0.90) {
                            console.log(chalk.blue(`[RECONCILE] Aligning ${coinSymbol}: ${position.amount} -> ${exchangeQty}`));
                            position.amount = exchangeQty;
                            this.saveState();
                        }
                    }
                });
            }

            // 2. Adopt orphan positions (on exchange but missing from state)
            for (const [asset, { total: qty, free }] of Object.entries(balances)) {
                if (asset === 'USDT') continue;
                const symbol = asset + 'USDT';
                if (this.state.positions[symbol]) continue;     // already tracked
                if (!exInfo[symbol]) continue;                  // not a tracked USDT pair

                const symbolRules = exInfo[symbol];
                const minQty = symbolRules ? parseFloat(symbolRules.stepSize) : 0.0001;
                const price  = (this.state.currentPrices && this.state.currentPrices[symbol]) || 0;
                const notional = qty * price;

                if (qty >= minQty && price > 0 && notional > (symbolRules?.minNotional || 5)) {
                    console.log(chalk.yellow(`[RECONCILE] Adopting orphan position: ${qty} ${asset} @ ~$${price.toFixed(4)}`));
                    this.state.positions[symbol] = {
                        amount: qty,
                        totalSize: qty,
                        entryPrice: price,
                        slPrice: price * 0.97,     // emergency 3% stop
                        tp1Price: price * 1.06,
                        tp1Hit: false,
                        riskDist: price * 0.03,
                        entryAtr: 0,
                        protectionOrderListId: null,
                        strategy: 'Reconciled Orphan',
                        timestamp: Date.now()
                    };
                    this.saveState();
                }
            }
        } catch (e) {
            console.error(chalk.red("[RECONCILE] Failed:", e.message));
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

            await delay(TRADING_CONFIG.limitOrderWaitMs);

            const statusRes = await getOrderStatus(coinSymbol, orderId);

            if (statusRes.status === 'FILLED') {
                const avgPrice = parseFloat(statusRes.cummulativeQuoteQty) / parseFloat(statusRes.executedQty) || limitPrice;
                console.log(chalk.green(`Limit ${side} FILLED at avg $${avgPrice.toFixed(4)}`));
                return { status: 'FILLED', executedQty: parseFloat(statusRes.executedQty), avgPrice };
            } else {
                console.log(chalk.yellow(`Limit ${side} not filled (${statusRes.status}). Cancelling and falling back to MARKET...`));
                try {
                    await cancelOrder(coinSymbol, orderId);
                } catch (cancelErr) {
                    if (cancelErr.response?.data?.code === -2011) {
                        const finalCheck = await getOrderStatus(coinSymbol, orderId);
                        if (finalCheck.status === 'FILLED') {
                            const avgPrice = parseFloat(finalCheck.cummulativeQuoteQty) / parseFloat(finalCheck.executedQty) || limitPrice;
                            return { status: 'FILLED', executedQty: parseFloat(finalCheck.executedQty), avgPrice };
                        }
                    }
                }

                const cancelRes = await getOrderStatus(coinSymbol, orderId);
                const filledSoFar = parseFloat(cancelRes.executedQty);
                const remaining = amount - filledSoFar;

                if (remaining > 0) {
                    const roundedRemaining = roundStep(remaining, symbolRules.stepSize);
                    if (roundedRemaining > 0) {
                        console.log(chalk.magenta(`MARKET fallback for remaining ${roundedRemaining}...`));
                        const marketOrder = await placeMarketOrder(coinSymbol, side, roundedRemaining);
                        const marketQty = parseFloat(marketOrder.executedQty);
                        const marketAvg = parseFloat(marketOrder.cummulativeQuoteQty) / marketQty;
                        const blendedAvg = filledSoFar > 0
                            ? ((filledSoFar * limitPrice) + (marketQty * marketAvg)) / (filledSoFar + marketQty)
                            : marketAvg;
                        return { status: 'HYBRID_FILLED', executedQty: filledSoFar + marketQty, avgPrice: blendedAvg };
                    }
                }
                return { status: 'PARTIAL_FILLED', executedQty: filledSoFar, avgPrice: limitPrice };
            }
        } catch (e) {
            console.error(chalk.red(`Limit order failed, falling back to MARKET:`, e.response ? JSON.stringify(e.response.data) : e.message));
            try {
                const marketOrder = await placeMarketOrder(coinSymbol, side, amount);
                const marketQty = parseFloat(marketOrder.executedQty);
                const avgPrice  = parseFloat(marketOrder.cummulativeQuoteQty) / marketQty;
                return { status: 'MARKET_FILLED', executedQty: marketQty, avgPrice };
            } catch (fallbackErr) {
                console.error(chalk.red(`MARKET fallback also failed:`, fallbackErr.response ? JSON.stringify(fallbackErr.response.data) : fallbackErr.message));
                throw fallbackErr;
            }
        }
    }

    async placeProtectionOco(coinSymbol, quantity, tpPrice, slPrice, symbolRules) {
        const roundedQty       = roundStep(quantity, symbolRules.stepSize);
        const roundedTp        = roundTick(tpPrice, symbolRules.tickSize);
        const roundedStop      = roundTick(slPrice, symbolRules.tickSize);
        const roundedStopLimit = roundTick(slPrice * (1 - TRADING_CONFIG.stopLimitBufferPct), symbolRules.tickSize);

        if (roundedQty <= 0) return null;

        try {
            const oco = await placeOcoSellOrder(coinSymbol, roundedQty, roundedTp, roundedStop, roundedStopLimit);
            console.log(chalk.green(`Placed OCO for ${coinSymbol}. TP: ${roundedTp}, SL: ${roundedStop}`));
            return oco;
        } catch (e) {
            console.error(chalk.red(`FAILED to place OCO for ${coinSymbol}:`, e.response ? JSON.stringify(e.response.data) : e.message));
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
            console.error(chalk.red(`FAILED to cancel OCO for ${coinSymbol}:`, e.response ? JSON.stringify(e.response.data) : e.message));
        }
    }

    async executeTrade(coinSymbol, action, currentPrice, strategyName, reason = '', atr = 0) {
        return this.withSymbolLock(coinSymbol, async () => {
            this.resetDailyLossesIfNewDay();
            await this.syncBalance();

            const exInfo = await getExchangeInfo();
            const symbolRules = exInfo[coinSymbol];
            if (!symbolRules) {
                console.log("No symbol rules found for", coinSymbol);
                return;
            }

            if (action === 'BUY' && !this.state.positions[coinSymbol]) {
                // Gate 1: portfolio-value drawdown
                const portfolioValue = this.getPortfolioValue(this.state.currentPrices || {});
                if (this.state.dailyDrawdownUSD >= portfolioValue * TRADING_CONFIG.dailyMaxDrawdownPct) {
                    console.log(`Daily max drawdown reached (portfolio: $${portfolioValue.toFixed(2)}). Skipping BUY for ${coinSymbol}.`);
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
                // Size off total portfolio equity, not just free USDT — cap to actual free balance
                const portfolioVal = this.getPortfolioValue(this.state.currentPrices || {});
                let tradeAmountUSD = getTradeAmountUSD(portfolioVal, currentPrice, atr, universe, coinSymbol, symbolRules.minNotional);
                // Constrain to what we actually have free
                tradeAmountUSD = Math.min(tradeAmountUSD, this.balance * TRADING_CONFIG.maxBalanceUsePct);

                if (!tradeAmountUSD || tradeAmountUSD < Math.max(TRADING_CONFIG.minTradeUSD, symbolRules.minNotional)) {
                    console.log(`Trade size under minimum for ${coinSymbol}. Skipping.`);
                    return;
                }

                let coinAmount = tradeAmountUSD / currentPrice;

                try {
                    const result = await this.executeHybridOrder(coinSymbol, 'BUY', coinAmount, currentPrice, symbolRules);
                    const actualQty   = result.executedQty;
                    const entryPrice  = result.avgPrice || currentPrice;
                    const riskDist    = getRiskDistance(atr, entryPrice);
                    const slPrice     = entryPrice - riskDist;
                    const tp1Price    = entryPrice + getTakeProfitDistance(atr);
                    const oco = await this.placeProtectionOco(coinSymbol, actualQty, tp1Price, slPrice, symbolRules);

                    this.state.positions[coinSymbol] = {
                        amount: actualQty,
                        totalSize: actualQty,
                        entryPrice,
                        slPrice,
                        tp1Price,
                        tp1Hit: false,
                        riskDist,
                        entryAtr: atr,
                        protectionOrderListId: oco?.orderListId,
                        strategy: strategyName,
                        timestamp: Date.now()
                    };

                    console.log(chalk.green(`LIVE BOUGHT ${actualQty} ${coinSymbol} @ avg $${entryPrice.toFixed(4)}. SL: ${slPrice.toFixed(4)}`));
                    this.state.tradeHistory.push({ action: 'BUY', coin: coinSymbol, amount: actualQty, strategy: strategyName, reason, timestamp: new Date().toISOString() });
                    this._capTradeHistory();
                    this.saveState();
                } catch (e) {
                    console.error(chalk.red(`LIVE BUY FAILED for ${coinSymbol}:`, e.message));
                }

            } else if (action === 'SELL' && this.state.positions[coinSymbol]) {
                const position = this.state.positions[coinSymbol];

                await this.cancelProtectionOco(coinSymbol);

                if (symbolRules && (position.amount * currentPrice < symbolRules.minNotional)) {
                    console.warn(chalk.red(`[WARNING] Exit for ${coinSymbol} below minNotional. Order may fail.`));
                }

                try {
                    const roundedQty = roundStep(position.amount, symbolRules.stepSize);
                    const result = await placeMarketOrder(coinSymbol, 'SELL', roundedQty);
                    const actualSold = parseFloat(result.executedQty);
                    const fillAvg    = parseFloat(result.cummulativeQuoteQty) / actualSold;
                    const sellValueUSD = actualSold * fillAvg;
                    const fee = sellValueUSD * TRADING_CONFIG.feeRate;
                    const profitLoss = (sellValueUSD - fee) - (actualSold * position.entryPrice);

                    if (profitLoss < 0) {
                        this.state.dailyLosses += 1;
                        this.state.dailyDrawdownUSD += Math.abs(profitLoss);
                    }

                    if (actualSold >= position.amount * 0.99) {
                        delete this.state.positions[coinSymbol];
                    } else {
                        this.state.positions[coinSymbol].amount -= actualSold;
                    }

                    console.log(chalk.green(`LIVE SOLD ${actualSold} ${coinSymbol} @ avg $${fillAvg.toFixed(4)}. P/L: $${profitLoss.toFixed(2)}. Reason: ${reason}`));
                    this.state.tradeHistory.push({ action: 'SELL', coin: coinSymbol, amount: actualSold, strategy: position.strategy, pnl: profitLoss, reason, timestamp: new Date().toISOString() });
                    this._capTradeHistory();
                    this.saveState();
                    await this.syncBalance();
                } catch (e) {
                    console.error(chalk.red(`LIVE SELL FAILED for ${coinSymbol}:`, e.message));
                    if (this.state.positions[coinSymbol]) {
                        this.state.positions[coinSymbol].lastAttemptTime = Date.now();
                        this.saveState();
                    }
                }
            }
        });
    }

    // Internal partial sell — no lock. Called from within already-locked contexts.
    async _doPartialSell(coinSymbol, currentPrice, fraction, reason, symbolRules, position) {
        let sellAmount = position.totalSize * fraction;
        const sellValueUSD = sellAmount * currentPrice;
        const remainingAmount = position.amount - sellAmount;
        const remainingValueUSD = remainingAmount * currentPrice;

        if (symbolRules && (sellValueUSD < symbolRules.minNotional || remainingValueUSD < symbolRules.minNotional)) {
            console.log(chalk.yellow(`Partial sell for ${coinSymbol} below MIN_NOTIONAL. Executing FULL sell.`));
            await this._doSell(coinSymbol, currentPrice, position, symbolRules, `${reason} (Full Sell due to MIN_NOTIONAL limit)`);
            return;
        }

        try {
            const roundedQty = roundStep(sellAmount, symbolRules.stepSize);
            const result = await placeMarketOrder(coinSymbol, 'SELL', roundedQty);
            const actualSold = parseFloat(result.executedQty);
            const fillAvg    = parseFloat(result.cummulativeQuoteQty) / actualSold;

            position.amount -= actualSold;
            const profitLoss = (actualSold * fillAvg * (1 - TRADING_CONFIG.feeRate)) - (actualSold * position.entryPrice);

            console.log(chalk.green(`LIVE PARTIAL SOLD ${actualSold} ${coinSymbol} @ avg $${fillAvg.toFixed(4)}. Reason: ${reason}`));
            this.state.tradeHistory.push({ action: 'PARTIAL_SELL', coin: coinSymbol, amount: actualSold, strategy: position.strategy, pnl: profitLoss, reason, timestamp: new Date().toISOString() });
            this._capTradeHistory();
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

    // Public partial sell — acquires lock. Called from outside (e.g. index.js won't call this).
    async executePartialSell(coinSymbol, currentPrice, fraction, reason) {
        return this.withSymbolLock(coinSymbol, async () => {
            const position = this.state.positions[coinSymbol];
            if (!position) return;
            const exInfo = await getExchangeInfo();
            const symbolRules = exInfo[coinSymbol];
            if (!symbolRules) return;
            await this._doPartialSell(coinSymbol, currentPrice, fraction, reason, symbolRules, position);
        });
    }

    // Internal sell that does NOT acquire the symbol lock (called from within a locked context)
    async _doSell(coinSymbol, currentPrice, position, symbolRules, reason) {
        await this.cancelProtectionOco(coinSymbol);
        try {
            const roundedQty = roundStep(position.amount, symbolRules.stepSize);
            const result = await placeMarketOrder(coinSymbol, 'SELL', roundedQty);
            const actualSold = parseFloat(result.executedQty);
            const fillAvg    = parseFloat(result.cummulativeQuoteQty) / actualSold;
            const sellValueUSD = actualSold * fillAvg;
            const fee = sellValueUSD * TRADING_CONFIG.feeRate;
            const profitLoss = (sellValueUSD - fee) - (actualSold * position.entryPrice);

            if (profitLoss < 0) {
                this.state.dailyLosses += 1;
                this.state.dailyDrawdownUSD += Math.abs(profitLoss);
            }

            delete this.state.positions[coinSymbol];
            console.log(chalk.green(`LIVE SOLD ${actualSold} ${coinSymbol} @ avg $${fillAvg.toFixed(4)}. P/L: $${profitLoss.toFixed(2)}. Reason: ${reason}`));
            this.state.tradeHistory.push({ action: 'SELL', coin: coinSymbol, amount: actualSold, strategy: position.strategy, pnl: profitLoss, reason, timestamp: new Date().toISOString() });
            this._capTradeHistory();
            this.saveState();
            await this.syncBalance();
        } catch (e) {
            console.error(chalk.red(`_doSell FAILED for ${coinSymbol}:`, e.message));
            if (this.state.positions[coinSymbol]) {
                this.state.positions[coinSymbol].lastAttemptTime = Date.now();
                this.saveState();
            }
        }
    }

    async checkRiskManagement(coinSymbol, currentPrice) {
        return this.withSymbolLock(coinSymbol, async () => {
            if (!this.state.positions[coinSymbol]) return false;
            const position = this.state.positions[coinSymbol];

            if (position.lastAttemptTime && Date.now() - position.lastAttemptTime < 10000) return false;

            this.resetDailyLossesIfNewDay();

            // Stop-skip protection: price is significantly below SL — exchange stop may have been skipped.
            const triggerBuffer = position.entryAtr ? (position.entryAtr * 0.5) : (position.entryPrice * 0.01);
            if (currentPrice <= (position.slPrice - triggerBuffer)) {
                console.log(chalk.red(`[ALERT] Price (${currentPrice}) far below SL (${position.slPrice}). Force-exiting.`));

                // Check how much we actually hold before selling (OCO may have already fired)
                try {
                    const account = await getAccountInfo();
                    const baseAsset = coinSymbol.replace('USDT', '');
                    const holding = account.balances.find(b => b.asset === baseAsset);
                    const freeQty = holding ? parseFloat(holding.free) : 0;

                    if (freeQty < position.amount * 0.01) {
                        // Exchange already sold via OCO — clean up state
                        console.log(chalk.yellow(`[ALERT] OCO already executed for ${coinSymbol}. Cleaning up state.`));
                        if (position.protectionOrderListId) {
                            try { await cancelOrderList(coinSymbol, position.protectionOrderListId); } catch (_) {}
                        }
                        delete this.state.positions[coinSymbol];
                        this.saveState();
                        return true;
                    }
                } catch (_) { /* If balance check fails, proceed with the sell anyway */ }

                if (position.protectionOrderListId) {
                    try { await cancelOrderList(coinSymbol, position.protectionOrderListId); delete position.protectionOrderListId; } catch (_) {}
                }

                const exInfo = await getExchangeInfo();
                const symbolRules = exInfo[coinSymbol];
                if (symbolRules) await this._doSell(coinSymbol, currentPrice, position, symbolRules, 'Stop Loss Skipped (Emergency Market Exit)');
                return true;
            }

            if (!position.tp1Hit && currentPrice >= position.tp1Price) {
                if (position.protectionOrderListId) return false; // OCO handles it
                position.tp1Hit = true;
                // Use _doPartialSell (no lock) — we already hold the symbol lock here
                const exInfoTp = await getExchangeInfo();
                const rulesTp  = exInfoTp[coinSymbol];
                if (rulesTp) await this._doPartialSell(coinSymbol, currentPrice, TRADING_CONFIG.takeProfitFraction, 'Take Profit', rulesTp, position);
                if (this.state.positions[coinSymbol] && position.slPrice < position.entryPrice) {
                    position.slPrice = position.entryPrice;
                }
                this.saveState();
            }

            if (this.state.positions[coinSymbol] && currentPrice <= position.slPrice) {
                if (position.protectionOrderListId) return false; // OCO handles it
                const exInfo = await getExchangeInfo();
                const symbolRules = exInfo[coinSymbol];
                if (symbolRules) await this._doSell(coinSymbol, currentPrice, position, symbolRules, 'Stop Loss');
                return true;
            }

            return false;
        });
    }

    async updateTrailingStops(coinSymbol, currentPrice, emergencyExitFlag = false) {
        return this.withSymbolLock(coinSymbol, async () => {
            if (!this.state.positions[coinSymbol]) return false;
            const position = this.state.positions[coinSymbol];

            if (position.lastAttemptTime && Date.now() - position.lastAttemptTime < 10000) return false;

            const newStop = currentPrice - (position.entryAtr * TRADING_CONFIG.trailingAtrMultiplier);
            if (newStop > position.slPrice) {
                if (position.protectionOrderListId) {
                    const exInfo = await getExchangeInfo();
                    const symbolRules = exInfo[coinSymbol];
                    const oldStop = position.slPrice;
                    const oldOcoId = position.protectionOrderListId;

                    // Cancel old OCO first (exchange won't accept two concurrent OCOs per symbol/side)
                    await this.cancelProtectionOco(coinSymbol);

                    const newOco = await this.placeProtectionOco(coinSymbol, position.amount, position.tp1Price, newStop, symbolRules);
                    if (newOco) {
                        position.slPrice = newStop;
                        position.protectionOrderListId = newOco.orderListId;
                        console.log(chalk.blue(`Trailing Stop moved for ${coinSymbol}: ${oldStop.toFixed(4)} → ${newStop.toFixed(4)}`));
                    } else {
                        // Replacement failed — restore protection at original stop level
                        console.error(chalk.red(`OCO replacement failed for ${coinSymbol}. Restoring original stop.`));
                        const restore = await this.placeProtectionOco(coinSymbol, position.amount, position.tp1Price, oldStop, symbolRules);
                        position.protectionOrderListId = restore?.orderListId;
                        // Do NOT advance slPrice — only advance when replacement succeeds
                    }
                } else {
                    position.slPrice = newStop;
                    console.log(chalk.blue(`Trailing Stop moved for ${coinSymbol} to ${newStop.toFixed(4)}`));
                }
                this.saveState();
            }

            if (emergencyExitFlag) {
                const exInfo = await getExchangeInfo();
                const symbolRules = exInfo[coinSymbol];
                if (symbolRules && this.state.positions[coinSymbol]) {
                    await this._doSell(coinSymbol, currentPrice, position, symbolRules, 'Emergency Exit V2.3');
                }
                return true;
            }
            return false;
        });
    }

    getPortfolioValue(currentPrices) {
        let value = this.balance;
        for (const [symbol, position] of Object.entries(this.state.positions)) {
            const price = (currentPrices && currentPrices[symbol]) || position.entryPrice;
            value += position.amount * price;
        }
        return value;
    }
}

LiveTrader._shutdownRegistered = false;

module.exports = LiveTrader;
