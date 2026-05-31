const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { evaluateTradeV2, checkEmergencyExitV2 } = require('./strategyV2');
const { EMA } = require('technicalindicators');

const TIMEFRAME = '15m';
const KLINES_TO_FETCH = 1000; // ~10 days of 15-minute candles (3 days warmup + 7 days active trading)

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
    let data = await fetchHistoricalData(symbol);
    if(data.length < 500) return null;
    
    let position = null;
    let grossWin = 0;
    let grossLoss = 0;
    let tradesCount = 0;
    
    const TRADE_USD = 60;

    for (let i = 300; i < data.length; i++) {
        const slice = data.slice(Math.max(0, i - 400), i + 1);
        const currentCandle = slice[slice.length - 1];
        const currentPrice = currentCandle.close;
        const currentHigh = currentCandle.high;
        const currentLow = currentCandle.low;

        if (!position) {
            const coin = { symbol, current_price: currentPrice };
            const result = evaluateTradeV2(coin, slice);
            if (result.signal === 'BUY') {
                const fee = TRADE_USD * 0.001;
                
                const riskDist = result.atr * 1.5;
                position = {
                    entryPrice: currentPrice,
                    atr: result.atr,
                    totalSize: TRADE_USD / currentPrice,
                    remainingSize: TRADE_USD / currentPrice,
                    risk: riskDist,
                    slPrice: currentPrice - riskDist,
                    tp1Price: currentPrice + (riskDist * 2), // 2R target
                    tp1Hit: false,
                    pnlTracker: -fee
                };
            }
        } else {
            let tradeClosed = false;
            // 2.0 ATR trailing stop to give it room to hit 2R
            position.slPrice = Math.max(position.slPrice, currentPrice - (position.atr * 2.0));

            // 50% TP at 2R
            if (!position.tp1Hit && currentHigh >= position.tp1Price) {
                position.tp1Hit = true;
                const sellSize = position.totalSize * 0.5;
                const sellVal = sellSize * position.tp1Price;
                position.pnlTracker += (sellVal - (sellVal * 0.001)) - (sellSize * position.entryPrice);
                position.remainingSize -= sellSize;
                position.slPrice = Math.max(position.slPrice, position.entryPrice); // move to breakeven
            }

            if (currentLow <= position.slPrice) {
                tradeClosed = true;
                const sellVal = position.remainingSize * position.slPrice;
                position.pnlTracker += (sellVal - (sellVal * 0.001)) - (position.remainingSize * position.entryPrice);
                position.remainingSize = 0;
            } else {
                const emergencyExit = checkEmergencyExitV2(slice, position.entryPrice, position.atr);
                if (emergencyExit) {
                    tradeClosed = true;
                    const sellVal = position.remainingSize * currentPrice;
                    position.pnlTracker += (sellVal - (sellVal * 0.001)) - (position.remainingSize * position.entryPrice);
                    position.remainingSize = 0;
                }
            }

            if (tradeClosed || position.remainingSize <= 0.0001) {
                tradesCount++;
                if (position.pnlTracker > 0) grossWin += position.pnlTracker;
                else grossLoss += Math.abs(position.pnlTracker);
                position = null;
            }
        }
    }
    
    if (position && position.remainingSize > 0) {
        const currentPrice = data[data.length - 1].close;
        const sellVal = position.remainingSize * currentPrice;
        position.pnlTracker += (sellVal - (sellVal * 0.001)) - (position.remainingSize * position.entryPrice);
        tradesCount++;
        if (position.pnlTracker > 0) grossWin += position.pnlTracker;
        else grossLoss += Math.abs(position.pnlTracker);
    }

    const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);
    return { symbol, tradesCount, pf, grossWin, grossLoss };
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
    }
    console.log("\nEvaluation complete.");

    // Filter by PF > 1.2 and at least 8 trades over 7.3 days of active backtesting (~1.1 trades/day density)
    let validCoins = results.filter(c => c.pf > 1.2 && c.tradesCount >= 8);
    validCoins.sort((a, b) => b.pf - a.pf);
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
        let tier = c.pf >= 2.0 ? 1 : 2;
        universe.coins[c.symbol] = {
            tier: tier,
            pf: parseFloat(c.pf.toFixed(2)),
            trades: c.tradesCount
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
