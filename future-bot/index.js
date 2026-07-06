require('dotenv').config();
const { startDashboard } = require('./dashboard');
const { LiveFuturesTrader } = require('./liveTrader');
const { PaperFuturesTrader } = require('./paperFuturesTrader');

let trader;
if (process.env.TRADE_MODE === 'LIVE') {
    console.log("!!! RUNNING IN LIVE TRADING MODE (REAL MONEY) !!!");
    trader = new LiveFuturesTrader();
} else {
    console.log("Running in PAPER TRADING MODE with $1000 initial balance");
    trader = new PaperFuturesTrader(1000);
}

// Run every minute
setInterval(() => {
    trader.runCycle().catch(console.error);
}, 60000);
trader.runCycle(); // initial run

// Start dashboard on port 3001
startDashboard(3001, trader);

// Run universe selector daily at UTC midnight
function scheduleUniverseRotation() {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(24, 0, 0, 0); // Next UTC midnight
    const delay = next.getTime() - now.getTime();
    
    setTimeout(async () => {
        try {
            const { runSelector } = require('./universeSelector');
            await runSelector();
        } catch (e) {
            console.error('Universe rotation failed:', e.message);
        }
        scheduleUniverseRotation();
    }, delay);
}
scheduleUniverseRotation();
