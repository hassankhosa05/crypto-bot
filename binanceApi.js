const axios = require('axios');
const crypto = require('crypto');

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const BASE_URL = 'https://api.binance.com';

const RECV_WINDOW = 5000;
const REQUEST_TIMEOUT = 10000;

let serverTimeOffset = 0;

async function syncServerTime() {
    try {
        const res = await axios.get(`${BASE_URL}/api/v3/time`, { timeout: REQUEST_TIMEOUT });
        serverTimeOffset = res.data.serverTime - Date.now();
    } catch (e) {
        serverTimeOffset = 0;
    }
}

function getTimestamp() {
    return Date.now() + serverTimeOffset;
}

function getSignature(queryString) {
    if (!API_SECRET) throw new Error("Missing BINANCE_API_SECRET");
    return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

function clientOrderId(symbol) {
    return `bot_${symbol}_${getTimestamp()}`;
}

const authHeaders = { 'X-MBX-APIKEY': API_KEY };

async function getAccountInfo() {
    const timestamp = getTimestamp();
    const queryString = `timestamp=${timestamp}&recvWindow=${RECV_WINDOW}`;
    const signature = getSignature(queryString);
    const response = await axios.get(
        `${BASE_URL}/api/v3/account?${queryString}&signature=${signature}`,
        { headers: authHeaders, timeout: REQUEST_TIMEOUT }
    );
    return response.data;
}

async function getUSDTBalance() {
    const account = await getAccountInfo();
    const usdt = account.balances.find(b => b.asset === 'USDT');
    return usdt ? parseFloat(usdt.free) : 0;
}

async function placeMarketOrder(symbol, side, quantity) {
    const timestamp = getTimestamp();
    const newClientOrderId = clientOrderId(symbol);
    const queryString = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&newClientOrderId=${newClientOrderId}&timestamp=${timestamp}&recvWindow=${RECV_WINDOW}`;
    const signature = getSignature(queryString);
    const response = await axios.post(
        `${BASE_URL}/api/v3/order?${queryString}&signature=${signature}`,
        null,
        { headers: authHeaders, timeout: REQUEST_TIMEOUT }
    );
    return response.data;
}

async function placeLimitOrder(symbol, side, quantity, price) {
    const timestamp = getTimestamp();
    const newClientOrderId = clientOrderId(symbol);
    const queryString = `symbol=${symbol}&side=${side}&type=LIMIT&timeInForce=GTC&quantity=${quantity}&price=${price}&newClientOrderId=${newClientOrderId}&timestamp=${timestamp}&recvWindow=${RECV_WINDOW}`;
    const signature = getSignature(queryString);
    const response = await axios.post(
        `${BASE_URL}/api/v3/order?${queryString}&signature=${signature}`,
        null,
        { headers: authHeaders, timeout: REQUEST_TIMEOUT }
    );
    return response.data;
}

async function placeOcoSellOrder(symbol, quantity, takeProfitPrice, stopPrice, stopLimitPrice) {
    const timestamp = getTimestamp();
    const params = new URLSearchParams({
        symbol,
        side: 'SELL',
        quantity: String(quantity),
        aboveType: 'LIMIT_MAKER',
        abovePrice: String(takeProfitPrice),
        belowType: 'STOP_LOSS_LIMIT',
        belowStopPrice: String(stopPrice),
        belowPrice: String(stopLimitPrice),
        belowTimeInForce: 'GTC',
        timestamp: String(timestamp),
        recvWindow: String(RECV_WINDOW)
    });
    const queryString = params.toString();
    const signature = getSignature(queryString);
    const response = await axios.post(
        `${BASE_URL}/api/v3/orderList/oco?${queryString}&signature=${signature}`,
        null,
        { headers: authHeaders, timeout: REQUEST_TIMEOUT }
    );
    return response.data;
}

async function cancelOrder(symbol, orderId) {
    const timestamp = getTimestamp();
    const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}&recvWindow=${RECV_WINDOW}`;
    const signature = getSignature(queryString);
    const response = await axios.delete(
        `${BASE_URL}/api/v3/order?${queryString}&signature=${signature}`,
        { headers: authHeaders, timeout: REQUEST_TIMEOUT }
    );
    return response.data;
}

async function cancelOrderList(symbol, orderListId) {
    const timestamp = getTimestamp();
    const queryString = `symbol=${symbol}&orderListId=${orderListId}&timestamp=${timestamp}&recvWindow=${RECV_WINDOW}`;
    const signature = getSignature(queryString);
    const response = await axios.delete(
        `${BASE_URL}/api/v3/orderList?${queryString}&signature=${signature}`,
        { headers: authHeaders, timeout: REQUEST_TIMEOUT }
    );
    return response.data;
}

async function getOrderStatus(symbol, orderId) {
    const timestamp = getTimestamp();
    const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}&recvWindow=${RECV_WINDOW}`;
    const signature = getSignature(queryString);
    const response = await axios.get(
        `${BASE_URL}/api/v3/order?${queryString}&signature=${signature}`,
        { headers: authHeaders, timeout: REQUEST_TIMEOUT }
    );
    return response.data;
}

async function testOrder(symbol, side, quantity) {
    const timestamp = getTimestamp();
    const queryString = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}&recvWindow=${RECV_WINDOW}`;
    const signature = getSignature(queryString);
    const response = await axios.post(
        `${BASE_URL}/api/v3/order/test?${queryString}&signature=${signature}`,
        null,
        { headers: authHeaders, timeout: REQUEST_TIMEOUT }
    );
    return response.data;
}

module.exports = {
    syncServerTime,
    getAccountInfo,
    getUSDTBalance,
    placeMarketOrder,
    placeLimitOrder,
    placeOcoSellOrder,
    cancelOrder,
    cancelOrderList,
    getOrderStatus,
    testOrder
};
