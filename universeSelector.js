const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { evaluateTradeV2, checkEmergencyExitV2 } = require('./strategyV2');
const { EMA } = require('technicalindicators');
const { simulateThreeWay } = require('./backtestEngine');

const TIMEFRAME = '15m';
// ~15 days of 15m candles — gives a meaningful holdout window after the 3-way split
const KLINES_TO_FETCH = 2500;
const WARMUP_CANDLES = 400;

// Minimum thresholds applied to the validate window (used for selection)
const MIN_TRAIN_PF     = 1.05;
const MIN_VALIDATE_PF  = 1.01;
const MIN_HOLDOUT_PF   = 0.90; // holdout must not be a disaster
const MIN_FORWARD_TRADES = 2;
const MIN_TRADES_PER_MONTH = 4;
const MAX_AVG_DAYS_BETWEEN_TRADES = 6;

// Maximum allowed PF decay from train to validate — penalises overfitting
const MAX_PF_DECAY_RATIO = 0.55; // validate.pf must be >= train.pf * (1 - 0.55)

const STABLECOINS = ['USDT', 'USDC', 'FDUSD', 'TUSD', 'USD1', 'RLUSD', 'DAI', 'USDP'];

async function getTopVolumeCoins(limit = 40) {
    try {
        const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr');
        const validCoins = response.data.filter(c => {
            if (!c.symbol.endsWith('USDT')) return false;
            const baseAsset = c.symbol.replace('USDT', '');
            if (STABLECOINS.includes(baseAsset)) return false;
            if (c.symbol.includes('DOWN') || c.symbol.includes('UP')) return false;
            return true;
        });
        validCoins.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
        return validCoins.slice(0, limit).map(c => c.symbol);
    } catch (e) {
        console.error("Error fetching top coins:", e);
        return [];
    }
}

async function getBTCRegime() {
    try {
        const response = await axios.get('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=250');
        const closes = response.data.map(d => parseFloat(d[4]));
        const ema50  = EMA.calculate({ period: 50,  values: closes });
        const ema200 = EMA.calculate({ period: 200, values: closes });

        if (ema50.length > 0 && ema200.length > 0) {
            return ema50[ema50.length - 1] > ema200[ema200.length - 1] ? 'TRENDING' : 'CHOPPY';
        }
    } catch (e) {
        console.error("Error fetching BTC regime:", e);
    }
    return 'CHOPPY'; // Fail-safe default
}

