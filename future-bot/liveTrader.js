const fs = require('fs');
const path = require('path');
const api = require('./binanceApi');
const { checkMarketRegime } = require('./marketGate');
const { evaluateTrade, checkExitCriteria } = require('./strategyFutures');

const STATE_FILE = path.join(__dirname, 'live_state.json');
const LOG_FILE = path.join(__dirname, 'futures_trades.csv');

// Quick utility for rounding to step size
function formatStep(value, stepSize) {
    const inv = 1.0 / parseFloat(stepSize);
    return (Math.floor(value * inv) / inv).toFixed(Math.max(0, -Math.floor(Math.log10(parseFloat(stepSize)))));
}

class LiveFuturesTrader {
    constructor() {
        this.state = this.loadState();
        this.maxPositions = 2;
        this.riskPerTrade = 0.01;
        this.leverage = 5;
        this.exchangeInfoCache = null;
    }

    loadState() {
        try {
            if (fs.existsSync(STATE_FILE)) {
                return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            }
        } catch (e) { }
        return {
            positions: {},
            dailyLosses: 0,
            dailyDrawdownPct: 0,
            lastTradeDate: new Date().toISOString().split('T')[0],
            accountBalanceStartOfDay: 0
        };
    }

    saveState() {
        fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    }

    async initExchangeInfo() {
        if (!this.exchangeInfoCache) {
            const axios = require('axios');
            const res = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
            this.exchangeInfoCache = {};
            for (const s of res.data.symbols) {
                const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
                const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');
                this.exchangeInfoCache[s.symbol] = {
                    stepSize: lotFilter ? lotFilter.stepSize : '0.001',
                    tickSize: priceFilter ? priceFilter.tickSize : '0.0001'
                };
            }
        }
    }

    checkDailyLimits(currentBalance) {
        const today = new Date().toISOString().split('T')[0];
        if (this.state.lastTradeDate !== today) {
            this.state.lastTradeDate = today;
            this.state.dailyLosses = 0;
            this.state.dailyDrawdownPct = 0;
            this.state.accountBalanceStartOfDay = currentBalance;
            this.saveState();
            return true;
        }

        if (this.state.accountBalanceStartOfDay === 0) {
            this.state.accountBalanceStartOfDay = currentBalance;
            this.saveState();
        }

        const drawdown = (this.state.accountBalanceStartOfDay - currentBalance) / this.state.accountBalanceStartOfDay;
        
        if (this.state.dailyLosses >= 3) {
            console.log("Daily Limit: 3 Consecutive Losses.");
            return false;
        }
        if (drawdown >= 0.03) {
            console.log(`Daily Limit: Drawdown ${(drawdown*100).toFixed(2)}%`);
            return false;
        }
        return true;
    }

    async runCycle() {
        console.log(`\n--- Futures Trader Cycle [${new Date().toISOString()}] ---`);
        try {
            await api.syncServerTime();
            await this.initExchangeInfo();
            
            const currentBalance = await api.getUSDTBalance();
            if (!this.checkDailyLimits(currentBalance)) {
                return;
            }

            const regime = await checkMarketRegime();
            console.log("Global Market Regime:", regime);

            await this.managePositions(currentBalance);

            if (regime !== 'SIDEWAYS') {
                await this.scanForEntries(regime, currentBalance);
            }
        } catch (error) {
            console.error("Cycle error:", error.message);
        }
    }

