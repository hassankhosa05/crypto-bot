const axios = require('axios');
const { EMA, RSI, ATR, ADX } = require('technicalindicators');

function calculateVWAP(data) {
    let cumulativePV = 0;
    let cumulativeVolume = 0;
    for (const candle of data) {
        const typicalPrice = (candle.high + candle.low + candle.close) / 3;
        cumulativePV += typicalPrice * candle.volume;
        cumulativeVolume += candle.volume;
    }
    return cumulativeVolume ? cumulativePV / cumulativeVolume : null;
}

async function fetchKlines(symbol, interval, limit = 400) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await axios.get(url);
    return res.data.map(d => ({
        timestamp: d[0],
        open:      parseFloat(d[1]),
        high:      parseFloat(d[2]),
        low:       parseFloat(d[3]),
        close:     parseFloat(d[4]),
        volume:    parseFloat(d[5])
    }));
}

async function evaluateTrade(symbol, marketRegime, fundingRate) {
    const diag = {
        timestamp:             new Date().toISOString(),
        symbol:                symbol,
        globalRegime:          marketRegime,
        direction:             'NONE',
        ema20_1H:              null,
        ema50_1H:              null,
        adx_1H:                null,
        atr_1H:                null,
        coin4hTrend:           'UNKNOWN',
        pullbackStatus:        false,
        rvol:                  null,
        rsi_15m:               null,
        atr_15m:               null,
        gate1_pass:            false,
        gate2_pass:            false,
        gate3_pass:            false,
        gate4_pass:            false,
        gate5_pass:            false,
        finalDecision:         'REJECTED',
        primaryRejectionGate:  null,
        failedReason:          ''
    };

    try {
        const isMildChoppy = marketRegime === 'MILD_CHOPPY_BULL' || marketRegime === 'MILD_CHOPPY_BEAR';

        // ── Gate 0: Global Regime ─────────────────────────────────────────────
        // Only trade in strictly BULLISH conditions (BTC 4H ADX > 25, EMA20 > EMA50).
        // This keeps the trade history clean so we can measure bull performance accurately
        // before adding strategies for other conditions later.
        if (marketRegime !== 'BULLISH') {
            diag.primaryRejectionGate = 'Gate 0 (Global Regime)';
            diag.failedReason = `Regime is ${marketRegime} — only trading in BULLISH conditions for now`;
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }

        // ── Fetch all timeframes in parallel ─────────────────────────────────
        const [klines15m, klines1H, klines4H] = await Promise.all([
            fetchKlines(symbol, '15m', 100),
            fetchKlines(symbol, '1h',  100),
            fetchKlines(symbol, '4h',  60)
        ]);

        if (klines15m.length < 50 || klines1H.length < 50) {
            diag.primaryRejectionGate = 'Data Length';
            diag.failedReason = 'Insufficient candle history';
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }

        // ── 1H Indicators ─────────────────────────────────────────────────────
        const closes1H = klines1H.map(c => c.close);
        const highs1H  = klines1H.map(c => c.high);
        const lows1H   = klines1H.map(c => c.low);

        const ema20_1H_arr = EMA.calculate({ period: 20, values: closes1H });
        const ema50_1H_arr = EMA.calculate({ period: 50, values: closes1H });
        const adx_1H_arr   = ADX.calculate({ high: highs1H, low: lows1H, close: closes1H, period: 14 });
        const atr_1H_arr   = ATR.calculate({ high: highs1H, low: lows1H, close: closes1H, period: 14 });

        const curEma20_1H = ema20_1H_arr[ema20_1H_arr.length - 1];
        const curEma50_1H = ema50_1H_arr[ema50_1H_arr.length - 1];
        const curAdx_1H   = adx_1H_arr[adx_1H_arr.length - 1]?.adx || 0;
        const curPrice_1H = closes1H[closes1H.length - 1];
        const curAtr_1H   = atr_1H_arr[atr_1H_arr.length - 1] || 0;

        diag.ema20_1H = curEma20_1H ? parseFloat(curEma20_1H.toFixed(4)) : null;
        diag.ema50_1H = curEma50_1H ? parseFloat(curEma50_1H.toFixed(4)) : null;
        diag.adx_1H   = parseFloat(curAdx_1H.toFixed(2));
        diag.atr_1H   = parseFloat(curAtr_1H.toFixed(4));

        // ── Gate 1: Coin 1H Trend Alignment + ADX ─────────────────────────────
        let coinTrend = 'NONE';
        if (curEma20_1H > curEma50_1H && curPrice_1H > curEma20_1H) coinTrend = 'BULLISH';
        else if (curEma20_1H < curEma50_1H && curPrice_1H < curEma20_1H) coinTrend = 'BEARISH';

        diag.direction = coinTrend === 'BULLISH' ? 'LONG' : (coinTrend === 'BEARISH' ? 'SHORT' : 'NONE');

        if (coinTrend === 'NONE') {
            diag.primaryRejectionGate = 'Gate 1 (1H Trend Alignment)';
            diag.failedReason = 'Coin 1H: No clear EMA trend alignment';
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }

        const requiredAdx = isMildChoppy ? 30 : 25;
        if (curAdx_1H < requiredAdx) {
            diag.primaryRejectionGate = 'Gate 1 (1H ADX)';
            diag.failedReason = `Coin 1H ADX too weak (${curAdx_1H.toFixed(1)} < ${requiredAdx})`;
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }

        const regimeWantsBull = marketRegime === 'BULLISH' || marketRegime === 'MILD_CHOPPY_BULL';
        const regimeWantsBear = marketRegime === 'BEARISH' || marketRegime === 'MILD_CHOPPY_BEAR';

        if (regimeWantsBull && coinTrend === 'BEARISH') {
            diag.primaryRejectionGate = 'Gate 1 (Regime Alignment)';
            diag.failedReason = 'Coin trend conflicts with global BULLISH bias';
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        if (regimeWantsBear && coinTrend === 'BULLISH') {
            diag.primaryRejectionGate = 'Gate 1 (Regime Alignment)';
            diag.failedReason = 'Coin trend conflicts with global BEARISH bias';
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        diag.gate1_pass = true;

        // ── Gate 2: Coin 4H Trend Confirmation ────────────────────────────────
        // Prevents entering a 1H bullish setup when the 4H is still bearish.
        // This stops "counter-trend trap" entries — the most common cause of losses.
        if (klines4H.length >= 55) {
            const closes4H    = klines4H.map(c => c.close);
            const ema20_4H    = EMA.calculate({ period: 20, values: closes4H });
            const ema50_4H    = EMA.calculate({ period: 50, values: closes4H });
            const curEma20_4H = ema20_4H[ema20_4H.length - 1];
            const curEma50_4H = ema50_4H[ema50_4H.length - 1];

            const coin4hTrend = curEma20_4H > curEma50_4H ? 'BULL' : 'BEAR';
            diag.coin4hTrend  = coin4hTrend;

            if (coinTrend === 'BULLISH' && coin4hTrend === 'BEAR') {
                diag.primaryRejectionGate = 'Gate 2 (Coin 4H Regime)';
                diag.failedReason = 'Coin 4H is BEARISH — 1H bullish signal is a counter-trend trap';
                return { signal: 'NONE', reason: diag.failedReason, diag };
            }
            if (coinTrend === 'BEARISH' && coin4hTrend === 'BULL') {
                diag.primaryRejectionGate = 'Gate 2 (Coin 4H Regime)';
                diag.failedReason = 'Coin 4H is BULLISH — 1H bearish signal is a counter-trend trap';
                return { signal: 'NONE', reason: diag.failedReason, diag };
            }
        }
        diag.gate2_pass = true;

        // ── 15m Tactical Entry Indicators ─────────────────────────────────────
        const closes15m = klines15m.map(k => k.close);
        const highs15m  = klines15m.map(k => k.high);
        const lows15m   = klines15m.map(k => k.low);

        const ema21_15m_arr = EMA.calculate({ period: 21, values: closes15m });
        const rsi_15m_arr   = RSI.calculate({ period: 14, values: closes15m });
        const atr_15m_arr   = ATR.calculate({ high: highs15m, low: lows15m, close: closes15m, period: 14 });

        const curEma21_15m = ema21_15m_arr[ema21_15m_arr.length - 1];
        const curRsi_15m   = rsi_15m_arr[rsi_15m_arr.length - 1] || 50;
        const curAtr_15m   = atr_15m_arr[atr_15m_arr.length - 1] || 0;
        const vwap         = calculateVWAP(klines15m.slice(-Math.min(96, klines15m.length)));

        diag.rsi_15m = parseFloat(curRsi_15m.toFixed(2));
        diag.atr_15m = parseFloat(curAtr_15m.toFixed(4));

        // ── Gate 3: Pullback Entry Timing ──────────────────────────────────────
        // FIX: We look at the PREVIOUS closed candle for the actual pullback touch,
        // then confirm the CURRENT forming candle is recovering back in trend direction.
        // Old approach: entered on the candle that touched EMA21, which is already done.
        // New approach: enter on the candle AFTER the touch, catching the actual reclaim.
        const prevCandle = klines15m[klines15m.length - 2]; // fully closed
        const currCandle = klines15m[klines15m.length - 1]; // currently forming
        const margin     = curAtr_15m * 0.3;

        // For LONGS: previous candle dipped to/through EMA21 or VWAP (the pullback)
        const prevTouchedEma  = prevCandle.low  <= curEma21_15m + margin;
        const prevTouchedVwap = prevCandle.low  <= vwap + margin;
        // For SHORTS: previous candle bounced up to EMA21 or VWAP (the bounce)
        const prevBounceEma   = prevCandle.high >= curEma21_15m - margin;
        const prevBounceVwap  = prevCandle.high >= vwap - margin;

        // Current candle is recovering back into trend direction
        const currentRecoveringLong  = currCandle.close > curEma21_15m || currCandle.close > vwap;
        const currentRecoveringShort = currCandle.close < curEma21_15m || currCandle.close < vwap;

        let validPullback = false;
        if (coinTrend === 'BULLISH') {
            validPullback = (prevTouchedEma || prevTouchedVwap) && currentRecoveringLong;
        } else {
            validPullback = (prevBounceEma || prevBounceVwap) && currentRecoveringShort;
        }

        diag.pullbackStatus = validPullback;
        if (!validPullback) {
            diag.primaryRejectionGate = 'Gate 3 (Pullback Timing)';
            diag.failedReason = 'No confirmed pullback to EMA21/VWAP with current candle reclaiming';
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        diag.gate3_pass = true;

        // ── Gate 4: Funding Rate Sanity & RVOL ────────────────────────────────
        const volumes15m   = klines15m.map(k => k.volume);
        const prev20Vol    = volumes15m.slice(-22, -2);
        const avgVol       = prev20Vol.length > 0 ? prev20Vol.reduce((a, b) => a + b, 0) / prev20Vol.length : 1;
        const completedVol = volumes15m[volumes15m.length - 2] || volumes15m[volumes15m.length - 1];
        const rvol         = avgVol > 0 ? completedVol / avgVol : 0;
        diag.rvol          = parseFloat(rvol.toFixed(2));

        if (coinTrend === 'BULLISH' && fundingRate > 0.001) {
            diag.primaryRejectionGate = 'Gate 4 (Funding)';
            diag.failedReason = 'Funding too positive for LONG — trade too crowded';
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        if (coinTrend === 'BEARISH' && fundingRate < -0.001) {
            diag.primaryRejectionGate = 'Gate 4 (Funding)';
            diag.failedReason = 'Funding too negative for SHORT — trade too crowded';
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        diag.gate4_pass = true;

        // ── Gate 5: RSI Momentum (loosened window: 40–72) ─────────────────────
        // Old window was 44–68 — too narrow. Strong trends frequently run RSI 68–72
        // and valid pullbacks often recover to RSI 40–44. Don't miss those.
        if (coinTrend === 'BULLISH' && curRsi_15m > 72) {
            diag.primaryRejectionGate = 'Gate 5 (RSI Overbought)';
            diag.failedReason = `15m RSI overbought (${curRsi_15m.toFixed(1)} > 72) — skipping exhaustion top`;
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        if (coinTrend === 'BEARISH' && curRsi_15m < 28) {
            diag.primaryRejectionGate = 'Gate 5 (RSI Oversold)';
            diag.failedReason = `15m RSI oversold (${curRsi_15m.toFixed(1)} < 28) — skipping deep oversold bottom`;
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        if (coinTrend === 'BULLISH' && curRsi_15m < 40) {
            diag.primaryRejectionGate = 'Gate 5 (RSI Momentum)';
            diag.failedReason = `15m RSI too weak for LONG (${curRsi_15m.toFixed(1)} < 40)`;
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        if (coinTrend === 'BEARISH' && curRsi_15m > 60) {
            diag.primaryRejectionGate = 'Gate 5 (RSI Momentum)';
            diag.failedReason = `15m RSI too high for SHORT (${curRsi_15m.toFixed(1)} > 60)`;
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        diag.gate5_pass = true;

        // ── All Gates Passed: Build Trade Signal ──────────────────────────────
        diag.finalDecision = 'ACCEPTED';

        // FIX: Stop loss uses 1H ATR, not 15m ATR.
        // 15m ATR is ~3–5x smaller than 1H ATR. A single wick on 15m can be
        // larger than a full 1.5x 15m ATR stop, so you get stopped by noise.
        // 1H ATR reflects real market movement at the trend timeframe.
        const slDistance = 2.0 * curAtr_1H;

        // Score: ADX + RVOL + candle structure (for ranking multiple setups)
        let score = curAdx_1H;
        if (rvol >= 1.2) score += 10;
        const highestOf3 = Math.max(...highs15m.slice(-4, -1));
        const lowestOf3  = Math.min(...lows15m.slice(-4, -1));
        const breakHigh  = currCandle.close > highestOf3;
        const breakLow   = currCandle.close < lowestOf3;
        const bodyPct    = Math.abs(currCandle.close - currCandle.open) / currCandle.open * 100;
        const strongBull = currCandle.close > currCandle.open && bodyPct > 0.2;
        const strongBear = currCandle.close < currCandle.open && bodyPct > 0.2;
        if (breakHigh || breakLow) score += 5;
        if (strongBull || strongBear) score += 5;

        return {
            signal:   coinTrend === 'BULLISH' ? 'LONG' : 'SHORT',
            reason:   `Trend: ${coinTrend}, Pullback confirmed & reclaiming`,
            price:    currCandle.close,
            stopLoss: coinTrend === 'BULLISH'
                        ? currCandle.close - slDistance
                        : currCandle.close + slDistance,
            atr:      curAtr_1H,    // 1H ATR — used for trailing stop calculations
            atr15m:   curAtr_15m,   // 15m ATR — kept for reference/diagnostics only
            adx:      curAdx_1H,
            score:    score,
            diag:     diag
        };

    } catch (e) {
        console.error('Strategy error:', e.message);
        diag.primaryRejectionGate = 'Exception';
        diag.failedReason = `Strategy error: ${e.message}`;
        return { signal: 'NONE', reason: diag.failedReason, diag };
    }
}

async function checkExitCriteria(symbol, direction) {
    return { exit: false };
}

module.exports = { evaluateTrade, checkExitCriteria };
