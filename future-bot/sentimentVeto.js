/**
 * sentimentVeto.js — v2 SKETCH (not yet wired into the live trade path).
 *
 * DESIGN PRINCIPLE: this module can ONLY block a buy, never initiate one.
 * It is a risk gate, not an alpha source. A sentiment model that generates
 * signals would be non-deterministic, un-backtestable, and an overfit trap.
 * Used purely as a veto, the worst case is a missed trade — never a bad fill.
 *
 * FAIL-OPEN: if the provider errors or times out, the trade is ALLOWED.
 * Rationale: a sentiment-API outage must not silently halt the whole bot.
 * Every fail-open is logged loudly so outages are visible in monitoring.
 *
 * INTEGRATION POINT (when promoted to v2): in the BUY branch of
 * paperTrader.executeTrade / liveTrader.executeTrade, after all existing
 * gates and before sizing:
 *
 *     const veto = await checkSentimentVeto(coinSymbol);
 *     if (veto.blocked) {
 *         console.log(`Sentiment veto for ${coinSymbol}: ${veto.reason}`);
 *         return;
 *     }
 *
 * Do NOT enable until the base strategy shows non-negative paper expectancy
 * (see monitor.js GO-LIVE GATE). Layering a veto on a zero-edge strategy
 * just hides the problem.
 */

// --- Tunables ---
const SENTIMENT_TIMEOUT_MS = 4000;
// Veto a buy only on STRONGLY negative sentiment — keep the gate rare and
// high-conviction so it doesn't quietly suppress most of the strategy.
const VETO_THRESHOLD = -0.5; // score in [-1, +1]; below this => block
// Cache so we don't hit the provider on every 15m candle per symbol.
const CACHE_TTL_MS = 10 * 60 * 1000;

const _cache = new Map(); // symbol -> { score, ts, reason }

/**
 * Provider seam. Replace the body with a real implementation:
 *   - LLM headline classifier (feed last N headlines, return [-1,+1])
 *   - Crypto Fear & Greed index delta
 *   - Funding-rate / liquidation-cascade signal
 * Must return { score: number in [-1,+1], reason: string } or throw.
 */
async function fetchSentiment(symbol) {
    // STUB: neutral. No network call until a real provider is chosen.
    return { score: 0, reason: 'stub: no provider configured' };
}

/**
 * @returns {{ blocked: boolean, score: number, reason: string }}
 */
async function checkSentimentVeto(symbol, now = Date.now()) {
    const cached = _cache.get(symbol);
    if (cached && (now - cached.ts) < CACHE_TTL_MS) {
        return decide(cached.score, cached.reason);
    }

    try {
        const res = await withTimeout(fetchSentiment(symbol), SENTIMENT_TIMEOUT_MS);
        _cache.set(symbol, { score: res.score, reason: res.reason, ts: now });
        return decide(res.score, res.reason);
    } catch (e) {
        // FAIL-OPEN — allow the trade, but make the outage visible.
        console.log(`[sentimentVeto] FAIL-OPEN for ${symbol} (${e.message}) — allowing trade.`);
        return { blocked: false, score: 0, reason: `fail-open: ${e.message}` };
    }
}

function decide(score, reason) {
    const blocked = score < VETO_THRESHOLD;
    return { blocked, score, reason: blocked ? `negative sentiment ${score} (${reason})` : reason };
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms))
    ]);
}

module.exports = { checkSentimentVeto, fetchSentiment, VETO_THRESHOLD };
