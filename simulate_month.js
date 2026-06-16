const axios = require('axios');
const fs = require('fs');
const { evaluateTradeV2, checkEmergencyExitV2 } = require('./strategyV2');
const { simulateWalkForward } = require('./backtestEngine');

const TIMEFRAME = '15m';
const KLINES_TO_FETCH = 2880; // ~30 days
const WARMUP_CANDLES = 400;
const TRAIN_SPLIT = 0.7;
const MIN_TRAIN_PF = 1.05;
const MIN_FORWARD_PF = 1.01;
const MIN_FORWARD_TRADES = 2;
const MIN_TRADES_PER_MONTH = 4;
const MAX_AVG_DAYS_BETWEEN_TRADES = 6;

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
    
    const TRADE_USD = 100; 

    for (let i = startIndex; i < endIndex; i++) {
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
                const riskDist = result.atr * 1.2;
                position = {
                    entryPrice: currentPrice,
                    atr: result.atr,
                    totalSize: TRADE_USD / currentPrice,
                    remainingSize: TRADE_USD / currentPrice,
                    risk: riskDist,
                    slPrice: currentPrice - riskDist,
                    tp1Price: currentPrice + (result.atr * 1.5),
                    tp2Price: currentPrice + (result.atr * 3.0),
                    tp1Hit: false,
                    pnlTracker: -fee
                };
            }
        } else {
            let tradeClosed = false;
            
            // Trail at 1 x ATR after TP1
            if (position.tp1Hit) {
                position.slPrice = Math.max(position.slPrice, currentPrice - (position.atr * 1.0));
            }

            const slTriggered = currentLow <= position.slPrice;
            const tp1Triggered = !position.tp1Hit && currentHigh >= position.tp1Price;
            const tp2Triggered = position.tp1Hit && currentHigh >= position.tp2Price;

            if (tp1Triggered && slTriggered) {
                if (Math.random() < 0.5) {
                    position.tp1Hit = true;
                    const sellSize = position.totalSize * 0.5;
                    const sellVal = sellSize * position.tp1Price;
                    position.pnlTracker += (sellVal - (sellVal * 0.001)) - (sellSize * position.entryPrice);
                    position.remainingSize -= sellSize;
                    position.slPrice = Math.max(position.slPrice, position.entryPrice);

                    if (position.remainingSize > 0.0001 && currentLow <= position.slPrice) {
                        tradeClosed = true;
                        const slSellVal = position.remainingSize * position.slPrice;
                        position.pnlTracker += (slSellVal - (slSellVal * 0.001)) - (position.remainingSize * position.entryPrice);
                        position.remainingSize = 0;
                    }
                } else {
                    tradeClosed = true;
                    const sellVal = position.remainingSize * position.slPrice;
                    position.pnlTracker += (sellVal - (sellVal * 0.001)) - (position.remainingSize * position.entryPrice);
                    position.remainingSize = 0;
                }
            } else if (tp2Triggered && slTriggered) {
                if (Math.random() < 0.5) {
                    tradeClosed = true;
                    const sellVal = position.remainingSize * position.tp2Price;
                    position.pnlTracker += (sellVal - (sellVal * 0.001)) - (position.remainingSize * position.entryPrice);
                    position.remainingSize = 0;
                } else {
                    tradeClosed = true;
                    const sellVal = position.remainingSize * position.slPrice;
                    position.pnlTracker += (sellVal - (sellVal * 0.001)) - (position.remainingSize * position.entryPrice);
                    position.remainingSize = 0;
                }
            } else if (slTriggered) {
                tradeClosed = true;
                const sellVal = position.remainingSize * position.slPrice;
                position.pnlTracker += (sellVal - (sellVal * 0.001)) - (position.remainingSize * position.entryPrice);
                position.remainingSize = 0;
            } else if (tp1Triggered) {
                position.tp1Hit = true;
                const sellSize = position.totalSize * 0.5;
                const sellVal = sellSize * position.tp1Price;
                position.pnlTracker += (sellVal - (sellVal * 0.001)) - (sellSize * position.entryPrice);
                position.remainingSize -= sellSize;
                position.slPrice = Math.max(position.slPrice, position.entryPrice);

                if (currentHigh >= position.tp2Price) {
                    tradeClosed = true;
                    const sellVal2 = position.remainingSize * position.tp2Price;
                    position.pnlTracker += (sellVal2 - (sellVal2 * 0.001)) - (position.remainingSize * position.entryPrice);
                    position.remainingSize = 0;
                }
            } else if (tp2Triggered) {
                tradeClosed = true;
                const sellVal = position.remainingSize * position.tp2Price;
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

    const losses = tradesCount - wins;
    return {
        tradesCount,
        wins,
        winRate: tradesCount > 0 ? wins / tradesCount : 0,
        avgWin: wins > 0 ? grossWin / wins : 0,
        avgLoss: losses > 0 ? grossLoss / losses : 0,
        pf,
        netPnL,
        grossWin,
        grossLoss,
        testedDays,
        tradesPerMonth,
        avgDaysBetweenTrades
    };
}

async function evaluateCoin(symbol) {
    const data = await fetchHistoricalData(symbol);
    if(data.length < 500) return null;

    const result = simulateWalkForward(data, {
        symbol,
        warmupCandles: WARMUP_CANDLES,
        trainSplit: TRAIN_SPLIT,
        initialBalance: 1000,
        fixedTradeUSD: 100
    });
    if (!result) return null;

    return {
        symbol,
        train: result.train,
        forward: result.forward,
        score: result.forward.netPnL + (Math.min(result.forward.pf, 5) * 2) + (result.forward.tradesPerMonth * 0.15)
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

    console.log("All coins raw results:");
    results.forEach(c => {
        console.log(`${c.symbol} | Train PF: ${c.train.pf.toFixed(2)} | Forward PF: ${c.forward.pf.toFixed(2)} | Forward Trades: ${c.forward.tradesCount} | Trades/Mo: ${c.forward.tradesPerMonth.toFixed(1)} | Avg Days/Trade: ${c.forward.avgDaysBetweenTrades.toFixed(2)} | Net PnL: $${c.forward.netPnL.toFixed(2)}`);
    });

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
    
    console.log("\\n=== Top Performing Coins (30 Days) ===");
    let totalPortfolioNetPnL = 0;
    
    top20.forEach(c => {
        console.log(
            c.symbol +
            " | Train PF: " + c.train.pf.toFixed(2) +
            " | Forward PF: " + c.forward.pf.toFixed(2) +
            " | Forward Trades: " + c.forward.tradesCount +
            " | Trades/Mo: " + c.forward.tradesPerMonth.toFixed(1) +
            " | Avg Days/Trade: " + c.forward.avgDaysBetweenTrades.toFixed(2) +
            " | Avg Win: $" + c.forward.avgWin.toFixed(2) +
            " | Avg Loss: $" + c.forward.avgLoss.toFixed(2) +
            " | Forward Net PnL (per $100 size): $" + c.forward.netPnL.toFixed(2)
        );
        totalPortfolioNetPnL += c.forward.netPnL;
    });

    console.log("\\n=== Monthly Projection ===");
    console.log("Coins qualifying: " + top20.length);
    console.log("Projection uses only the forward validation window after each coin passed the training window.");
    console.log("Estimated forward-window portfolio growth from qualifying coins: +$" + totalPortfolioNetPnL.toFixed(2));
    
    const roi = (totalPortfolioNetPnL / 300) * 100;
    console.log("Monthly ROI: " + roi.toFixed(2) + "%");
}

runMonthlySimulation().catch(console.error);
