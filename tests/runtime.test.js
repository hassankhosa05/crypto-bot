const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const binancePath = require.resolve('../binanceApi');

require.cache[binancePath] = {
    id: binancePath,
    filename: binancePath,
    loaded: true,
    exports: {
        getAccountInfo: async () => ({ balances: [{ asset: "USDT", free: "123.45", locked: "0" }] }),
        getUSDTBalance: async () => 123.45,
        placeMarketOrder: async () => ({ executedQty: '1' }),
        placeLimitOrder: async () => ({ orderId: 1 }),
        placeOcoSellOrder: async () => ({ orderListId: 99 }),
        cancelOrder: async () => ({}),
        cancelOrderList: async () => ({}),
        getOrderStatus: async () => ({ status: 'FILLED', executedQty: '1', price: '100' })
    }
};

const { TRADING_CONFIG, getRiskDistance, getTakeProfitDistance } = require('../tradingConfig');
const { createPosition, updateSimulatedPosition } = require('../tradeSimulation');
const LiveTrader = require('../liveTrader');

async function testLiveStartupState() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crypto-bot-test-'));
    const previousCwd = process.cwd();
    process.chdir(tmp);

    try {
        const trader = new LiveTrader();
        await new Promise(resolve => setTimeout(resolve, 0));

        assert.strictEqual(trader.state.balance, 123.45);
        assert.strictEqual(trader.state.initialBalance, 123.45);
        assert.ok(fs.existsSync(path.join(tmp, 'live_state.json')));
    } finally {
        process.chdir(previousCwd);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

function testSharedRiskModel() {
    const atr = 2;
    const price = 100;

    assert.strictEqual(TRADING_CONFIG.timeframe, '15m');
    assert.strictEqual(getRiskDistance(atr, price), atr * TRADING_CONFIG.stopAtrMultiplier);
    assert.strictEqual(getTakeProfitDistance(atr), atr * TRADING_CONFIG.takeProfitAtrMultiplier);
}

function testSimulatedFillCosts() {
    const position = createPosition({
        symbol: 'TESTUSDT',
        balance: 1000,
        price: 100,
        atr: 2,
        fixedTradeUSD: 100
    });

    assert.ok(position.entryPrice > 100);
    const update = updateSimulatedPosition(position, {
        close: position.tp1Price,
        high: position.tp1Price * 1.01,
        low: position.entryPrice,
        timestamp: Date.now()
    });

    assert.strictEqual(update.closed, true);
    assert.ok(position.feeTracker > position.entryFee);
}

async function run() {
    testSharedRiskModel();
    testSimulatedFillCosts();
    await testLiveStartupState();
    console.log('runtime tests passed');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
