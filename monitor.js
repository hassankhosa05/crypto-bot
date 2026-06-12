#!/usr/bin/env node
/**
 * monitor.js — Paper-trading health monitor.
 *
 * Answers the only question that matters during the paper-forward window:
 *   "Does LIVE PAPER expectancy match the HOLDOUT backtest, or is it decaying?"
 *
 * Reads:
 *   - portfolio.json        (live paper trade history)
 *   - active_universe.json  (holdout PF per coin, set by universeSelector)
 *
 * Usage:
 *   node monitor.js               # full report
 *   node monitor.js --json        # machine-readable, for cron/append-to-log
 *   node monitor.js --coin BTCUSDT
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const STATE_FILE = path.join(DATA_DIR, 'portfolio.json');
const UNIVERSE_FILE = path.join(DATA_DIR, 'active_universe.json');
const REGIME_LOG = path.join(DATA_DIR, 'regime_log.jsonl');

// Minimum closed trades before paper results carry statistical weight.
const TRADE_SAMPLE_TARGET = 100;
// How far live PF may fall below holdout PF before we flag overfit decay.
const PF_DECAY_WARN_RATIO = 0.75; // livePf < holdoutPf * 0.75  => warn

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { return null; }
}

/** Count regime transitions (flips) from the append-only regime log. */
function regimeFlips() {
    try {
        const lines = fs.readFileSync(REGIME_LOG, 'utf8').trim().split('\n').filter(Boolean);
        const regimes = lines.map(l => JSON.parse(l).regime);
        let flips = 0;
        for (let i = 1; i < regimes.length; i++) {
            if (regimes[i] !== regimes[i - 1]) flips++;
        }
        return { flips, snapshots: regimes.length, sequence: regimes };
    } catch (e) {
        return { flips: 0, snapshots: 0, sequence: [] };
    }
}

function profitFactor(pnls) {
    let gross = 0, loss = 0;
    for (const p of pnls) {
        if (p > 0) gross += p;
        else loss += Math.abs(p);
    }
    if (loss === 0) return gross > 0 ? Infinity : 0;
    return gross / loss;
}

function fmt(n, d = 2) {
    if (n === Infinity) return '∞';
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    return n.toFixed(d);
}

/**
 * Build per-coin and overall closing-trade stats from tradeHistory.
 * Only SELL and PARTIAL_SELL rows carry realized pnl.
 */
function computeStats(state) {
    const closes = (state.tradeHistory || []).filter(
        t => (t.action === 'SELL' || t.action === 'PARTIAL_SELL') && typeof t.pnl === 'number'
    );

    const byCoin = {};
    for (const t of closes) {
        (byCoin[t.coin] = byCoin[t.coin] || []).push(t);
    }

    const perCoin = {};
    for (const [coin, trades] of Object.entries(byCoin)) {
        const pnls = trades.map(t => t.pnl);
        const wins = pnls.filter(p => p > 0).length;
        const net = pnls.reduce((a, b) => a + b, 0);
        perCoin[coin] = {
            trades: trades.length,
            pf: profitFactor(pnls),
            winRate: trades.length ? wins / trades.length : 0,
            netPnL: net,
            expectancy: trades.length ? net / trades.length : 0
        };
    }

    const allPnls = closes.map(t => t.pnl);
    const overall = {
        trades: closes.length,
        pf: profitFactor(allPnls),
        winRate: allPnls.length ? allPnls.filter(p => p > 0).length / allPnls.length : 0,
        netPnL: allPnls.reduce((a, b) => a + b, 0),
        expectancy: allPnls.length ? allPnls.reduce((a, b) => a + b, 0) / allPnls.length : 0
    };

    return { perCoin, overall, closes };
}

function buildReport(state, universe) {
    const { perCoin, overall } = computeStats(state);
    const uCoins = (universe && universe.coins) || {};

    const rows = Object.keys(perCoin).map(coin => {
        const live = perCoin[coin];
        const holdoutPf = uCoins[coin] ? uCoins[coin].holdoutPf : null;
        let decay = null, flag = '';
        if (holdoutPf && holdoutPf > 0 && live.pf !== Infinity) {
            decay = live.pf / holdoutPf;
            if (decay < PF_DECAY_WARN_RATIO) flag = 'OVERFIT?';
        }
        if (live.pf < 1.0) flag = flag ? flag + ' LOSING' : 'LOSING';
        return { coin, live, holdoutPf, decay, flag };
    });
    rows.sort((a, b) => b.live.trades - a.live.trades);

    return { rows, overall, regime: universe ? universe.regime : null };
}

