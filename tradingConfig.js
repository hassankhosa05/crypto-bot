const TRADING_CONFIG = {
    timeframe: '15m',
    warmupCandles: 300,
    historyCandles: 2880,
    feeRate: 0.001,
    slippagePct: 0.0005,
    spreadPct: 0.0008,
    entryLimitBufferPct: 0.001,
    limitOrderWaitMs: 3000,
    riskPct: 0.02,
    tier2RiskPct: 0.01,
    choppyRiskMultiplier: 0.5,
    maxPositionPct: 0.2,
    maxBalanceUsePct: 0.95,
    minTradeUSD: 5,
    stopAtrMultiplier: 1.2,
    takeProfitAtrMultiplier: 1.5,
    takeProfit2AtrMultiplier: 3.0,
    // Sell half at TP1, trail the runner — keeps the move-to-breakeven code live
    // takeProfitFraction disabled — full position kept for trailing stop
    trailingAtrMultiplier: 1.0,
    stopLimitBufferPct: 0.001,
    dailyMaxDrawdownPct: 0.03,
    dailyMaxLosses: 3,
    maxConcurrentPositions: 3
};

function getRiskPctForSymbol(universe, symbol) {
    let riskPct = TRADING_CONFIG.riskPct;

    if (universe && universe.coins && universe.coins[symbol]?.tier === 2) {
        riskPct = TRADING_CONFIG.tier2RiskPct;
    }

    if (universe && universe.regime === 'CHOPPY') {
        riskPct *= TRADING_CONFIG.choppyRiskMultiplier;
    }

    return riskPct;
}

function getRiskDistance(atr, currentPrice) {
    return Math.max(
        atr * TRADING_CONFIG.stopAtrMultiplier,
        currentPrice * TRADING_CONFIG.slippagePct * 10
    );
}

function getTakeProfitDistance(atr) {
    return atr * TRADING_CONFIG.takeProfitAtrMultiplier;
}

function getTradeAmountUSD(balance, currentPrice, atr, universe, symbol, minNotional = TRADING_CONFIG.minTradeUSD) {
    const riskPct = getRiskPctForSymbol(universe, symbol);
    const riskUSD = balance * riskPct;
    const stopDistance = getRiskDistance(atr, currentPrice);
    let tradeAmountUSD = (riskUSD / stopDistance) * currentPrice;

    tradeAmountUSD = Math.min(
        tradeAmountUSD,
        balance * TRADING_CONFIG.maxPositionPct,
        balance * TRADING_CONFIG.maxBalanceUsePct
    );

    if (tradeAmountUSD < Math.max(TRADING_CONFIG.minTradeUSD, minNotional)) {
        return 0;
    }

    return tradeAmountUSD;
}

module.exports = {
    TRADING_CONFIG,
    getRiskPctForSymbol,
    getRiskDistance,
    getTakeProfitDistance,
    getTradeAmountUSD
};
