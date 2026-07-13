const axios = require('axios');
const { EMA, ADX } = require('technicalindicators');

const BTC_SYMBOL = 'BTCUSDT';
const LIMIT = 250;

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Timeframe Regime: 4H BTC = Strategic Direction
//
// BULLISH     → EMA20 > EMA50 AND ADX > 25          → Longs only (standard filters)
// BEARISH     → EMA20 < EMA50 AND ADX > 25          → Shorts only (standard filters)
// MILD_CHOPPY → ADX 18–25 AND EMAs have clear slope → Allow, but ultra-strict coin filters
// CHOPPY      → ADX < 18 OR EMAs flat/crossing      → No new trades at all
// ─────────────────────────────────────────────────────────────────────────────
async function checkMarketRegime() {
    try {
        const response = await axios.get(
            `https://fapi.binance.com/fapi/v1/klines?symbol=${BTC_SYMBOL}&interval=4h&limit=${LIMIT}`
        );
        const data = response.data;

        if (data.length < 100) return 'CHOPPY';

        const closes = data.map(d => parseFloat(d[4]));
        const highs  = data.map(d => parseFloat(d[2]));
        const lows   = data.map(d => parseFloat(d[3]));

        const ema20 = EMA.calculate({ period: 20, values: closes });
        const ema50 = EMA.calculate({ period: 50, values: closes });
        const adxResult = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });

        const curEma20  = ema20[ema20.length - 1];
        const curEma50  = ema50[ema50.length - 1];
        const prevEma20 = ema20[ema20.length - 4]; // 1 bar ago (3 × 4H = 12H lookback for slope)
        const prevEma50 = ema50[ema50.length - 4];
        const curAdx    = adxResult[adxResult.length - 1]?.adx || 0;

        // EMA slope: is the fast EMA clearly moving in one direction?
        const ema20Slope = curEma20 - prevEma20; // positive = rising, negative = falling
        const ema50Slope = curEma50 - prevEma50;
        const emaClearSlope = Math.abs(ema20Slope) > 0 && Math.sign(ema20Slope) === Math.sign(ema50Slope);

        console.log(
            `[MarketGate] BTC 4H → EMA20: ${curEma20?.toFixed(2)}, EMA50: ${curEma50?.toFixed(2)}, ` +
            `ADX: ${curAdx?.toFixed(2)}, EMA slope aligned: ${emaClearSlope}`
        );

        // ── True trending ────────────────────────────────────────────────
        if (curAdx > 25) {
            if (curEma20 > curEma50) return 'BULLISH';
            if (curEma20 < curEma50) return 'BEARISH';
        }

        // ── Mild choppy: some trend structure but not strong enough ──────
        // ADX 18–25 with EMAs still sloping in the same direction
        if (curAdx >= 18 && emaClearSlope) {
            if (curEma20 > curEma50) return 'MILD_CHOPPY_BULL'; // can look for longs, strict filters
            if (curEma20 < curEma50) return 'MILD_CHOPPY_BEAR'; // can look for shorts, strict filters
        }

        // ── True choppy: flat, no direction ─────────────────────────────
        return 'CHOPPY';

    } catch (error) {
        console.error('Error in Global Market Gate:', error.message);
        return 'CHOPPY'; // fail-safe
    }
}

module.exports = { checkMarketRegime };
