const axios = require('axios');

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch top 20 mid-cap coins ($50M - $200M market cap)
async function fetchMidCapCoins() {
    try {
        const config = {
            params: {
                vs_currency: 'usd',
                order: 'market_cap_desc',
                per_page: 250, // Fetch top 250, then filter
                page: 1,
                sparkline: false
            }
        };
        if (process.env.COINGECKO_API_KEY) {
            config.headers = { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY };
        }
        const response = await axios.get('https://api.coingecko.com/api/v3/coins/markets', config);

        // Filter for $50M to $200M market cap
        const midCaps = response.data.filter(coin => coin.market_cap >= 50000000 && coin.market_cap <= 200000000);
        
        // Return top 13
        return midCaps.slice(0, 13).map(coin => ({
            id: coin.id,
            symbol: coin.symbol.toUpperCase(),
            current_price: coin.current_price
        }));
    } catch (error) {
        console.error('Error fetching mid-cap coins:', error.message);
        return [];
    }
}

// Fetch historical data (e.g., 15 minute or 1 hour candles)
// For CoinGecko, /ohlc endpoint gives 30min candles if days=1
async function fetchHistoricalData(coinId) {
    try {
        const config = {
            params: {
                vs_currency: 'usd',
                days: 1 // 1 day gives 30-minute candles on CoinGecko API (usually 48 data points).
            }
        };
        if (process.env.COINGECKO_API_KEY) {
            config.headers = { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY };
        }
        const response = await axios.get(`https://api.coingecko.com/api/v3/coins/${coinId}/ohlc`, config);

        const data = response.data;
        
        return data.map(d => ({
            timestamp: d[0],
            open: d[1],
            high: d[2],
            low: d[3],
            close: d[4],
            volume: Math.random() * 1000000 + 500000 // Mocking volume
        }));

    } catch (error) {
        console.error(`Error fetching historical data for ${coinId}:`, error.message);
        return null;
    }
}

module.exports = {
    fetchMidCapCoins,
    fetchHistoricalData,
    delay
};
