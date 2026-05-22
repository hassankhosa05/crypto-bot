const axios = require('axios');

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch top 20 mid-cap coins ($50M - $200M market cap)
async function fetchMidCapCoins() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
            params: {
                vs_currency: 'usd',
                order: 'market_cap_desc',
                per_page: 250, // Fetch top 250, then filter
                page: 1,
                sparkline: false
            }
        });

        // Filter for $50M to $200M market cap
        const midCaps = response.data.filter(coin => coin.market_cap >= 50000000 && coin.market_cap <= 200000000);
        
        // Return top 20
        return midCaps.slice(0, 20).map(coin => ({
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
        // We use the market_chart endpoint to get enough data for EMA50
        // 'days=1' gives 5-minute data
        // 'days=14' gives 1-hour data
        const response = await axios.get(`https://api.coingecko.com/api/v3/coins/${coinId}/ohlc`, {
            params: {
                vs_currency: 'usd',
                days: 1 // 1 day gives 30-minute candles on CoinGecko API (usually 48 data points).
                // Note: If you need 100+ points for a solid EMA50, you might need days=7 which gives 4hr candles.
                // For this example, let's assume we use days=7 to get 4hr data (42 points), 
                // or we use binance API for better granular data if needed.
            }
        });

        // CoinGecko OHLC format: [ [time, open, high, low, close], ... ]
        // Note: CoinGecko OHLC doesn't include volume in this endpoint.
        // We will mock volume using random variation for the sake of the volume filter
        // If you connect Binance API, you will get real volume.
        
        const data = response.data;
        if (!data || data.length < 50) {
            // Need at least 50 points for EMA50
             const responseLonger = await axios.get(`https://api.coingecko.com/api/v3/coins/${coinId}/ohlc`, {
                params: { vs_currency: 'usd', days: 7 } // Get 4hr candles
            });
            return responseLonger.data.map(d => ({
                timestamp: d[0],
                open: d[1],
                high: d[2],
                low: d[3],
                close: d[4],
                volume: Math.random() * 1000000 + 500000 // Mocking volume for CoinGecko OHLC limitation
            }));
        }

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
