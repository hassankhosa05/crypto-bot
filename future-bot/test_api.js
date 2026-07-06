require('dotenv').config();
const { getUSDTBalance, testOrder } = require('./binanceApi');

async function runTest() {
    console.log("Testing Binance API Keys...");
    try {
        const balance = await getUSDTBalance();
        console.log(`✅ SUCCESS! Keys are valid. Your USDT Balance is: $${balance.toFixed(2)}`);
        
        console.log("Testing test endpoint with a fake order...");
        await testOrder('BTCUSDT', 'BUY', 0.0005);
        console.log("✅ SUCCESS! Trading permissions are valid. The API accepted the test order.");
    } catch(e) {
        console.error("❌ FAILED:", e.response ? JSON.stringify(e.response.data) : e.message);
    }
}
runTest();
