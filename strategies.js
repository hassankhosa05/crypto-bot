const { EMA, MACD, RSI, BollingerBands, ATR } = require('technicalindicators');

/**
 * Confluence Decision Engine
 * Evaluates a coin's historical data against multiple filters and scoring rules.
 * 
 * @param {Object} coin - Coin object containing symbol and current_price
 * @param {Array} historicalData - Array of OHLCV objects: { open, high, low, close, volume }
 * @returns {Object} { signal: 'BUY' | 'SELL' | 'HOLD' | 'NO TRADE', score: number, reason: string, atr: number }
 */
function evaluateTrade(coin, historicalData) {
    if (historicalData.length < 45) {
        return { signal: 'NO TRADE', score: 0, reason: 'Not enough data (needs 45+ periods)', atr: 0 };
    }

    const closes = historicalData.map(d => d.close);
    const highs = historicalData.map(d => d.high);
    const lows = historicalData.map(d => d.low);
    const volumes = historicalData.map(d => d.volume);
    const currentPrice = coin.current_price;

    // --- Calculate Indicators ---
    const ema9 = EMA.calculate({ period: 9, values: closes });
    const ema21 = EMA.calculate({ period: 21, values: closes });
    const ema30 = EMA.calculate({ period: 30, values: closes });
    
    const macdInput = { values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false };
    const macdResult = MACD.calculate(macdInput);
    
    const rsi = RSI.calculate({ period: 14, values: closes });
    const bb = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
    const atrResult = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });

    // Get current (latest) indicator values
    const currentEma9 = ema9[ema9.length - 1];
    const prevEma9 = ema9[ema9.length - 2];
    const ema9_2barsAgo = ema9[ema9.length - 3];
    const ema9_3barsAgo = ema9[ema9.length - 4];

    const currentEma21 = ema21[ema21.length - 1];
    const prevEma21 = ema21[ema21.length - 2];
    const ema21_2barsAgo = ema21[ema21.length - 3];
    const ema21_3barsAgo = ema21[ema21.length - 4];
    const currentEma30 = ema30[ema30.length - 1];
    const ema30_3barsAgo = ema30[ema30.length - 4];

    const currentMacd = macdResult[macdResult.length - 1];
    const prevMacd = macdResult[macdResult.length - 2];
    
    const currentRsi = rsi[rsi.length - 1];
    const currentBb = bb[bb.length - 1];
    const prevBb = bb[bb.length - 2];
    const currentAtr = atrResult[atrResult.length - 1];

    // --- 1. CORE FILTERS (MUST PASS) ---
    
    // Trend Filter: Price > EMA30 AND EMA30 slope positive
    const isUptrend = currentPrice > currentEma30 && currentEma30 > ema30_3barsAgo;
    if (!isUptrend) {
        return { signal: 'NO TRADE', score: 0, reason: 'Failed Trend Filter (EMA30 trend invalid)', atr: currentAtr };
    }

    // Volume Filter: Current volume > 85% of 20-bar average volume
    const vol20 = volumes.slice(-20);
    const avgVol20 = vol20.reduce((a, b) => a + b, 0) / 20;
    const currentVolume = volumes[volumes.length - 1];
    if (currentVolume <= avgVol20 * 0.85) {
        return { signal: 'NO TRADE', score: 0, reason: 'Failed Volume Filter (Volume < 85% of average)', atr: currentAtr };
    }

    // Liquidity Heatmap Filter (Placeholder)
    const majorLiquidityWallOverhead = false; // TODO: Plug in real orderbook data here
    if (majorLiquidityWallOverhead) {
         return { signal: 'NO TRADE', score: 0, reason: 'Failed Heatmap Filter (Major sell wall overhead)', atr: currentAtr };
    }

    const estimatedSpreadPct = coin.spreadPct || 0.0001;
    const atrPct = currentAtr / currentPrice;
    if (estimatedSpreadPct > atrPct * 0.20) {
        return { signal: 'NO TRADE', score: 0, reason: 'Spread too large', atr: currentAtr };
    }

    // --- 2. ENTRY SIGNALS (SCORE SYSTEM) ---
    let score = 0;
    const scoreReasons = [];

    // EMA9 crosses above EMA21 within the last 3 candles
    const crossNow = prevEma9 <= prevEma21 && currentEma9 > currentEma21;
    const cross1BarAgo = ema9_2barsAgo <= ema21_2barsAgo && prevEma9 > prevEma21;
    const cross2BarsAgo = ema9_3barsAgo <= ema21_3barsAgo && ema9_2barsAgo > ema21_2barsAgo;
    
    const recentCross = crossNow || cross1BarAgo || cross2BarsAgo;
    const emaBullish = currentEma9 > currentEma21;

    if (recentCross && emaBullish) {
        score += 3;
        if(crossNow){
            score += 0.5;
        } else if(cross1BarAgo){
            score += 0.3;
        } else {
            score += 0.1;
        }
        scoreReasons.push('EMA Momentum');
    }

    // MACD logic
    const macdBullish = currentMacd.histogram > 0;
    if(macdBullish){
        score += 2;
        scoreReasons.push('MACD Bull (+2)');
    }

    // RSI between 42-68
    if (currentRsi >= 42 && currentRsi <= 68) {
        score += 1;
        scoreReasons.push('RSI Mid (+1)');
    }

    // Bollinger lower-band true bounce AND RSI 35-48
    const prevClose = closes[closes.length - 2];
    const touchedLowerBand = prevBb && prevClose <= prevBb.lower && currentPrice > currentBb.lower;
    if (touchedLowerBand && currentRsi >= 35 && currentRsi <= 48) {
        score += 1;
        scoreReasons.push('Bollinger Bounce (+1)');
    }

    // --- 3. DECISION ---
    if (emaBullish && recentCross && score >= 5) {
        return {
            signal: 'BUY',
            score,
            reason: `BUY Score:${score}\nEMA9:${currentEma9.toFixed(4)}\nEMA21:${currentEma21.toFixed(4)}\nRSI:${currentRsi.toFixed(1)}\nATR:${currentAtr.toFixed(4)}\nFilters:\n${scoreReasons.join(', ')}`,
            atr: currentAtr
        };
    } else if (score >= 3) {
        return { signal: 'HOLD', score, reason: `HOLD (Score: ${score}) - Not enough confluence`, atr: currentAtr };
    } else {
        return { signal: 'NO TRADE', score, reason: `NO TRADE (Score: ${score})`, atr: currentAtr };
    }
}

