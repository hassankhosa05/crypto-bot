const express = require('express');
const path = require('path');
const fs = require('fs');
const { TAKE_PROFIT_PCT, STOP_LOSS_PCT } = require('./paperTrader');

const STATE_FILE = path.join(__dirname, 'portfolio.json');
const PRICES_FILE = path.join(__dirname, 'currentPrices.json');

function readJsonSafe(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function startDashboard(port = 3000) {
    const app = express();
    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/api/state', (req, res) => {
        const state = readJsonSafe(STATE_FILE, {
            balance: 0,
            initialBalance: 0,
            positions: {},
            tradeHistory: []
        });
        const pricesPayload = readJsonSafe(PRICES_FILE, { prices: {}, lastUpdate: null });
        res.json({
            ...state,
            currentPrices: pricesPayload.prices || {},
            lastUpdate: pricesPayload.lastUpdate || null,
            risk: {
                takeProfitPct: TAKE_PROFIT_PCT,
                stopLossPct: STOP_LOSS_PCT
            }
        });
    });

    app.listen(port, () => {
        console.log(`Dashboard running at http://localhost:${port}`);
    });
}

module.exports = { startDashboard };
