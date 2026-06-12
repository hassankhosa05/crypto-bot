const axios = require('axios');

let exchangeInfoCache = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getExchangeInfo() {
    if (exchangeInfoCache && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
        return exchangeInfoCache;
    }
    try {
        const response = await axios.get('https://api.binance.com/api/v3/exchangeInfo', { timeout: 10000 });
        const newCache = {};
        for (const symbolInfo of response.data.symbols) {
            if (symbolInfo.symbol.endsWith('USDT')) {
                const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
                const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
                const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'NOTIONAL') ||
                    symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');

                newCache[symbolInfo.symbol] = {
                    stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : 1,
                    minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : 1,
                    tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.01,
                    minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.minNotional) : 5
                };
            }
        }
        exchangeInfoCache = newCache;
        cacheTimestamp = Date.now();
        return exchangeInfoCache;
    } catch (e) {
        console.error("Failed to fetch exchangeInfo:", e.message);
        // Return stale cache if available rather than empty object
        return exchangeInfoCache || {};
    }
}

function roundStep(quantity, stepSize) {
    const inv = 1.0 / stepSize;
    return Math.floor(quantity * inv) / inv;
}

function roundTick(price, tickSize) {
    const inv = 1.0 / tickSize;
    return Math.round(price * inv) / inv;
}

module.exports = { getExchangeInfo, roundStep, roundTick };
