const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { EMA, RSI, ATR, ADX } = require('technicalindicators');

const SYMBOLS = ['SOLUSDT', 'ETHUSDT', 'BNBUSDT', 'DOGEUSDT', 'XRPUSDT', 'ZECUSDT', 'SUIUSDT', 'ADAUSDT'];
const DAYS = 30; // 30-day replay
const TAKER_FEE = 0.0004;
const INITIAL_BALANCE = 500;
const RISK_PER_TRADE = 0.003;
const LEVERAGE = 5;

async function fetchHistoricalKlines(symbol, interval, days = 30) {
    const limit = 1000;
    const intervalMs = interval === '15m' ? 15 * 60 * 1000 : (interval === '1h' ? 60 * 60 * 1000 : 4 * 60 * 60 * 1000);
    const totalBarsNeeded = Math.ceil((days * 24 * 60 * 60 * 1000) / intervalMs);
    let allData = [];
    let endTime = Date.now();

    while (allData.length < totalBarsNeeded) {
        try {
            const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&endTime=${endTime}`;
            const res = await axios.get(url);
            if (!res.data || res.data.length === 0) break;
            const parsed = res.data.map(d => ({
                timestamp: d[0],
                open: parseFloat(d[1]),
                high: parseFloat(d[2]),
                low: parseFloat(d[3]),
                close: parseFloat(d[4]),
                volume: parseFloat(d[5])
            }));
            allData = parsed.concat(allData);
            endTime = res.data[0][0] - 1;
            if (res.data.length < limit) break;
            await new Promise(r => setTimeout(r, 200));
        } catch (e) {
            console.error(`Error fetching ${symbol} ${interval}:`, e.message);
            break;
        }
    }
    // Sort ascending by timestamp & deduplicate
    const map = new Map();
    for (const b of allData) map.set(b.timestamp, b);
    return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function calculateVWAP(candles) {
    let cumulativePV = 0;
    let cumulativeVolume = 0;
    for (const candle of candles) {
        const typicalPrice = (candle.high + candle.low + candle.close) / 3;
        cumulativePV += typicalPrice * candle.volume;
        cumulativeVolume += candle.volume;
    }
    return cumulativeVolume ? cumulativePV / cumulativeVolume : null;
}

function computeIndicators(klines15m, klines1H, btc4H, btc15m) {
    // 4H BTC Regime lookup map
    const btc4HCloses = btc4H.map(k => k.close);
    const btc4HHighs  = btc4H.map(k => k.high);
    const btc4HLows   = btc4H.map(k => k.low);
    const btc4HEma20  = EMA.calculate({ period: 20, values: btc4HCloses });
    const btc4HEma50  = EMA.calculate({ period: 50, values: btc4HCloses });
    const btc4HAdx    = ADX.calculate({ high: btc4HHighs, low: btc4HLows, close: btc4HCloses, period: 14 });

    const btcRegimeTimeline = [];
    const offset4H = btc4HCloses.length - btc4HEma50.length;
    for (let i = 0; i < btc4HEma50.length; i++) {
        const rawIdx = i + offset4H;
        const e20 = btc4HEma20[i + (btc4HEma20.length - btc4HEma50.length)];
        const e50 = btc4HEma50[i];
        const adxObj = btc4HAdx[i + (btc4HAdx.length - btc4HEma50.length)];
        const adxVal = adxObj ? adxObj.adx : 0;
        let regime = 'CHOPPY';
        if (adxVal >= 25) {
            if (e20 > e50) regime = 'BULLISH';
            else if (e20 < e50) regime = 'BEARISH';
        } else if (adxVal >= 18) {
            if (e20 > e50) regime = 'MILD_CHOPPY_BULL';
            else if (e20 < e50) regime = 'MILD_CHOPPY_BEAR';
        }
        btcRegimeTimeline.push({ timestamp: btc4H[rawIdx].timestamp, regime });
    }

    return { btcRegimeTimeline };
}

function runSimulation(symbol, klines15m, klines1H, btc15m, btcRegimeTimeline, variant) {
    let balance = INITIAL_BALANCE;
    let positions = [];
    let tradeHistory = [];
    let cooldowns = {};
    let globalCooldownUntil = 0;
    let peakBalance = INITIAL_BALANCE;
    let maxDrawdownUSD = 0;

    const btc15mMap = new Map();
    for (let i = 50; i < btc15m.length; i++) {
        const sub = btc15m.slice(0, i + 1);
        const closes = sub.map(k => k.close);
        const ema50 = EMA.calculate({ period: 50, values: closes });
        btc15mMap.set(btc15m[i].timestamp, {
            price: closes[closes.length - 1],
            ema50: ema50[ema50.length - 1]
        });
    }

    // Iterate through 15m bars from index 100
    for (let i = 100; i < klines15m.length; i++) {
        const currentBar = klines15m[i];
        const currentTimestamp = currentBar.timestamp;
        const currentPrice = currentBar.close;

        // ── 1. Update Open Position ─────────────────────────────────────
        if (positions.length > 0) {
            const pos = positions[0];
            const isLong = pos.direction === 'LONG';
            const initialRisk = Math.abs(pos.entryPrice - pos.initialStopLoss);
            const atr = pos.atr;

            // Update peak / trough
            if (isLong) {
                pos.peakPrice = Math.max(pos.peakPrice, currentBar.high);
                pos.troughPrice = Math.min(pos.troughPrice, currentBar.low);
            } else {
                pos.peakPrice = Math.min(pos.peakPrice, currentBar.low);
                pos.troughPrice = Math.max(pos.troughPrice, currentBar.high);
            }

            const mfeR = initialRisk > 0 ? (isLong ? (pos.peakPrice - pos.entryPrice) : (pos.entryPrice - pos.peakPrice)) / initialRisk : 0;
            const maeR = initialRisk > 0 ? (isLong ? (pos.entryPrice - pos.troughPrice) : (pos.troughPrice - pos.entryPrice)) / initialRisk : 0;
            pos.maxFavorableR = Math.max(pos.maxFavorableR || 0, mfeR);
            pos.maxAdverseR = Math.max(pos.maxAdverseR || 0, maeR);

            const currentR = initialRisk > 0 ? (isLong ? (currentPrice - pos.entryPrice) : (pos.entryPrice - currentPrice)) / initialRisk : 0;

            // Trailing Stop logic
            if (pos.stage === 'INITIAL' && currentR >= 1.0) {
                pos.stopLoss = pos.entryPrice;
                pos.stage = 'BREAKEVEN';
            }
            if (pos.stage === 'BREAKEVEN' && currentR >= 1.5) {
                pos.stage = 'TRAILING';
            }
            if (pos.stage === 'TRAILING' && currentR >= 2.5) {
                pos.stage = 'RUNNER';
            }

            if (pos.stage === 'TRAILING' || pos.stage === 'RUNNER') {
                const mult = pos.stage === 'RUNNER' ? 1.5 : 2.5;
                if (isLong) {
                    const trail = pos.peakPrice - mult * atr;
                    if (trail > pos.stopLoss) pos.stopLoss = trail;
                } else {
                    const trail = pos.peakPrice + mult * atr;
                    if (trail < pos.stopLoss) pos.stopLoss = trail;
                }
            }

            // Check SL / Exit Hit
            let hitExit = false;
            let exitPrice = pos.stopLoss;
            if (isLong && currentBar.low <= pos.stopLoss) {
                hitExit = true;
                exitPrice = pos.stopLoss;
            } else if (!isLong && currentBar.high >= pos.stopLoss) {
                hitExit = true;
                exitPrice = pos.stopLoss;
            }

            if (hitExit) {
                const rawPnl = isLong ? (exitPrice - pos.entryPrice) * pos.qty : (pos.entryPrice - exitPrice) * pos.qty;
                const fee = pos.qty * exitPrice * TAKER_FEE;
                const netPnl = rawPnl - fee;
                balance += netPnl;

                peakBalance = Math.max(peakBalance, balance);
                const dd = peakBalance - balance;
                maxDrawdownUSD = Math.max(maxDrawdownUSD, dd);

                const finalR = initialRisk > 0 ? (isLong ? (exitPrice - pos.entryPrice) : (pos.entryPrice - exitPrice)) / initialRisk : 0;
                const isInitialSL = pos.stage === 'INITIAL';

                tradeHistory.push({
                    symbol: symbol,
                    direction: pos.direction,
                    entryPrice: pos.entryPrice,
                    exitPrice: exitPrice,
                    pnl: netPnl,
                    realizedR: finalR,
                    maxFavorableR: pos.maxFavorableR,
                    maxAdverseR: pos.maxAdverseR,
                    reason: isInitialSL ? 'STOP_LOSS' : (pos.stage === 'RUNNER' ? 'RUNNER_TRAIL' : (pos.stage === 'TRAILING' ? 'TRAIL' : 'BREAKEVEN'))
                });

                // Cooldown logic by variant
                if (variant.cooldownType === 'GLOBAL_2H') {
                    globalCooldownUntil = currentTimestamp + 2 * 60 * 60 * 1000;
                } else if (variant.cooldownType === 'SYMBOL_SL_2H') {
                    if (isInitialSL) cooldowns[symbol] = currentTimestamp + 2 * 60 * 60 * 1000;
                } else if (variant.cooldownType === 'SYMBOL_SL_4H') {
                    if (isInitialSL) cooldowns[symbol] = currentTimestamp + 4 * 60 * 60 * 1000;
                }

                positions = [];
            }
        }

        // ── 2. Scan for Entry if no open position ───────────────────────
        if (positions.length === 0) {
            // Check Cooldown
            if (globalCooldownUntil && currentTimestamp < globalCooldownUntil) continue;
            if (cooldowns[symbol] && currentTimestamp < cooldowns[symbol]) continue;

            // Get Current Regime
            let regime = 'CHOPPY';
            for (let r = btcRegimeTimeline.length - 1; r >= 0; r--) {
                if (btcRegimeTimeline[r].timestamp <= currentTimestamp) {
                    regime = btcRegimeTimeline[r].regime;
                    break;
                }
            }
            if (regime === 'CHOPPY') continue;

            // 1H Slice up to current timestamp
            const klines1HSlice = klines1H.filter(k => k.timestamp <= currentTimestamp);
            if (klines1HSlice.length < 50) continue;

            const closes1H = klines1HSlice.map(c => c.close);
            const highs1H  = klines1HSlice.map(c => c.high);
            const lows1H   = klines1HSlice.map(c => c.low);

            const ema20_1H = EMA.calculate({ period: 20, values: closes1H });
            const ema50_1H = EMA.calculate({ period: 50, values: closes1H });
            const adx_1H   = ADX.calculate({ high: highs1H, low: lows1H, close: closes1H, period: 14 });

            const curEma20_1H = ema20_1H[ema20_1H.length - 1];
            const curEma50_1H = ema50_1H[ema50_1H.length - 1];
            const curAdx_1H   = adx_1H[adx_1H.length - 1]?.adx || 0;
            const curPrice_1H = closes1H[closes1H.length - 1];

            let coinTrend = 'NONE';
            if (curEma20_1H > curEma50_1H && curPrice_1H > curEma20_1H) coinTrend = 'BULLISH';
            else if (curEma20_1H < curEma50_1H && curPrice_1H < curEma20_1H) coinTrend = 'BEARISH';

            if (coinTrend === 'NONE') continue;
            const isMildChoppy = regime === 'MILD_CHOPPY_BULL' || regime === 'MILD_CHOPPY_BEAR';
            const requiredAdx = isMildChoppy ? 30 : 25;
            if (curAdx_1H < requiredAdx) continue;

            if ((regime === 'BULLISH' || regime === 'MILD_CHOPPY_BULL') && coinTrend === 'BEARISH') continue;
            if ((regime === 'BEARISH' || regime === 'MILD_CHOPPY_BEAR') && coinTrend === 'BULLISH') continue;

            // 1H Dump / Pump Guard
            const last1H = klines1HSlice[klines1HSlice.length - 1];
            const body1H = Math.abs(last1H.close - last1H.open);
            const bodyPct1H = (body1H / last1H.open) * 100;
            if (coinTrend === 'BULLISH' && last1H.close < last1H.open && bodyPct1H > 1.2) continue;
            if (coinTrend === 'BEARISH' && last1H.close > last1H.open && bodyPct1H > 1.2) continue;

            // BTC 15m Alignment
            const btcState = btc15mMap.get(currentTimestamp);
            if (btcState) {
                if (coinTrend === 'BULLISH' && btcState.price < btcState.ema50) continue;
                if (coinTrend === 'BEARISH' && btcState.price > btcState.ema50) continue;
            }

            // 15m Slice
            const klines15mSlice = klines15m.slice(0, i + 1);
            const closes15m = klines15mSlice.map(k => k.close);
            const highs15m  = klines15mSlice.map(k => k.high);
            const lows15m   = klines15mSlice.map(k => k.low);

            const ema21_15m = EMA.calculate({ period: 21, values: closes15m });
            const rsi_15m   = RSI.calculate({ period: 14, values: closes15m });
            const atr_15m   = ATR.calculate({ high: highs15m, low: lows15m, close: closes15m, period: 14 });

            const curEma21_15m = ema21_15m[ema21_15m.length - 1];
            const curRsi_15m   = rsi_15m[rsi_15m.length - 1] || 50;
            const prevRsi_15m  = rsi_15m[rsi_15m.length - 2] || 50;
            const curAtr_15m   = atr_15m[atr_15m.length - 1] || 0;

            const last15m = klines15mSlice[klines15mSlice.length - 1];
            const vwap = calculateVWAP(klines15mSlice.slice(-Math.min(96, klines15mSlice.length)));

            // Gate 4: Pullback to EMA21 or VWAP
            const margin = curAtr_15m * 0.2;
            const nearEma21 = Math.abs(last15m.low - curEma21_15m) <= margin ||
                              Math.abs(last15m.high - curEma21_15m) <= margin ||
                              (last15m.low <= curEma21_15m && last15m.high >= curEma21_15m);
            const nearVwap  = Math.abs(last15m.low - vwap) <= margin ||
                              Math.abs(last15m.high - vwap) <= margin ||
                              (last15m.low <= vwap && last15m.high >= vwap);

            if (!nearEma21 && !nearVwap) continue;

            // ── Gate 5: RVOL Variant Logic ──────────────────────────────
            const volumes15m = klines15mSlice.map(k => k.volume);
            const prev20Vol  = volumes15m.slice(-22, -2);
            const avgVol     = prev20Vol.length > 0 ? prev20Vol.reduce((a, b) => a + b, 0) / prev20Vol.length : 1;
            const completedVol = volumes15m[volumes15m.length - 2] || volumes15m[volumes15m.length - 1];
            const rvol       = avgVol > 0 ? completedVol / avgVol : 0;

            if (variant.gate5HardRVOL) {
                const reqRvol = isMildChoppy ? 1.5 : 1.3;
                if (rvol < reqRvol) continue;
            }

            // ── Gate 6: Entry Timing Variant Logic ───────────────────────
            if (variant.gate6BreakoutConfirmation) {
                // Old logic: require 3-candle breakout + strong candle confirmation
                const highestOf3 = Math.max(...highs15m.slice(-4, -1));
                const lowestOf3  = Math.min(...lows15m.slice(-4, -1));
                const breakHigh  = last15m.close > highestOf3;
                const breakLow   = last15m.close < lowestOf3;
                const bodyPct    = Math.abs(last15m.close - last15m.open) / last15m.open * 100;
                const strongBull = last15m.close > last15m.open && bodyPct > 0.2;
                const strongBear = last15m.close < last15m.open && bodyPct > 0.2;

                let conf = 0;
                if (coinTrend === 'BULLISH') {
                    if (curRsi_15m > 45 && curRsi_15m > prevRsi_15m) conf++;
                    if (breakHigh) conf++;
                    if (strongBull) conf++;
                } else {
                    if (curRsi_15m < 55 && curRsi_15m < prevRsi_15m) conf++;
                    if (breakLow) conf++;
                    if (strongBear) conf++;
                }
                const reqConf = isMildChoppy ? 3 : 2;
                if (conf < reqConf) continue;
                if (coinTrend === 'BULLISH' && curRsi_15m > 68) continue;
                if (coinTrend === 'BEARISH' && curRsi_15m < 32) continue;
            } else {
                // New logic: Pullback reclaim + Directional RSI
                if (coinTrend === 'BULLISH') {
                    if (curRsi_15m > 68 || curRsi_15m < 44) continue;
                } else {
                    if (curRsi_15m < 32 || curRsi_15m > 56) continue;
                }
            }

            // ── Execute Entry ───────────────────────────────────────────
            const slDistance = 1.5 * curAtr_15m;
            const entryPrice = last15m.close;
            const stopLoss = coinTrend === 'BULLISH' ? entryPrice - slDistance : entryPrice + slDistance;

            const riskUSD = balance * RISK_PER_TRADE;
            let qty = riskUSD / slDistance;
            const maxNotional = balance * LEVERAGE;
            if (qty * entryPrice > maxNotional) qty = maxNotional / entryPrice;

            const openFee = qty * entryPrice * TAKER_FEE;
            balance -= openFee;

            positions.push({
                direction: coinTrend === 'BULLISH' ? 'LONG' : 'SHORT',
                entryPrice: entryPrice,
                stopLoss: stopLoss,
                initialStopLoss: stopLoss,
                qty: qty,
                atr: curAtr_15m,
                stage: 'INITIAL',
                peakPrice: entryPrice,
                troughPrice: entryPrice,
                maxFavorableR: 0,
                maxAdverseR: 0
            });
        }
    }

    return { balance, tradeHistory, maxDrawdownUSD };
}

async function main() {
    console.log(`=== FETCHING ${DAYS}-DAY HISTORICAL DATA ===`);
    const [btc4H, btc15m] = await Promise.all([
        fetchHistoricalKlines('BTCUSDT', '4h', DAYS),
        fetchHistoricalKlines('BTCUSDT', '15m', DAYS)
    ]);

    const { btcRegimeTimeline } = computeIndicators([], [], btc4H, btc15m);

    const coinData = {};
    for (const sym of SYMBOLS) {
        process.stdout.write(`Fetching ${sym}... `);
        const [k15m, k1h] = await Promise.all([
            fetchHistoricalKlines(sym, '15m', DAYS),
            fetchHistoricalKlines(sym, '1h', DAYS)
        ]);
        coinData[sym] = { k15m, k1h };
        console.log(`Done (${k15m.length} 15m bars, ${k1h.length} 1h bars)`);
    }

    const VARIANTS = [
        { name: '1. Baseline (Old Bot)', gate5HardRVOL: true, gate6BreakoutConfirmation: true, cooldownType: 'GLOBAL_2H' },
        { name: '2. Gate 6 Relaxed Only', gate5HardRVOL: true, gate6BreakoutConfirmation: false, cooldownType: 'GLOBAL_2H' },
        { name: '3. Gate 5 Changed Only', gate5HardRVOL: false, gate6BreakoutConfirmation: true, cooldownType: 'GLOBAL_2H' },
        { name: '4. Gate 5 + 6 Combined', gate5HardRVOL: false, gate6BreakoutConfirmation: false, cooldownType: 'GLOBAL_2H' },
        { name: '5. Current Live (G5+G6 + 2h Symbol SL Cooldown)', gate5HardRVOL: false, gate6BreakoutConfirmation: false, cooldownType: 'SYMBOL_SL_2H' }
    ];

    console.log(`
=== RUNNING BACKTEST SIMULATION OVER ${DAYS} DAYS ===
`);

    const results = [];

    for (const v of VARIANTS) {
        let allTrades = [];
        let totalNetPnl = 0;
        let maxDd = 0;

        for (const sym of SYMBOLS) {
            const res = runSimulation(sym, coinData[sym].k15m, coinData[sym].k1h, btc15m, btcRegimeTimeline, v);
            allTrades = allTrades.concat(res.tradeHistory);
            totalNetPnl += (res.balance - INITIAL_BALANCE);
            maxDd = Math.max(maxDd, res.maxDrawdownUSD);
        }

        const wins = allTrades.filter(t => t.pnl > 0);
        const losses = allTrades.filter(t => t.pnl <= 0);
        const winRate = allTrades.length > 0 ? (wins.length / allTrades.length) * 100 : 0;

        let grossWins = wins.reduce((a, b) => a + b.pnl, 0);
        let grossLosses = Math.abs(losses.reduce((a, b) => a + b.pnl, 0));
        const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? 999 : 0);

        const avgR = allTrades.length > 0 ? allTrades.reduce((a, b) => a + b.realizedR, 0) / allTrades.length : 0;
        const avgMFE = allTrades.length > 0 ? allTrades.reduce((a, b) => a + b.maxFavorableR, 0) / allTrades.length : 0;
        const avgMAE = allTrades.length > 0 ? allTrades.reduce((a, b) => a + b.maxAdverseR, 0) / allTrades.length : 0;
        const expectancyUSD = allTrades.length > 0 ? totalNetPnl / allTrades.length : 0;

        results.push({
            variant: v.name,
            trades: allTrades.length,
            winRate: winRate.toFixed(1) + '%',
            profitFactor: profitFactor.toFixed(2),
            avgR: avgR.toFixed(2) + 'R',
            avgMFE: avgMFE.toFixed(2) + 'R',
            avgMAE: avgMAE.toFixed(2) + 'R',
            netPnL: '$' + totalNetPnl.toFixed(2),
            maxDrawdown: '$' + maxDd.toFixed(2),
            expectancy: '$' + expectancyUSD.toFixed(2)
        });
    }

    console.table(results);
    fs.writeFileSync(path.join(__dirname, 'backtest_comparison_results.json'), JSON.stringify(results, null, 2));
}

if (require.main === module) {
    main().catch(console.error);
}
