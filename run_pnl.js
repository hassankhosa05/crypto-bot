const axios = require('axios');
const fs = require('fs');
const { TRADING_CONFIG } = require('./tradingConfig');
const { simulateSymbol } = require('./backtestEngine');

const portfolio = JSON.parse(fs.readFileSync('./portfolio.json', 'utf8'));
const SYMBOLS = Object.keys(portfolio.currentPrices);
const TIMEFRAME = TRADING_CONFIG.timeframe;
const KLINES_TO_FETCH = TRADING_CONFIG.historyCandles;

async function fetchHistoricalData(symbol) {
    let klins = [];
    let endTime = Date.now();
    const limit = 1000;
    while(klins.length < KLINES_TO_FETCH) {
        const url = 'https://api.binance.com/api/v3/klines?symbol=' + symbol + '&interval=' + TIMEFRAME + '&limit=' + limit + '&endTime=' + endTime;
        try {
            const response = await axios.get(url);
            const data = response.data;
            if(data.length === 0) break;
            klins = data.concat(klins);
            endTime = data[0][0] - 1;
        } catch(e) {
            break;
        }
        await new Promise(r => setTimeout(r, 50));
    }
    if (klins.length > KLINES_TO_FETCH) klins = klins.slice(klins.length - KLINES_TO_FETCH);
    return klins.map(d => ({
        timestamp: d[0],
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4]),
        volume: parseFloat(d[5])
    }));
}

async function runTrueBacktest() {
    console.log("Running shared-assumption PnL backtest...");
    let totalPortfolioPnlAll = 0;
    let totalFees = 0;
    let totalTrades = 0;
    let totalGrossWin = 0;
    let totalWins = 0;
    let totalGrossLoss = 0;

    for (const symbol of SYMBOLS) {
        const data = await fetchHistoricalData(symbol);
        if(data.length < 500) continue;

        const stats = simulateSymbol(data, {
            symbol,
            startIndex: TRADING_CONFIG.warmupCandles,
            initialBalance: 300
        });

        totalPortfolioPnlAll += stats.netPnl;
        totalFees += stats.totalFees;
        totalTrades += stats.trades;
        totalGrossWin += stats.grossWin;
        totalWins += stats.wins;
        totalGrossLoss += stats.grossLoss;
    }

    const totalLosses = totalTrades - totalWins;
    const avgWin = totalWins > 0 ? totalGrossWin / totalWins : 0;
    const avgLoss = totalLosses > 0 ? totalGrossLoss / totalLosses : 0;
    const winRate = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;

    console.log("=== FINAL RESULTS (Start: $300 per symbol simulation) ===");
    console.log("Total Profit/Loss: $" + totalPortfolioPnlAll.toFixed(2));
    console.log("Total Trades: " + totalTrades);
    console.log("Win Rate: " + winRate.toFixed(1) + "%");
    console.log("Avg Win: $" + avgWin.toFixed(2));
    console.log("Avg Loss: $" + avgLoss.toFixed(2));
    console.log("Total Fee Drag: $" + totalFees.toFixed(2));
}

runTrueBacktest().catch(console.error);
