const { BollingerBands, RSI } = require('technicalindicators');

// Strategy 1: Mean Reversion (Bollinger Bands)
// Buys when price crosses below lower band, sells when crossing middle band
function executeBollingerStrategy(historicalData) {
    if (!historicalData || historicalData.length < 20) return null;

    const closes = historicalData.map(d => d.close);
    
    const bb = BollingerBands.calculate({
        period: 20,
        values: closes,
        stdDev: 2
    });

    if (bb.length < 2) return null;

    const currentPrice = closes[closes.length - 1];
    const previousPrice = closes[closes.length - 2];
    const currentBB = bb[bb.length - 1];
    const previousBB = bb[bb.length - 2];

    // Buy signal: Price crossed below lower band recently and is starting to turn up
    if (previousPrice <= previousBB.lower && currentPrice > currentBB.lower) {
        return 'BUY';
    }

    // Sell signal: Price reaches or crosses middle band (mean)
    if (currentPrice >= currentBB.middle) {
        return 'SELL';
    }

    return 'HOLD';
}

// Strategy 2: Momentum / Volume Breakout
// Buys when volume spikes significantly alongside a price increase
function executeVolumeBreakoutStrategy(historicalData) {
    if (!historicalData || historicalData.length < 10) return null;

    // Calculate moving average of volume for the last 10 periods
    const recentData = historicalData.slice(-10);
    const avgVolume = recentData.reduce((sum, d) => sum + d.volume, 0) / 10;
    
    const currentData = historicalData[historicalData.length - 1];
    const previousData = historicalData[historicalData.length - 2];

    // Volume is 3x the average and price increased
    if (currentData.volume > avgVolume * 3 && currentData.close > previousData.close) {
        return 'BUY';
    }

    // Sell if momentum drops (volume normalizes or price drops)
    if (currentData.volume < avgVolume * 1.5 || currentData.close < previousData.close) {
         return 'SELL';
    }

    return 'HOLD';
}

// Strategy 3: Range Trading (RSI)
// Buys when oversold (< 30) and turning up, sells when overbought (> 70)
function executeRSIStrategy(historicalData) {
     if (!historicalData || historicalData.length < 15) return null;

     const closes = historicalData.map(d => d.close);
     
     const rsiValues = RSI.calculate({
         period: 14,
         values: closes
     });

     if (rsiValues.length < 2) return null;

     const currentRSI = rsiValues[rsiValues.length - 1];
     const previousRSI = rsiValues[rsiValues.length - 2];

     // Buy signal: RSI was oversold and is now rising
     if (previousRSI < 30 && currentRSI > 30) {
         return 'BUY';
     }

     // Sell signal: RSI is overbought
     if (currentRSI > 70) {
         return 'SELL';
     }

     return 'HOLD';
}

module.exports = {
    executeBollingerStrategy,
    executeVolumeBreakoutStrategy,
    executeRSIStrategy
};
