require('dotenv').config();
const schedule = require('node-schedule');
const chalk = require('chalk');
const { fetchMidCapCoins, fetchHistoricalData, delay } = require('./dataFetcher');
const { evaluateTrade, checkEmergencyExit } = require('./strategies');
const PaperTrader = require('./paperTrader');
const { startDashboard } = require('./dashboard');

const trader = new PaperTrader(300); // Start with $300 simulated balance

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
    
    // Update live prices in state so dashboard can see them
    trader.state.currentPrices = currentPrices;
    trader.saveState();

    console.log(chalk.cyan(`Current Portfolio Value: $${trader.getPortfolioValue(currentPrices).toFixed(2)}`));
    console.log(chalk.cyan(`Available Balance: $${trader.state.balance.toFixed(2)}`));
    console.log(chalk.cyan(`Daily Losses: ${trader.state.dailyLosses}/3`));

    // 2. Analyze & Trade each coin
    for (const coin of coins) {
        // Respect API rate limits
        await delay(10000); 

        const historicalData = await fetchHistoricalData(coin.id);
        if (!historicalData) continue;

        // Check if we have an open position
        if (trader.state.positions[coin.symbol]) {
            // First check Risk Management (SL, TP, Break-even)
            // Also pass in the emergency exit check
            const emergencyExitFlag = checkEmergencyExit(historicalData);
            await trader.checkRiskManagement(coin.symbol, coin.current_price, emergencyExitFlag);
            continue; // If we already own it, we manage risk, we don't buy more.
        }

        // We do NOT have an open position. Run the Confluence Decision Engine.
        const decision = evaluateTrade(coin, historicalData);

        if (decision.signal === 'BUY') {
            // executeTrade signature: coinSymbol, action, currentPrice, strategyName, reason, atr
            await trader.executeTrade(coin.symbol, 'BUY', coin.current_price, 'Confluence Engine', decision.reason, decision.atr);
        } else {
            // Uncomment the next line if you want to log holds and no-trades to console (can be noisy)
            // console.log(`[${coin.symbol}] ${decision.reason}`);
        }
    }
    
    console.log(chalk.blue(`--- Cycle Complete ---`));
}

// Start Dashboard
startDashboard(3000);

// Run immediately once
runCycle();

// Schedule every 1 hour
const job = schedule.scheduleJob('0 * * * *', function(){
  runCycle();
});
console.log(chalk.green('Bot started and scheduled to run every 1 hour.'));
