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
    const ema45 = EMA.calculate({ period: 45, values: closes });
    
    const macdInput = { values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false };
    const macdResult = MACD.calculate(macdInput);
    
    const rsi = RSI.calculate({ period: 14, values: closes });
    const bb = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
    const atrResult = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });

    // Get current (latest) indicator values
    const currentEma9 = ema9[ema9.length - 1];
    const prevEma9 = ema9[ema9.length - 2];
    const currentEma21 = ema21[ema21.length - 1];
    const prevEma21 = ema21[ema21.length - 2];
    const currentEma45 = ema45[ema45.length - 1];
    const prevEma45 = ema45[ema45.length - 2];

    const currentMacd = macdResult[macdResult.length - 1];
    const prevMacd = macdResult[macdResult.length - 2];
    
    const currentRsi = rsi[rsi.length - 1];
    const currentBb = bb[bb.length - 1];
    const currentAtr = atrResult[atrResult.length - 1];

    // --- 1. CORE FILTERS (MUST PASS) ---
    
    // Trend Filter: Price > EMA45 AND EMA45 slope positive
    const isUptrend = currentPrice > currentEma45 && currentEma45 > prevEma45;
    if (!isUptrend) {
        return { signal: 'NO TRADE', score: 0, reason: 'Failed Trend Filter (Below EMA45 or EMA45 pointing down)', atr: currentAtr };
    }

    // Volume Filter: Current volume > 20-bar average volume
    const vol20 = volumes.slice(-20);
    const avgVol20 = vol20.reduce((a, b) => a + b, 0) / 20;
    const currentVolume = volumes[volumes.length - 1];
    if (currentVolume <= avgVol20) {
        return { signal: 'NO TRADE', score: 0, reason: 'Failed Volume Filter (Volume too low)', atr: currentAtr };
    }

    // Liquidity Heatmap Filter (Placeholder)
    const majorLiquidityWallOverhead = false; // TODO: Plug in real orderbook data here
    if (majorLiquidityWallOverhead) {
         return { signal: 'NO TRADE', score: 0, reason: 'Failed Heatmap Filter (Major sell wall overhead)', atr: currentAtr };
    }

    // --- 2. ENTRY SIGNALS (SCORE SYSTEM) ---
    let score = 0;
    const scoreReasons = [];

    // EMA9 crosses above EMA21
    const emaCrossUp = prevEma9 <= prevEma21 && currentEma9 > currentEma21;
    if (emaCrossUp) {
        score += 3;
        scoreReasons.push('EMA 9/21 Cross (+3)');
    }

    // MACD histogram flips negative to positive AND price > EMA45
    const macdFlipPositive = prevMacd.histogram <= 0 && currentMacd.histogram > 0;
    if (macdFlipPositive && currentPrice > currentEma45) {
        score += 2;
        scoreReasons.push('MACD Flip (+2)');
    }

    // RSI between 45-65
    if (currentRsi >= 45 && currentRsi <= 65) {
        score += 1;
        scoreReasons.push('RSI Mid (+1)');
    }

    // Bollinger lower-band bounce AND RSI 35-45 (Only evaluated if trend passed, which it has by this point)
    const touchedLowerBand = currentPrice <= currentBb.lower;
    if (touchedLowerBand && currentRsi >= 35 && currentRsi <= 45) {
        score += 1;
        scoreReasons.push('Bollinger Bounce (+1)');
    }

    // --- 3. DECISION ---
    if (score >= 4) {
        return { signal: 'BUY', score, reason: `BUY (Score: ${score}) - ` + scoreReasons.join(', '), atr: currentAtr };
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
    if (historicalData.length < 26) return false;
    
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

    // EMA9 crosses below EMA21
    const emaCrossDown = prevEma9 >= prevEma21 && currentEma9 < currentEma21;
    
    // MACD histogram flips positive to negative
    const macdFlipNegative = prevMacd.histogram >= 0 && currentMacd.histogram < 0;

    return emaCrossDown || macdFlipNegative;
}

module.exports = {
    evaluateTrade,
    checkEmergencyExit
};
