'use strict';

/**
 * Binance Futures executor (exchange/executor.js)
 *
 * Handles:
 *  - Setting leverage + margin mode per symbol
 *  - Opening a LONG/SHORT market order (ISOLATED margin)
 *  - Placing a stop-market order such that max loss = config.maxLossPerPositionUsdt
 *  - Polling open positions and triggering emergency close if stop order is missed
 *  - Closing positions (market close)
 *
 * Uses ccxt for order management.
 */

const ccxt = require('ccxt');
const { makeLogger } = require('../lib/logger');
const config = require('../lib/config');
const state = require('../lib/state');
const { getPrice } = require('../data/binance-api');

const log = makeLogger('executor');

let _exchange = null;

function getExchange() {
  if (_exchange) return _exchange;

  if (!config.binanceApiKey || !config.binanceApiSecret) {
    throw new Error('BINANCE_API_KEY and BINANCE_API_SECRET must be set for live trading');
  }

  const options = {
    apiKey: config.binanceApiKey,
    secret: config.binanceApiSecret,
    options: { defaultType: 'future' },
  };

  if (config.binanceTestnet) {
    options.urls = {
      api: {
        public: 'https://testnet.binancefuture.com/fapi/v1',
        private: 'https://testnet.binancefuture.com/fapi/v1',
      },
    };
  }

  _exchange = new ccxt.binanceusdm(options);
  return _exchange;
}

/**
 * Set leverage and margin mode for a symbol.
 * Safe to call multiple times (ignores "already set" errors).
 */
async function prepareSymbol(symbol, leverage) {
  const ex = getExchange();
  const ccxtSymbol = symbol.replace('USDT', '/USDT');

  try {
    await ex.setMarginMode(config.marginType, ccxtSymbol);
    log.debug('Margin mode set', { symbol, mode: config.marginType });
  } catch (err) {
    if (!err.message.includes('already')) {
      log.warn('setMarginMode warning', { symbol, error: err.message });
    }
  }

  try {
    await ex.setLeverage(leverage, ccxtSymbol);
    log.info('Leverage set', { symbol, leverage });
  } catch (err) {
    log.warn('setLeverage warning', { symbol, error: err.message });
  }
}

/**
 * Calculate the stop-loss price given entry price, side, and max loss.
 *
 * For a LONG with margin M and leverage L:
 *   positionSize = M * L  (in USDT notional)
 *   qty = positionSize / entryPrice
 *   maxLoss = qty * |entryPrice - stopPrice|
 *   stopPrice = entryPrice - (maxLoss / qty)   for LONG
 *             = entryPrice + (maxLoss / qty)   for SHORT
 */
function calcStopPrice(side, entryPrice, qty, maxLossUsdt) {
  const lossPriceMove = maxLossUsdt / qty;
  if (side === 'LONG') {
    return parseFloat((entryPrice - lossPriceMove).toFixed(8));
  }
  return parseFloat((entryPrice + lossPriceMove).toFixed(8));
}

/**
 * Open a futures position.
 *
 * @param {string} symbol   e.g. 'BTCUSDT'
 * @param {string} side     'LONG' | 'SHORT'
 * @param {number} leverage integer
 * @returns {object|null}   position record or null on failure
 */
