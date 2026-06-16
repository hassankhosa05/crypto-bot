const { TRADING_CONFIG, getRiskDistance, getTakeProfitDistance, getTradeAmountUSD } = require('./tradingConfig');

function applyBuyFill(price) {
    return price * (1 + TRADING_CONFIG.spreadPct / 2 + TRADING_CONFIG.slippagePct);
}

function applySellFill(price) {
    return price * (1 - TRADING_CONFIG.spreadPct / 2 - TRADING_CONFIG.slippagePct);
}

function createPosition({ symbol, balance, price, atr, universe, minNotional, fixedTradeUSD }) {
    const tradeAmountUSD = fixedTradeUSD || getTradeAmountUSD(balance, price, atr, universe, symbol, minNotional);
    if (!tradeAmountUSD) return null;

    const entryPrice = applyBuyFill(price);
    const entryFee = tradeAmountUSD * TRADING_CONFIG.feeRate;
    const amount = tradeAmountUSD / entryPrice;
    
    const riskDist = atr * 1.2; // SL = 1.2 x ATR
    const slPrice = entryPrice - riskDist;
    const tp1Price = entryPrice + (atr * 1.5); // TP1 = 1.5 x ATR
    const tp2Price = entryPrice + (atr * 3.0); // TP2 = 3.0 x ATR

    return {
        symbol,
        amount,
        totalSize: amount,
        remainingSize: amount,
        entryPrice,
        entryFee,
        tradeAmountUSD,
        atr,
        riskDist,
        slPrice,
        tp1Price,
        tp2Price,
        tp1Hit: false,
        pnlTracker: -entryFee,
        feeTracker: entryFee
    };
}

function sellValue(position, amount, rawPrice) {
    const fillPrice = applySellFill(rawPrice);
    const gross = amount * fillPrice;
    const fee = gross * TRADING_CONFIG.feeRate;
    const pnl = gross - fee - (amount * position.entryPrice);

    return { fillPrice, gross, fee, pnl, net: gross - fee };
}

function updateSimulatedPosition(position, candle, emergencyExit = false) {
    let exitCash = 0;
    let closed = false;
    const events = [];

    // 1. Advance trailing stop only after TP1 has been hit
    if (position.tp1Hit) {
        // trail at 1 x ATR
        position.slPrice = Math.max(
            position.slPrice,
            candle.close - (position.atr * 1.0)
        );
    }

    const slTriggered = candle.low <= position.slPrice;
    const tp1Triggered = !position.tp1Hit && candle.high >= position.tp1Price;
    const tp2Triggered = position.tp1Hit && candle.high >= position.tp2Price;

    // 2. Handle same-candle SL and TP conflicts
    if (tp1Triggered && slTriggered) {
        // 50/50 probability choice to prevent lookahead bias
        if (Math.random() < 0.5) {
            // TP1 hits first
            position.tp1Hit = true;
            const sellAmount = position.totalSize * 0.5;
            const sale = sellValue(position, sellAmount, position.tp1Price);
            position.remainingSize -= sellAmount;
            position.pnlTracker += sale.pnl;
            position.feeTracker += sale.fee;
            exitCash += sale.net;
            
            // Move stop to breakeven
            position.slPrice = Math.max(position.slPrice, position.entryPrice);
            events.push('TP1');

            // Recheck if remaining size stops out on same candle
            if (position.remainingSize > 0.0001 && candle.low <= position.slPrice) {
                const slSale = sellValue(position, position.remainingSize, position.slPrice);
                position.pnlTracker += slSale.pnl;
                position.feeTracker += slSale.fee;
                exitCash += slSale.net;
                position.remainingSize = 0;
                closed = true;
                events.push('Stop');
            }
        } else {
            // SL hits first — closes full position
            const sale = sellValue(position, position.remainingSize, position.slPrice);
            position.pnlTracker += sale.pnl;
            position.feeTracker += sale.fee;
            exitCash += sale.net;
            position.remainingSize = 0;
            closed = true;
            events.push('Stop');
        }
    } else if (tp2Triggered && slTriggered) {
        if (Math.random() < 0.5) {
            // TP2 hits first
            const sale = sellValue(position, position.remainingSize, position.tp2Price);
            position.pnlTracker += sale.pnl;
            position.feeTracker += sale.fee;
            exitCash += sale.net;
            position.remainingSize = 0;
            closed = true;
            events.push('TP2');
        } else {
            // SL hits first
            const sale = sellValue(position, position.remainingSize, position.slPrice);
            position.pnlTracker += sale.pnl;
            position.feeTracker += sale.fee;
            exitCash += sale.net;
            position.remainingSize = 0;
            closed = true;
            events.push('Stop');
        }
    } else if (slTriggered) {
        // Normal stop loss
        const sale = sellValue(position, position.remainingSize, position.slPrice);
        position.pnlTracker += sale.pnl;
        position.feeTracker += sale.fee;
        exitCash += sale.net;
        position.remainingSize = 0;
        closed = true;
        events.push('Stop');
    } else if (emergencyExit) {
        // Emergency exit
        const sale = sellValue(position, position.remainingSize, candle.close);
        position.pnlTracker += sale.pnl;
        position.feeTracker += sale.fee;
        exitCash += sale.net;
        position.remainingSize = 0;
        closed = true;
        events.push('Emergency');
    } else {
        // 3. Normal execution check
        if (tp1Triggered) {
            position.tp1Hit = true;
            const sellAmount = position.totalSize * 0.5;
            const sale = sellValue(position, sellAmount, position.tp1Price);
            position.remainingSize -= sellAmount;
            position.pnlTracker += sale.pnl;
            position.feeTracker += sale.fee;
            exitCash += sale.net;
            
            // Move stop to breakeven
            position.slPrice = Math.max(position.slPrice, position.entryPrice);
            events.push('TP1');

            // In extreme cases, did the same candle also breach TP2?
            if (candle.high >= position.tp2Price) {
                const sale2 = sellValue(position, position.remainingSize, position.tp2Price);
                position.pnlTracker += sale2.pnl;
                position.feeTracker += sale2.fee;
                exitCash += sale2.net;
                position.remainingSize = 0;
                closed = true;
                events.push('TP2');
            }
        } else if (tp2Triggered) {
            const sale = sellValue(position, position.remainingSize, position.tp2Price);
            position.pnlTracker += sale.pnl;
            position.feeTracker += sale.fee;
            exitCash += sale.net;
            position.remainingSize = 0;
            closed = true;
            events.push('TP2');
        }
    }

    if (position.remainingSize <= 0.0001) {
        closed = true;
    }

    return { closed, exitCash, events };
}

