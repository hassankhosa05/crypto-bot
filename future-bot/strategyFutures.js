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
        timestamp: new Date().toISOString(),
        symbol: symbol,
        globalRegime: marketRegime,
        direction: 'NONE',
        ema20_1H: null,
        ema50_1H: null,
        adx_1H: null,
        btc15mEma50Relationship: 'UNKNOWN',
        pullbackStatus: false,
        rvol: null,
        rsi_15m: null,
        atr_15m: null,
        gate1_pass: false,
        gate2_pass: false,
        gate3_pass: false,
        gate4_pass: false,
        gate5_pass: false,
        gate6_pass: false,
        finalDecision: 'REJECTED',
        primaryRejectionGate: null,
        failedReason: ''
    };

    try {
        const isMildChoppy = marketRegime === 'MILD_CHOPPY_BULL' || marketRegime === 'MILD_CHOPPY_BEAR';

        // ── Gate 0: Global Regime Check ─────────────────────────────────
        if (marketRegime === 'CHOPPY') {
            diag.primaryRejectionGate = 'Gate 0 (Global Regime)';
            diag.failedReason = '4H Regime is CHOPPY — no trend trades';
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }

        const [klines15m, btcKlines15m] = await Promise.all([
            fetchKlines(symbol, '15m', 100),
            symbol === 'BTCUSDT' ? null : fetchKlines('BTCUSDT', '15m', 100)
        ]);

        if (klines15m.length < 50) {
            diag.primaryRejectionGate = 'Data Length';
            diag.failedReason = 'Insufficient 15m candle history';
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }

        // ── 1H Resampled Indicators ─────────────────────────────────────
        const candles1H = get1HCandles(klines15m);
        if (candles1H.length < 20) {
            diag.primaryRejectionGate = 'Data Length (1H)';
            diag.failedReason = 'Insufficient 1H candle history';
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }

        const closes1H = candles1H.map(c => c.close);
        const highs1H  = candles1H.map(c => c.high);
        const lows1H   = candles1H.map(c => c.low);

        const ema20_1H = EMA.calculate({ period: 20, values: closes1H });
        const ema50_1H = EMA.calculate({ period: 50, values: closes1H });
        const adx_1H   = ADX.calculate({ high: highs1H, low: lows1H, close: closes1H, period: 14 });

        const curEma20_1H = ema20_1H[ema20_1H.length - 1];
        const curEma50_1H = ema50_1H[ema50_1H.length - 1];
        const curAdx_1H   = adx_1H[adx_1H.length - 1]?.adx || 0;
        const curPrice_1H = closes1H[closes1H.length - 1];

        diag.ema20_1H = curEma20_1H ? parseFloat(curEma20_1H.toFixed(4)) : null;
        diag.ema50_1H = curEma50_1H ? parseFloat(curEma50_1H.toFixed(4)) : null;
        diag.adx_1H   = parseFloat(curAdx_1H.toFixed(2));

        // ── Gate 1: Coin 1H Trend Alignment + ADX ────────────────────────
        let coinTrend = 'NONE';
        if (curEma20_1H > curEma50_1H && curPrice_1H > curEma20_1H) coinTrend = 'BULLISH';
        else if (curEma20_1H < curEma50_1H && curPrice_1H < curEma20_1H) coinTrend = 'BEARISH';

        diag.direction = coinTrend === 'BULLISH' ? 'LONG' : (coinTrend === 'BEARISH' ? 'SHORT' : 'NONE');

        if (coinTrend === 'NONE') {
            diag.primaryRejectionGate = 'Gate 1 (1H Trend Alignment)';
            diag.failedReason = 'Coin 1H: No clear EMA trend alignment';
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }

        const requiredCoinAdx = isMildChoppy ? 30 : 25;
        if (curAdx_1H < requiredCoinAdx) {
            diag.primaryRejectionGate = 'Gate 1 (1H ADX)';
            diag.failedReason = `Coin 1H ADX too weak (${curAdx_1H.toFixed(1)} < ${requiredCoinAdx})`;
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

        // ── Gate 2: 1H Violent Dump / Pump Protection ────────────────────
        const currentCandle1H = candles1H[candles1H.length - 1];
        if (currentCandle1H) {
            const body1H = Math.abs(currentCandle1H.close - currentCandle1H.open);
            const bodyPct1H = (body1H / currentCandle1H.open) * 100;
            const is1HDump = currentCandle1H.close < currentCandle1H.open && bodyPct1H > 1.2;
            const is1HPump = currentCandle1H.close > currentCandle1H.open && bodyPct1H > 1.2;

            if (coinTrend === 'BULLISH' && is1HDump) {
                diag.primaryRejectionGate = 'Gate 2 (1H Dump Protection)';
                diag.failedReason = `Coin 1H is in a heavy dump (-${bodyPct1H.toFixed(2)}%) — blocking dead-cat bounce buy`;
                return { signal: 'NONE', reason: diag.failedReason, diag };
            }
            if (coinTrend === 'BEARISH' && is1HPump) {
                diag.primaryRejectionGate = 'Gate 2 (1H Pump Protection)';
                diag.failedReason = `Coin 1H is in a heavy pump (+${bodyPct1H.toFixed(2)}%) — blocking shorting into squeeze`;
                return { signal: 'NONE', reason: diag.failedReason, diag };
            }
        }
        diag.gate2_pass = true;

        // ── Gate 3: BTC Short-Term (15m EMA50) Alignment ─────────────────
        const btcKlines = symbol === 'BTCUSDT' ? klines15m : btcKlines15m;
        if (btcKlines && btcKlines.length >= 55) {
            const btcCloses = btcKlines.map(k => k.close);
            const btcEma50 = EMA.calculate({ period: 50, values: btcCloses });
            const curBtcEma50 = btcEma50[btcEma50.length - 1];
            const curBtcPrice = btcCloses[btcCloses.length - 1];

            if (curBtcEma50) {
                diag.btc15mEma50Relationship = curBtcPrice >= curBtcEma50 ? 'ABOVE_EMA50' : 'BELOW_EMA50';
                if (coinTrend === 'BULLISH' && curBtcPrice < curBtcEma50) {
                    diag.primaryRejectionGate = 'Gate 3 (BTC 15m Alignment)';
                    diag.failedReason = `BTC 15m trend is bearish (${curBtcPrice} < EMA50 ${curBtcEma50.toFixed(2)})`;
                    return { signal: 'NONE', reason: diag.failedReason, diag };
                }
                if (coinTrend === 'BEARISH' && curBtcPrice > curBtcEma50) {
                    diag.primaryRejectionGate = 'Gate 3 (BTC 15m Alignment)';
                    diag.failedReason = `BTC 15m trend is bullish (${curBtcPrice} > EMA50 ${curBtcEma50.toFixed(2)})`;
                    return { signal: 'NONE', reason: diag.failedReason, diag };
                }
            }
        }
        diag.gate3_pass = true;

        // ── 15m Tactical Entry Indicators ───────────────────────────────
        const closes15m = klines15m.map(k => k.close);
        const highs15m  = klines15m.map(k => k.high);
        const lows15m   = klines15m.map(k => k.low);
        const opens15m  = klines15m.map(k => k.open);

        const ema21_15m = EMA.calculate({ period: 21, values: closes15m });
        const rsi_15m   = RSI.calculate({ period: 14, values: closes15m });
        const atr_15m   = ATR.calculate({ high: highs15m, low: lows15m, close: closes15m, period: 14 });

        const curEma21_15m = ema21_15m[ema21_15m.length - 1];
        const curRsi_15m   = rsi_15m[rsi_15m.length - 1] || 50;
        const prevRsi_15m  = rsi_15m[rsi_15m.length - 2] || 50;
        const curAtr_15m   = atr_15m[atr_15m.length - 1] || 0;

        const last15m = klines15m[klines15m.length - 1];
        const vwap = calculateVWAP(klines15m.slice(-Math.min(96, klines15m.length)));

        diag.rsi_15m = parseFloat(curRsi_15m.toFixed(2));
        diag.atr_15m = parseFloat(curAtr_15m.toFixed(4));

        // ── Gate 4: 15m Pullback Location (EMA21 or VWAP) ────────────────
        const margin = curAtr_15m * 0.2;
        const nearEma21 = Math.abs(last15m.low - curEma21_15m) <= margin ||
                          Math.abs(last15m.high - curEma21_15m) <= margin ||
                          (last15m.low <= curEma21_15m && last15m.high >= curEma21_15m);
        const nearVwap  = Math.abs(last15m.low - vwap) <= margin ||
                          Math.abs(last15m.high - vwap) <= margin ||
                          (last15m.low <= vwap && last15m.high >= vwap);

        diag.pullbackStatus = nearEma21 || nearVwap;
        if (!nearEma21 && !nearVwap) {
            diag.primaryRejectionGate = 'Gate 4 (Pullback Location)';
            diag.failedReason = 'No Pullback to EMA21 or VWAP';
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        diag.gate4_pass = true;

        // ── Gate 5: RVOL > 1.3 on 15m ───────────────────────────────────
        const volumes15m = klines15m.map(k => k.volume);
        const prev20Vol  = volumes15m.slice(-22, -2);
        const avgVol     = prev20Vol.length > 0 ? prev20Vol.reduce((a, b) => a + b, 0) / prev20Vol.length : 1;
        const completedVol = volumes15m[volumes15m.length - 2] || volumes15m[volumes15m.length - 1];
        const rvol       = avgVol > 0 ? completedVol / avgVol : 0;
        diag.rvol        = parseFloat(rvol.toFixed(2));

        const requiredRvol = isMildChoppy ? 1.5 : 1.3;
        if (rvol < requiredRvol) {
            diag.primaryRejectionGate = 'Gate 5 (RVOL)';
            diag.failedReason = `RVOL too low (${rvol.toFixed(2)} < ${requiredRvol})`;
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        diag.gate5_pass = true;

        // Funding rate sanity check
        if (coinTrend === 'BULLISH' && fundingRate > 0.001) {
            diag.primaryRejectionGate = 'Gate 5.1 (Funding)';
            diag.failedReason = 'Funding too positive for LONG';
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        if (coinTrend === 'BEARISH' && fundingRate < -0.001) {
            diag.primaryRejectionGate = 'Gate 5.1 (Funding)';
            diag.failedReason = 'Funding too negative for SHORT';
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }

        // ── Gate 6: Directional RSI & Momentum Confirmation ───────────────
        const highestOf3 = Math.max(...highs15m.slice(-4, -1));
        const lowestOf3  = Math.min(...lows15m.slice(-4, -1));

        const breakHigh   = last15m.close > highestOf3;
        const breakLow    = last15m.close < lowestOf3;
        const bodyPct     = Math.abs(last15m.close - last15m.open) / last15m.open * 100;
        const strongBull  = last15m.close > last15m.open && bodyPct > 0.2;
        const strongBear  = last15m.close < last15m.open && bodyPct > 0.2;

        let confirmations = 0;
        if (coinTrend === 'BULLISH') {
            if (curRsi_15m > 45 && curRsi_15m > prevRsi_15m) confirmations++;
            if (breakHigh) confirmations++;
            if (strongBull) confirmations++;
        } else {
            if (curRsi_15m < 55 && curRsi_15m < prevRsi_15m) confirmations++;
            if (breakLow) confirmations++;
            if (strongBear) confirmations++;
        }

        const requiredConfirmations = isMildChoppy ? 3 : 2;
        if (confirmations < requiredConfirmations) {
            diag.primaryRejectionGate = 'Gate 6 (Momentum Confirmation)';
            diag.failedReason = `Need ≥${requiredConfirmations} confirmations, got ${confirmations}`;
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }

        // Overbought / Oversold Exhaustion Guards
        if (coinTrend === 'BULLISH' && curRsi_15m > 68) {
            diag.primaryRejectionGate = 'Gate 6 (RSI Overbought)';
            diag.failedReason = `15m RSI is overbought (${curRsi_15m.toFixed(1)} > 68) — skipping exhaustion top`;
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        if (coinTrend === 'BEARISH' && curRsi_15m < 32) {
            diag.primaryRejectionGate = 'Gate 6 (RSI Oversold)';
            diag.failedReason = `15m RSI is oversold (${curRsi_15m.toFixed(1)} < 32) — skipping deep oversold bottom`;
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        diag.gate6_pass = true;

        // ── All 6 Gates Passed ──────────────────────────────────────────
        diag.finalDecision = 'ACCEPTED';
        const slDistance = 1.5 * curAtr_15m;

        let score = curAdx_1H;
        if (breakHigh || breakLow) score += 5;
        if (strongBull || strongBear) score += 5;

        return {
            signal:   coinTrend === 'BULLISH' ? 'LONG' : 'SHORT',
            reason:   `Trend: ${coinTrend}, Confirmed by Pullback & Momentum`,
            price:    last15m.close,
            stopLoss: coinTrend === 'BULLISH'
                        ? last15m.close - slDistance
                        : last15m.close + slDistance,
            atr:      curAtr_15m,
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