/**
 * Emergency Exit Check
 * Used to close an open position early if market turns hostile.
 */
function checkEmergencyExit(historicalData) {
    if (historicalData.length < 34) return false; // Needs at least 34 bars for stable MACD histogram
    
    const closes = historicalData.map(d => d.close);
    const ema9 = EMA.calculate({ period: 9, values: closes });
    const ema21 = EMA.calculate({ period: 21, values: closes });
    
    const macdInput = { values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false };
    const macdResult = MACD.calculate(macdInput);

    const currentEma9 = ema9[ema9.length - 1];
    const prevEma9 = ema9[ema9.length - 2];
    const currentEma21 = ema21[ema21.length - 1];
    const prevEma21 = ema21[ema21.length - 2];

    const currentMacd = macdResult[macdResult.length - 1];
    const prevMacd = macdResult[macdResult.length - 2];

    if (!currentMacd || !prevMacd) return false;

    // EMA9 crosses below EMA21
    const emaCrossDown = prevEma9 >= prevEma21 && currentEma9 < currentEma21;
    
    // Relaxed Emergency Exit: Only exit if EMA9 crosses below EMA21 AND MACD is bearish (histogram < 0)
    // This reduces false exits due to noise on minor pullbacks.
    const macdIsBearish = currentMacd.histogram < 0;

    return emaCrossDown && macdIsBearish;
}

module.exports = {
    evaluateTrade,
    checkEmergencyExit
};
