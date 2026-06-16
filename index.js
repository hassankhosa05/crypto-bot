require('dotenv').config();
const WebSocket = require('ws');
const chalk = require('chalk');
const { fetchMidCapCoins, fetchHistoricalData, delay } = require('./dataFetcher');
const { evaluateTradeV2: evaluateTrade, checkEmergencyExitV2: checkEmergencyExit } = require('./strategyV2');
const PaperTrader = require('./paperTrader');
const { startDashboard } = require('./dashboard');
const { TRADING_CONFIG } = require('./tradingConfig');
const { syncServerTime } = require('./binanceApi');

// ─────────────────────────────────────────────────────────────────────────────
// Unhandled error safety net — log and attempt to keep the process alive
// ─────────────────────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
    console.error(chalk.red('[FATAL] Unhandled promise rejection:'), reason);
});
process.on('uncaughtException', (err) => {
    console.error(chalk.red('[FATAL] Uncaught exception:'), err);
});

let trader;
if (process.env.TRADE_MODE === 'LIVE') {
    const LiveTrader = require('./liveTrader');
    trader = new LiveTrader();
    // Sync clock before any signed requests
    syncServerTime().catch(() => {});
    console.log(chalk.red.bold("!!! WARNING: BOT IS RUNNING IN LIVE TRADING MODE WITH REAL MONEY !!!"));
} else {
    trader = new PaperTrader(300);
    console.log(chalk.green("Bot is running in PAPER TRADING mode."));
}

const historicalDataStore = {};
const emergencyExitCache  = {};
let dashboardStarted = false;
let activeWs = null;
let rotationTimer = null;

// ─────────────────────────────────────────────────────────────────────────────
// Per-symbol async mutex — prevents concurrent async handlers from racing on
// the same coin's position state across multiple WebSocket ticks
// ─────────────────────────────────────────────────────────────────────────────
const symbolLocks = {};

async function withSymbolLock(symbol, fn) {
    if (!symbolLocks[symbol]) symbolLocks[symbol] = Promise.resolve();
    const prev = symbolLocks[symbol];
    let release;
    symbolLocks[symbol] = new Promise(r => { release = r; });
    await prev;
    try {
        return await fn();
    } finally {
        release();
    }
}

function scheduleUniverseRotation(delayMs = 3 * 24 * 60 * 60 * 1000) {
    if (rotationTimer) return;
    console.log(chalk.green("Next universe rotation in " + (delayMs / (60 * 60 * 1000)).toFixed(1) + " hours."));
    rotationTimer = setTimeout(async () => {
        rotationTimer = null;
        console.log(chalk.yellow('\n=== Running Scheduled Universe Rotation ==='));
        let success = false;
        try {
            const { runSelector } = require('./universeSelector');
            await runSelector();
            success = true;
        } catch (e) {
            console.error(chalk.red('Universe rotation failed:'), e.message);
        }

        if (success) {
            console.log(chalk.green('Universe rotation complete. Reconnecting with new universe...'));
            if (activeWs) activeWs.close();
            scheduleUniverseRotation(3 * 24 * 60 * 60 * 1000);
        } else {
            console.log(chalk.yellow('Universe rotation failed. Retrying in 24 hours.'));
            scheduleUniverseRotation(24 * 60 * 60 * 1000);
        }
    }, delayMs);
}

