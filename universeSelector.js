const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { evaluateTradeV2, checkEmergencyExitV2 } = require('./strategyV2');
const { EMA } = require('technicalindicators');
const { simulateWalkForward } = require('./backtestEngine');

const TIMEFRAME = '15m';
const KLINES_TO_FETCH = 1000; // ~10 days of 15-minute candles (3 days warmup + 7 days active trading)
const WARMUP_CANDLES = 300;
const TRAIN_SPLIT = 0.7;
const MIN_TRAIN_PF = 1.25;
const MIN_FORWARD_PF = 1.05;
const MIN_FORWARD_TRADES = 3;
const MIN_TRADES_PER_MONTH = 8;
const MAX_AVG_DAYS_BETWEEN_TRADES = 4;

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
        console.error("Error fetching top coins:", e);
        return [];
    }
}

async function getBTCRegime() {
    try {
        const response = await axios.get('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=250');
        const closes = response.data.map(d => parseFloat(d[4]));
        const ema50 = EMA.calculate({ period: 50, values: closes });
        const ema200 = EMA.calculate({ period: 200, values: closes });
        
        if (ema50.length > 0 && ema200.length > 0) {
            const currentEMA50 = ema50[ema50.length - 1];
            const currentEMA200 = ema200[ema200.length - 1];
            return currentEMA50 > currentEMA200 ? 'TRENDING' : 'CHOPPY';
        }
    } catch(e) {
        console.error("Error fetching BTC regime:", e);
    }
    return 'CHOPPY'; // Default safety
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
        } catch(e) {
            break;
        }
        await new Promise(r => setTimeout(r, 50));
    }
    if (klins.length > KLINES_TO_FETCH) klins = klins.slice(klins.length - KLINES_TO_FETCH);
    return klins.map(d => ({
        timestamp: d[0], open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4]), volume: parseFloat(d[5])
    }));
}

async function evaluateCoin(symbol) {
    const data = await fetchHistoricalData(symbol);
    if(data.length < 500) return null;

    const result = simulateWalkForward(data, {
        symbol,
        warmupCandles: WARMUP_CANDLES,
        trainSplit: TRAIN_SPLIT,
        initialBalance: 1000,
        fixedTradeUSD: 60
    });
    if (!result) return null;

    return {
        symbol,
        train: result.train,
        forward: result.forward,
        score: result.forward.netPnL + (Math.min(result.forward.pf, 5) * 2) + (result.forward.tradesPerMonth * 0.15)
    };
}

async function runSelector() {
    console.log("Starting Dynamic Universe Selection...");
    const regime = await getBTCRegime();
    console.log("Detected Global Regime:", regime);

    const candidates = await getTopVolumeCoins(40);
    console.log("Evaluating top volume coins...");

    const results = [];
    for (const sym of candidates) {
        process.stdout.write(sym + " ");
        const res = await evaluateCoin(sym);
        if (res) results.push(res);
        await new Promise(r => setTimeout(r, 5000)); // Delay 5 seconds between coins
    }
    console.log("\nEvaluation complete.");

    let validCoins = results.filter(c => {
        return c.train.pf >= MIN_TRAIN_PF &&
            c.forward.pf >= MIN_FORWARD_PF &&
            c.forward.netPnL > 0 &&
            c.forward.tradesCount >= MIN_FORWARD_TRADES &&
            c.forward.tradesPerMonth >= MIN_TRADES_PER_MONTH &&
            c.forward.avgDaysBetweenTrades <= MAX_AVG_DAYS_BETWEEN_TRADES;
    });
    validCoins.sort((a, b) => b.score - a.score);
    const top15 = validCoins.slice(0, 15);
    
    if (top15.length === 0) {
        console.error(require("chalk").red("\n[ERROR] Universe selection returned 0 valid coins (possibly due to API rate limits or IP ban). Aborting active_universe.json update to prevent clearing active streams."));
        return;
    }
    
    const universe = {
        updatedAt: new Date().toISOString(),
        regime: regime,
        coins: {}
    };

    top15.forEach(c => {
        let tier = c.forward.pf >= 2.0 && c.forward.tradesPerMonth >= 12 ? 1 : 2;
        universe.coins[c.symbol] = {
            tier: tier,
            pf: parseFloat(c.forward.pf.toFixed(2)),
            trades: c.forward.tradesCount,
            trainPf: parseFloat(c.train.pf.toFixed(2)),
            forwardPf: parseFloat(c.forward.pf.toFixed(2)),
            forwardNetPnL: parseFloat(c.forward.netPnL.toFixed(2)),
            forwardTrades: c.forward.tradesCount,
            tradesPerMonth: parseFloat(c.forward.tradesPerMonth.toFixed(1)),
            avgDaysBetweenTrades: parseFloat(c.forward.avgDaysBetweenTrades.toFixed(2)),
            winRate: parseFloat((c.forward.winRate * 100).toFixed(1))
        };
    });

    const outPath = path.join(__dirname, 'active_universe.json');
    fs.writeFileSync(outPath, JSON.stringify(universe, null, 2));
    
    console.log("\n=== ACTIVE UNIVERSE SAVED ===");
    console.log(JSON.stringify(universe, null, 2));
}

if (require.main === module) {
    runSelector().catch(console.error);
}

module.exports = { runSelector };
