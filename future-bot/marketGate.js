const axios = require('axios');
const { EMA, ADX } = require('technicalindicators');

const BTC_SYMBOL = 'BTCUSDT';
const TIMEFRAME = '1h';
const LIMIT = 250;

async function checkMarketRegime() {
    try {
        const response = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${BTC_SYMBOL}&interval=${TIMEFRAME}&limit=${LIMIT}`);
        const data = response.data;
        
        if (data.length < 100) return 'SIDEWAYS';
        
        const closes = data.map(d => parseFloat(d[4]));
        const highs = data.map(d => parseFloat(d[2]));
        const lows = data.map(d => parseFloat(d[3]));
        
        const currentPrice = closes[closes.length - 1];
        
        const ema20 = EMA.calculate({ period: 20, values: closes });
        const ema50 = EMA.calculate({ period: 50, values: closes });
        
        const currentEma20 = ema20[ema20.length - 1];
        const currentEma50 = ema50[ema50.length - 1];
        
        const adxResult = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
        const currentAdx = adxResult[adxResult.length - 1]?.adx || 0;
        
        if (currentAdx > 20) {
            if (currentPrice > currentEma50 && currentEma20 > currentEma50) {
                return 'BULLISH';
            } else if (currentPrice < currentEma50 && currentEma20 < currentEma50) {
                return 'BEARISH';
            }
        }
        
        return 'SIDEWAYS';
    } catch (error) {
        console.error("Error in Global Market Gate:", error.message);
        return 'SIDEWAYS'; // Fail-safe
    }
}

module.exports = { checkMarketRegime };
