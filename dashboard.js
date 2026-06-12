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

    app.get('/ping', (req, res) => res.send('OK'));

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
        res.json({
            ts: new Date().toISOString(),
            regime: rep.regime,
            regimeFlips: regimeFlips().flips,
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
