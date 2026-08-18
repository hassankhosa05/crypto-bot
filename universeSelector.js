const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { EMA, ATR } = require('technicalindicators');

const STABLECOINS = ['USDT', 'USDC', 'FDUSD', 'TUSD', 'USD1', 'RLUSD', 'DAI', 'USDP'];

async function getTopVolumeSpot(limit = 40) {
    try {
        const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr');
        let validCoins = response.data.filter(c => {
            if (!c.symbol.endsWith('USDT')) return false;
            const baseAsset = c.symbol.replace('USDT', '');
            if (STABLECOINS.includes(baseAsset)) return false;
            if (c.symbol.includes('DOWN') || c.symbol.includes('UP')) return false;
            // Minimum M daily volume — eliminates illiquid micro-caps
            if (parseFloat(c.quoteVolume) < 50_000_000) return false;
            return true;
        });
        validCoins.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
        return validCoins.slice(0, limit).map(c => c.symbol);
    } catch (e) {
        console.error('Error fetching top spot coins:', e.message);
        return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'BNBUSDT'];
    }
}

async function getSpread(symbol) {
    try {
        const bookRes = await axios.get(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${symbol}`);
        const bid = parseFloat(bookRes.data.bidPrice);
        const ask = parseFloat(bookRes.data.askPrice);
        const spreadPct = (ask - bid) / bid;
        return spreadPct;
    } catch (e) {
        return 0.001;
    }
}

async function getAtrAndTrend(symbol) {
    try {
        const response = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=100`);
        const data = response.data;
        if (data.length < 50) return null;
        
        const highs = data.map(d => parseFloat(d[2]));
        const lows = data.map(d => parseFloat(d[3]));
        const closes = data.map(d => parseFloat(d[4]));
        
        const atrResult = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
        const currentAtr = atrResult[atrResult.length - 1] || 0;
        const currentPrice = closes[closes.length - 1];
        
        const atrPct = (currentAtr / currentPrice) * 100;
        
        const ema20 = EMA.calculate({ period: 20, values: closes });
        const ema50 = EMA.calculate({ period: 50, values: closes });
        
        const currentEma20 = ema20[ema20.length - 1];
        const currentEma50 = ema50[ema50.length - 1];
        
        let trend = 'SIDEWAYS';
        if (currentPrice > currentEma50 && currentEma20 > currentEma50) trend = 'UP';
        else if (currentPrice < currentEma50 && currentEma20 < currentEma50) trend = 'DOWN';
        
        return { atrPct, trend, currentPrice };
    } catch (e) {
        return null;
    }
}

async function getBTCRegime() {
    try {
        const response = await axios.get('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=250');
        const closes = response.data.map(d => parseFloat(d[4]));
        const ema20  = EMA.calculate({ period: 20, values: closes });
        const ema50  = EMA.calculate({ period: 50, values: closes });

        if (ema20.length > 0 && ema50.length > 0) {
            return ema20[ema20.length - 1] > ema50[ema50.length - 1] ? 'TRENDING' : 'CHOPPY';
        }
    } catch (e) {
        console.error('Error fetching BTC regime:', e.message);
    }
    return 'CHOPPY';
}

async function runSelector() {
    console.log('Starting Dynamic Spot Universe Selection...');
    const regime = await getBTCRegime();
    console.log('Detected Global Regime:', regime);

    const candidates = await getTopVolumeSpot(25);
    console.log(`Evaluating top volume spot candidates (${candidates.length})...`);

    let validCoins = [];

    for (const sym of candidates) {
        const spread = await getSpread(sym);
        if (spread > 0.001) continue; // max 0.10% spread

        const technicals = await getAtrAndTrend(sym);
        if (!technicals) continue;

        // Filter out extreme ATR (min 0.4%, max 5.0%)
        if (technicals.atrPct < 0.4 || technicals.atrPct > 5.0) continue;

        validCoins.push({
            symbol: sym,
            atrPct: technicals.atrPct,
            spreadPct: spread,
            trend: technicals.trend
        });

        await new Promise(r => setTimeout(r, 250));
    }

    // If too few passed, fallback to top volume candidates
    if (validCoins.length < 5) {
        console.log('Fewer than 5 strict coins found, adding top liquid volume majors...');
        for (const sym of candidates.slice(0, 10)) {
            if (!validCoins.some(v => v.symbol === sym)) {
                validCoins.push({
                    symbol: sym,
                    atrPct: 1.0,
                    spreadPct: 0.0005,
                    trend: 'UP'
                });
            }
        }
    }

    validCoins.sort((a, b) => b.atrPct - a.atrPct);
    const top10 = validCoins.slice(0, 10);

    const universe = {
        updatedAt: new Date().toISOString(),
        regime,
        coins: {}
    };

    top10.forEach(c => {
        universe.coins[c.symbol] = {
            tier: 1,
            atrPct: parseFloat(c.atrPct.toFixed(2)),
            spreadPct: parseFloat((c.spreadPct * 100).toFixed(3)),
            trend: c.trend
        };
    });

    const outPath = path.join(__dirname, 'active_universe.json');
    fs.writeFileSync(outPath, JSON.stringify(universe, null, 2));

    console.log('=== ACTIVE SPOT UNIVERSE SAVED ===');
    console.log(JSON.stringify(universe, null, 2));
    return universe;
}

if (require.main === module) {
    runSelector().catch(console.error);
}

module.exports = { runSelector };