function printReport(rep, state) {
    const { rows, overall } = rep;

    console.log('\n=== PAPER-TRADING MONITOR ===');
    console.log(`Regime (universe snapshot): ${rep.regime || 'unknown'}`);
    console.log(`Balance: $${fmt(state.balance)}  |  Initial: $${fmt(state.initialBalance)}  |  Open positions: ${Object.keys(state.positions || {}).length}`);
    console.log(`Daily losses: ${state.dailyLosses ?? 0}  |  Daily drawdown: $${fmt(state.dailyDrawdownUSD ?? 0)}\n`);

    console.log('--- OVERALL ---');
    console.log(`Closed trades: ${overall.trades} / ${TRADE_SAMPLE_TARGET} target`);
    if (overall.trades < TRADE_SAMPLE_TARGET) {
        console.log(`  ⚠ Sample too small — results are NOISE until ≥${TRADE_SAMPLE_TARGET} trades across ≥1 regime flip.`);
    }
    console.log(`Profit factor: ${fmt(overall.pf)}   Win rate: ${fmt(overall.winRate * 100, 1)}%`);
    console.log(`Net P/L: $${fmt(overall.netPnL)}   Expectancy/trade: $${fmt(overall.expectancy)}`);
    if (overall.expectancy <= 0 && overall.trades > 0) {
        console.log('  ⚠ NEGATIVE/ZERO expectancy — no edge. Do NOT deploy real capital.');
    }

    console.log('\n--- PER COIN (live paper vs backtest holdout) ---');
    console.log('coin'.padEnd(12) + 'trades'.padEnd(8) + 'livePF'.padEnd(9) + 'holdPF'.padEnd(9) + 'decay'.padEnd(8) + 'win%'.padEnd(7) + 'netPnL'.padEnd(10) + 'flag');
    for (const r of rows) {
        console.log(
            r.coin.padEnd(12) +
            String(r.live.trades).padEnd(8) +
            fmt(r.live.pf).padEnd(9) +
            (r.holdoutPf !== null ? fmt(r.holdoutPf) : '—').padEnd(9) +
            (r.decay !== null ? fmt(r.decay) : '—').padEnd(8) +
            fmt(r.live.winRate * 100, 0).padEnd(7) +
            ('$' + fmt(r.live.netPnL)).padEnd(10) +
            (r.flag || '')
        );
    }

    const rf = regimeFlips();
    console.log('\n--- REGIME COVERAGE ---');
    console.log(`Universe refreshes logged: ${rf.snapshots}  |  Regime flips observed: ${rf.flips}`);
    if (rf.flips < 1) {
        console.log('  ⚠ No regime flip yet. Edge unproven across regimes — keep running.');
    }

    console.log('\nGO-LIVE GATE (all must hold):');
    const gates = [
        [`≥${TRADE_SAMPLE_TARGET} closed trades`, overall.trades >= TRADE_SAMPLE_TARGET],
        ['≥1 regime flip observed', rf.flips >= 1],
        ['overall expectancy > 0', overall.expectancy > 0],
        ['overall PF ≥ 1.1', overall.pf >= 1.1]
    ];
    for (const [label, ok] of gates) console.log(`  [${ok ? 'x' : ' '}] ${label}`);
    const ready = gates.every(g => g[1]);
    console.log(`\n  => ${ready ? 'Gates PASSED — candidate for small real-capital test.' : 'NOT ready for real capital.'}\n`);

    console.log('Interpretation: decay = livePF / holdoutPF. ~1.0 = paper matches backtest;');
    console.log(`  < ${PF_DECAY_WARN_RATIO} = live edge decaying vs backtest = residual overfit.\n`);
}

function main() {
    const args = process.argv.slice(2);
    const state = readJson(STATE_FILE);
    if (!state) {
        console.error(`Could not read ${STATE_FILE}`);
        process.exit(1);
    }
    const universe = readJson(UNIVERSE_FILE); // may be null if not yet generated
    const rep = buildReport(state, universe);

    if (args.includes('--json')) {
        console.log(JSON.stringify({
            ts: new Date().toISOString(),
            regime: rep.regime,
            regimeFlips: regimeFlips().flips,
            overall: rep.overall,
            perCoin: rep.rows.reduce((acc, r) => {
                acc[r.coin] = { ...r.live, holdoutPf: r.holdoutPf, decay: r.decay, flag: r.flag };
                return acc;
            }, {})
        }));
        return;
    }

    const coinFilter = args.includes('--coin') ? args[args.indexOf('--coin') + 1] : null;
    if (coinFilter) {
        rep.rows = rep.rows.filter(r => r.coin === coinFilter);
    }
    printReport(rep, state);
}

if (require.main === module) main();

module.exports = { computeStats, profitFactor, buildReport, regimeFlips };
