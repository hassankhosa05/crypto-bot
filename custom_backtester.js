const axios = require('axios');
const { evaluateTradeV2, checkEmergencyExitV2 } = require('./strategyV2');

const TIMEFRAME = '15m';
const STABLECOINS = ['USDT', 'USDC', 'FDUSD', 'TUSD', 'USD1', 'RLUSD', 'DAI', 'USDP'];

const args = process.argv.slice(2);
const startTimestamp = parseInt(args[0]);
const endTimestamp = parseInt(args[1]);
const PORTFOLIO_BALANCE = parseFloat(args[2]);
const RISK_PCT = 0.02; // 2% fixed risk for projections

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

async function fetchHistoricalData(symbol, start, end) {
    let klins = [];
    let currentTime = start;
    const limit = 1000;
    while(currentTime < end) {
        const url = 'https://api.binance.com/api/v3/klines?symbol=' + symbol + '&interval=' + TIMEFRAME + '&startTime=' + currentTime + '&endTime=' + end + '&limit=' + limit;
        try {
            const response = await axios.get(url);
            const data = response.data;
            if(data.length === 0) break;
            klins = klins.concat(data);
            currentTime = data[data.length - 1][0] + 1;
        } catch(e) { break; }
        await new Promise(r => setTimeout(r, 20));
    }
    return klins.map(d => ({
        timestamp: d[0], open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4]), volume: parseFloat(d[5])
    }));
}

async function evaluateCoin(symbol) {
    let data = await fetchHistoricalData(symbol, startTimestamp, endTimestamp);
    if(data.length < 100) return null; // Not enough data
    
    let position = null;
    let grossWin = 0;
    let grossLoss = 0;
    let tradesCount = 0;

    for (let i = 50; i < data.length; i++) {
        const slice = data.slice(Math.max(0, i - 100), i + 1);
        const currentCandle = slice[slice.length - 1];
        const currentPrice = currentCandle.close;
        const currentHigh = currentCandle.high;
        const currentLow = currentCandle.low;

        if (!position) {
            const coin = { symbol, current_price: currentPrice };
            const result = evaluateTradeV2(coin, slice);
            if (result.signal === 'BUY') {
                const riskUSD = PORTFOLIO_BALANCE * RISK_PCT;
                const riskDist = result.atr * 1.5;
                
                let totalSizeCoins = riskUSD / riskDist;
                const maxTradeUSD = PORTFOLIO_BALANCE * 0.5;
                let tradeUSD = totalSizeCoins * currentPrice;
                if (tradeUSD > maxTradeUSD) {
                    tradeUSD = maxTradeUSD;
                    totalSizeCoins = tradeUSD / currentPrice;
                }
                
                if (tradeUSD < 5) continue;
                
                const fee = tradeUSD * 0.001;
                
                position = {
                    entryPrice: currentPrice,
                    atr: result.atr,
                    totalSize: totalSizeCoins,
                    remainingSize: totalSizeCoins,
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
    return { symbol, tradesCount, pf, netPnL };
}

async function runCustomSimulation() {
    const candidates = await getTopVolumeCoins(40);
    const results = [];
    for (const sym of candidates) {
        const res = await evaluateCoin(sym);
        if (res) results.push(res);
    }

    let validCoins = results.filter(c => c.pf > 1.2 && c.tradesCount >= 5); // lower trades count for custom ranges
    validCoins.sort((a, b) => b.pf - a.pf);
    
    const top20 = validCoins.slice(0, 20);
    let totalPortfolioNetPnL = 0;
    
    top20.forEach(c => {
        totalPortfolioNetPnL += c.netPnL;
    });

    const payload = {
        success: true,
        coins: top20,
        totalNetPnL: totalPortfolioNetPnL,
        startingBalance: PORTFOLIO_BALANCE,
        endingBalance: PORTFOLIO_BALANCE + totalPortfolioNetPnL,
        roi: (totalPortfolioNetPnL / PORTFOLIO_BALANCE) * 100
    };

    console.log(JSON.stringify(payload));
}

runCustomSimulation().catch(e => {
    console.error(e);
    console.log(JSON.stringify({success: false, error: e.message}));
});
