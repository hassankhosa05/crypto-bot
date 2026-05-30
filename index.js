require('dotenv').config();
const WebSocket = require('ws');
const chalk = require('chalk');
const { fetchMidCapCoins, fetchHistoricalData, delay } = require('./dataFetcher');
const { evaluateTradeV2: evaluateTrade, checkEmergencyExitV2: checkEmergencyExit } = require('./strategyV2');
const PaperTrader = require('./paperTrader');
const { startDashboard } = require('./dashboard');

let trader;
if (process.env.TRADE_MODE === 'LIVE') {
    const LiveTrader = require('./liveTrader');
    trader = new LiveTrader();
    console.log(chalk.red.bold("!!! WARNING: BOT IS RUNNING IN LIVE TRADING MODE WITH REAL MONEY !!!"));
} else {
    trader = new PaperTrader(300);
    console.log(chalk.green("Bot is running in PAPER TRADING mode."));
}
const historicalDataStore = {}; // Memory store for 100 candles per coin
const emergencyExitCache = {}; // Cache of { symbol: boolean } to avoid CPU-heavy recalculations
let dashboardStarted = false;
let activeWs = null; // Track active WebSocket connection globally for dynamic rotation
let rotationTimer = null; // Track scheduled rotation timer

function scheduleUniverseRotation() {
    if (rotationTimer) return; // Prevent creating multiple rotation timers on WebSocket reconnects
    
    const rotationIntervalMs = 24 * 60 * 60 * 1000; // 24 hours
    
    rotationTimer = setInterval(async () => {
        console.log(chalk.yellow('\n=== Running Scheduled Daily Universe Rotation ==='));
        try {
            const { runSelector } = require('./universeSelector');
            await runSelector(); // Re-evaluate top coins using 7-day parameters and save new active_universe.json
            
            if (activeWs) {
                console.log(chalk.cyan('Closing active WebSocket to trigger refresh with new universe...'));
                activeWs.close(); // Triggers the ws 'close' event, which calls startBot() and connects to the new coins
            }
        } catch (e) {
            console.error(chalk.red('Scheduled daily rotation failed:'), e.message);
        }
    }, rotationIntervalMs);
    
    console.log(chalk.green('Daily universe automatic rotation scheduler successfully registered.'));
}

