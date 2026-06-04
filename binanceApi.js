const axios = require('axios');
const crypto = require('crypto');

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const BASE_URL = 'https://api.binance.com';

function getSignature(queryString) {
    if (!API_SECRET) throw new Error("Missing BINANCE_API_SECRET");
    return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

async function getAccountInfo() {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = getSignature(queryString);
    
    const response = await axios.get(`${BASE_URL}/api/v3/account?${queryString}&signature=${signature}`, {
        headers: { 'X-MBX-APIKEY': API_KEY }
    });
    return response.data;
}

async function getUSDTBalance() {
    const account = await getAccountInfo();
    const usdt = account.balances.find(b => b.asset === 'USDT');
    return usdt ? parseFloat(usdt.free) : 0;
}

async function placeMarketOrder(symbol, side, quantity) {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`;
    const signature = getSignature(queryString);
    
    const response = await axios.post(`${BASE_URL}/api/v3/order?${queryString}&signature=${signature}`, null, {
        headers: { 'X-MBX-APIKEY': API_KEY }
    });
    return response.data;
}

async function placeLimitOrder(symbol, side, quantity, price) {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&side=${side}&type=LIMIT&timeInForce=GTC&quantity=${quantity}&price=${price}&timestamp=${timestamp}`;
    const signature = getSignature(queryString);
    
    const response = await axios.post(`${BASE_URL}/api/v3/order?${queryString}&signature=${signature}`, null, {
        headers: { 'X-MBX-APIKEY': API_KEY }
    });
    return response.data;
}

async function placeOcoSellOrder(symbol, quantity, takeProfitPrice, stopPrice, stopLimitPrice) {
    const timestamp = Date.now();
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
        timestamp: String(timestamp)
    });
    const queryString = params.toString();
    const signature = getSignature(queryString);

    const response = await axios.post(`${BASE_URL}/api/v3/orderList/oco?${queryString}&signature=${signature}`, null, {
        headers: { 'X-MBX-APIKEY': API_KEY }
    });
    return response.data;
}

async function cancelOrder(symbol, orderId) {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}`;
    const signature = getSignature(queryString);
    
    const response = await axios.delete(`${BASE_URL}/api/v3/order?${queryString}&signature=${signature}`, {
        headers: { 'X-MBX-APIKEY': API_KEY }
    });
    return response.data;
}

async function cancelOrderList(symbol, orderListId) {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&orderListId=${orderListId}&timestamp=${timestamp}`;
    const signature = getSignature(queryString);

    const response = await axios.delete(`${BASE_URL}/api/v3/orderList?${queryString}&signature=${signature}`, {
        headers: { 'X-MBX-APIKEY': API_KEY }
    });
    return response.data;
}

async function getOrderStatus(symbol, orderId) {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}`;
    const signature = getSignature(queryString);
    
    const response = await axios.get(`${BASE_URL}/api/v3/order?${queryString}&signature=${signature}`, {
        headers: { 'X-MBX-APIKEY': API_KEY }
    });
    return response.data;
}

async function testOrder(symbol, side, quantity) {
    const timestamp = Date.now();
    const queryString = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`;
    const signature = getSignature(queryString);
    
    const response = await axios.post(`${BASE_URL}/api/v3/order/test?${queryString}&signature=${signature}`, null, {
        headers: { 'X-MBX-APIKEY': API_KEY }
    });
    return response.data;
}

module.exports = { getAccountInfo, getUSDTBalance, placeMarketOrder, placeLimitOrder, placeOcoSellOrder, cancelOrder, cancelOrderList, getOrderStatus, testOrder };
