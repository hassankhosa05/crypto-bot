const fmtUSD = (n, digits = 2) => {
    if (n === null || n === undefined || Number.isNaN(n)) return '-';
    return `$${Number(n).toFixed(digits)}`;
};
const fmtPrice = n => fmtUSD(n, n < 1 ? 6 : 4);
const fmtPct = n => {
    if (n === null || n === undefined || Number.isNaN(n)) return '-';
    const v = n * 100;
    const sign = v > 0 ? '+' : '';
    return `${sign}${v.toFixed(2)}%`;
};
const pnlClass = n => (n > 0 ? 'profit-positive' : n < 0 ? 'profit-negative' : '');
const fmtTime = ts => {
    if (!ts) return "-";
    const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
    const pad = n => String(n).padStart(2, "0");
    const month = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    const seconds = pad(d.getSeconds());
    const year = d.getFullYear();
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

async function updateDashboard() {
    try {
        const response = await fetch('/api/state');
        const state = await response.json();

        const balance = Number(state.balance) || 0;
        const initial = Number(state.initialBalance) || 0;
        const positions = state.positions || {};
        const prices = state.currentPrices || {};
        const trades = state.tradeHistory || [];

        let invested = 0;
        let marketValue = 0;
        for (const [, position] of Object.entries(positions)) {
            invested += position.costBasis ?? position.amount * position.entryPrice;
        }
        for (const [symbol, position] of Object.entries(positions)) {
            const live = prices[symbol] ?? position.entryPrice;
            marketValue += position.amount * live;
        }

        const totalValue = balance + marketValue;
        const totalPnl = totalValue - initial;
        const totalPnlPct = initial > 0 ? totalPnl / initial : 0;

        document.getElementById('initialBalance').textContent = fmtUSD(initial);
        document.getElementById('balance').textContent = fmtUSD(balance);
        document.getElementById('invested').textContent = fmtUSD(invested);
        document.getElementById('totalValue').textContent = fmtUSD(totalValue);
        const pnlEl = document.getElementById('totalPnl');
        pnlEl.textContent = `${fmtUSD(totalPnl)} (${fmtPct(totalPnlPct)})`;
        pnlEl.className = `value ${pnlClass(totalPnl)}`;

        const lastUpdateEl = document.getElementById('lastUpdate');
        if (lastUpdateEl) {
            lastUpdateEl.textContent = state.lastUpdate
                ? `Updated ${new Date(state.lastUpdate).toLocaleString()}`
                : 'No price data yet';
        }

        // --- Open positions table ---
        const positionsBody = document.querySelector('#positionsTable tbody');
        positionsBody.innerHTML = '';
        const positionEntries = Object.entries(positions);
        if (positionEntries.length === 0) {
            positionsBody.innerHTML = '<tr><td colspan="10" class="empty">No open positions</td></tr>';
        } else {
            for (const [symbol, position] of positionEntries) {
                const currentPrice = prices[symbol] ?? position.entryPrice;
                const movePct = (currentPrice - position.entryPrice) / position.entryPrice;
                const unrealized = (currentPrice - position.entryPrice) * position.amount;
                const stopLoss = position.stopLoss || position.slPrice || 0;
                const takeProfit = position.tp1 || position.tpPrice || 0;
                const direction = position.direction || 'LONG';
                const qty = position.qty || position.originalQty || position.amount || 0;

                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${symbol.toUpperCase()} <span style="font-size: 0.8em; color: ${direction === 'LONG' ? 'lime' : 'red'};">${direction}</span></td>
                    <td>${Number(qty).toFixed(4)}</td>
                    <td>${fmtPrice(position.entryPrice)}</td>
                    <td>${fmtPrice(currentPrice)}</td>
                    <td class="${pnlClass(movePct)}">${fmtPct(movePct)}</td>
                    <td class="${pnlClass(unrealized)}">${fmtUSD(unrealized)}</td>
                    <td class="sl">${fmtPrice(stopLoss)}</td>
                    <td class="tp">${fmtPrice(takeProfit)}</td>
                    <td>${position.stage || position.strategy || 'N/A'}</td>
                    <td>${fmtTime(position.openedAt || position.timestamp)}</td>
                `;
                positionsBody.appendChild(row);
            }
        }

        // --- Recent trades table (last 20) ---
        const tradesBody = document.querySelector('#tradesTable tbody');
        tradesBody.innerHTML = '';
        const recentTrades = trades.slice(-100).reverse();
        if (recentTrades.length === 0) {
            tradesBody.innerHTML = '<tr><td colspan="9" class="empty">No trades yet</td></tr>';
        } else {
            for (const trade of recentTrades) {
                const isBuy = trade.action === 'BUY';
                const actionClass = isBuy ? 'action-buy' : 'action-sell';
                const pnl = trade.pnl;
                const pnlPct = trade.pnlPct;
                const pnlText = isBuy
                    ? '-'
                    : `${fmtUSD(pnl)} (${fmtPct(pnlPct)})`;

                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${fmtTime(trade.timestamp)}</td>
                    <td class="${actionClass}">${trade.action}</td>
                    <td>${trade.coin.toUpperCase()}</td>
                    <td>${fmtPrice(trade.entryPrice ?? trade.price)}</td>
                    <td>${isBuy ? '-' : fmtPrice(trade.exitPrice ?? trade.price)}</td>
                    <td>${Number(trade.amount).toFixed(4)}</td>
                    <td>${trade.strategy}</td>
                    <td>${trade.reason || (isBuy ? 'Strategy Signal' : '-')}</td>
                    <td class="${isBuy ? '' : pnlClass(pnl)}">${pnlText}</td>
                `;
                tradesBody.appendChild(row);
            }
        }
    } catch (error) {
        console.error('Error fetching state:', error);
    }
}

updateDashboard();
setInterval(updateDashboard, 5000);
