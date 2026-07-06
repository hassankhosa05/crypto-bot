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
    console.log("Starting Futures Universe Selection...");
    const candidates = await getTopVolumePerps(30);
    
    let validCoins = [];
    
    for (const sym of candidates) {
        process.stdout.write(`Evaluating ${sym}... `);
        
        const metrics = await getFundingAndSpread(sym);
        if (!metrics) {
            console.log("Failed to fetch metrics.");
            continue;
        }
        
        // Filter out extreme funding > 0.10% (0.001) or spread > 0.05% (0.0005)
        if (Math.abs(metrics.fundingRate) > 0.001) {
            console.log(`Rejected (Funding ${metrics.fundingRate})`);
            continue;
        }
        if (metrics.spreadPct > 0.0005) {
            console.log(`Rejected (Spread ${(metrics.spreadPct*100).toFixed(3)}%)`);
            continue;
        }
        
        const technicals = await getAtrAndTrend(sym);
        if (!technicals) {
            console.log("Failed to fetch klins.");
            continue;
        }
        
        if (technicals.trend === 'SIDEWAYS') {
            console.log("Rejected (Sideways Trend)");
            continue;
        }
        
        console.log(`Accepted. ATR%: ${technicals.atrPct.toFixed(2)}%`);
        validCoins.push({
            symbol: sym,
            fundingRate: metrics.fundingRate,
            spreadPct: metrics.spreadPct,
            atrPct: technicals.atrPct,
            trend: technicals.trend
        });
        
        await new Promise(r => setTimeout(r, 500)); // avoid rate limit
    }
    
    // Sort by ATR % to find the most volatile trending coins
    validCoins.sort((a, b) => b.atrPct - a.atrPct);
    
    const top15 = validCoins.slice(0, 15);
    
    const universe = {
        updatedAt: new Date().toISOString(),
        coins: {}
    };
    
    top15.forEach(c => {
        universe.coins[c.symbol] = {
            tier: 1,
            atrPct: parseFloat(c.atrPct.toFixed(2)),
            fundingRate: parseFloat(c.fundingRate.toFixed(6)),
            spreadPct: parseFloat((c.spreadPct * 100).toFixed(3)),
            trend: c.trend
        };
    });
    
    const outPath = path.join(__dirname, 'active_universe.json');
    fs.writeFileSync(outPath, JSON.stringify(universe, null, 2));
    
    console.log("\n=== ACTIVE FUTURES UNIVERSE SAVED ===");
    console.log(JSON.stringify(universe, null, 2));
}

if (require.main === module) {
    runSelector().catch(console.error);
}

module.exports = { runSelector };
