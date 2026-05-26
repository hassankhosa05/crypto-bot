const axios = require('axios');
const fs = require('fs');
const { evaluateTradeV2, checkEmergencyExitV2 } = require('./strategyV2');

const portfolio = JSON.parse(fs.readFileSync('./portfolio.json', 'utf8'));
const SYMBOLS = Object.keys(portfolio.currentPrices);
const TIMEFRAME = '5m';
const KLINES_TO_FETCH = 4000; // ~14 days of 5m

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
        
        let balance = 1000;
        let peakBalance = balance;
        let maxDrawdown = 0;
        let position = null;
        let tradesCount = 0;
        let wins = 0;
        let symbolGrossWin = 0;
        let symbolGrossLoss = 0;

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
                    const fee = balance * 0.001;
                    balance -= fee;
                    const riskDist = result.atr * 1.5;
                    position = {
                        entryPrice: currentPrice,
                        atr: result.atr,
                        totalSize: balance / currentPrice,
                        remainingSize: balance / currentPrice,
                        risk: riskDist,
                        slPrice: currentPrice - riskDist,
                        tp1Price: currentPrice + riskDist,
                        tp2Price: currentPrice + (riskDist * 2),
                        tp1Hit: false,
                        tp2Hit: false,
                        setup: result.reason.includes('Breakout') ? 'Breakout' : 'Pullback',
                        pnlTracker: 0
                    };
                }
            } else {
                let tradeClosed = false;
                let exitValue = 0;

                // Update Trailing Stop
                position.slPrice = Math.max(position.slPrice, currentPrice - position.risk);

                // Check Partial TPs
                if (!position.tp1Hit && currentHigh >= position.tp1Price) {
                    position.tp1Hit = true;
                    const sellSize = position.totalSize * 0.4;
                    const val = sellSize * position.tp1Price;
                    exitValue += val - (val * 0.001);
                    position.remainingSize -= sellSize;
                    position.pnlTracker += val - (sellSize * position.entryPrice);
                    position.slPrice = Math.max(position.slPrice, position.entryPrice);
                }
                
                if (!position.tp2Hit && currentHigh >= position.tp2Price) {
                    position.tp2Hit = true;
                    const sellSize = position.totalSize * 0.4;
                    const val = sellSize * position.tp2Price;
                    exitValue += val - (val * 0.001);
                    position.remainingSize -= sellSize;
                    position.pnlTracker += val - (sellSize * position.entryPrice);
                }

                // Check Stop Loss
                if (currentLow <= position.slPrice) {
                    tradeClosed = true;
                    const val = position.remainingSize * position.slPrice;
                    exitValue += val - (val * 0.001);
                    position.pnlTracker += val - (position.remainingSize * position.entryPrice);
                    position.remainingSize = 0;
                } else {
                    const emergencyExit = checkEmergencyExitV2(slice, position.entryPrice, position.atr);
                    if (emergencyExit) {
                        tradeClosed = true;
                        const val = position.remainingSize * currentPrice;
                        exitValue += val - (val * 0.001);
                        position.pnlTracker += val - (position.remainingSize * position.entryPrice);
                        position.remainingSize = 0;
                    }
                }

                if (exitValue > 0) balance += exitValue;

                if (tradeClosed || position.remainingSize <= 0.0001) {
                    tradesCount++;
                    if (position.pnlTracker > 0) {
                        wins++;
                        symbolGrossWin += position.pnlTracker;
                        grossWin += position.pnlTracker;
                    } else {
                        symbolGrossLoss += Math.abs(position.pnlTracker);
                        grossLoss += Math.abs(position.pnlTracker);
                    }
                    position = null;
                }

                if (balance > peakBalance) peakBalance = balance;
                const dd = (peakBalance - balance) / peakBalance;
                if (dd > maxDrawdown) maxDrawdown = dd;
            }
        }
        
        if (position && position.remainingSize > 0) {
            const currentPrice = data[data.length - 1].close;
            const val = position.remainingSize * currentPrice;
            balance += val - (val * 0.001);
            position.pnlTracker += val - (position.remainingSize * position.entryPrice);
            tradesCount++;
            if (position.pnlTracker > 0) {
                wins++;
                symbolGrossWin += position.pnlTracker;
                grossWin += position.pnlTracker;
            } else {
                symbolGrossLoss += Math.abs(position.pnlTracker);
                grossLoss += Math.abs(position.pnlTracker);
            }
        }

        const profitFactor = symbolGrossLoss > 0 ? (symbolGrossWin / symbolGrossLoss).toFixed(2) : (symbolGrossWin > 0 ? 'INF' : '0.00');
        results[symbol] = {
            trades: tradesCount,
            winRate: tradesCount > 0 ? (wins / tradesCount * 100).toFixed(1) + '%' : '0%',
            pf: profitFactor,
            maxDD: (maxDrawdown * 100).toFixed(1) + '%'
        };
        totalTrades += tradesCount;
        totalWins += wins;
    }

    console.log("\n\n=== V2.2 Backtest Summary ===");
    console.table(results);
    const overallWinRate = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(2) + '%' : '0%';
    const overallPf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : '0.00';
    console.log(`Overall Trades: ${totalTrades} | Win Rate: ${overallWinRate} | Profit Factor: ${overallPf}`);
}

runBacktest().catch(console.error);
