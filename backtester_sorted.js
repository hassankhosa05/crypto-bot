const axios = require('axios');
const fs = require('fs');
const { evaluateTradeV2, checkEmergencyExitV2 } = require('./strategyV2');
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
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${TIMEFRAME}&limit=${limit}&endTime=${endTime}`;
        try {
            const response = await axios.get(url);
            const data = response.data;
            if(data.length === 0) break;
            klins = data.concat(klins);
            endTime = data[0][0] - 1; 
        } catch(e) {
            break;
        }
        await new Promise(r => setTimeout(r, 100)); // rate limit
    }
    if (klins.length > KLINES_TO_FETCH) {
        klins = klins.slice(klins.length - KLINES_TO_FETCH);
    }
    return klins.map(d => ({
        timestamp: d[0],
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4]),
        volume: parseFloat(d[5])
    }));
}

async function runBacktest() {
    console.log("Starting V2.2 Backtest (20-Coin Universe, Partial Exits, Fees)...");
    const results = {};
    let totalTrades = 0;
    let totalWins = 0;
    let grossWin = 0;
    let grossLoss = 0;

    for (const symbol of SYMBOLS) {
        process.stdout.write(`${symbol} `);
        let data = await fetchHistoricalData(symbol);
        if(data.length < 500) continue;
        
        const stats = simulateSymbol(data, {
            symbol,
            startIndex: TRADING_CONFIG.warmupCandles,
            initialBalance: 1000
        });

        results[symbol] = {
            netProfit: (stats.roi * 100).toFixed(2) + '%',
            trades: stats.trades,
            tradesPerMonth: stats.tradesPerMonth.toFixed(1),
            winRate: (stats.winRate * 100).toFixed(1) + '%',
            avgWin: '$' + stats.avgWin.toFixed(2),
            avgLoss: '$' + stats.avgLoss.toFixed(2),
            pf: stats.profitFactor.toFixed(2),
            maxDD: (stats.maxDrawdown * 100).toFixed(1) + '%',
            feeDrag: '$' + stats.totalFees.toFixed(2)
        };
        totalTrades += stats.trades;
        totalWins += stats.wins;
        grossWin += stats.grossWin;
        grossLoss += stats.grossLoss;
    }

    console.log("\n\n=== V2.2 Backtest Summary ===");
    const sortedResults = Object.entries(results).sort((a,b) => parseFloat(b[1].netProfit) - parseFloat(a[1].netProfit)).reduce((acc, [k,v]) => { acc[k] = v; return acc; }, {});
    console.table(sortedResults);
    const overallWinRate = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(2) + '%' : '0%';
    const overallPf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : '0.00';
    console.log(`Overall Trades: ${totalTrades} | Win Rate: ${overallWinRate} | Profit Factor: ${overallPf}`);
}

runBacktest().catch(console.error);
