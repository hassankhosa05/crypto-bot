const axios = require('axios');
const fs = require('fs');
const { evaluateTradeV2, checkEmergencyExitV2 } = require('./strategyV2');

const TIMEFRAME = '15m';
const KLINES_TO_FETCH = 2880; // ~30 days

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
    
    let position = null;
    let grossWin = 0;
    let grossLoss = 0;
    let tradesCount = 0;
    
    const TRADE_USD = 100; 

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
            position.slPrice = Math.max(position.slPrice, currentPrice - (position.atr * 2.0));

            if (!position.tp1Hit && currentHigh >= position.tp1Price) {
                position.tp1Hit = true;
                const sellSize = position.totalSize * 0.5;
                const sellVal = sellSize * position.tp1Price;
                position.pnlTracker += (sellVal - (sellVal * 0.001)) - (sellSize * position.entryPrice);
                position.remainingSize -= sellSize;
                position.slPrice = Math.max(position.slPrice, position.entryPrice);
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
    
    const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);
    const netPnL = grossWin - grossLoss;
    return { symbol, tradesCount, pf, netPnL, grossWin, grossLoss };
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

    let validCoins = results.filter(c => c.pf > 1.2 && c.tradesCount >= 10);
    validCoins.sort((a, b) => b.pf - a.pf);
    
    const top20 = validCoins.slice(0, 20);
    
    console.log("\\n=== Top Performing Coins (30 Days) ===");
    let totalPortfolioNetPnL = 0;
    
    top20.forEach(c => {
        console.log(c.symbol + " | PF: " + c.pf.toFixed(2) + " | Trades: " + c.tradesCount + " | Net PnL (per $100 size): $" + c.netPnL.toFixed(2));
        totalPortfolioNetPnL += c.netPnL;
    });

    console.log("\\n=== Monthly Projection ===");
    console.log("Coins qualifying: " + top20.length);
    console.log("If you invested $300 and scaled standard trade sizes to roughly $100 per setup (risking ~$1.50 per trade)...");
    console.log("Your expected portfolio growth in 1 month: +$" + totalPortfolioNetPnL.toFixed(2));
    
    const roi = (totalPortfolioNetPnL / 300) * 100;
    console.log("Monthly ROI: " + roi.toFixed(2) + "%");
}

runMonthlySimulation().catch(console.error);
