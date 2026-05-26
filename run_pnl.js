const axios = require('axios');
const fs = require('fs');
const { evaluateTradeV2, checkEmergencyExitV2 } = require('/Users/developer/.gemini/antigravity/projects/crypto-bot/strategyV2');

const portfolio = JSON.parse(fs.readFileSync('/Users/developer/.gemini/antigravity/projects/crypto-bot/portfolio.json', 'utf8'));
const SYMBOLS = Object.keys(portfolio.currentPrices);
const TIMEFRAME = '5m';
const KLINES_TO_FETCH = 4000; 

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

async function runTrueBacktest() {
    console.log("Running fixed PnL backtest...");
    let totalPortfolioPnlAll = 0;
    let totalPortfolioPnlWinners = 0;
    const winningCoins = ["BTCUSDT","ETHUSDT","XRPUSDT","SUIUSDT","BNBUSDT","TRXUSDT","ASTERUSDT","TONUSDT","ADAUSDT","RENDERUSDT","SAHARAUSDT"];

    // Base our calculation strictly on proportional risk to $300 balance per trade. 
    // The paperTrader allocates 1% risk per trade, max 20% size per coin. 
    // Let's assume average capital allocated per trade was $60 (20% of $300).
    const TRADE_USD = 60;

    for (const symbol of SYMBOLS) {
        let data = await fetchHistoricalData(symbol);
        if(data.length < 500) continue;
        
        let position = null;
        let symbolPnl = 0;

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
                    symbolPnl -= fee;
                    
                    const riskDist = result.atr * 1.5;
                    position = {
                        entryPrice: currentPrice,
                        atr: result.atr,
                        totalSize: TRADE_USD / currentPrice,
                        remainingSize: TRADE_USD / currentPrice,
                        risk: riskDist,
                        slPrice: currentPrice - riskDist,
                        tp1Price: currentPrice + riskDist,
                        tp2Price: currentPrice + (riskDist * 2),
                        tp1Hit: false,
                        tp2Hit: false
                    };
                }
            } else {
                let tradeClosed = false;

                // Update Trailing Stop
                position.slPrice = Math.max(position.slPrice, currentPrice - position.risk);

                // Check Partial TPs
                if (!position.tp1Hit && currentHigh >= position.tp1Price) {
                    position.tp1Hit = true;
                    const sellSize = position.totalSize * 0.4;
                    const sellVal = sellSize * position.tp1Price;
                    symbolPnl += (sellVal - (sellVal * 0.001)) - (sellSize * position.entryPrice);
                    position.remainingSize -= sellSize;
                    position.slPrice = Math.max(position.slPrice, position.entryPrice);
                }
                
                if (!position.tp2Hit && currentHigh >= position.tp2Price) {
                    position.tp2Hit = true;
                    const sellSize = position.totalSize * 0.4;
                    const sellVal = sellSize * position.tp2Price;
                    symbolPnl += (sellVal - (sellVal * 0.001)) - (sellSize * position.entryPrice);
                    position.remainingSize -= sellSize;
                }

                // Check Stop Loss / Trailing
                if (currentLow <= position.slPrice) {
                    tradeClosed = true;
                    const sellVal = position.remainingSize * position.slPrice;
                    symbolPnl += (sellVal - (sellVal * 0.001)) - (position.remainingSize * position.entryPrice);
                    position.remainingSize = 0;
                } else {
                    const emergencyExit = checkEmergencyExitV2(slice, position.entryPrice, position.atr);
                    if (emergencyExit) {
                        tradeClosed = true;
                        const sellVal = position.remainingSize * currentPrice;
                        symbolPnl += (sellVal - (sellVal * 0.001)) - (position.remainingSize * position.entryPrice);
                        position.remainingSize = 0;
                    }
                }

                if (tradeClosed || position.remainingSize <= 0.0001) {
                    position = null;
                }
            }
        }
        
        if (position && position.remainingSize > 0) {
            const currentPrice = data[data.length - 1].close;
            const sellVal = position.remainingSize * currentPrice;
            symbolPnl += (sellVal - (sellVal * 0.001)) - (position.remainingSize * position.entryPrice);
        }

        totalPortfolioPnlAll += symbolPnl;
        if(winningCoins.includes(symbol)) {
            totalPortfolioPnlWinners += symbolPnl;
        }
    }

    console.log("=== FINAL RESULTS (Start: $300, Trade Size: $60) ===");
    console.log("Total Profit/Loss (Trading ALL 30 COINS): $" + totalPortfolioPnlAll.toFixed(2));
    console.log("Total Profit/Loss (Trading ONLY TOP 11 COINS): $" + totalPortfolioPnlWinners.toFixed(2));
}

runTrueBacktest().catch(console.error);
