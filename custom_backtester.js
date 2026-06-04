const axios = require('axios');
const { evaluateTradeV2, checkEmergencyExitV2 } = require('./strategyV2');
const { simulateWalkForward } = require('./backtestEngine');

const TIMEFRAME = '15m';
const STABLECOINS = ['USDT', 'USDC', 'FDUSD', 'TUSD', 'USD1', 'RLUSD', 'DAI', 'USDP'];

const args = process.argv.slice(2);
const startTimestamp = parseInt(args[0]);
const endTimestamp = parseInt(args[1]);
const PORTFOLIO_BALANCE = parseFloat(args[2]);
const RISK_PCT = 0.02; // 2% fixed risk for projections
const TRAIN_SPLIT = 0.7;
const MIN_TRAIN_PF = 1.25;
const MIN_FORWARD_PF = 1.05;
const MIN_FORWARD_TRADES = 3;
const MIN_TRADES_PER_MONTH = 8;
const MAX_AVG_DAYS_BETWEEN_TRADES = 4;

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

function calculateProfitFactor(grossWin, grossLoss) {
    if (grossLoss > 0) return grossWin / grossLoss;
    return grossWin > 0 ? 999 : 0;
}

function calculateTestedDays(data, startIndex, endIndex) {
    if (endIndex <= startIndex || !data[startIndex] || !data[endIndex - 1]) return 0;
    return Math.max(1, (data[endIndex - 1].timestamp - data[startIndex].timestamp) / (24 * 60 * 60 * 1000));
}

function simulateWindow(symbol, data, startIndex, endIndex) {
    let position = null;
    let grossWin = 0;
    let grossLoss = 0;
    let tradesCount = 0;
    let wins = 0;

    for (let i = startIndex; i < endIndex; i++) {
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
                const riskDist = result.atr * 2.0;
                
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
                    tp1Price: currentPrice + (riskDist * 3),
                    tp1Hit: false,
                    pnlTracker: -fee
                };
            }
        } else {
            let tradeClosed = false;
            position.slPrice = Math.max(position.slPrice, currentPrice - (position.atr * 2.5));

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
                if (position.pnlTracker > 0) {
                    wins++;
                    grossWin += position.pnlTracker;
                } else {
                    grossLoss += Math.abs(position.pnlTracker);
                }
                position = null;
            }
        }
    }

    if (position && position.remainingSize > 0) {
        const currentPrice = data[endIndex - 1].close;
        const sellVal = position.remainingSize * currentPrice;
        position.pnlTracker += (sellVal - (sellVal * 0.001)) - (position.remainingSize * position.entryPrice);
        tradesCount++;
        if (position.pnlTracker > 0) {
            wins++;
            grossWin += position.pnlTracker;
        } else {
            grossLoss += Math.abs(position.pnlTracker);
        }
    }

    const testedDays = calculateTestedDays(data, startIndex, endIndex);
    const pf = calculateProfitFactor(grossWin, grossLoss);
    const netPnL = grossWin - grossLoss;
    const tradesPerMonth = testedDays > 0 ? (tradesCount / testedDays) * 30 : 0;
    const avgDaysBetweenTrades = tradesCount > 0 ? testedDays / tradesCount : 999;

    return {
        tradesCount,
        wins,
        winRate: tradesCount > 0 ? wins / tradesCount : 0,
        pf,
        netPnL,
        testedDays,
        tradesPerMonth,
        avgDaysBetweenTrades
    };
}

async function evaluateCoin(symbol) {
    const data = await fetchHistoricalData(symbol, startTimestamp, endTimestamp);
    if(data.length < 100) return null; // Not enough data

    const warmup = Math.min(300, Math.max(50, Math.floor(data.length * 0.2)));
    const result = simulateWalkForward(data, {
        symbol,
        warmupCandles: warmup,
        trainSplit: TRAIN_SPLIT,
        initialBalance: PORTFOLIO_BALANCE,
        minNotional: 5
    });
    if (!result) return null;

    return {
        symbol,
        train: result.train,
        forward: result.forward,
        pf: result.forward.pf,
        tradesCount: result.forward.tradesCount,
        netPnL: result.forward.netPnL,
        tradesPerMonth: result.forward.tradesPerMonth,
        avgDaysBetweenTrades: result.forward.avgDaysBetweenTrades,
        score: result.forward.netPnL + (Math.min(result.forward.pf, 5) * 2) + (result.forward.tradesPerMonth * 0.15)
    };
}

async function runCustomSimulation() {
    const candidates = await getTopVolumeCoins(40);
    const results = [];
    for (const sym of candidates) {
        const res = await evaluateCoin(sym);
        if (res) results.push(res);
    }

    let validCoins = results.filter(c => {
        return c.train.pf >= MIN_TRAIN_PF &&
            c.forward.pf >= MIN_FORWARD_PF &&
            c.forward.netPnL > 0 &&
            c.forward.tradesCount >= MIN_FORWARD_TRADES &&
            c.forward.tradesPerMonth >= MIN_TRADES_PER_MONTH &&
            c.forward.avgDaysBetweenTrades <= MAX_AVG_DAYS_BETWEEN_TRADES;
    });
    validCoins.sort((a, b) => b.score - a.score);
    
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
