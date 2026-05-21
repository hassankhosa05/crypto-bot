require('dotenv').config();
const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');
const chalk = require('chalk');
const {
    fetchMidCapCoins,
    fetchCurrentPrices,
    getHistoricalData,
    bumpCycle
} = require('./dataFetcher');
const {
    executeBollingerStrategy,
    executeEmaCrossStrategy,
    executeMacdStrategy
} = require('./strategies');
const PaperTrader = require('./paperTrader');
const { startDashboard } = require('./dashboard');

const STARTING_BALANCE = 300;
const PRICES_FILE = path.join(__dirname, 'currentPrices.json');

const trader = new PaperTrader(STARTING_BALANCE);

function writeCurrentPrices(pricesBySymbol) {
    fs.writeFileSync(
        PRICES_FILE,
        JSON.stringify({ prices: pricesBySymbol, lastUpdate: new Date().toISOString() }, null, 2)
    );
}

async function runCycle() {
    bumpCycle();
    console.log(chalk.blue(`\n--- Starting Cycle: ${new Date().toISOString()} ---`));

    const coins = await fetchMidCapCoins();
    if (coins.length === 0) {
        console.log(chalk.red('No coins fetched. Skipping cycle.'));
        return;
    }

    // One bulk request for live prices instead of one per coin.
    console.log(chalk.gray(`Fetching current prices for ${coins.length} coins (1 request)...`));
    const livePrices = await fetchCurrentPrices(coins.map(c => c.id));

    // Build symbol-keyed price map for portfolio valuation + dashboard.
    const pricesBySymbol = {};
    for (const coin of coins) {
        const live = livePrices[coin.id];
        const price = live ? live.price : coin.current_price;
        coin.current_price = price; // overwrite stale list price with bulk-call price
        pricesBySymbol[coin.symbol] = price;
    }
    // Include any open positions whose coins fell out of the top-20 list so the dashboard still values them.
    for (const symbol of Object.keys(trader.state.positions)) {
        if (!(symbol in pricesBySymbol)) {
            pricesBySymbol[symbol] = trader.state.positions[symbol].entryPrice;
        }
    }
    writeCurrentPrices(pricesBySymbol);

    console.log(chalk.cyan(`Portfolio Value: $${trader.getPortfolioValue(pricesBySymbol).toFixed(2)} | Cash: $${trader.state.balance.toFixed(2)}`));

    for (const coin of coins) {
        // Risk management first — uses the live price we just fetched.
        const riskTriggered = await trader.checkRiskManagement(coin.symbol, coin.current_price);
        if (riskTriggered) continue;

        const historicalData = await getHistoricalData(coin.id, coin.current_price);
        if (!historicalData) continue;

        // Bollinger Bands
        const bbSignal = executeBollingerStrategy(historicalData);
        if (bbSignal === 'BUY') {
            await trader.executeTrade(coin.symbol, 'BUY', coin.current_price, 'Bollinger Bands');
            continue;
        }
        if (bbSignal === 'SELL' && trader.state.positions[coin.symbol]?.strategy === 'Bollinger Bands') {
            await trader.executeTrade(coin.symbol, 'SELL', coin.current_price, 'Bollinger Bands');
            continue;
        }

        // EMA 9/21 Cross
        const emaSignal = executeEmaCrossStrategy(historicalData);
        if (emaSignal === 'BUY') {
            await trader.executeTrade(coin.symbol, 'BUY', coin.current_price, 'EMA Cross');
            continue;
        }
        if (emaSignal === 'SELL' && trader.state.positions[coin.symbol]?.strategy === 'EMA Cross') {
            await trader.executeTrade(coin.symbol, 'SELL', coin.current_price, 'EMA Cross');
            continue;
        }

        // MACD Momentum
        const macdSignal = executeMacdStrategy(historicalData);
        if (macdSignal === 'BUY') {
            await trader.executeTrade(coin.symbol, 'BUY', coin.current_price, 'MACD Momentum');
            continue;
        }
        if (macdSignal === 'SELL' && trader.state.positions[coin.symbol]?.strategy === 'MACD Momentum') {
            await trader.executeTrade(coin.symbol, 'SELL', coin.current_price, 'MACD Momentum');
            continue;
        }
    }

    console.log(chalk.blue('--- Cycle Complete ---'));
}

startDashboard(3000);

runCycle().catch(err => console.error(chalk.red('Cycle error:'), err.message));

schedule.scheduleJob('*/3 * * * *', () => {
    runCycle().catch(err => console.error(chalk.red('Cycle error:'), err.message));
});
console.log(chalk.green('Bot started and scheduled to run every 3 minutes.'));