    async managePositions(currentBalance) {
        const activePositions = await api.getPositionRisk();
        const myPositions = activePositions.filter(p => parseFloat(p.positionAmt) !== 0);
        const currentSymbols = myPositions.map(p => p.symbol);

        // Sync local state
        for (const sym of Object.keys(this.state.positions)) {
            if (!currentSymbols.includes(sym)) {
                console.log(`Position for ${sym} closed externally or stopped out.`);
                // Assume stopped out (loss) if it disappears unexpectedly in INITIAL stage
                if (this.state.positions[sym].stage === 'INITIAL') {
                    this.state.dailyLosses++;
                }
                delete this.state.positions[sym];
                this.saveState();
            }
        }

        // Check TP limits and Time stops
        for (const position of myPositions) {
            const sym = position.symbol;
            if (!this.state.positions[sym]) continue;
            
            let pState = this.state.positions[sym];
            pState.candlesHeld = (pState.candlesHeld || 0) + 1; // approx 1 min
            
            const currentPrice = parseFloat(position.markPrice);
            const isLong = pState.direction === 'LONG';

            // Check Time Stop (12 candles = 180 minutes approx if cycle is 1m, wait! we run every 1m. So 180 cycles.)
            if (pState.candlesHeld >= 180 && pState.stage === 'INITIAL') {
                console.log(`Time Stop (180 mins) for ${sym}. Closing.`);
                await this.closePositionFull(sym, position);
                delete this.state.positions[sym];
                this.saveState();
                continue;
            }

            // Check TP1
            if (pState.stage === 'INITIAL') {
                const hitTP1 = isLong ? (currentPrice >= pState.tp1) : (currentPrice <= pState.tp1);
                if (hitTP1) {
                    console.log(`TP1 HIT for ${sym}. Closing 50%, moving SL to breakeven.`);
                    const closeQty = formatStep(parseFloat(position.positionAmt) * 0.5, this.exchangeInfoCache[sym].stepSize);
                    const closeSide = isLong ? 'SELL' : 'BUY';
                    await api.placeMarketOrder(sym, closeSide, Math.abs(closeQty));
                    
                    // Move SL
                    await api.cancelAllOpenOrders(sym);
                    const bePrice = formatStep(pState.entryPrice, this.exchangeInfoCache[sym].tickSize);
                    await api.placeConditionalOrder(sym, closeSide, 'STOP_MARKET', 0, bePrice, true);
                    
                    pState.stage = 'TP1';
                    this.saveState();
                    continue;
                }
            }

            // Check TP2
            if (pState.stage === 'TP1') {
                const hitTP2 = isLong ? (currentPrice >= pState.tp2) : (currentPrice <= pState.tp2);
                if (hitTP2) {
                    console.log(`TP2 HIT for ${sym}. Closing 30% of original.`);
                    const closeQty = formatStep(pState.originalQty * 0.3, this.exchangeInfoCache[sym].stepSize);
                    const closeSide = isLong ? 'SELL' : 'BUY';
                    await api.placeMarketOrder(sym, closeSide, Math.abs(closeQty));
                    
                    pState.stage = 'TP2'; // Runner mode
                    this.saveState();
                    continue;
                }
            }

            // Check Strategy Exit
            const exitCheck = await checkExitCriteria(sym, pState.direction);
            if (exitCheck.exit) {
                console.log(`Strategy Exit for ${sym}: ${exitCheck.reason}`);
                await this.closePositionFull(sym, position);
                delete this.state.positions[sym];
                this.saveState();
                continue;
            }
            
            this.saveState();
        }
    }

    async closePositionFull(symbol, positionData) {
        const side = parseFloat(positionData.positionAmt) > 0 ? 'SELL' : 'BUY';
        const qty = Math.abs(parseFloat(positionData.positionAmt));
        await api.cancelAllOpenOrders(symbol);
        await api.placeMarketOrder(symbol, side, qty);
    }

    async scanForEntries(regime, currentBalance) {
        if (Object.keys(this.state.positions).length >= this.maxPositions) return;

        const universePath = path.join(__dirname, 'active_universe.json');
        if (!fs.existsSync(universePath)) return;
        const universe = JSON.parse(fs.readFileSync(universePath, 'utf8'));

        let validSetups = [];
        for (const sym of Object.keys(universe.coins)) {
            if (this.state.positions[sym]) continue;
            
            const metrics = universe.coins[sym];
            const tradeRes = await evaluateTrade(sym, regime, metrics.fundingRate);
            
            if (tradeRes.signal !== 'NONE') {
                validSetups.push({ symbol: sym, ...tradeRes });
            }
        }

        validSetups.sort((a, b) => b.score - a.score || b.adx - a.adx);

        for (const setup of validSetups) {
            if (Object.keys(this.state.positions).length >= this.maxPositions) break;
            console.log(`Executing ${setup.signal} on ${setup.symbol}. Score: ${setup.score}`);
            await this.executeTrade(setup, currentBalance);
        }
    }

    async executeTrade(setup, balance) {
        try {
            await api.changeMarginType(setup.symbol, 'ISOLATED');
            await api.changeLeverage(setup.symbol, this.leverage);

            const info = this.exchangeInfoCache[setup.symbol];
            if (!info) return;

            const riskAmount = balance * this.riskPerTrade;
            const distanceToSl = Math.abs(setup.price - setup.stopLoss);
            let positionSize = riskAmount / distanceToSl;
            
            if (positionSize * setup.price > (balance * this.leverage)) {
                 positionSize = (balance * this.leverage) / setup.price;
            }

            const qty = formatStep(positionSize, info.stepSize);
            const side = setup.signal === 'LONG' ? 'BUY' : 'SELL';
            
            await api.placeMarketOrder(setup.symbol, side, qty);

            const slSide = side === 'BUY' ? 'SELL' : 'BUY';
            const slPrice = formatStep(setup.stopLoss, info.tickSize);
            await api.placeConditionalOrder(setup.symbol, slSide, 'STOP_MARKET', 0, slPrice, true);

            this.state.positions[setup.symbol] = {
                direction: setup.signal,
                entryPrice: setup.price,
                originalQty: parseFloat(qty),
                stopLoss: parseFloat(slPrice),
                tp1: setup.tp1,
                tp2: setup.tp2,
                stage: 'INITIAL',
                candlesHeld: 0,
                openedAt: new Date().toISOString()
            };
            this.saveState();

        } catch (e) {
            console.error(`Failed to execute trade for ${setup.symbol}:`, e.message);
        }
    }
}

module.exports = { LiveFuturesTrader };