function closePositionAt(position, price) {
    const sale = sellValue(position, position.remainingSize, price);
    position.pnlTracker += sale.pnl;
    position.feeTracker += sale.fee;
    position.remainingSize = 0;
    return sale.net;
}

function createStatsTracker() {
    return {
        trades: 0,
        wins: 0,
        grossWin: 0,
        grossLoss: 0,
        totalFees: 0,
        totalPnl: 0,
        peakEquity: 0,
        maxDrawdown: 0,
        firstTradeTs: null,
        lastTradeTs: null,
        avgWin: 0,
        avgLoss: 0,
        profitFactor: 0,
        winRate: 0,
        tradesPerMonth: 0,
        avgDaysBetweenTrades: 999
    };
}

function recordTrade(stats, pnl, fees, timestamp, equity) {
    stats.trades += 1;
    stats.totalFees += fees;
    stats.totalPnl += pnl;
    if (pnl > 0) {
        stats.wins += 1;
        stats.grossWin += pnl;
    } else {
        stats.grossLoss += Math.abs(pnl);
    }

    if (!stats.firstTradeTs) stats.firstTradeTs = timestamp;
    stats.lastTradeTs = timestamp;
    stats.peakEquity = Math.max(stats.peakEquity || equity, equity);
    if (stats.peakEquity > 0) {
        stats.maxDrawdown = Math.max(stats.maxDrawdown, (stats.peakEquity - equity) / stats.peakEquity);
    }
}

function finalizeStats(stats, testedDays) {
    stats.avgWin = stats.wins > 0 ? stats.grossWin / stats.wins : 0;
    const losses = stats.trades - stats.wins;
    stats.avgLoss = losses > 0 ? stats.grossLoss / losses : 0;
    stats.profitFactor = stats.grossLoss > 0 ? stats.grossWin / stats.grossLoss : (stats.grossWin > 0 ? 999 : 0);
    stats.winRate = stats.trades > 0 ? stats.wins / stats.trades : 0;
    stats.tradesPerMonth = testedDays > 0 ? (stats.trades / testedDays) * 30 : 0;
    stats.avgDaysBetweenTrades = stats.trades > 0 && testedDays > 0 ? testedDays / stats.trades : 999;
    return stats;
}

module.exports = {
    applyBuyFill,
    applySellFill,
    createPosition,
    updateSimulatedPosition,
    closePositionAt,
    createStatsTracker,
    recordTrade,
    finalizeStats
};
