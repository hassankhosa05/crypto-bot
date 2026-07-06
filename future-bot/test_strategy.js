const { evaluateTradeV2 } = require('./strategyV2');
const { simulateSymbol } = require('./backtestEngine');
const axios = require('axios');

async function testSingle() {
    const symbol = 'SOLUSDT';
    console.log(`Fetching 1000 candles for ${symbol}...`);
    const response = await axios.get(`https://api.binance.com/api/v3/klines`, {
        params: {
            symbol: symbol,
            interval: '15m',
            limit: 1000
        }
    });

    const data = response.data.map(d => ({
        timestamp: d[0],
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4]),
        volume: parseFloat(d[5])
    }));

    console.log(`Running simulation...`);
    const result = simulateSymbol(data, { symbol, startIndex: 400 });
    console.log(JSON.stringify(result, null, 2));

    // Also run evaluations for the last few candles to see what they look like
    console.log('\n--- Last 5 Evaluations ---');
    for (let i = data.length - 5; i < data.length; i++) {
        const slice = data.slice(Math.max(0, i - 400), i + 1);
        const candle = slice[slice.length - 1];
        const res = evaluateTradeV2({ symbol, current_price: candle.close }, slice);
        console.log(`Candle Close: ${candle.close} | Signal: ${res.signal} | FailedReason: ${res.failedReason || 'None'} | Meta: ${JSON.stringify(res.meta || {})}`);
    }
}

testSingle().catch(console.error);
