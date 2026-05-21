const axios = require('axios');

const COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';
const USE_MOCK_DATA = false; // Set to true to bypass rate limits for testing

// Delay helper to respect rate limits
const delay = ms => new Promise(res => setTimeout(res, ms));

async function fetchMidCapCoins() {
    if (USE_MOCK_DATA) {
        console.log('Using mock data for mid-cap coins to bypass rate limits.');
        return [
            { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', current_price: 65000, market_cap: 100000000 },
            { id: 'ethereum', symbol: 'ETH', name: 'Ethereum', current_price: 3500, market_cap: 80000000 },
            { id: 'solana', symbol: 'SOL', name: 'Solana', current_price: 150, market_cap: 60000000 },
            { id: 'cardano', symbol: 'ADA', name: 'Cardano', current_price: 0.5, market_cap: 55000000 },
            { id: 'polkadot', symbol: 'DOT', name: 'Polkadot', current_price: 7, market_cap: 52000000 }
        ];
    }

    try {
        console.log('Fetching top 20 mid-cap coins ($50M - $200M market cap)...');
        const response = await axios.get(`${COINGECKO_BASE_URL}/coins/markets`, {
            params: {
                vs_currency: 'usd',
                order: 'market_cap_desc',
                per_page: 250,
                page: 1,
                sparkline: false
            }
        });

        // Filter for market cap between $50M and $200M
        let midCaps = response.data.filter(coin => coin.market_cap >= 50000000 && coin.market_cap <= 200000000);
        
        // Take the top 20
        midCaps = midCaps.slice(0, 20);
        console.log(`Successfully found ${midCaps.length} mid-cap coins.`);
        return midCaps.map(coin => ({ id: coin.id, symbol: coin.symbol, name: coin.name, current_price: coin.current_price, market_cap: coin.market_cap }));
    } catch (error) {
        console.error('Error fetching mid-cap coins:', error.message);
        return [];
    }
}

async function fetchHistoricalData(coinId, days = '1') {
    if (USE_MOCK_DATA) {
        // Generate some fake historical data with slight randomness to trigger strategies
        const data = [];
        let basePrice = 100;
        if (coinId === 'bitcoin') basePrice = 65000;
        if (coinId === 'ethereum') basePrice = 3500;
        if (coinId === 'solana') basePrice = 150;
        
        const now = Date.now();
        for (let i = 24; i >= 0; i--) {
            // Random walk
            const change = (Math.random() - 0.45) * (basePrice * 0.05); // slight upward bias
            basePrice = basePrice + change;
            
            // Occasional volume spike for breakout strategy
            const volume = Math.random() > 0.9 ? 100000 : 20000;

            data.push({
                timestamp: now - (i * 5 * 60 * 1000), // 5 min intervals
                close: basePrice,
                volume: volume
            });
        }
        return data;
    }

    try {
        const response = await axios.get(`${COINGECKO_BASE_URL}/coins/${coinId}/market_chart`, {
            params: {
                vs_currency: 'usd',
                days: days
            }
        });
        
        const prices = response.data.prices;
        const volumes = response.data.total_volumes;
        
        const data = [];
        for (let i = 0; i < prices.length; i++) {
            data.push({
                timestamp: prices[i][0],
                close: prices[i][1],
                volume: volumes[i][1]
            });
        }
        return data;
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
