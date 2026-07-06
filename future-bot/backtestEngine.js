const { evaluateTradeV2, checkEmergencyExitV2 } = require('./strategyV2');
const {
    createPosition,
    updateSimulatedPosition,
    closePositionAt,
    createStatsTracker,
    recordTrade,
    finalizeStats
} = require('./tradeSimulation');

function calculateTestedDays(data, startIndex, endIndex) {
    if (endIndex <= startIndex || !data[startIndex] || !data[endIndex - 1]) return 0;
    return Math.max(1, (data[endIndex - 1].timestamp - data[startIndex].timestamp) / (24 * 60 * 60 * 1000));
}

function simulateSymbol(data, options = {}) {
    const {
        symbol,
        startIndex = 400,
        endIndex = data.length,
        initialBalance = 1000,
        fixedTradeUSD = null,
        universe = null,
        minNotional = 5,
        regime = 'TRENDING'
    } = options;

    let balance = initialBalance;
    let position = null;
    const stats = createStatsTracker();
    stats.peakEquity = initialBalance;

    for (let i = startIndex; i < endIndex; i++) {
        const slice = data.slice(0, i + 1);
        const candle = slice[slice.length - 1];

        if (!position) {
            const result = evaluateTradeV2({ symbol, current_price: candle.close }, slice, regime);
            if (result.signal !== 'BUY') continue;

            const nextPosition = createPosition({
                symbol,
                balance,
                price: candle.close,
                atr: result.atr,
                universe,
                minNotional,
                fixedTradeUSD
            });

            if (!nextPosition) continue;

            position = nextPosition;
            balance -= position.tradeAmountUSD + position.entryFee;
        } else {
            const emergencyExit = checkEmergencyExitV2(slice, position.entryPrice, position.atr);
            const update = updateSimulatedPosition(position, candle, emergencyExit);
            balance += update.exitCash;

            if (update.closed) {
                recordTrade(stats, position.pnlTracker, position.feeTracker, candle.timestamp, balance);
                position = null;
            }
        }
    }

    if (position && position.remainingSize > 0) {
        const finalCandle = data[endIndex - 1];
        balance += closePositionAt(position, finalCandle.close);
        recordTrade(stats, position.pnlTracker, position.feeTracker, finalCandle.timestamp, balance);
    }

    const testedDays = calculateTestedDays(data, startIndex, endIndex);
    const finalized = finalizeStats(stats, testedDays);

    return {
        ...finalized,
        tradesCount: finalized.trades,
        pf: finalized.profitFactor,
        netPnL: balance - initialBalance,
        testedDays,
        endingBalance: balance,
        netPnl: balance - initialBalance,
        roi: initialBalance > 0 ? (balance - initialBalance) / initialBalance : 0
    };
}

// 2-way split: train (first trainSplit%) / forward (remaining%)
function simulateWalkForward(data, options = {}) {
    const warmup = options.warmupCandles || 300;
    const split = options.trainSplit || 0.7;
    const tradableLength = data.length - warmup;
    const splitIndex = warmup + Math.floor(tradableLength * split);

    if (splitIndex <= warmup || splitIndex >= data.length - 5) return null;

    return {
        train:   simulateSymbol(data, { ...options, startIndex: warmup,      endIndex: splitIndex }),
        forward: simulateSymbol(data, { ...options, startIndex: splitIndex,  endIndex: data.length })
    };
}

// 3-way split: train (60%) / validate (20%) / holdout (20%)
// validate is used for threshold checks; holdout is a true unseen confirmation window.
function simulateThreeWay(data, options = {}) {
    const warmup = options.warmupCandles || 300;
    const tradable = data.length - warmup;
    const trainEnd    = warmup + Math.floor(tradable * 0.60);
    const validateEnd = warmup + Math.floor(tradable * 0.80);

    if (trainEnd <= warmup || validateEnd <= trainEnd || validateEnd >= data.length - 5) return null;

    return {
        train:    simulateSymbol(data, { ...options, startIndex: warmup,       endIndex: trainEnd }),
        validate: simulateSymbol(data, { ...options, startIndex: trainEnd,     endIndex: validateEnd }),
        holdout:  simulateSymbol(data, { ...options, startIndex: validateEnd,  endIndex: data.length })
    };
}

module.exports = {
    calculateTestedDays,
    simulateSymbol,
    simulateWalkForward,
    simulateThreeWay
};