async function startBot() {
    console.log(chalk.blue(`\n--- Starting Bot Initialization: ${new Date().toISOString()} ---`));
    
    // 1. Load Adaptive Universe
    let activeUniverse = null;
    try {
        activeUniverse = JSON.parse(require('fs').readFileSync('./active_universe.json', 'utf8'));
    } catch(e) {
        console.log(chalk.yellow('No active_universe.json found. Running universe selector first...'));
        const { runSelector } = require('./universeSelector');
        await runSelector();
        activeUniverse = JSON.parse(require('fs').readFileSync('./active_universe.json', 'utf8'));
    }
    
    if (!activeUniverse || !activeUniverse.coins) {
        console.log(chalk.red('Failed to load active universe. Exiting.'));
        return;
    }
    
    const coins = Object.keys(activeUniverse.coins).map(sym => ({ symbol: sym, id: sym }));

    const currentPrices = {};
    const streamNames = [];

    // Ensure we track and subscribe to all currently held positions, even if they fall out of top 30
    const heldSymbols = Object.keys(trader.state.positions);
    if (heldSymbols.length > 0) {
        console.log(chalk.cyan(`Currently held positions: ${heldSymbols.join(', ')}`));
    }

    // Merge top volume coins and currently held positions
    const allCoinsToTrack = [...coins];
    for (const heldSymbol of heldSymbols) {
        if (!allCoinsToTrack.some(c => c.symbol === heldSymbol)) {
            allCoinsToTrack.push({
                id: heldSymbol,
                symbol: heldSymbol,
                current_price: trader.state.positions[heldSymbol].entryPrice // fallback price
            });
        }
    }

    // 2. Warm up indicators by fetching last 100 candles for each coin
    console.log(chalk.yellow(`Warming up indicators for ${allCoinsToTrack.length} coins...`));
    for (const coin of allCoinsToTrack) {
        currentPrices[coin.symbol] = coin.current_price;
        
        await delay(500); // Respect REST API limits during initialization
        const historicalData = await fetchHistoricalData(coin.id);
        if (historicalData) {
            historicalDataStore[coin.symbol] = historicalData;
            streamNames.push(`${coin.symbol.toLowerCase()}@kline_15m`);
            
            // Calculate and cache initial emergency exit flag using correct entryAtr key
            const initPosition = trader.state.positions[coin.symbol];
            emergencyExitCache[coin.symbol] = checkEmergencyExit(
                historicalData,
                initPosition?.entryPrice,
                initPosition?.entryAtr
            );
        }
    }
    
    trader.state.currentPrices = currentPrices;
    trader.saveState();

    console.log(chalk.cyan(`Current Portfolio Value: $${trader.getPortfolioValue(currentPrices).toFixed(2)}`));
    console.log(chalk.cyan(`Available Balance: $${trader.state.balance.toFixed(2)}`));
    console.log(chalk.cyan(`Daily Losses: ${trader.state.dailyLosses}/3`));
    
    // 3. Start Dashboard (Only once across reconnects)
    if (!dashboardStarted) {
        startDashboard(3000, trader);
        dashboardStarted = true;
    }

    // 4. Connect to Binance WebSockets
    const streamUrl = `wss://stream.binance.com:9443/stream?streams=${streamNames.join('/')}`;
    console.log(chalk.green(`\nConnecting to Binance WebSocket for ${streamNames.length} streams...`));
    
    const ws = new WebSocket(streamUrl);
    activeWs = ws; // Store reference globally for rotation close trigger

    ws.on('open', () => {
        console.log(chalk.green('WebSocket connected successfully! Listening for live price events...'));
    });

    ws.on('message', async (dataString) => {
        const payload = JSON.parse(dataString);
        if (!payload.data || !payload.data.k) return;

        const kline = payload.data.k;
        const symbol = kline.s; // e.g. BTCUSDT
        const currentPrice = parseFloat(kline.c);
        const isClosed = kline.x;

        // Update live price in memory for dashboard
        trader.state.currentPrices[symbol] = currentPrice;

        // Continuous Risk Management (Runs on EVERY tick)
        if (trader.state.positions[symbol]) {
            // Optimized: use the cached emergency exit flag computed on the last closed candle
            await trader.checkRiskManagement(symbol, currentPrice);
        }

        // Strategy Execution (Runs ONLY exactly when a 5m candle closes)
        if (isClosed) {
            console.log(chalk.dim(`[${symbol}] 15m Candle Closed at $${currentPrice}`));
            
            // 1. Append the newly closed candle to historical data
            const newCandle = {
                timestamp: kline.t,
                open: parseFloat(kline.o),
                high: parseFloat(kline.h),
                low: parseFloat(kline.l),
                close: currentPrice,
                volume: parseFloat(kline.v)
            };
            
            if (historicalDataStore[symbol]) {
                historicalDataStore[symbol].push(newCandle);
                if (historicalDataStore[symbol].length > 100) {
                    historicalDataStore[symbol].shift(); // Keep array at 100 length
                }
                
                // Recalculate and cache emergency exit flag only when candle closes
                const position = trader.state.positions[symbol];
                emergencyExitCache[symbol] = checkEmergencyExit(
                    historicalDataStore[symbol],
                    position?.entryPrice,
                    position?.entryAtr
                );

                // Consolidate: Call updateTrailingStops exactly once on candle close with updated flag
                if (trader.state.positions[symbol] && trader.updateTrailingStops) {
                    await trader.updateTrailingStops(symbol, currentPrice, emergencyExitCache[symbol]);
                }
            }

            // 2. Execute Strategy if we don't have a position
            if (!trader.state.positions[symbol]) {
                const coinObj = allCoinsToTrack.find(c => c.symbol === symbol) || { symbol, current_price: currentPrice };
                // Update current price in coin object just in case
                coinObj.current_price = currentPrice;
                
                if (historicalDataStore[symbol]) {
                    const decision = evaluateTrade(coinObj, historicalDataStore[symbol]);

                    if (decision.signal === 'BUY') {
                        await trader.executeTrade(symbol, 'BUY', currentPrice, 'Confluence Engine', decision.reason, decision.atr);
                    }
                }
            }
        }
    });

    ws.on('close', () => {
        console.log(chalk.red('WebSocket disconnected. Attempting to reconnect in 5 seconds...'));
        setTimeout(startBot, 5000);
    });

    ws.on('error', (err) => {
        console.error(chalk.red('WebSocket error:'), err);
    });

    // 5. Register daily universe rotation scheduler
    scheduleUniverseRotation();
}

// Start the bot
startBot();
