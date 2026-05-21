async function updateDashboard() {
    try {
        const response = await fetch('/api/state');
        const state = await response.json();

        // Update Balance
        document.getElementById('balance').textContent = `$${state.balance.toFixed(2)}`;

        // Update Positions
        const positionsTable = document.getElementById('positionsTable').querySelector('tbody');
        positionsTable.innerHTML = '';
        
        for (const [coin, position] of Object.entries(state.positions || {})) {
            const row = document.createElement('tr');
            const timeStr = new Date(position.timestamp).toLocaleTimeString();
            row.innerHTML = `
                <td>${coin}</td>
                <td>${position.amount.toFixed(4)}</td>
                <td>$${position.entryPrice.toFixed(4)}</td>
                <td>${position.strategy}</td>
                <td>${timeStr}</td>
            `;
            positionsTable.appendChild(row);
        }

        // Update Trades (Show last 10)
        const tradesTable = document.getElementById('tradesTable').querySelector('tbody');
        tradesTable.innerHTML = '';
        
        const recentTrades = (state.tradeHistory || []).slice(-10).reverse();
        
        recentTrades.forEach(trade => {
            const row = document.createElement('tr');
            const isBuy = trade.action === 'BUY';
            const actionClass = isBuy ? 'action-buy' : 'action-sell';
            const pnlStr = isBuy ? '-' : (trade.pnl >= 0 ? `+$${trade.pnl.toFixed(2)}` : `-$${Math.abs(trade.pnl).toFixed(2)}`);
            const pnlClass = isBuy ? '' : (trade.pnl >= 0 ? 'profit-positive' : 'profit-negative');
            const timeStr = new Date(trade.timestamp).toLocaleTimeString();

            row.innerHTML = `
                <td class="${actionClass}">${trade.action}</td>
                <td>${trade.coin}</td>
                <td>$${trade.price.toFixed(4)}</td>
                <td>${trade.strategy}</td>
                <td class="${pnlClass}">${pnlStr}</td>
                <td>${timeStr}</td>
            `;
            tradesTable.appendChild(row);
        });

    } catch (error) {
        console.error('Error fetching state:', error);
    }
}

// Initial update
updateDashboard();

// Poll every 5 seconds
setInterval(updateDashboard, 5000);
