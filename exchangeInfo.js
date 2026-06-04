const axios = require('axios');

let exchangeInfoCache = null;

async function getExchangeInfo() {
    if (exchangeInfoCache) return exchangeInfoCache;
    try {
        const response = await axios.get('https://api.binance.com/api/v3/exchangeInfo');
        exchangeInfoCache = {};
        for (const symbolInfo of response.data.symbols) {
            if (symbolInfo.symbol.endsWith('USDT')) {
                const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
                const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
                const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'NOTIONAL') ||
                    symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');
                
                exchangeInfoCache[symbolInfo.symbol] = {
                    stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : 1,
                    minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : 1,
                    tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.01,
                    minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.minNotional) : 5
                };
            }
        }
        return exchangeInfoCache;
    } catch (e) {
        console.error("Failed to fetch exchangeInfo:", e.message);
        return {};
    }
}

function roundStep(quantity, stepSize) {
    const inv = 1.0 / stepSize;
    // For quantity, we floor to avoid insufficient balance errors
    return Math.floor(quantity * inv) / inv;
}

function roundTick(price, tickSize) {
    const inv = 1.0 / tickSize;
    return Math.round(price * inv) / inv;
}

module.exports = { getExchangeInfo, roundStep, roundTick };
