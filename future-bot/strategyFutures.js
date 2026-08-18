const axios = require('axios');
const { EMA, ADX, RSI, ATR } = require('technicalindicators');

async function getKlines(symbol, interval, limit) {
    const response = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    return response.data.map(d => ({
        timestamp: d[0],
        open:   parseFloat(d[1]),
        high:   parseFloat(d[2]),
        low:    parseFloat(d[3]),
        close:  parseFloat(d[4]),
        volume: parseFloat(d[5])
    }));
}

function calculateVWAP(klines) {
    let typicalPriceVol = 0;
    let totalVol = 0;
    for (let k of klines) {
        const tp = (k.high + k.low + k.close) / 3;
        typicalPriceVol += tp * k.volume;
        totalVol += k.volume;
    }
    return totalVol === 0 ? klines[klines.length - 1].close : typicalPriceVol / totalVol;
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateTrade
//
// Global regime (4H BTC) is passed in. If CHOPPY → reject immediately.
//
// Tactical entry uses 1H coin trend (EMA20/50 alignment + ADX > 25 + RVOL > 1.3)
// and 15m pullback/momentum confirmation.
//
// Exit targets: initial SL only (no TP1/TP2). The ATR trailing stop and
// break-even logic live in paperFuturesTrader.js.
// ─────────────────────────────────────────────────────────────────────────────
async function evaluateTrade(symbol, marketRegime, fundingRate) {
    try {
        // ── Gate 1: Regime gate ──────────────────────────────────────────
        // CHOPPY = true ranging market, no new trades at all.
        // MILD_CHOPPY_BULL/BEAR = some structure, ultra-strict coin filters apply.
        if (marketRegime === 'CHOPPY') {
            return { signal: 'NONE', reason: '4H Regime is CHOPPY — no trend trades' };
        }

        const isMildChoppy = marketRegime === 'MILD_CHOPPY_BULL' || marketRegime === 'MILD_CHOPPY_BEAR';

        // ── Fetch 1H and 15m data (including BTC 15m for short-term correlation check) ──
        const [klines1H, klines15m, btcKlines15m] = await Promise.all([
            getKlines(symbol, '1h', 100),
            getKlines(symbol, '15m', 100),
            symbol === 'BTCUSDT' ? Promise.resolve([]) : getKlines('BTCUSDT', '15m', 50).catch(() => [])
        ]);

        if (klines1H.length < 55 || klines15m.length < 50) {
            return { signal: 'NONE', reason: 'Not enough data' };
        }

        // ── 1H Coin Trend Indicators ─────────────────────────────────────
        const closes1H = klines1H.map(k => k.close);
        const highs1H  = klines1H.map(k => k.high);
        const lows1H   = klines1H.map(k => k.low);

        const ema20_1H = EMA.calculate({ period: 20, values: closes1H });
        const ema50_1H = EMA.calculate({ period: 50, values: closes1H });
        const adx_1H   = ADX.calculate({ high: highs1H, low: lows1H, close: closes1H, period: 14 });

        const curEma20_1H = ema20_1H[ema20_1H.length - 1];
        const curEma50_1H = ema50_1H[ema50_1H.length - 1];
        const curAdx_1H   = adx_1H[adx_1H.length - 1]?.adx || 0;
        const curPrice_1H = closes1H[closes1H.length - 1];

        // ── Gate 2: Strict Coin Trend Filter ────────────────────────────
        // Coin EMA20/50 must align with the global regime.
        // Coin ADX must be > 25 (strong trending, not noisy chop).
        // RVOL check happens on 15m data below.
        let coinTrend = 'NONE';
        if (curEma20_1H > curEma50_1H && curPrice_1H > curEma20_1H) coinTrend = 'BULLISH';
        else if (curEma20_1H < curEma50_1H && curPrice_1H < curEma20_1H) coinTrend = 'BEARISH';

        if (coinTrend === 'NONE') {
            return { signal: 'NONE', reason: 'Coin 1H: No clear EMA trend alignment' };
        }
        // ADX filter: stricter during MILD_CHOPPY (require 30), standard requires 25
        const requiredCoinAdx = isMildChoppy ? 30 : 25;
        if (curAdx_1H < requiredCoinAdx) {
            return { signal: 'NONE', reason: `Coin 1H ADX too weak (${curAdx_1H.toFixed(1)} < ${requiredCoinAdx})` };
        }

        // Gate 2.1: 1H Violent Dump / Pump Guard (prevents buying relief wicks during dumps or shorting into squeezes)
        const currentCandle1H = candles1H[candles1H.length - 1];
        if (currentCandle1H) {
            const body1H = Math.abs(currentCandle1H.close - currentCandle1H.open);
            const bodyPct1H = (body1H / currentCandle1H.open) * 100;
            const is1HDump = currentCandle1H.close < currentCandle1H.open && bodyPct1H > 1.2;
            const is1HPump = currentCandle1H.close > currentCandle1H.open && bodyPct1H > 1.2;

            if (coinTrend === 'BULLISH' && is1HDump) {
                return { signal: 'NONE', reason: `Coin 1H is in a heavy dump (-${bodyPct1H.toFixed(2)}%) — blocking dead-cat bounce buy` };
            }
            if (coinTrend === 'BEARISH' && is1HPump) {
                return { signal: 'NONE', reason: `Coin 1H is in a heavy pump (+${bodyPct1H.toFixed(2)}%) — blocking shorting into squeeze` };
            }
        }
        // Regime direction matching (covers BULLISH, BEARISH, and MILD_CHOPPY variants)
        const regimeWantsBull = marketRegime === 'BULLISH' || marketRegime === 'MILD_CHOPPY_BULL';
        const regimeWantsBear = marketRegime === 'BEARISH' || marketRegime === 'MILD_CHOPPY_BEAR';

        if (regimeWantsBull && coinTrend === 'BEARISH') {
            return { signal: 'NONE', reason: 'Coin trend conflicts with global BULLISH bias' };
        }
        if (regimeWantsBear && coinTrend === 'BULLISH') {
            return { signal: 'NONE', reason: 'Coin trend conflicts with global BEARISH bias' };
        }

        // ── Gate 2.5: BTC Short-Term (15m) Filter ───────────────────────
        const btcKlines = symbol === 'BTCUSDT' ? klines15m : btcKlines15m;
        if (btcKlines && btcKlines.length >= 25) {
            const btcCloses = btcKlines.map(k => k.close);
            const btcEma50 = EMA.calculate({ period: 50, values: btcCloses });
            const curBtcEma50 = btcEma50[btcEma50.length - 1];
            const curBtcPrice = btcCloses[btcCloses.length - 1];

            if (curBtcEma50) {
                if (coinTrend === "BULLISH" && curBtcPrice < curBtcEma50) {
                    return { signal: "NONE", reason: "BTC 15m trend is bearish (Price < EMA50)" };
                }
                if (coinTrend === "BEARISH" && curBtcPrice > curBtcEma50) {
                    return { signal: "NONE", reason: "BTC 15m trend is bullish (Price > EMA50)" };
                }
            }
        }

        // ── 15m Tactical Entry Indicators ───────────────────────────────
        const closes15m = klines15m.map(k => k.close);
        const highs15m  = klines15m.map(k => k.high);
        const lows15m   = klines15m.map(k => k.low);
        const opens15m  = klines15m.map(k => k.open);

        const ema21_15m = EMA.calculate({ period: 21, values: closes15m });
        const ema9_15m  = EMA.calculate({ period: 9,  values: closes15m });
        const rsi_15m   = RSI.calculate({ period: 14, values: closes15m });
        const atr_15m   = ATR.calculate({ high: highs15m, low: lows15m, close: closes15m, period: 14 });

        const curEma21_15m = ema21_15m[ema21_15m.length - 1];
        const curRsi_15m   = rsi_15m[rsi_15m.length - 1];
        const prevRsi_15m  = rsi_15m[rsi_15m.length - 2];
        const curAtr_15m   = atr_15m[atr_15m.length - 1];

        const last15m = klines15m[klines15m.length - 1];
        const vwap = calculateVWAP(klines15m.slice(-Math.min(96, klines15m.length)));

        // ── Gate 3: RVOL > 1.3 on 15m ───────────────────────────────────
        const volumes15m = klines15m.map(k => k.volume);
        const prev20Vol  = volumes15m.slice(-22, -2);
        const avgVol     = prev20Vol.length > 0 ? prev20Vol.reduce((a, b) => a + b, 0) / prev20Vol.length : 1;
        const completedVol = volumes15m[volumes15m.length - 2] || volumes15m[volumes15m.length - 1];
        const rvol       = avgVol > 0 ? completedVol / avgVol : 0;

        // RVOL filter: stricter during MILD_CHOPPY (require 1.5), standard requires 1.3
        const requiredRvol = isMildChoppy ? 1.5 : 1.3;
        if (rvol < requiredRvol) {
            return { signal: 'NONE', reason: `RVOL too low (${rvol.toFixed(2)} < ${requiredRvol})` };
        }

        // ── Gate 4: Funding sanity check ─────────────────────────────────
        if (coinTrend === 'BULLISH' && fundingRate > 0.001) {
            return { signal: 'NONE', reason: 'Funding too positive for LONG' };
        }
        if (coinTrend === 'BEARISH' && fundingRate < -0.001) {
            return { signal: 'NONE', reason: 'Funding too negative for SHORT' };
        }

        // ── Gate 5: Pullback to EMA21 or VWAP ───────────────────────────
        const margin = curAtr_15m * 0.2;
        const nearEma21 = Math.abs(last15m.low - curEma21_15m) <= margin ||
                          Math.abs(last15m.high - curEma21_15m) <= margin ||
                          (last15m.low <= curEma21_15m && last15m.high >= curEma21_15m);
        const nearVwap  = Math.abs(last15m.low - vwap) <= margin ||
                          Math.abs(last15m.high - vwap) <= margin ||
                          (last15m.low <= vwap && last15m.high >= vwap);

        if (!nearEma21 && !nearVwap) {
            return { signal: 'NONE', reason: 'No Pullback to EMA21 or VWAP' };
        }

        // ── Gate 6: Momentum Confirmation ───────────────────────────────
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

        // MILD_CHOPPY requires all 3 confirmations (RSI + break + strong candle)
        const requiredConfirmations = isMildChoppy ? 3 : 2;
        if (confirmations < requiredConfirmations) {
            return { signal: 'NONE', reason: `Need ≥${requiredConfirmations} confirmations, got ${confirmations}` };
        }

        // ── Gate 6.5: RSI Overbought / Oversold Exhaustion Guards ─────────
        if (coinTrend === 'BULLISH' && curRsi_15m > 68) {
            return { signal: 'NONE', reason: `15m RSI is overbought (${curRsi_15m.toFixed(1)} > 68) — skipping exhaustion top` };
        }
        if (coinTrend === 'BEARISH' && curRsi_15m < 32) {
            return { signal: 'NONE', reason: `15m RSI is oversold (${curRsi_15m.toFixed(1)} < 32) — skipping deep oversold bottom` };
        }

        // ── SL only — no TP1/TP2 targets ────────────────────────────────
        // 1.5 * ATR provides adequate breathing room against normal 15m noise wicks
        const slDistance = 1.5 * curAtr_15m;

        // Score: used to rank multiple simultaneous setups
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
            atr:   curAtr_15m,
            adx:   curAdx_1H,
            score: score
        };

    } catch (e) {
        console.error('Strategy error:', e.message);
        return { signal: 'NONE', reason: 'Strategy error' };
    }
}

async function checkExitCriteria(symbol, direction) {
    // Exit management is handled entirely inside paperFuturesTrader.js
    return { exit: false };
}

module.exports = { evaluateTrade, checkExitCriteria };