async function fetchHistoricalData(symbol) {
    let klins = [];
    let endTime = Date.now();
    const limit = 1000;
    while (klins.length < KLINES_TO_FETCH) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${TIMEFRAME}&limit=${limit}&endTime=${endTime}`;
        try {
            const response = await axios.get(url);
            const data = response.data;
            if (data.length === 0) break;
            klins = data.concat(klins);
            endTime = data[0][0] - 1;
        } catch (e) {
            break;
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    if (klins.length > KLINES_TO_FETCH) klins = klins.slice(klins.length - KLINES_TO_FETCH);
    return klins.map(d => ({
        timestamp: d[0],
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4]),
        volume: parseFloat(d[5])
    }));
}

async function evaluateCoin(symbol, regime) {
    const data = await fetchHistoricalData(symbol);
    if (data.length < 600) return null;

    const result = simulateThreeWay(data, {
        symbol,
        warmupCandles: WARMUP_CANDLES,
        initialBalance: 1000,
        fixedTradeUSD: 60,
        regime
    });
    if (!result) return null;

    const { train, validate, holdout } = result;

    // --- Selection filters ---
    // 1. Train must be profitable
    if (train.pf < MIN_TRAIN_PF) return null;
    // 2. Validate window must pass minimum thresholds
    if (validate.pf < MIN_VALIDATE_PF) return null;
    if (validate.netPnL <= 0) return null;
    if (validate.tradesCount < MIN_FORWARD_TRADES) return null;
    if (validate.tradesPerMonth < MIN_TRADES_PER_MONTH) return null;
    if (validate.avgDaysBetweenTrades > MAX_AVG_DAYS_BETWEEN_TRADES) return null;
    // 3. PF consistency: validate must not be wildly worse than train (overfit detector)
    if (validate.pf < train.pf * (1 - MAX_PF_DECAY_RATIO)) return null;
    // 4. Holdout confirmation: the completely unseen period must not be a disaster
    if (holdout.pf < MIN_HOLDOUT_PF) return null;
    if (holdout.netPnL < -20) return null; // -$20 on a $1000 base is too bad

    // --- Consistency-based score (avoids ranking purely on raw PnL) ---
    // Weighted average PF across all three windows + frequency bonus
    const avgPf = (train.pf * 0.3 + validate.pf * 0.4 + holdout.pf * 0.3);
    const consistencyPenalty = Math.abs(train.pf - validate.pf) / Math.max(train.pf, 0.1);
    const score = (avgPf - consistencyPenalty * 0.5) * Math.log1p(validate.tradesPerMonth);

    return { symbol, train, validate, holdout, forward: validate, score };
}

async function runSelector() {
    console.log("Starting Dynamic Universe Selection...");
    const regime = await getBTCRegime();
    console.log("Detected Global Regime:", regime);

    const candidates = await getTopVolumeCoins(40);
    console.log("Evaluating top volume coins...");

    const results = [];
    for (const sym of candidates) {
        process.stdout.write(sym + " ");
        const res = await evaluateCoin(sym, regime);
        if (res) results.push(res);
        await new Promise(r => setTimeout(r, 10000));
    }
    console.log("\nEvaluation complete.");

    // Sort by consistency score — not by raw netPnL
    results.sort((a, b) => b.score - a.score);
    const top15 = results.slice(0, 15);

    if (top15.length === 0) {
        throw new Error('Universe selection returned 0 valid coins (possibly due to API rate limits or IP ban). active_universe.json not updated.');
    }

    const universe = {
        updatedAt: new Date().toISOString(),
        regime,
        coins: {}
    };

    top15.forEach(c => {
        const tier = c.validate.pf >= 2.0 && c.validate.tradesPerMonth >= 12 ? 1 : 2;
        universe.coins[c.symbol] = {
            tier,
            pf:                    parseFloat(c.validate.pf.toFixed(2)),
            trades:                c.validate.tradesCount,
            trainPf:               parseFloat(c.train.pf.toFixed(2)),
            forwardPf:             parseFloat(c.validate.pf.toFixed(2)),
            holdoutPf:             parseFloat(c.holdout.pf.toFixed(2)),
            forwardNetPnL:         parseFloat(c.validate.netPnL.toFixed(2)),
            forwardTrades:         c.validate.tradesCount,
            tradesPerMonth:        parseFloat(c.validate.tradesPerMonth.toFixed(1)),
            avgDaysBetweenTrades:  parseFloat(c.validate.avgDaysBetweenTrades.toFixed(2)),
            winRate:               parseFloat((c.validate.winRate * 100).toFixed(1))
        };
    });

    const outPath = path.join(__dirname, 'active_universe.json');
    fs.writeFileSync(outPath, JSON.stringify(universe, null, 2));

    // Append a regime snapshot so monitor.js can verify "≥1 regime flip" over the paper window.
    try {
        const regimeLogPath = path.join(__dirname, 'regime_log.jsonl');
        fs.appendFileSync(regimeLogPath, JSON.stringify({ ts: universe.updatedAt, regime }) + '\n');
    } catch (e) { /* non-fatal */ }

    console.log("\n=== ACTIVE UNIVERSE SAVED ===");
    console.log(JSON.stringify(universe, null, 2));
}

if (require.main === module) {
    runSelector().catch(console.error);
}

module.exports = { runSelector };
