const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const CSV_PATH = path.join(DATA_DIR, 'trades.csv');
const HEADER = 'timestamp,action,coin,entryPrice,exitPrice,amount,strategy,pnl,pnlPct,reason\n';

function ensureFile() {
    if (!fs.existsSync(CSV_PATH)) {
        fs.writeFileSync(CSV_PATH, HEADER);
    }
}

function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

function logTrade(entry) {
    ensureFile();
    const row = [
        entry.timestamp,
        entry.action,
        entry.coin,
        entry.entryPrice ?? '',
        entry.exitPrice ?? '',
        entry.amount,
        entry.strategy,
        entry.pnl ?? '',
        entry.pnlPct ?? '',
        entry.reason
    ].map(csvEscape).join(',') + '\n';
    fs.appendFileSync(CSV_PATH, row);
}

module.exports = { logTrade, CSV_PATH };
