const axios = require('axios');
const { TRADING_CONFIG } = require('./tradingConfig');

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch top 30 USDT pairs by 24h volume from Binance
async function fetchMidCapCoins() {
    try {
        const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr');
        
        // Filter for USDT pairs, excluding standard stablecoins
        const usdtPairs = response.data.filter(coin => 
            coin.symbol.endsWith('USDT') && 
            !['USDCUSDT', 'FDUSDUSDT', 'TUSDUSDT', 'EURUSDT'].includes(coin.symbol) &&
            parseFloat(coin.lastPrice) > 0 // Ensure it's actively trading
        );

        // Sort by quoteVolume (highest liquidity)
        usdtPairs.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
        
        // Return top 30
        return usdtPairs.slice(0, 30).map(coin => ({
            id: coin.symbol, // For Binance, id is the symbol like BTCUSDT
            symbol: coin.symbol,
            current_price: parseFloat(coin.lastPrice)
        }));
    } catch (error) {
        console.error('Error fetching top coins from Binance:', error.message);
        return [];
    }
}

// Fetch exactly 100 recent candles from Binance using the shared bot timeframe
async function fetchHistoricalData(symbol, retries = 3, delayMs = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.get(`https://api.binance.com/api/v3/klines`, {
                params: {
                    symbol: symbol,
                    interval: TRADING_CONFIG.timeframe,
                    limit: 100
                }
            });

            const data = response.data;
            
            return data.map(d => ({
                timestamp: d[0],
                open: parseFloat(d[1]),
                high: parseFloat(d[2]),
                low: parseFloat(d[3]),
                close: parseFloat(d[4]),
                volume: parseFloat(d[5])
            }));

        } catch (error) {
            console.error(`Attempt ${i + 1} failed fetching historical data for ${symbol}:`, error.message);
            if (i < retries - 1) {
                await delay(delayMs * Math.pow(2, i)); // Exponential backoff
            } else {
                return null;
            }
        }
    }
}

module.exports = {
    fetchMidCapCoins,
    fetchHistoricalData,
    delay
};
