const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { EMA, ATR } = require('technicalindicators');

const STABLECOINS = ['USDT', 'USDC', 'FDUSD', 'TUSD', 'USD1', 'RLUSD', 'DAI', 'USDP'];

async function getTopVolumePerps(limit = 40) {
    try {
        const response = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
        let validCoins = response.data.filter(c => {
            if (!c.symbol.endsWith('USDT')) return false;
            const baseAsset = c.symbol.replace('USDT', '');
            if (STABLECOINS.includes(baseAsset)) return false;
            // Minimum M daily volume — excludes micro-caps and low-liquidity coins
            if (parseFloat(c.quoteVolume) < 50_000_000) return false;
            return true;
        });
        validCoins.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
        return validCoins.slice(0, limit).map(c => c.symbol);
    } catch (e) {
        console.error("Error fetching top coins:", e);
        return [];
    }
}

async function getFundingAndSpread(symbol) {
    try {
        const [fundingRes, bookRes] = await Promise.all([
            axios.get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
            axios.get(`https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=${symbol}`)
        ]);
        
        const fundingRate = parseFloat(fundingRes.data.lastFundingRate);
        const bid = parseFloat(bookRes.data.bidPrice);
        const ask = parseFloat(bookRes.data.askPrice);
        const spreadPct = (ask - bid) / bid;
        
        return { fundingRate, spreadPct };
    } catch (e) {
        return null;
    }
}

async function getAtrAndTrend(symbol) {
    try {
        const response = await axios.get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=100`);
        const data = response.data;
        if (data.length < 50) return null;
        
        const highs = data.map(d => parseFloat(d[2]));
        const lows = data.map(d => parseFloat(d[3]));
        const closes = data.map(d => parseFloat(d[4]));
        
        const atrResult = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
        const currentAtr = atrResult[atrResult.length - 1] || 0;
        const currentPrice = closes[closes.length - 1];
        
        const atrPct = (currentAtr / currentPrice) * 100; // ATR as a % of price
        
        const ema20 = EMA.calculate({ period: 20, values: closes });
        const ema50 = EMA.calculate({ period: 50, values: closes });
        
        const currentEma20 = ema20[ema20.length - 1];
        const currentEma50 = ema50[ema50.length - 1];
        
        let trend = 'SIDEWAYS';
        if (currentPrice > currentEma50 && currentEma20 > currentEma50) trend = 'UP';
        else if (currentPrice < currentEma50 && currentEma20 < currentEma50) trend = 'DOWN';
        
        return { atrPct, trend };
    } catch (e) {
        return null;
    }
}

async function runSelector() {
    console.log("=== ACTIVE FUTURES UNIVERSE SAVED ===");
    console.log("Diagnostic Rejections Summary:", JSON.stringify(stats, null, 2));
    console.log(JSON.stringify(universe, null, 2));
}

if (require.main === module) {
    runSelector().catch(console.error);
}

module.exports = { runSelector };
