require('dotenv').config();
const schedule = require('node-schedule');
const chalk = require('chalk');
const { fetchMidCapCoins, fetchHistoricalData, delay } = require('./dataFetcher');
const { executeBollingerStrategy, executeVolumeBreakoutStrategy, executeRSIStrategy } = require('./strategies');
const PaperTrader = require('./paperTrader');
const { startDashboard } = require('./dashboard');
// const GoogleSheetsLogger = require('./googleSheetsLogger'); // Commented out until configured

const trader = new PaperTrader(300); // Start with $10,000 simulated balance

async function runCycle() {
    console.log(chalk.blue(`\n--- Starting Cycle: ${new Date().toISOString()} ---`));
    
    // 1. Fetch Coins
    const coins = await fetchMidCapCoins();
    if (coins.length === 0) {
        console.log(chalk.red('No coins fetched. Skipping cycle.'));
        return;
    }

    const currentPrices = {};
    for (const coin of coins) {
        currentPrices[coin.symbol] = coin.current_price;
    }

    console.log(chalk.cyan(`Current Portfolio Value: $${trader.getPortfolioValue(currentPrices).toFixed(2)}`));
    console.log(chalk.cyan(`Available Balance: $${trader.state.balance.toFixed(2)}`));

    // 2. Analyze & Trade each coin
    for (const coin of coins) {
        // First check risk management for existing positions
        const riskTriggered = await trader.checkRiskManagement(coin.symbol, coin.current_price);
        if (riskTriggered) continue; // If we just sold due to risk, skip new signals

        // Respect API rate limits (rough estimate: 1 request per second max, but free tier is tighter, often 30/min)
        // Let's use a longer delay to ensure we don't hit 429s, even if the cycle takes longer
        await delay(5000); 

        const historicalData = await fetchHistoricalData(coin.id);
        if (!historicalData) continue;

        // Try Strategy 1: Bollinger Bands
        const bbSignal = executeBollingerStrategy(historicalData);
        if (bbSignal === 'BUY') {
            await trader.executeTrade(coin.symbol, 'BUY', coin.current_price, 'Bollinger Bands');
            continue; // Only take one strategy signal per cycle per coin
        } else if (bbSignal === 'SELL' && trader.state.positions[coin.symbol]?.strategy === 'Bollinger Bands') {
             await trader.executeTrade(coin.symbol, 'SELL', coin.current_price, 'Bollinger Bands');
             continue;
        }

        // Try Strategy 2: Volume Breakout
        const volSignal = executeVolumeBreakoutStrategy(historicalData);
        if (volSignal === 'BUY') {
            await trader.executeTrade(coin.symbol, 'BUY', coin.current_price, 'Volume Breakout');
            continue;
        } else if (volSignal === 'SELL' && trader.state.positions[coin.symbol]?.strategy === 'Volume Breakout') {
             await trader.executeTrade(coin.symbol, 'SELL', coin.current_price, 'Volume Breakout');
             continue;
        }

        // Try Strategy 3: RSI
        const rsiSignal = executeRSIStrategy(historicalData);
        if (rsiSignal === 'BUY') {
            await trader.executeTrade(coin.symbol, 'BUY', coin.current_price, 'RSI Range');
            continue;
        } else if (rsiSignal === 'SELL' && trader.state.positions[coin.symbol]?.strategy === 'RSI Range') {
             await trader.executeTrade(coin.symbol, 'SELL', coin.current_price, 'RSI Range');
             continue;
        }
    }
    
    console.log(chalk.blue(`--- Cycle Complete ---`));
}

// Start Dashboard
startDashboard(3000);

// Run immediately once
runCycle();

// Schedule every 5 minutes
// Free CoinGecko API has tight limits. Every 3 minutes for 20 coins + market data might hit limits.
// We might need to handle 429 Too Many Requests errors robustly in a real scenario.
const job = schedule.scheduleJob('*/5 * * * *', function(){
  runCycle();
});
console.log(chalk.green('Bot started and scheduled to run every 5 minutes.'));
