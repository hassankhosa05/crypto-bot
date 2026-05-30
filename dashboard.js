const express = require('express');
const path = require('path');

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

    const host = process.env.BIND_IP || '127.0.0.1';
    serverInstance = app.listen(port, host, () => {
        console.log(`Dashboard running at http://${host}:${port}`);
    });

    return serverInstance;
}

module.exports = { startDashboard };
