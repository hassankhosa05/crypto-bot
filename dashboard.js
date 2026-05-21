// ==========================================
// File: dashboard.js
// ==========================================
const express = require('express');
const path = require('path');
const fs = require('fs');

function startDashboard(port = 3000) {
    const app = express();
    
    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/api/state', (req, res) => {
        try {
            const state = JSON.parse(fs.readFileSync('portfolio.json', 'utf8'));
            res.json(state);
        } catch (e) {
            res.json({ balance: 0, positions: {}, tradeHistory: [] });
        }
    });

    app.listen(port, () => {
        console.log(`Dashboard running at http://localhost:${port}`);
    });
}

module.exports = { startDashboard };