async function openPosition(symbol, side, leverage) {
  if (config.dryRun) {
    const mockPrice = await getPrice(symbol).catch(() => 1);
    const margin = config.maxPositionMarginUsdt;
    const qty = parseFloat(((margin * leverage) / mockPrice).toFixed(6));
    const stopPrice = calcStopPrice(side, mockPrice, qty, config.maxLossPerPositionUsdt);

    const pos = { symbol, side, leverage, entryPrice: mockPrice, qty, margin, stopPrice, orderId: 'dry-run', stopOrderId: 'dry-run' };
    state.openPosition(symbol, pos);
    log.info('[DRY RUN] Position opened', { symbol, side, leverage, entryPrice: mockPrice, stopPrice, qty });
    return pos;
  }

  const ex = getExchange();
  await prepareSymbol(symbol, leverage);

  const ccxtSymbol = symbol.replace('USDT', '/USDT');
  const entryPrice = await getPrice(symbol);
  const margin = config.maxPositionMarginUsdt;
  const notional = margin * leverage;
  const qty = parseFloat((notional / entryPrice).toFixed(6));

  log.info('Opening position', { symbol, side, leverage, entryPrice, qty, margin });

  try {
    // Market entry order
    const orderSide = side === 'LONG' ? 'buy' : 'sell';
    const entryOrder = await ex.createMarketOrder(ccxtSymbol, orderSide, qty, undefined, {
      positionSide: side,
    });

    const filledPrice = parseFloat(entryOrder.average || entryPrice);
    const stopPrice = calcStopPrice(side, filledPrice, qty, config.maxLossPerPositionUsdt);

    // Stop-market order (reduce-only)
    const stopSide = side === 'LONG' ? 'sell' : 'buy';
    const stopOrder = await ex.createOrder(ccxtSymbol, 'STOP_MARKET', stopSide, qty, undefined, {
      stopPrice: stopPrice.toFixed(8),
      closePosition: false,
      positionSide: side,
      reduceOnly: true,
    });

    const pos = {
      symbol,
      side,
      leverage,
      entryPrice: filledPrice,
      qty,
      margin,
      stopPrice,
      orderId: entryOrder.id,
      stopOrderId: stopOrder.id,
    };

    state.openPosition(symbol, pos);
    log.info('Position opened successfully', { symbol, filledPrice, stopPrice, stopOrderId: stopOrder.id });
    return pos;

  } catch (err) {
    log.error('Failed to open position', { symbol, error: err.message });
    return null;
  }
}

/**
 * Close a position at market price.
 * reason: 'stop-loss' | 'manual' | 'daily-limit'
 */
async function closePosition(symbol, reason) {
  const positions = state.getOpenPositions();
  const pos = positions[symbol];
  if (!pos) {
    log.warn('closePosition: no open position', { symbol });
    return null;
  }

  if (config.dryRun) {
    const currentPrice = await getPrice(symbol).catch(() => pos.entryPrice);
    const priceDiff = pos.side === 'LONG'
      ? currentPrice - pos.entryPrice
      : pos.entryPrice - currentPrice;
    const pnlUsdt = priceDiff * pos.qty;

    const closed = state.closePosition(symbol, {
      exitPrice: currentPrice,
      pnlUsdt: parseFloat(pnlUsdt.toFixed(4)),
      reason,
    });
    log.info('[DRY RUN] Position closed', { symbol, currentPrice, pnlUsdt, reason });
    return closed;
  }

  const ex = getExchange();
  const ccxtSymbol = symbol.replace('USDT', '/USDT');

  try {
    // Cancel the stop order first
    if (pos.stopOrderId && pos.stopOrderId !== 'dry-run') {
      await ex.cancelOrder(pos.stopOrderId, ccxtSymbol).catch((e) => {
        log.warn('Could not cancel stop order', { symbol, error: e.message });
      });
    }

    const closeSide = pos.side === 'LONG' ? 'sell' : 'buy';
    const closeOrder = await ex.createMarketOrder(ccxtSymbol, closeSide, pos.qty, undefined, {
      positionSide: pos.side,
      reduceOnly: true,
    });

    const exitPrice = parseFloat(closeOrder.average || closeOrder.price);
    const priceDiff = pos.side === 'LONG'
      ? exitPrice - pos.entryPrice
      : pos.entryPrice - exitPrice;
    const pnlUsdt = parseFloat((priceDiff * pos.qty).toFixed(4));

    const closed = state.closePosition(symbol, { exitPrice, pnlUsdt, reason });
    log.info('Position closed', { symbol, exitPrice, pnlUsdt, reason });
    return closed;

  } catch (err) {
    log.error('Failed to close position', { symbol, error: err.message });
    return null;
  }
}

/**
 * Check all open positions against current prices.
 * If price has blown through the stop (stop order might have missed), force close.
 */
async function monitorPositions() {
  const positions = state.getOpenPositions();
  const symbols = Object.keys(positions);
  if (symbols.length === 0) return;

  for (const symbol of symbols) {
    const pos = positions[symbol];
    try {
      const price = await getPrice(symbol);

      const hitStop = pos.side === 'LONG'
        ? price <= pos.stopPrice
        : price >= pos.stopPrice;

      if (hitStop) {
        log.warn('Stop price breached, forcing close', { symbol, price, stopPrice: pos.stopPrice });
        await closePosition(symbol, 'stop-loss');
      }
    } catch (err) {
      log.warn('monitorPositions error', { symbol, error: err.message });
    }
  }
}

module.exports = { openPosition, closePosition, monitorPositions };
