const {
    EMA,
    RSI,
    ATR,
    ADX
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

function synthesizeCandle(candles) {
    const opens = candles.map(c => c.open);
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);
    
    return {
        timestamp: candles[0].timestamp,
        open: opens[0],
        high: Math.max(...highs),
        low: Math.min(...lows),
        close: closes[closes.length - 1],
        volume: volumes.reduce((a, b) => a + b, 0)
    };
}

function get1HCandles(historicalData15m) {
    const candles1H = [];
    let currentHour = null;
    let currentCandles = [];
    
    for (const candle of historicalData15m) {
        const date = new Date(candle.timestamp);
        // Generate UTC hour string (e.g. "2026-06-16 17:00")
        const hour = date.getUTCFullYear() + '-' + 
                     String(date.getUTCMonth() + 1).padStart(2, '0') + '-' + 
                     String(date.getUTCDate()).padStart(2, '0') + ' ' + 
                     String(date.getUTCHours()).padStart(2, '0') + ':00';
        
        if (currentHour !== hour) {
            if (currentCandles.length > 0) {
                candles1H.push(synthesizeCandle(currentCandles));
            }
            currentHour = hour;
            currentCandles = [candle];
        } else {
            currentCandles.push(candle);
        }
    }
    if (currentCandles.length > 0) {
        candles1H.push(synthesizeCandle(currentCandles));
    }
    return candles1H;
}

