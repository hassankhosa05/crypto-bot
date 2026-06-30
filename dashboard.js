const express = require('express');
const path = require('path');
const { buildReport, regimeFlips } = require('./monitor');

let serverInstance = null;

function startDashboard(port = process.env.PORT || 3000, trader) {
    if (serverInstance) {
        console.log('Dashboard server is already running.');
        return serverInstance;
    }

    const app = express();
    app.use(express.static(path.join(__dirname, 'public')));

    // app.get('/ping', (req, res) => res.send('OK'));

    app.get('/api/state', (req, res) => {
        if (!trader) {
            return res.status(500).json({ error: 'Trader instance not provided' });
        }
        res.json({
            ...trader.state,
            lastUpdate: new Date().toISOString()
        });
    });

    // Paper-health monitor — computed from in-memory state, no second process.
    app.get('/monitor', (req, res) => {
        if (!trader) return res.status(500).json({ error: 'Trader instance not provided' });
        const universe = typeof trader.loadUniverse === 'function' ? trader.loadUniverse() : null;
        const rep = buildReport(trader.state, universe);

        let recentEvaluations = [];
        try {
            const fs = require('fs');
            const evalPath = path.join(__dirname, 'trade_evaluations.jsonl');
            if (fs.existsSync(evalPath)) {
                const lines = fs.readFileSync(evalPath, 'utf8').trim().split('\n');
                recentEvaluations = lines.slice(-100).filter(l => l).map(l => {
                    try { return JSON.parse(l); } catch(e) { return null; }
                }).filter(Boolean);
            }
        } catch(e) {
            console.error("Error reading trade evaluations:", e.message);
        }

        res.json({
            ts: new Date().toISOString(),
            regime: rep.regime,
            regimeFlips: regimeFlips().flips,
            recentEvaluations: recentEvaluations.reverse(),
            overall: rep.overall,
            perCoin: rep.rows.reduce((acc, r) => {
                acc[r.coin] = { ...r.live, holdoutPf: r.holdoutPf, decay: r.decay, flag: r.flag };
                return acc;
            }, {})
        });
    });

    const host = process.env.BIND_IP || '0.0.0.0';
    serverInstance = app.listen(port, host, () => {
        console.log(`Dashboard running at http://${host}:${port}`);
    });

    return serverInstance;
}

module.exports = { startDashboard };
