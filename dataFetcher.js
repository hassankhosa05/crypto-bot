const axios = require('axios');

const COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';

const delay = ms => new Promise(res => setTimeout(res, ms));

// Cache historical OHLCV per coin. Refreshed every HISTORICAL_REFRESH_CYCLES cycles
// so scalping strategies don't trigger the rate limiter on every cycle.
const HISTORICAL_REFRESH_CYCLES = 5;
const historicalCache = {};
let cycleCounter = 0;

function bumpCycle() {
    cycleCounter += 1;
}

async function fetchWithRetry(url, params, { maxAttempts = 4, baseDelay = 2000 } = {}) {
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            return await axios.get(url, { params, timeout: 15000 });
        } catch (error) {
            lastError = error;
            const status = error.response && error.response.status;
            if (status !== 429 && status !== 503) throw error;

            // Honor Retry-After if the server provided one, else exponential backoff with jitter.
            const retryAfterHeader = error.response.headers && error.response.headers['retry-after'];
            const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
            const backoffMs = retryAfterMs || baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
            await delay(backoffMs);
        }
    }
    throw lastError;
}

async function fetchMidCapCoins() {
    try {
        console.log('Fetching top 20 mid-cap coins ($50M - $200M market cap)...');
        const response = await fetchWithRetry(`${COINGECKO_BASE_URL}/coins/markets`, {
            vs_currency: 'usd',
            order: 'market_cap_desc',
            per_page: 250,
            page: 1,
            sparkline: false
        });

        const midCaps = response.data
            .filter(coin => coin.market_cap >= 50_000_000 && coin.market_cap <= 200_000_000)
            .slice(0, 20)
            .map(coin => ({
                id: coin.id,
                symbol: coin.symbol,
                name: coin.name,
                current_price: coin.current_price,
                market_cap: coin.market_cap
            }));

        console.log(`Successfully found ${midCaps.length} mid-cap coins.`);
        return midCaps;
    } catch (error) {
        console.error('Error fetching mid-cap coins:', error.message);
        return [];
    }
}

// One bulk call to refresh every coin's spot price in a single request.
async function fetchCurrentPrices(coinIds) {
    if (!coinIds || coinIds.length === 0) return {};
    try {
        const response = await fetchWithRetry(`${COINGECKO_BASE_URL}/simple/price`, {
            ids: coinIds.join(','),
            vs_currencies: 'usd',
            include_24hr_vol: true,
            include_last_updated_at: true
        });
        const prices = {};
        for (const id of coinIds) {
            const entry = response.data[id];
            if (entry && typeof entry.usd === 'number') {
                prices[id] = {
                    price: entry.usd,
                    volume24h: entry.usd_24h_vol,
                    updatedAt: entry.last_updated_at
                };
            }
        }
        return prices;
    } catch (error) {
        console.error('Error fetching bulk prices:', error.message);
        return {};
    }
}

// Returns cached historical data if fresh enough, otherwise refetches.
// Also appends the latest spot close so strategies see up-to-date price action.
async function getHistoricalData(coinId, latestClose) {
    const cached = historicalCache[coinId];
    const cacheAgeCycles = cached ? cycleCounter - cached.fetchedAtCycle : Infinity;

    if (cached && cacheAgeCycles < HISTORICAL_REFRESH_CYCLES) {
        return appendLatestClose(cached.data, latestClose);
    }

    try {
        // Inter-request jitter only on the path that actually hits the API.
        await delay(2500 + Math.floor(Math.random() * 1000));

        const response = await fetchWithRetry(
            `${COINGECKO_BASE_URL}/coins/${coinId}/market_chart`,
            { vs_currency: 'usd', days: '1' }
        );

        const prices = response.data.prices || [];
        const volumes = response.data.total_volumes || [];
        const data = prices.map((p, i) => ({
            timestamp: p[0],
            close: p[1],
            volume: (volumes[i] && volumes[i][1]) || 0
        }));

        historicalCache[coinId] = { data, fetchedAtCycle: cycleCounter };
        return appendLatestClose(data, latestClose);
    } catch (error) {
        console.error(`Error fetching historical data for ${coinId}:`, error.message);
        // Fall back to stale cache if we have one — better than nothing.
        return cached ? appendLatestClose(cached.data, latestClose) : null;
    }
}

function appendLatestClose(data, latestClose) {
    if (!data || data.length === 0) return data;
    if (typeof latestClose !== 'number') return data;
    const last = data[data.length - 1];
    // If spot is meaningfully newer than the last cached close, append a synthetic tick.
    if (Math.abs(last.close - latestClose) / last.close > 0.0001) {
        return [...data, { timestamp: Date.now(), close: latestClose, volume: last.volume }];
    }
    return data;
}

module.exports = {
    fetchMidCapCoins,
    fetchCurrentPrices,
    getHistoricalData,
    bumpCycle,
    delay
};
