const { BollingerBands, RSI, EMA, MACD } = require('technicalindicators');

// --- Shared helpers ---

// Coefficient of variation over the last N closes. Used to skip coins in dead chop
// (tiny moves where scalping just bleeds fees / spread). Mid-caps typically run 0.5-2%
// over 20 5-min bars, so anything under 0.3% is genuinely sideways.
const DEAD_CHOP_CV_THRESHOLD = 0.003;

function isDeadChop(closes, lookback = 20) {
    if (closes.length < lookback) return true;
    const recent = closes.slice(-lookback);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (mean === 0) return true;
    const variance = recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length;
    const cv = Math.sqrt(variance) / mean;
    return cv < DEAD_CHOP_CV_THRESHOLD;
}

// --- Strategy 1: Bollinger Bands + RSI confluence (mean reversion) ---
// Old version sold on *any* bar above the middle band. Now we wait for real
// oversold confluence on entry and a confirmed cross-up through the middle band on exit.
function executeBollingerStrategy(historicalData) {
    if (!historicalData || historicalData.length < 30) return null;
    const closes = historicalData.map(d => d.close);
    if (isDeadChop(closes)) return 'HOLD';

    const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
    const rsi = RSI.calculate({ period: 14, values: closes });
    if (bb.length < 2 || rsi.length < 2) return null;

    const currentClose = closes[closes.length - 1];
    const previousClose = closes[closes.length - 2];
    const currentBB = bb[bb.length - 1];
    const previousBB = bb[bb.length - 2];
    const currentRSI = rsi[rsi.length - 1];

    // BUY: price tagged the lower band recently AND RSI is in oversold territory.
    // The two-bar lower-band touch filters out single noisy ticks.
    const touchedLower = previousClose <= previousBB.lower || currentClose <= currentBB.lower;
    if (touchedLower && currentClose > currentBB.lower && currentRSI < 40) {
        return 'BUY';
    }

    // SELL: confirmed cross *through* the middle band from below (not just "above middle"),
    // with RSI showing some strength so we're not selling into a fakeout dip.
    if (previousClose < previousBB.middle && currentClose >= currentBB.middle && currentRSI > 55) {
        return 'SELL';
    }

    return 'HOLD';
}

// --- Strategy 2: EMA 9/21 cross with RSI safety filter (momentum) ---
// Replaces the broken "Volume Breakout" which exited on the very next bar.
// EMA cross is the workhorse of professional scalping bots — clear, robust, no naive volume reliance.
function executeEmaCrossStrategy(historicalData) {
    if (!historicalData || historicalData.length < 30) return null;
    const closes = historicalData.map(d => d.close);
    if (isDeadChop(closes)) return 'HOLD';

    const ema9 = EMA.calculate({ period: 9, values: closes });
    const ema21 = EMA.calculate({ period: 21, values: closes });
    const rsi = RSI.calculate({ period: 14, values: closes });
    if (ema9.length < 2 || ema21.length < 2 || rsi.length < 1) return null;

    const e9Curr = ema9[ema9.length - 1];
    const e9Prev = ema9[ema9.length - 2];
    const e21Curr = ema21[ema21.length - 1];
    const e21Prev = ema21[ema21.length - 2];
    const currentRSI = rsi[rsi.length - 1];

    // Bullish cross: 9 just crossed above 21. RSI bounds keep us out of exhausted moves
    // (>70 = chasing top) and out of fakeout crosses while still oversold (<40 = false signal).
    if (e9Prev <= e21Prev && e9Curr > e21Curr && currentRSI > 40 && currentRSI < 70) {
        return 'BUY';
    }

    // Bearish cross: real momentum reversal, exit.
    if (e9Prev >= e21Prev && e9Curr < e21Curr) {
        return 'SELL';
    }

    return 'HOLD';
}

// --- Strategy 3: MACD histogram flip with EMA50 trend filter (momentum + trend) ---
// Replaces the noisy single-bar RSI cross. MACD histogram is more robust because it
// requires sustained momentum shift, and the EMA50 filter stops us from buying flips
// inside a confirmed downtrend (one of the original strategies' biggest leak).
function executeMacdStrategy(historicalData) {
    if (!historicalData || historicalData.length < 60) return null;
    const closes = historicalData.map(d => d.close);
    if (isDeadChop(closes)) return 'HOLD';

    const macd = MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false
    });
    const ema50 = EMA.calculate({ period: 50, values: closes });
    if (macd.length < 2 || ema50.length < 1) return null;

    const current = macd[macd.length - 1];
    const previous = macd[macd.length - 2];
    if (current.histogram === undefined || previous.histogram === undefined) return null;

    const currentClose = closes[closes.length - 1];
    const currentEma50 = ema50[ema50.length - 1];
    const inUptrend = currentClose > currentEma50;

    // BUY: histogram flipped from negative to positive AND we're above the 50-EMA.
    // The trend filter is the key fix — no more catching knives in downtrends.
    if (previous.histogram <= 0 && current.histogram > 0 && inUptrend) {
        return 'BUY';
    }

    // SELL: histogram flipped negative — momentum has rolled over.
    if (previous.histogram >= 0 && current.histogram < 0) {
        return 'SELL';
    }

    return 'HOLD';
}

module.exports = {
    executeBollingerStrategy,
    executeEmaCrossStrategy,
    executeMacdStrategy
};