function evaluateTradeV2(coin, historicalData, regime = 'TRENDING') {
    if (historicalData.length < 50) {
        return { signal: 'NO TRADE', score: 0, failedReason: 'Insufficient history', atr: 0 };
    }

    const closes  = historicalData.map(x => x.close);
    const highs   = historicalData.map(x => x.high);
    const lows    = historicalData.map(x => x.low);
    const opens   = historicalData.map(x => x.open);
    const volumes = historicalData.map(x => x.volume);

    const currentPrice = closes[closes.length - 1];

    // ─────────────────────────────────────────────────────────────────────────
    // LAYER 1 — LIQUIDITY & VOLATILITY (15m Timeframe)
    // ─────────────────────────────────────────────────────────────────────────
    
    // 1. Volume filter
    const currentVolume = volumes[volumes.length - 1];
    const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const rvol = avgVol20 > 0 ? currentVolume / avgVol20 : 0;
    const requiredRVOL = regime === 'CHOPPY' ? 1.3 : 0.9;
    if (rvol < requiredRVOL) {
        return { signal: 'NO TRADE', score: 0, failedReason: 'RVOL', atr: 0, meta: { rvol: parseFloat(rvol.toFixed(2)), required: requiredRVOL } };
    }

    // 2. Volatility filter (ATR% >= 0.4%)
    const atrCalc = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const currentATR = atrCalc[atrCalc.length - 1] || 0;
    const atrPct = currentATR / currentPrice;
    if (atrPct < 0.004) {
        return { signal: 'NO TRADE', score: 0, failedReason: 'ATR%', atr: currentATR, meta: { atrPct: parseFloat(atrPct.toFixed(4)), required: 0.004 } };
    }

    // 3. Candle activity filter (>= 45% of last 50 candles have body > wick)
    const last50 = historicalData.slice(-50);
    let bodyGreaterCount = 0;
    for (const candle of last50) {
        const body = Math.abs(candle.close - candle.open);
        const wick = (candle.high - candle.low) - body;
        if (body > wick) {
            bodyGreaterCount++;
        }
    }
    const bodyWickRatio = bodyGreaterCount / last50.length;
    if (bodyWickRatio < 0.45) {
        return { signal: 'NO TRADE', score: 0, failedReason: 'CandleActivity', atr: currentATR, meta: { bodyWickRatio: parseFloat(bodyWickRatio.toFixed(2)), required: 0.45 } };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LAYER 2 — TREND & MARKET BIAS (1H resampled EMAs + 15m ADX)
    // ─────────────────────────────────────────────────────────────────────────
    
    // 1. Market bias from 1H resampled candles
    const candles1H = get1HCandles(historicalData);
    const closes1H = candles1H.map(c => c.close);
    
    if (closes1H.length < 50) {
        return { signal: 'NO TRADE', score: 0, failedReason: 'Insufficient 1H history', atr: currentATR };
    }

    const ema20_1H = EMA.calculate({ period: 20, values: closes1H });
    const ema50_1H = EMA.calculate({ period: 50, values: closes1H });

    const currentEMA20_1H = ema20_1H[ema20_1H.length - 1];
    const currentEMA50_1H = ema50_1H[ema50_1H.length - 1];

    if (!currentEMA20_1H || !currentEMA50_1H) {
        return { signal: 'NO TRADE', score: 0, failedReason: 'EMA 1H calculation failed', atr: currentATR };
    }

    const distance = Math.abs(currentEMA20_1H - currentEMA50_1H) / currentEMA50_1H;
    let bias = 'NEUTRAL';
    if (distance >= 0.0015) {
        bias = currentEMA20_1H > currentEMA50_1H ? 'LONG' : 'SHORT';
    }

    if (bias === 'NEUTRAL') {
        return { signal: 'NO TRADE', score: 0, failedReason: 'Neutral bias', atr: currentATR, meta: { distance: parseFloat(distance.toFixed(4)), required: 0.0015 } };
    }

    // 2. Trend Strength Filter (stricter in CHOPPY)
    const adxCalc = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const currentADXObj = adxCalc[adxCalc.length - 1];
    const currentADX = currentADXObj ? currentADXObj.adx : 0;
    const requiredADX = regime === 'CHOPPY' ? 25 : 14;
    if (currentADX < requiredADX) {
        return { signal: 'NO TRADE', score: 0, failedReason: `ADX < ${requiredADX}`, atr: currentATR, meta: { adx: parseFloat(currentADX.toFixed(2)), required: requiredADX } };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LAYER 3 — ENTRY MODEL (Trigger & Confirmations)
    // ─────────────────────────────────────────────────────────────────────────
    
    const ema21_15m = EMA.calculate({ period: 21, values: closes });
    const currentEMA21 = ema21_15m[ema21_15m.length - 1];
    const vwap = calculateVWAP(historicalData.slice(-30));
    
    if (!currentEMA21 || !vwap) {
        return { signal: 'NO TRADE', score: 0, failedReason: 'EMA21/VWAP calculation failed', atr: currentATR };
    }

    const inVwapZone = currentPrice >= (vwap * 0.998) && currentPrice <= (vwap * 1.002);
    
    // Indicators for confirmations
    const rsiCalc = RSI.calculate({ period: 14, values: closes });
    const currentRSI = rsiCalc[rsiCalc.length - 1] || 50;
    const prevRSI = rsiCalc[rsiCalc.length - 2] || 50;
    const currentOpen = opens[opens.length - 1];

    if (bias === 'LONG') {
        // 1. Pullback trigger: price <= EMA21 OR in VWAP zone
        const inPullback = (currentPrice <= currentEMA21) || inVwapZone;
        if (!inPullback) {
            return { signal: 'NO TRADE', score: 0, failedReason: 'Not in pullback zone', atr: currentATR, meta: { price: currentPrice, ema21: currentEMA21, vwap } };
        }

        // 2. Confirmations
        // a. RSI > 45 and rising
        const rsiConfirm = currentRSI > 45 && currentRSI > prevRSI;
        // b. Bullish candle break of last 3 candles
        const last3High = Math.max(highs[highs.length - 2], highs[highs.length - 3], highs[highs.length - 4]);
        const breakConfirm = currentPrice > last3High;
        // c. Momentum candle > 0.2%
        const momConfirm = (currentPrice > currentOpen) && ((currentPrice - currentOpen) / currentOpen > 0.002);

        let confirmations = 0;
        const reasons = [];
        if (rsiConfirm) { confirmations++; reasons.push(`RSI ${currentRSI.toFixed(1)} rising`); }
        if (breakConfirm) { confirmations++; reasons.push(`Breakout ${last3High.toFixed(4)}`); }
        if (momConfirm) { confirmations++; reasons.push('Bullish momentum'); }

        const requiredConfirmations = regime === 'CHOPPY' ? 2 : 1;
        if (confirmations >= requiredConfirmations) {
            return {
                signal: 'BUY',
                score: 3 + confirmations,
                reason: `3-Layer LONG Entry Confluence (${confirmations}/${requiredConfirmations}): ${reasons.join(', ')}`,
                atr: currentATR
            };
        }

        return { signal: 'NO TRADE', score: 0, failedReason: 'No entry confirmation', atr: currentATR };
    }

    if (bias === 'SHORT') {
        // 1. Pullback trigger: price >= EMA21 OR in VWAP zone
        const inPullback = (currentPrice >= currentEMA21) || inVwapZone;
        if (!inPullback) {
            return { signal: 'NO TRADE', score: 0, failedReason: 'Not in pullback zone', atr: currentATR, meta: { price: currentPrice, ema21: currentEMA21, vwap } };
        }

        // 2. Confirmations (ONE required):
        // a. RSI < 55 and falling
        const rsiConfirm = currentRSI < 55 && currentRSI < prevRSI;
        // b. Bearish candle break of last 3 candles
        const last3Low = Math.min(lows[lows.length - 2], lows[lows.length - 3], lows[lows.length - 4]);
        const breakConfirm = currentPrice < last3Low;
        // c. Momentum candle > 0.2%
        const momConfirm = (currentPrice < currentOpen) && ((currentOpen - currentPrice) / currentOpen > 0.002);

        if (rsiConfirm || breakConfirm || momConfirm) {
            const reasons = [];
            if (rsiConfirm) reasons.push(`RSI ${currentRSI.toFixed(1)} falling`);
            if (breakConfirm) reasons.push(`Breakdown ${last3Low.toFixed(4)}`);
            if (momConfirm) reasons.push('Bearish momentum');

            // Log SHORT setups in spot evaluations as rejected setup
            return {
                signal: 'NO TRADE',
                score: 0,
                failedReason: 'SHORT setup (Spot skipped)',
                atr: currentATR,
                meta: {
                    bias: 'SHORT',
                    reason: `3-Layer SHORT Entry Confluence: ${reasons.join(', ')}`
                }
            };
        }

        return { signal: 'NO TRADE', score: 0, failedReason: 'No entry confirmation', atr: currentATR };
    }

    return { signal: 'NO TRADE', score: 0, failedReason: 'Unknown bias state', atr: currentATR };
}

function checkEmergencyExitV2(historicalData, entryPrice, currentATR) {
    // Disabled: The user requested a strict ATR-based SL/TP and trailing system.
    // The previous emergency exit logic was causing premature exits on pullbacks.
    return false;
}

module.exports = { evaluateTradeV2, checkEmergencyExitV2 };
