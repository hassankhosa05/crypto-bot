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
        coin4hAdx:             null,
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
        // ── Gate 0: Global Regime ─────────────────────────────────────────────
        // Only trade in strictly BULLISH conditions (BTC 4H ADX > 25, EMA20 > EMA50).
        // Keeps trade history clean — no noise from choppy or bearish periods.
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

        if (curAdx_1H < 25) {
            diag.primaryRejectionGate = 'Gate 1 (1H ADX)';
            diag.failedReason = `Coin 1H ADX too weak (${curAdx_1H.toFixed(1)} < 25)`;
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }

        // Since Gate 0 only allows BULLISH regime, we only take LONG signals.
        // Reject BEARISH coin trends — they conflict with the global bull regime.
        if (coinTrend === 'BEARISH') {
            diag.primaryRejectionGate = 'Gate 1 (Regime Alignment)';
            diag.failedReason = 'Coin trend is BEARISH — conflicts with global BULLISH regime';
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        diag.gate1_pass = true;

        // ── Gate 2: Coin 4H Trend Confirmation + ADX ──────────────────────────
        // FIX (from review): EMA20 > EMA50 alone is not sufficient — EMAs can be
        // tangled during sideways consolidation. Require 4H ADX > 20 to confirm
        // the 4H trend has real established momentum before taking 15m entries.
        if (klines4H.length >= 55) {
            const closes4H = klines4H.map(c => c.close);
            const highs4H  = klines4H.map(c => c.high);
            const lows4H   = klines4H.map(c => c.low);

            const ema20_4H_arr = EMA.calculate({ period: 20, values: closes4H });
            const ema50_4H_arr = EMA.calculate({ period: 50, values: closes4H });
            const adx_4H_arr   = ADX.calculate({ high: highs4H, low: lows4H, close: closes4H, period: 14 });

            const curEma20_4H = ema20_4H_arr[ema20_4H_arr.length - 1];
            const curEma50_4H = ema50_4H_arr[ema50_4H_arr.length - 1];
            const curAdx_4H   = adx_4H_arr[adx_4H_arr.length - 1]?.adx || 0;

            const coin4hTrend = curEma20_4H > curEma50_4H ? 'BULL' : 'BEAR';
            diag.coin4hTrend  = coin4hTrend;
            diag.coin4hAdx    = parseFloat(curAdx_4H.toFixed(2));

            if (coin4hTrend === 'BEAR') {
                diag.primaryRejectionGate = 'Gate 2 (Coin 4H Trend)';
                diag.failedReason = 'Coin 4H is BEARISH — 1H bullish signal is a counter-trend trap';
                return { signal: 'NONE', reason: diag.failedReason, diag };
            }

            if (curAdx_4H < 20) {
                diag.primaryRejectionGate = 'Gate 2 (Coin 4H ADX)';
                diag.failedReason = `Coin 4H ADX too weak (${curAdx_4H.toFixed(1)} < 20) — 4H trend has no real momentum yet`;
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

        const curEma21_15m  = ema21_15m_arr[ema21_15m_arr.length - 1];
        const prevEma21_15m = ema21_15m_arr[ema21_15m_arr.length - 2]; // FIX: EMA at time of prev candle
        const curRsi_15m    = rsi_15m_arr[rsi_15m_arr.length - 1] || 50;
        const curAtr_15m    = atr_15m_arr[atr_15m_arr.length - 1] || 0;
        const vwap          = calculateVWAP(klines15m.slice(-Math.min(96, klines15m.length)));

        diag.rsi_15m = parseFloat(curRsi_15m.toFixed(2));
        diag.atr_15m = parseFloat(curAtr_15m.toFixed(4));

        // ── Gate 3: Pullback Entry Timing ──────────────────────────────────────
        // We look at the PREVIOUS closed candle for the actual pullback touch,
        // then confirm the CURRENT forming candle is recovering back above.
        //
        // FIX 1 (from review): Compare prevCandle.low to prevEma21_15m (not curEma21_15m).
        //        The EMA was at a different level when that candle formed.
        //
        // FIX 2 (from review): Require the previous candle to have TOUCHED EMA21 but
        //        NOT CLOSED significantly below it. A candle closing 2% below EMA21
        //        is a breakdown, not a pullback — don't trade it.
        //
        // FIX 3 (from review): Require the current candle to be bullish (close > open)
        //        AND above EMA21. Prevents entering on a candle that looks like
        //        recovery mid-formation but keeps falling.
        const prevCandle = klines15m[klines15m.length - 2]; // fully closed
        const currCandle = klines15m[klines15m.length - 1]; // currently forming
        const margin     = curAtr_15m * 0.3;

        // Prev candle wicked to EMA21 (using the EMA level at that time)
        const prevTouchedEma  = prevCandle.low <= prevEma21_15m + margin;
        const prevTouchedVwap = prevCandle.low <= vwap + margin;

        // Prev candle didn't close significantly below EMA21 (breakdown protection)
        // Allows wicks through EMA21 but not a dump candle closing 0.5 ATR below
        const prevNotDumpedThroughEma  = prevCandle.close >= prevEma21_15m - (curAtr_15m * 0.5);
        const prevNotDumpedThroughVwap = prevCandle.close >= vwap - (curAtr_15m * 0.5);

        // Current candle is bullish AND price has reclaimed EMA21 — not just briefly touching
        const currentBullish   = currCandle.close > currCandle.open;
        const currentAboveEma  = currCandle.close > curEma21_15m;
        const currentAboveVwap = currCandle.close > vwap;
        const currentRecovering = currentBullish && (currentAboveEma || currentAboveVwap);

        const validEma  = prevTouchedEma  && prevNotDumpedThroughEma  && currentAboveEma;
        const validVwap = prevTouchedVwap && prevNotDumpedThroughVwap && currentAboveVwap;
        const validPullback = (validEma || validVwap) && currentBullish;

        diag.pullbackStatus = validPullback;
        if (!validPullback) {
            diag.primaryRejectionGate = 'Gate 3 (Pullback Timing)';
            diag.failedReason = 'No confirmed pullback to EMA21/VWAP with current candle reclaiming bullishly';
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

        if (fundingRate > 0.001) {
            diag.primaryRejectionGate = 'Gate 4 (Funding)';
            diag.failedReason = 'Funding too positive for LONG — trade too crowded';
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        diag.gate4_pass = true;

        // ── Gate 5: RSI Momentum (window: 40–72) ──────────────────────────────
        if (curRsi_15m > 72) {
            diag.primaryRejectionGate = 'Gate 5 (RSI Overbought)';
            diag.failedReason = `15m RSI overbought (${curRsi_15m.toFixed(1)} > 72) — skipping exhaustion top`;
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        if (curRsi_15m < 40) {
            diag.primaryRejectionGate = 'Gate 5 (RSI Momentum)';
            diag.failedReason = `15m RSI too weak (${curRsi_15m.toFixed(1)} < 40) — momentum not confirmed`;
            return { signal: 'NONE', reason: diag.failedReason, diag };
        }
        diag.gate5_pass = true;

        // ── All Gates Passed: Build Trade Signal ──────────────────────────────
        diag.finalDecision = 'ACCEPTED';

        // FIX (from review): Stop loss uses 15m ATR — NOT 1H ATR.
        // Using 1H ATR broke the R-multiple math in liveTrader.js.
        // +1.5R with a 1H ATR stop would require a massive swing-trade sized move
        // from a 15m entry — nearly impossible. Back to 15m ATR, but WIDER (2.0x
        // instead of original 1.5x) to give breathing room against 15m noise.
        const slDistance = 2.0 * curAtr_15m;

        // Score: ADX + RVOL + candle structure
        let score = curAdx_1H;
        if (rvol >= 1.2) score += 10;
        const highestOf3 = Math.max(...highs15m.slice(-4, -1));
        const breakHigh  = currCandle.close > highestOf3;
        const bodyPct    = Math.abs(currCandle.close - currCandle.open) / currCandle.open * 100;
        const strongBull = currCandle.close > currCandle.open && bodyPct > 0.2;
        if (breakHigh)   score += 5;
        if (strongBull)  score += 5;

        return {
            signal:   'LONG',
            reason:   `Bullish trend confirmed, pullback to EMA21/VWAP reclaimed`,
            price:    currCandle.close,
            stopLoss: currCandle.close - slDistance,
            atr:      curAtr_15m,   // 15m ATR — consistent with R-multiple logic in liveTrader
            atr_1H:   curAtr_1H,    // 1H ATR — available for reference/diagnostics
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
