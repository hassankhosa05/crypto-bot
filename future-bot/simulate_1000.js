const axios = require('axios');
const fs = require('fs');
const { evaluateTradeV2, checkEmergencyExitV2 } = require('./strategyV2');
const { TRADING_CONFIG } = require('./tradingConfig');
const { simulateSymbol } = require('./backtestEngine');

const TIMEFRAME = TRADING_CONFIG.timeframe;
const KLINES_TO_FETCH = TRADING_CONFIG.historyCandles;
const PORTFOLIO_BALANCE = 1000;
const RISK_PCT = TRADING_CONFIG.riskPct;

const STABLECOINS = ['USDT', 'USDC', 'FDUSD', 'TUSD', 'USD1', 'RLUSD', 'DAI', 'USDP'];

async function getTopVolumeCoins(limit = 40) {
    try {
        const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr');
        const validCoins = response.data.filter(c => {
            if(!c.symbol.endsWith('USDT')) return false;
            const baseAsset = c.symbol.replace('USDT', '');
            if(STABLECOINS.includes(baseAsset)) return false;
            if(c.symbol.includes('DOWN') || c.symbol.includes('UP')) return false;
            return true;
        });
        validCoins.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
        return validCoins.slice(0, limit).map(c => c.symbol);
    } catch (e) {
        return [];
    }
}

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
        } catch(e) { break; }
        await new Promise(r => setTimeout(r, 50));
    }
    if (klins.length > KLINES_TO_FETCH) klins = klins.slice(klins.length - KLINES_TO_FETCH);
    return klins.map(d => ({
        timestamp: d[0], open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4]), volume: parseFloat(d[5])
    }));
}

async function evaluateCoin(symbol) {
    let data = await fetchHistoricalData(symbol);
    if(data.length < 500) return null;

    const stats = simulateSymbol(data, {
        symbol,
        startIndex: TRADING_CONFIG.warmupCandles,
        initialBalance: PORTFOLIO_BALANCE
    });

    return {
        symbol,
        tradesCount: stats.trades,
        pf: stats.profitFactor,
        netPnL: stats.netPnl,
        grossWin: stats.grossWin,
        grossLoss: stats.grossLoss,
        tradesPerMonth: stats.tradesPerMonth,
        maxDrawdown: stats.maxDrawdown,
        feeDrag: stats.totalFees
    };
}

async function runMonthlySimulation() {
    console.log("Fetching 30 days of 15m klins for top 40 coins...");
    const candidates = await getTopVolumeCoins(40);
    const results = [];
    for (const sym of candidates) {
        process.stdout.write(sym + " ");
        const res = await evaluateCoin(sym);
        if (res) results.push(res);
    }
    console.log("\\nSimulation complete.");

    // Filter: PF > 1.2 and Trades >= 10
    let validCoins = results.filter(c => c.pf > 1.2 && c.tradesCount >= 10);
    validCoins.sort((a, b) => b.pf - a.pf);
    
    const top20 = validCoins.slice(0, 20);
    
    console.log("\\n=== Top Performing Coins (30 Days) ===");
    let totalPortfolioNetPnL = 0;
    
    top20.forEach(c => {
        console.log(c.symbol + " | PF: " + c.pf.toFixed(2) + " | Trades: " + c.tradesCount + " | Net PnL: $" + c.netPnL.toFixed(2));
        totalPortfolioNetPnL += c.netPnL;
    });

    console.log("\\n=== Monthly Projection ===");
    console.log("Coins qualifying: " + top20.length);
    console.log("Starting Portfolio Balance: $" + PORTFOLIO_BALANCE.toFixed(2));
    console.log("Risk Parameter: " + (RISK_PCT * 100) + "% per trade");
    console.log("Your expected portfolio profit in 1 month: +$" + totalPortfolioNetPnL.toFixed(2));
    console.log("Ending Portfolio Balance: $" + (PORTFOLIO_BALANCE + totalPortfolioNetPnL).toFixed(2));
    
    const roi = (totalPortfolioNetPnL / PORTFOLIO_BALANCE) * 100;
    console.log("Monthly ROI: " + roi.toFixed(2) + "%");
}

runMonthlySimulation().catch(console.error);
