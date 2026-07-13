const axios = require('axios');
const { EMA, ADX } = require('technicalindicators');

const BTC_SYMBOL = 'BTCUSDT';
const LIMIT = 250;

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Timeframe Regime: 4H = Strategic Direction
// BULLISH  → BTC 4H EMA20 > EMA50 AND ADX > 20 → Longs only
// BEARISH  → BTC 4H EMA20 < EMA50 AND ADX > 20 → Shorts only
// CHOPPY   → Anything else                       → No new trades
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

        const curEma20 = ema20[ema20.length - 1];
        const curEma50 = ema50[ema50.length - 1];
        const curAdx   = adxResult[adxResult.length - 1]?.adx || 0;

        console.log(`[MarketGate] BTC 4H → EMA20: ${curEma20?.toFixed(2)}, EMA50: ${curEma50?.toFixed(2)}, ADX: ${curAdx?.toFixed(2)}`);

        if (curAdx > 20) {
            if (curEma20 > curEma50) return 'BULLISH';
            if (curEma20 < curEma50) return 'BEARISH';
        }

        return 'CHOPPY'; // Fail-safe: choppy = no new trend trades
    } catch (error) {
        console.error('Error in Global Market Gate:', error.message);
        return 'CHOPPY'; // Fail-safe default
    }
}

module.exports = { checkMarketRegime };
