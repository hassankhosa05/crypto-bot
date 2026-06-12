const {
    EMA,
    RSI,
    ATR
} = require('technicalindicators');

function calculateVWAP(data){
    let cumulativePV = 0;
    let cumulativeVolume = 0;
    for (const candle of data) {
        const typicalPrice = (candle.high + candle.low + candle.close) / 3;
        cumulativePV += typicalPrice * candle.volume;
        cumulativeVolume += candle.volume;
    }
    return cumulativeVolume ? cumulativePV / cumulativeVolume : null;
}

function calculateROC(closes, period = 5) {
    if (closes.length <= period) return 0;
    const prev = closes[closes.length - 1 - period];
    const current = closes[closes.length - 1];
    return ((current - prev) / prev) * 100;
}

function isBullStructure(closes) {
    if (closes.length < 12) return false;
    const recent = closes.slice(-12);
    const low1 = Math.min(...recent.slice(0, 6));
    const low2 = Math.min(...recent.slice(6));
    const high1 = Math.max(...recent.slice(0, 6));
    const high2 = Math.max(...recent.slice(6));
    return low2 > low1 && high2 > high1;
}

// regime: 'TRENDING' | 'CHOPPY' — when CHOPPY, all BUY entries are suppressed.
// Choppy markets mean-revert; a score-6 breakout entry systematically buys local tops.
function evaluateTradeV2(coin, historicalData, regime = 'TRENDING') {
    if (historicalData.length < 50) {
        return { signal: 'NO TRADE', score: 0, reason: 'Insufficient history', atr: 0 };
    }

    // Block all new entries in choppy regime — breakout logic buys tops into reversals.
    if (regime === 'CHOPPY') {
        return { signal: 'NO TRADE', score: 0, reason: 'Choppy regime: entries suppressed', atr: 0 };
    }

    const closes  = historicalData.map(x => x.close);
    const highs   = historicalData.map(x => x.high);
    const lows    = historicalData.map(x => x.low);
    const volumes = historicalData.map(x => x.volume);

    const currentPrice = closes[closes.length - 1];

    const ema9  = EMA.calculate({ period: 9,  values: closes });
    const ema21 = EMA.calculate({ period: 21, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });
    const rsi   = RSI.calculate({ period: 14, values: closes });
    const atr   = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });

    const currentEMA9    = ema9[ema9.length - 1];
    const currentEMA21   = ema21[ema21.length - 1];
    const currentEMA50   = ema50[ema50.length - 1];
    const ema50_5barsAgo = ema50[ema50.length - 6];
    const currentRSI     = rsi[rsi.length - 1];
    const currentATR     = atr[atr.length - 1];
    const currentVolume  = volumes[volumes.length - 1];
    const avgVol20       = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const rvol           = currentVolume / avgVol20;
    const vwap           = calculateVWAP(historicalData.slice(-30));
    const roc            = calculateROC(closes, 5);
    const structureBull  = isBullStructure(closes);

    // Core filters
    const trendValid = currentPrice > currentEMA50 && currentEMA50 > ema50_5barsAgo;

    if (!trendValid)    return { signal: 'NO TRADE', score: 0, reason: 'Trend invalid',     atr: currentATR };
    if (!structureBull) return { signal: 'NO TRADE', score: 0, reason: 'Structure invalid', atr: currentATR };
    if (rvol < 1.30)    return { signal: 'NO TRADE', score: 0, reason: 'Low RVOL',          atr: currentATR };
    if (currentPrice < vwap) return { signal: 'NO TRADE', score: 0, reason: 'Below VWAP',  atr: currentATR };

    // Scoring
    let score = 0;
    const reasons = [];

    const breakoutHigh = Math.max(...highs.slice(-10, -1));
    const breakoutMode = currentPrice > breakoutHigh;
    if (breakoutMode) {
        score += 2;
        reasons.push('Breakout');
    }

    const pullbackMode =
        currentPrice > currentEMA9 &&
        currentEMA9 > currentEMA21 &&
        Math.abs(currentPrice - currentEMA9) / currentPrice < 0.004;
    if (pullbackMode) {
        score += 2;
        reasons.push('EMA Pullback');
    }

    if (roc > 0.35) {
        score += 2;
        reasons.push(`ROC ${roc.toFixed(2)}%`);
    }

    if (currentRSI >= 50 && currentRSI <= 72) {
        score += 1;
        reasons.push(`RSI ${currentRSI.toFixed(1)}`);
    }

    if (currentPrice > vwap * 1.002) {
        score += 1;
        reasons.push('VWAP Strong');
    }

    if (score >= 6) {
        return {
            signal: 'BUY',
            score,
            reason: `BUY V2\nScore:${score}\nROC:${roc.toFixed(2)}%\nRVOL:${rvol.toFixed(2)}\nVWAP:${vwap.toFixed(4)}\n` + reasons.join(', '),
            atr: currentATR
        };
    }

    return { signal: 'NO TRADE', score, reason: `Weak confluence ${score}`, atr: currentATR };
}

function checkEmergencyExitV2(historicalData, entryPrice, currentATR) {
    if (historicalData.length < 30) return false;

    const closes     = historicalData.map(x => x.close);
    const ema9       = EMA.calculate({ period: 9,  values: closes });
    const ema21      = EMA.calculate({ period: 21, values: closes });
    const rocResult  = calculateROC(closes, 5);
    const currentPrice = closes[closes.length - 1];
    const currentEMA9  = ema9[ema9.length - 1];
    const currentEMA21 = ema21[ema21.length - 1];

    if (entryPrice && currentATR && currentPrice < entryPrice - (currentATR * 3.0)) {
        return true;
    }

    const vwap = calculateVWAP(historicalData.slice(-30));
    if (currentEMA9 < currentEMA21 && currentPrice < vwap && rocResult < 0) {
        return true;
    }

    return false;
}

module.exports = { evaluateTradeV2, checkEmergencyExitV2 };