const FALLBACK_UNIVERSE = {
    updatedAt: new Date().toISOString(),
    regime: 'CHOPPY',
    coins: {
        'BTCUSDT':  { tier: 1, pf: 1.5, trades: 10, trainPf: 1.5, forwardPf: 1.5, forwardNetPnL: 50, forwardTrades: 10, tradesPerMonth: 10, avgDaysBetweenTrades: 3.0, winRate: 55 },
        'ETHUSDT':  { tier: 1, pf: 1.5, trades: 10, trainPf: 1.5, forwardPf: 1.5, forwardNetPnL: 50, forwardTrades: 10, tradesPerMonth: 10, avgDaysBetweenTrades: 3.0, winRate: 55 },
        'SOLUSDT':  { tier: 2, pf: 1.2, trades:  8, trainPf: 1.2, forwardPf: 1.2, forwardNetPnL: 30, forwardTrades:  8, tradesPerMonth:  8, avgDaysBetweenTrades: 3.5, winRate: 50 },
        'BNBUSDT':  { tier: 2, pf: 1.2, trades:  8, trainPf: 1.2, forwardPf: 1.2, forwardNetPnL: 30, forwardTrades:  8, tradesPerMonth:  8, avgDaysBetweenTrades: 3.5, winRate: 50 },
        'XRPUSDT':  { tier: 2, pf: 1.2, trades:  8, trainPf: 1.2, forwardPf: 1.2, forwardNetPnL: 30, forwardTrades:  8, tradesPerMonth:  8, avgDaysBetweenTrades: 3.5, winRate: 50 },
        'ADAUSDT':  { tier: 2, pf: 1.2, trades:  8, trainPf: 1.2, forwardPf: 1.2, forwardNetPnL: 30, forwardTrades:  8, tradesPerMonth:  8, avgDaysBetweenTrades: 3.5, winRate: 50 },
        'DOGEUSDT': { tier: 2, pf: 1.2, trades:  8, trainPf: 1.2, forwardPf: 1.2, forwardNetPnL: 30, forwardTrades:  8, tradesPerMonth:  8, avgDaysBetweenTrades: 3.5, winRate: 50 },
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// startBot(isReconnect): on reconnect, skip warmup for coins already in memory
// to eliminate the ~60s blind window where positions are unmonitored
// ─────────────────────────────────────────────────────────────────────────────
async function startBot(isReconnect = false) {
    console.log(chalk.blue(`\n--- Bot ${isReconnect ? 'Reconnecting' : 'Starting'}: ${new Date().toISOString()} ---`));

    if (!dashboardStarted) {
        startDashboard(undefined, trader);
        dashboardStarted = true;
    }

    // Load active universe
    let activeUniverse = null;
    try {
        activeUniverse = JSON.parse(require('fs').readFileSync('./active_universe.json', 'utf8'));
    } catch (e) {
        console.log(chalk.yellow('No active_universe.json. Running universe selector...'));
        try {
            const { runSelector } = require('./universeSelector');
            await runSelector();
            activeUniverse = JSON.parse(require('fs').readFileSync('./active_universe.json', 'utf8'));
        } catch (selectorErr) {
            console.log(chalk.yellow('Universe selector failed. Using fallback universe.'));
            activeUniverse = { ...FALLBACK_UNIVERSE, updatedAt: new Date().toISOString() };
        }
    }

    if (!activeUniverse || !activeUniverse.coins) {
        console.log(chalk.red('Failed to load active universe. Exiting.'));
        return;
    }

    const coins = Object.keys(activeUniverse.coins).map(sym => ({ symbol: sym, id: sym }));
    const currentPrices = {};
    const streamNames = [];

    // Always track held positions even if they dropped out of the universe
    const heldSymbols = Object.keys(trader.state.positions);
    if (heldSymbols.length > 0) {
        console.log(chalk.cyan(`Held positions: ${heldSymbols.join(', ')}`));
    }

    const allCoinsToTrack = [...coins];
    for (const heldSymbol of heldSymbols) {
        if (!allCoinsToTrack.some(c => c.symbol === heldSymbol)) {
            allCoinsToTrack.push({ id: heldSymbol, symbol: heldSymbol, current_price: trader.state.positions[heldSymbol].entryPrice });
        }
    }

    // Warm up indicators — skip coins already loaded (fast reconnect path)
    const coinsNeedingWarmup = isReconnect
        ? allCoinsToTrack.filter(c => !historicalDataStore[c.symbol])
        : allCoinsToTrack;

    if (coinsNeedingWarmup.length > 0) {
        console.log(chalk.yellow(`Warming up ${coinsNeedingWarmup.length} coin(s)...`));
        for (const coin of coinsNeedingWarmup) {
            currentPrices[coin.symbol] = coin.current_price;
            await delay(2000);
            const historicalData = await fetchHistoricalData(coin.id);
            if (historicalData) {
                historicalDataStore[coin.symbol] = historicalData;
                const initPosition = trader.state.positions[coin.symbol];
                emergencyExitCache[coin.symbol] = checkEmergencyExit(
                    historicalData,
                    initPosition?.entryPrice,
                    initPosition?.entryAtr
                );
            }
        }
    }

    // All coins in the universe need a stream, whether just warmed up or already cached
    for (const coin of allCoinsToTrack) {
        if (historicalDataStore[coin.symbol]) {
            streamNames.push(`${coin.symbol.toLowerCase()}@kline_${TRADING_CONFIG.timeframe}`);
        }
    }

    trader.state.currentPrices = { ...trader.state.currentPrices, ...currentPrices };
    trader.saveState();

    console.log(chalk.cyan(`Portfolio Value: $${trader.getPortfolioValue(trader.state.currentPrices).toFixed(2)}`));
    console.log(chalk.cyan(`Available Balance: $${trader.state.balance.toFixed(2)}`));
    console.log(chalk.cyan(`Daily Losses: ${trader.state.dailyLosses}/${TRADING_CONFIG.dailyMaxLosses}`));

    const streamUrl = `wss://stream.binance.com:9443/stream?streams=${streamNames.join('/')}`;
    console.log(chalk.green(`\nConnecting to ${streamNames.length} streams...`));

    const ws = new WebSocket(streamUrl);
    activeWs = ws;

    ws.on('open', () => {
        console.log(chalk.green('WebSocket connected.'));
    });

    ws.on('message', async (dataString) => {
        // Stale WS guard: discard messages from any connection that has been superseded
        if (ws !== activeWs) return;

        let payload;
        try {
            payload = JSON.parse(dataString);
        } catch (e) {
            return; // Malformed frame — don't crash the handler
        }

        if (!payload.data || !payload.data.k) return;

        const kline        = payload.data.k;
        const symbol       = kline.s;
        const currentPrice = parseFloat(kline.c);
        const isClosed     = kline.x;

        trader.state.currentPrices[symbol] = currentPrice;

        // NOTE: No outer lock here. LiveTrader's public methods carry their own per-symbol
        // mutex; wrapping them in an outer lock of the same key would deadlock. PaperTrader
        // relies on JS single-threading + synchronous guard checks (tp1Hit, position exists)
        // to prevent double-execution across concurrent async handlers.

        // Continuous risk management on every tick
        if (trader.state.positions[symbol]) {
            await trader.checkRiskManagement(symbol, currentPrice);
        }

        if (isClosed) {
            console.log(chalk.dim(`[${symbol}] 15m candle closed at $${currentPrice}`));

            const newCandle = {
                timestamp: kline.t,
                open:   parseFloat(kline.o),
                high:   parseFloat(kline.h),
                low:    parseFloat(kline.l),
                close:  currentPrice,
                volume: parseFloat(kline.v)
            };

            if (historicalDataStore[symbol]) {
                historicalDataStore[symbol].push(newCandle);
                if (historicalDataStore[symbol].length > 1000) {
                    historicalDataStore[symbol].shift();
                }

                const position = trader.state.positions[symbol];
                emergencyExitCache[symbol] = checkEmergencyExit(
                    historicalDataStore[symbol],
                    position?.entryPrice,
                    position?.entryAtr
                );

                if (trader.state.positions[symbol] && trader.updateTrailingStops) {
                    await trader.updateTrailingStops(symbol, currentPrice, emergencyExitCache[symbol]);
                }
            }

            // Only enter if no open position
            if (!trader.state.positions[symbol] && historicalDataStore[symbol]) {
                const coinObj = allCoinsToTrack.find(c => c.symbol === symbol) || { symbol, current_price: currentPrice };
                coinObj.current_price = currentPrice;
                const decision = evaluateTrade(coinObj, historicalDataStore[symbol], activeUniverse.regime);
                
                if (decision.signal === 'NO TRADE') {
                    const logObj = { symbol: symbol, failedReason: decision.failedReason || decision.reason };
                    if (decision.meta) Object.assign(logObj, decision.meta);
                    require('fs').appendFileSync('./trade_evaluations.jsonl', JSON.stringify(logObj) + '\n');
                } else if (decision.signal === 'BUY') {
                    const logObj = { symbol: symbol, action: 'BUY', score: decision.score, reason: decision.reason };
                    require('fs').appendFileSync('./trade_evaluations.jsonl', JSON.stringify(logObj) + '\n');
                    await trader.executeTrade(symbol, 'BUY', currentPrice, 'Confluence Engine', decision.reason, decision.atr);
                }
            }
        }
    });

    ws.on('close', () => {
        console.log(chalk.red('WebSocket disconnected. Reconnecting in 5s...'));
        setTimeout(() => startBot(true), 5000);
    });

    ws.on('error', (err) => {
        console.error(chalk.red('WebSocket error:'), err.message);
    });

    scheduleUniverseRotation();
}

startBot();
