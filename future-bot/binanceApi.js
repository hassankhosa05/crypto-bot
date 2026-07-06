const axios = require('axios');
const crypto = require('crypto');

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const BASE_URL = 'https://fapi.binance.com';

const RECV_WINDOW = 5000;
const REQUEST_TIMEOUT = 10000;

let serverTimeOffset = 0;

async function syncServerTime() {
    try {
        const res = await axios.get(`${BASE_URL}/fapi/v1/time`, { timeout: REQUEST_TIMEOUT });
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
        `${BASE_URL}/fapi/v2/account?${queryString}&signature=${signature}`,
        { headers: authHeaders, timeout: REQUEST_TIMEOUT }
    );
    return response.data;
}

async function getUSDTBalance() {
    const account = await getAccountInfo();
    const usdt = account.assets.find(a => a.asset === 'USDT');
    return usdt ? parseFloat(usdt.availableBalance) : 0;
}

async function getPositionRisk() {
    const timestamp = getTimestamp();
    const queryString = `timestamp=${timestamp}&recvWindow=${RECV_WINDOW}`;
    const signature = getSignature(queryString);
    const response = await axios.get(
        `${BASE_URL}/fapi/v2/positionRisk?${queryString}&signature=${signature}`,
        { headers: authHeaders, timeout: REQUEST_TIMEOUT }
    );
    return response.data; // Array of position objects
}

async function changeLeverage(symbol, leverage = 5) {
    const timestamp = getTimestamp();
    const queryString = `symbol=${symbol}&leverage=${leverage}&timestamp=${timestamp}&recvWindow=${RECV_WINDOW}`;
    const signature = getSignature(queryString);
    try {
        const response = await axios.post(
            `${BASE_URL}/fapi/v1/leverage?${queryString}&signature=${signature}`,
            null,
            { headers: authHeaders, timeout: REQUEST_TIMEOUT }
        );
        return response.data;
    } catch (e) {
        if (e.response && e.response.data.code === -4028) return; // Leverage already set
        throw e;
    }
}

async function changeMarginType(symbol, marginType = 'ISOLATED') {
    const timestamp = getTimestamp();
    const queryString = `symbol=${symbol}&marginType=${marginType}&timestamp=${timestamp}&recvWindow=${RECV_WINDOW}`;
    const signature = getSignature(queryString);
    try {
        const response = await axios.post(
            `${BASE_URL}/fapi/v1/marginType?${queryString}&signature=${signature}`,
            null,
            { headers: authHeaders, timeout: REQUEST_TIMEOUT }
        );
        return response.data;
    } catch (e) {
        if (e.response && e.response.data.code === -4046) return; // No need to change margin type
        throw e;
    }
}

async function getPremiumIndex() {
    const response = await axios.get(`${BASE_URL}/fapi/v1/premiumIndex`, { timeout: REQUEST_TIMEOUT });
    return response.data; // Array with funding rates
}

async function getBookTickers() {
    const response = await axios.get(`${BASE_URL}/fapi/v1/ticker/bookTicker`, { timeout: REQUEST_TIMEOUT });
    return response.data;
}

async function placeMarketOrder(symbol, side, quantity) {
    const timestamp = getTimestamp();
    const newClientOrderId = clientOrderId(symbol);
    const queryString = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&newClientOrderId=${newClientOrderId}&timestamp=${timestamp}&recvWindow=${RECV_WINDOW}`;
    const signature = getSignature(queryString);
    const response = await axios.post(
        `${BASE_URL}/fapi/v1/order?${queryString}&signature=${signature}`,
        null,
        { headers: authHeaders, timeout: REQUEST_TIMEOUT }
    );
    return response.data;
}

// For TP / SL in Futures
async function placeConditionalOrder(symbol, side, type, quantity, stopPrice, reduceOnly = true) {
    // type: STOP_MARKET or TAKE_PROFIT_MARKET
    const timestamp = getTimestamp();
    const newClientOrderId = clientOrderId(symbol);
    let queryString = `symbol=${symbol}&side=${side}&type=${type}&stopPrice=${stopPrice}&reduceOnly=${reduceOnly}&newClientOrderId=${newClientOrderId}&timeInForce=GTC&timestamp=${timestamp}&recvWindow=${RECV_WINDOW}`;
    if (quantity && quantity > 0) {
        queryString += `&closePosition=false&quantity=${quantity}`;
    } else {
        queryString += `&closePosition=true`;
    }
    
    const signature = getSignature(queryString);
    const response = await axios.post(
        `${BASE_URL}/fapi/v1/order?${queryString}&signature=${signature}`,
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
        `${BASE_URL}/fapi/v1/order?${queryString}&signature=${signature}`,
        { headers: authHeaders, timeout: REQUEST_TIMEOUT }
    );
    return response.data;
}

async function cancelAllOpenOrders(symbol) {
    const timestamp = getTimestamp();
    const queryString = `symbol=${symbol}&timestamp=${timestamp}&recvWindow=${RECV_WINDOW}`;
    const signature = getSignature(queryString);
    const response = await axios.delete(
        `${BASE_URL}/fapi/v1/allOpenOrders?${queryString}&signature=${signature}`,
        { headers: authHeaders, timeout: REQUEST_TIMEOUT }
    );
    return response.data;
}

async function getOrderStatus(symbol, orderId) {
    const timestamp = getTimestamp();
    const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}&recvWindow=${RECV_WINDOW}`;
    const signature = getSignature(queryString);
    const response = await axios.get(
        `${BASE_URL}/fapi/v1/order?${queryString}&signature=${signature}`,
        { headers: authHeaders, timeout: REQUEST_TIMEOUT }
    );
    return response.data;
}

module.exports = {
    syncServerTime,
    getAccountInfo,
    getUSDTBalance,
    getPositionRisk,
    changeLeverage,
    changeMarginType,
    getPremiumIndex,
    getBookTickers,
    placeMarketOrder,
    placeConditionalOrder,
    cancelOrder,
    cancelAllOpenOrders,
    getOrderStatus
};
