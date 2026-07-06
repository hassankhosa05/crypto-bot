const axios = require('axios');
const { EMA, ADX, RSI, ATR } = require('technicalindicators');

async function getKlines(symbol, interval, limit) {
    const response = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    return response.data.map(d => ({
        timestamp: d[0],
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4]),
        volume: parseFloat(d[5])
    }));
}

function calculateVWAP(klines) {
    let typicalPriceVol = 0;
    let totalVol = 0;
    for (let k of klines) {
        let tp = (k.high + k.low + k.close) / 3;
        typicalPriceVol += tp * k.volume;
        totalVol += k.volume;
    }
    return totalVol === 0 ? klines[klines.length-1].close : typicalPriceVol / totalVol;
}

async function evaluateTrade(symbol, marketRegime, fundingRate) {
    try {
        // Fetch 1H and 15m data
        const [klines1H, klines15m] = await Promise.all([
            getKlines(symbol, '1h', 100),
            getKlines(symbol, '15m', 100)
        ]);

        if (klines1H.length < 50 || klines15m.length < 50) return { signal: 'NONE', reason: 'Not enough data' };

        // 1H Indicators
        const closes1H = klines1H.map(k => k.close);
        const highs1H = klines1H.map(k => k.high);
        const lows1H = klines1H.map(k => k.low);
        
        const ema20_1H = EMA.calculate({ period: 20, values: closes1H });
        const ema50_1H = EMA.calculate({ period: 50, values: closes1H });
        const adx_1H = ADX.calculate({ high: highs1H, low: lows1H, close: closes1H, period: 14 });
        
        const curEma20_1H = ema20_1H[ema20_1H.length - 1];
        const curEma50_1H = ema50_1H[ema50_1H.length - 1];
        const curAdx_1H = adx_1H[adx_1H.length - 1]?.adx || 0;
        const curPrice_1H = closes1H[closes1H.length - 1];

        // 15m Indicators
        const closes15m = klines15m.map(k => k.close);
        const highs15m = klines15m.map(k => k.high);
        const lows15m = klines15m.map(k => k.low);
        const opens15m = klines15m.map(k => k.open);
        
        const ema21_15m = EMA.calculate({ period: 21, values: closes15m });
        const ema9_15m = EMA.calculate({ period: 9, values: closes15m });
        const rsi_15m = RSI.calculate({ period: 14, values: closes15m });
        const atr_15m = ATR.calculate({ high: highs15m, low: lows15m, close: closes15m, period: 14 });
        
        const curEma21_15m = ema21_15m[ema21_15m.length - 1];
        const curEma9_15m = ema9_15m[ema9_15m.length - 1];
        const curRsi_15m = rsi_15m[rsi_15m.length - 1];
        const prevRsi_15m = rsi_15m[rsi_15m.length - 2];
        const curAtr_15m = atr_15m[atr_15m.length - 1];
        
        const last15m = klines15m[klines15m.length - 1];
        const vwap = calculateVWAP(klines15m.slice(-Math.min(96, klines15m.length))); // Rough daily VWAP (96 15m candles)

        const volumes15m = klines15m.map(k => k.volume);
        const avgVol = volumes15m.reduce((a,b) => a+b, 0) / volumes15m.length;
        const curVol = volumes15m[volumes15m.length-1];
        const rvol = avgVol > 0 ? (curVol / avgVol) : 0;

        // 1H Trend Filter
        let trend = 'NONE';
        if (curEma20_1H > curEma50_1H && curPrice_1H > curEma20_1H && curAdx_1H > 18) {
            trend = 'BULLISH';
        } else if (curEma20_1H < curEma50_1H && curPrice_1H < curEma20_1H && curAdx_1H > 18) {
            trend = 'BEARISH';
        }

        if (trend === 'NONE') return { signal: 'NONE', reason: 'Fails 1H Trend Filter' };
        if (marketRegime === 'BULLISH' && trend === 'BEARISH') return { signal: 'NONE', reason: 'Conflicts with Global BTC Bullish Regime' };
        if (marketRegime === 'BEARISH' && trend === 'BULLISH') return { signal: 'NONE', reason: 'Conflicts with Global BTC Bearish Regime' };
        
        if (marketRegime === 'SIDEWAYS') {
            if (curAdx_1H < 25) return { signal: 'NONE', reason: 'Sideways Regime: Coin ADX < 25' };
            if (rvol < 1.3) return { signal: 'NONE', reason: `Sideways Regime: RVOL too low (${rvol.toFixed(2)})` };
        }

        // Funding checks
        if (trend === 'BULLISH' && fundingRate > 0.001) return { signal: 'NONE', reason: 'Funding too positive for LONG' };
        if (trend === 'BEARISH' && fundingRate < -0.001) return { signal: 'NONE', reason: 'Funding too negative for SHORT' };

        // Pullback Filter
        const margin = curAtr_15m * 0.2;
        const nearEma21 = Math.abs(last15m.low - curEma21_15m) <= margin || Math.abs(last15m.high - curEma21_15m) <= margin || (last15m.low <= curEma21_15m && last15m.high >= curEma21_15m);
        const nearVwap = Math.abs(last15m.low - vwap) <= margin || Math.abs(last15m.high - vwap) <= margin || (last15m.low <= vwap && last15m.high >= vwap);
        
        if (!nearEma21 && !nearVwap) {
            return { signal: 'NONE', reason: 'No Pullback to EMA21 or VWAP' };
        }

        // Confirmation Filter
        // Break previous 3-candle high/low
        const highestOf3 = Math.max(...highs15m.slice(-4, -1));
        const lowestOf3 = Math.min(...lows15m.slice(-4, -1));
        
        const breakHigh = last15m.close > highestOf3;
        const breakLow = last15m.close < lowestOf3;
        
        // Strong candle (> 0.2% body)
        const bodyPct = Math.abs(last15m.close - last15m.open) / last15m.open * 100;
        const strongBullish = last15m.close > last15m.open && bodyPct > 0.2;
        const strongBearish = last15m.close < last15m.open && bodyPct > 0.2;

        let confirmations = 0;
        if (trend === 'BULLISH') {
            if (curRsi_15m > 45 && curRsi_15m > prevRsi_15m) confirmations++;
            if (breakHigh) confirmations++;
            if (strongBullish) confirmations++;
        } else if (trend === 'BEARISH') {
            if (curRsi_15m < 55 && curRsi_15m < prevRsi_15m) confirmations++;
            if (breakLow) confirmations++;
            if (strongBearish) confirmations++;
        }

        const reqConfirmations = marketRegime === 'SIDEWAYS' ? 2 : 1;
        if (confirmations < reqConfirmations) {
            return { signal: 'NONE', reason: `Need ${reqConfirmations} confirmations, got ${confirmations}` };
        }
        
        // Final calculation
        const stopDistance = 1.2 * curAtr_15m;
        
        // Calculate confluence score for correlation ranking
        let confluenceScore = curAdx_1H; // Base score on ADX
        if (breakHigh || breakLow) confluenceScore += 5;
        if (strongBullish || strongBearish) confluenceScore += 5;

        return {
            signal: trend === 'BULLISH' ? 'LONG' : 'SHORT',
            reason: `Trend: ${trend}, Confirmed by Pullback & Momentum`,
            price: last15m.close,
            stopLoss: trend === 'BULLISH' ? last15m.close - stopDistance : last15m.close + stopDistance,
            tp1: trend === 'BULLISH' ? last15m.close + stopDistance : last15m.close - stopDistance,
            tp2: trend === 'BULLISH' ? last15m.close + (2 * stopDistance) : last15m.close - (2 * stopDistance),
            atr: curAtr_15m,
            adx: curAdx_1H,
            score: confluenceScore
        };

    } catch (e) {
        console.error("Strategy error:", e.message);
        return { signal: 'NONE', reason: 'Strategy error' };
    }
}

async function checkExitCriteria(symbol, direction) {
    try {
        const klines15m = await getKlines(symbol, '15m', 50);
        if (klines15m.length < 30) return false;

        const closes = klines15m.map(k => k.close);
        const ema9 = EMA.calculate({ period: 9, values: closes });
        const ema21 = EMA.calculate({ period: 21, values: closes });
        
        const curEma9 = ema9[ema9.length - 1];
        const curEma21 = ema21[ema21.length - 1];
        
        // Simple MACD approximation for exit (EMA12 vs EMA26)
        const ema12 = EMA.calculate({ period: 12, values: closes });
        const ema26 = EMA.calculate({ period: 26, values: closes });
        const curMacd = ema12[ema12.length-1] - ema26[ema26.length-1];

        if (direction === 'LONG') {
            if (curEma9 < curEma21 && curMacd < 0) return { exit: true, reason: 'EMA9 cross down + MACD bearish' };
        } else {
            if (curEma9 > curEma21 && curMacd > 0) return { exit: true, reason: 'EMA9 cross up + MACD bullish' };
        }

        return { exit: false };
    } catch (e) {
        return { exit: false };
    }
}

module.exports = { evaluateTrade, checkExitCriteria };
