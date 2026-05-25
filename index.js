require('dotenv').config();
const WebSocket = require('ws');
const chalk = require('chalk');
const { fetchMidCapCoins, fetchHistoricalData, delay } = require('./dataFetcher');
const { evaluateTrade, checkEmergencyExit } = require('./strategies');
const PaperTrader = require('./paperTrader');
const { startDashboard } = require('./dashboard');

const trader = new PaperTrader(300); // Start with $300 simulated balance
const historicalDataStore = {}; // Memory store for 100 candles per coin

async function startBot() {
    console.log(chalk.blue(`\n--- Starting Bot Initialization: ${new Date().toISOString()} ---`));
    
    // 1. Fetch Top Coins
    const coins = await fetchMidCapCoins();
    if (coins.length === 0) {
        console.log(chalk.red('No coins fetched. Exiting.'));
        return;
    }

    const currentPrices = {};
    const streamNames = [];

    // 2. Warm up indicators by fetching last 100 candles for each coin
    console.log(chalk.yellow(`Warming up indicators for ${coins.length} coins...`));
    for (const coin of coins) {
        currentPrices[coin.symbol] = coin.current_price;
        
        await delay(500); // Respect REST API limits during initialization
        const historicalData = await fetchHistoricalData(coin.id);
        if (historicalData) {
            historicalDataStore[coin.symbol] = historicalData;
            streamNames.push(`${coin.symbol.toLowerCase()}@kline_5m`);
        }
    }
    
    trader.state.currentPrices = currentPrices;
    trader.saveState();

    console.log(chalk.cyan(`Current Portfolio Value: $${trader.getPortfolioValue(currentPrices).toFixed(2)}`));
    console.log(chalk.cyan(`Available Balance: $${trader.state.balance.toFixed(2)}`));
    console.log(chalk.cyan(`Daily Losses: ${trader.state.dailyLosses}/3`));
    
    // 3. Start Dashboard
    startDashboard(3000);

    // 4. Connect to Binance WebSockets
    const streamUrl = `wss://stream.binance.com:9443/stream?streams=${streamNames.join('/')}`;
    console.log(chalk.green(`\nConnecting to Binance WebSocket for ${streamNames.length} streams...`));
    
    const ws = new WebSocket(streamUrl);

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

        // Update live price for dashboard
        trader.state.currentPrices[symbol] = currentPrice;

        // Continuous Risk Management (Runs on EVERY tick)
        if (trader.state.positions[symbol]) {
            const historicalData = historicalDataStore[symbol];
            const emergencyExitFlag = historicalData ? checkEmergencyExit(historicalData) : false;
            await trader.checkRiskManagement(symbol, currentPrice, emergencyExitFlag);
        }

        // Strategy Execution (Runs ONLY exactly when a 5m candle closes)
        if (isClosed) {
            console.log(chalk.dim(`[${symbol}] 5m Candle Closed at $${currentPrice}`));
            
            // 1. Append the newly closed candle to historical data
            const newCandle = {
                timestamp: kline.t,
                open: parseFloat(kline.o),
                high: parseFloat(kline.h),
                low: parseFloat(kline.l),
                close: currentPrice,
                volume: parseFloat(kline.v)
            };
            
            historicalDataStore[symbol].push(newCandle);
            if (historicalDataStore[symbol].length > 100) {
                historicalDataStore[symbol].shift(); // Keep array at 100 length
            }

            // 2. Execute Strategy if we don't have a position
            if (!trader.state.positions[symbol]) {
                const coinObj = coins.find(c => c.symbol === symbol) || { symbol, current_price: currentPrice };
                // Update current price in coin object just in case
                coinObj.current_price = currentPrice;
                
                const decision = evaluateTrade(coinObj, historicalDataStore[symbol]);

                if (decision.signal === 'BUY') {
                    await trader.executeTrade(symbol, 'BUY', currentPrice, 'Confluence Engine', decision.reason, decision.atr);
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
}

// Start the bot
startBot();
