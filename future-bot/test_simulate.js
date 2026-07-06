const axios = require('axios');
const { evaluateTradeV2, checkEmergencyExitV2 } = require('/Users/developer/projects/crypto-bot_active/strategyV2');

const TIMEFRAME = '15m';

async function fetchHistoricalData(symbol) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${TIMEFRAME}&limit=1000`;
    const response = await axios.get(url);
    return response.data.map(d => ({
        timestamp: d[0], open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4]), volume: parseFloat(d[5])
    }));
}

async function runTest() {
    const symbol = 'ALLOUSDT';
    const data = await fetchHistoricalData(symbol);
    const startIndex = 400;
    const endIndex = data.length;

    let position = null;
    let grossWin = 0;
    let grossLoss = 0;
    let tradesCount = 0;
    let wins = 0;

    const TRADE_USD = 100;

    for (let i = startIndex; i < endIndex; i++) {
        const slice = data.slice(0, i + 1);
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
                console.log(`[${new Date(currentCandle.timestamp).toISOString()}] ENTRY at ${currentPrice.toFixed(2)} | SL: ${position.slPrice.toFixed(2)} | TP1: ${position.tp1Price.toFixed(2)} | TP2: ${position.tp2Price.toFixed(2)}`);
            }
        } else {
            let tradeClosed = false;

            if (position.tp1Hit) {
                position.slPrice = Math.max(position.slPrice, currentPrice - (position.atr * 1.0));
            }

            const slTriggered = currentLow <= position.slPrice;
            const tp1Triggered = !position.tp1Hit && currentHigh >= position.tp1Price;
            const tp2Triggered = position.tp1Hit && currentHigh >= position.tp2Price;

            if (tp1Triggered && slTriggered) {
                console.log(`[${new Date(currentCandle.timestamp).toISOString()}] Both TP1 and SL triggered. Coin flip...`);
                if (Math.random() < 0.5) {
                    position.tp1Hit = true;
                    const sellSize = position.totalSize * 0.5;
                    const sellVal = sellSize * position.tp1Price;
                    position.pnlTracker += (sellVal - (sellVal * 0.001)) - (sellSize * position.entryPrice);
                    position.remainingSize -= sellSize;
                    position.slPrice = Math.max(position.slPrice, position.entryPrice);
                    console.log(`[${new Date(currentCandle.timestamp).toISOString()}] -> Hit TP1 at ${position.tp1Price.toFixed(2)}`);

                    if (position.remainingSize > 0.0001 && currentLow <= position.slPrice) {
                        tradeClosed = true;
                        const slSellVal = position.remainingSize * position.slPrice;
                        position.pnlTracker += (slSellVal - (slSellVal * 0.001)) - (position.remainingSize * position.entryPrice);
                        position.remainingSize = 0;
                        console.log(`[${new Date(currentCandle.timestamp).toISOString()}] -> Also hit SL on runner at ${position.slPrice.toFixed(2)}`);
                    }
                } else {
                    tradeClosed = true;
                    const sellVal = position.remainingSize * position.slPrice;
                    position.pnlTracker += (sellVal - (sellVal * 0.001)) - (position.remainingSize * position.entryPrice);
                    position.remainingSize = 0;
                    console.log(`[${new Date(currentCandle.timestamp).toISOString()}] -> Hit full SL at ${position.slPrice.toFixed(2)}`);
                }
            } else if (tp2Triggered && slTriggered) {
                console.log(`[${new Date(currentCandle.timestamp).toISOString()}] Both TP2 and SL triggered. Coin flip...`);
                if (Math.random() < 0.5) {
                    tradeClosed = true;
                    const sellVal = position.remainingSize * position.tp2Price;
                    position.pnlTracker += (sellVal - (sellVal * 0.001)) - (position.remainingSize * position.entryPrice);
                    position.remainingSize = 0;
                    console.log(`[${new Date(currentCandle.timestamp).toISOString()}] -> Hit TP2 at ${position.tp2Price.toFixed(2)}`);
                } else {
                    tradeClosed = true;
                    const sellVal = position.remainingSize * position.slPrice;
                    position.pnlTracker += (sellVal - (sellVal * 0.001)) - (position.remainingSize * position.entryPrice);
                    position.remainingSize = 0;
                    console.log(`[${new Date(currentCandle.timestamp).toISOString()}] -> Hit SL on runner at ${position.slPrice.toFixed(2)}`);
                }
            } else if (slTriggered) {
                tradeClosed = true;
                const sellVal = position.remainingSize * position.slPrice;
                position.pnlTracker += (sellVal - (sellVal * 0.001)) - (position.remainingSize * position.entryPrice);
                position.remainingSize = 0;
                console.log(`[${new Date(currentCandle.timestamp).toISOString()}] Hit SL at ${position.slPrice.toFixed(2)}`);
            } else if (tp1Triggered) {
                position.tp1Hit = true;
                const sellSize = position.totalSize * 0.5;
                const sellVal = sellSize * position.tp1Price;
                position.pnlTracker += (sellVal - (sellVal * 0.001)) - (sellSize * position.entryPrice);
                position.remainingSize -= sellSize;
                position.slPrice = Math.max(position.slPrice, position.entryPrice);
                console.log(`[${new Date(currentCandle.timestamp).toISOString()}] Hit TP1 at ${position.tp1Price.toFixed(2)}. SL moved to ${position.slPrice.toFixed(2)}`);

                if (currentHigh >= position.tp2Price) {
                    tradeClosed = true;
                    const sellVal2 = position.remainingSize * position.tp2Price;
                    position.pnlTracker += (sellVal2 - (sellVal2 * 0.001)) - (position.remainingSize * position.entryPrice);
                    position.remainingSize = 0;
                    console.log(`[${new Date(currentCandle.timestamp).toISOString()}] Also hit TP2 in same candle at ${position.tp2Price.toFixed(2)}`);
                }
            } else if (tp2Triggered) {
                tradeClosed = true;
                const sellVal = position.remainingSize * position.tp2Price;
                position.pnlTracker += (sellVal - (sellVal * 0.001)) - (position.remainingSize * position.entryPrice);
                position.remainingSize = 0;
                console.log(`[${new Date(currentCandle.timestamp).toISOString()}] Hit TP2 at ${position.tp2Price.toFixed(2)}`);
            } else {
                const emergencyExit = checkEmergencyExitV2(slice, position.entryPrice, position.atr);
                if (emergencyExit) {
                    tradeClosed = true;
                    const sellVal = position.remainingSize * currentPrice;
                    position.pnlTracker += (sellVal - (sellVal * 0.001)) - (position.remainingSize * position.entryPrice);
                    position.remainingSize = 0;
                    console.log(`[${new Date(currentCandle.timestamp).toISOString()}] Emergency Exit triggered at ${currentPrice.toFixed(2)}`);
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
                console.log(`--- TRADE CLOSED | PnL Tracker: $${position.pnlTracker.toFixed(2)} ---\n`);
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
        console.log(`--- TRADE CLOSED (End of window) | PnL Tracker: $${position.pnlTracker.toFixed(2)} ---\n`);
    }

    console.log(`Total Trades: ${tradesCount} | Wins: ${wins} | Gross Win: $${grossWin.toFixed(2)} | Gross Loss: $${grossLoss.toFixed(2)} | Net PnL: $${(grossWin - grossLoss).toFixed(2)}`);
}

runTest().catch(console.error);
