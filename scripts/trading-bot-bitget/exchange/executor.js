'use strict';

/**
 * Bitget USDT-M Futures executor (exchange/executor.js)
 *
 * Handles:
 *  - Setting leverage and margin mode per symbol
 *  - Opening LONG/SHORT market orders (isolated margin)
 *  - Placing stop-loss orders calibrated to maxLossPerPositionUsdt
 *  - Closing positions (market close)
 *  - Position monitoring: enforce SL if stop order is missed
 *
 * Uses ccxt for order management (ccxt.bitget with swap type).
 */

const ccxt  = require('ccxt');
const { makeLogger } = require('../lib/logger');
const config = require('../lib/config');
const state  = require('../lib/state');
const { getPrice } = require('../data/bitget-api');

const log = makeLogger('executor');

let _exchange = null;

function getExchange() {
  if (_exchange) return _exchange;

  if (!config.bitgetApiKey || !config.bitgetApiSecret || !config.bitgetPassphrase) {
    throw new Error(
      'BITGET_API_KEY, BITGET_API_SECRET and BITGET_PASSPHRASE must be set for live trading'
    );
  }

  _exchange = new ccxt.bitget({
    apiKey:   config.bitgetApiKey,
    secret:   config.bitgetApiSecret,
    password: config.bitgetPassphrase, // Bitget calls this "passphrase"
    options:  { defaultType: 'swap' }, // USDT-M perpetuals
  });

  return _exchange;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert Bitget symbol format.
 * Bitget ccxt swap: 'BTC/USDT:USDT'
 */
function toCcxtSymbol(symbol) {
  const base = symbol.replace('USDT', '');
  return `${base}/USDT:USDT`;
}

/**
 * Calculate stop-loss price.
 * LONG: stopPrice = entryPrice - (maxLoss / qty)
 * SHORT: stopPrice = entryPrice + (maxLoss / qty)
 */
function calcStopPrice(side, entryPrice, qty, maxLossUsdt) {
  const lossPriceMove = maxLossUsdt / qty;
  return side === 'LONG'
    ? parseFloat((entryPrice - lossPriceMove).toFixed(8))
    : parseFloat((entryPrice + lossPriceMove).toFixed(8));
}

// ── Symbol setup ──────────────────────────────────────────────────────────────

async function prepareSymbol(symbol, leverage) {
  const ex = getExchange();
  const ccxtSym = toCcxtSymbol(symbol);

  // Set margin mode (isolated)
  try {
    await ex.setMarginMode(config.marginMode, ccxtSym);
    log.debug('Margin mode set', { symbol, mode: config.marginMode });
  } catch (err) {
    // "already set" errors are safe to ignore
    if (!err.message?.toLowerCase().includes('already')) {
      log.warn('setMarginMode warning', { symbol, error: err.message });
    }
  }

  // Set leverage
  try {
    await ex.setLeverage(leverage, ccxtSym);
    log.info('Leverage set', { symbol, leverage });
  } catch (err) {
    log.warn('setLeverage warning', { symbol, error: err.message });
  }
}

// ── Open position ─────────────────────────────────────────────────────────────

/**
 * Open a futures position.
 *
 * @param {string} symbol   e.g. 'BTCUSDT'
 * @param {string} side     'LONG' | 'SHORT'
 * @param {number} leverage integer
 * @param {object} decision Full LLM decision for logging
 * @returns {object|null}   Position record or null on failure
 */
async function openPosition(symbol, side, leverage, decision = {}) {
  const margin    = config.maxPositionMarginUsdt;
  const maxLoss   = config.maxLossPerPositionUsdt;

  // ── Dry run ─────────────────────────────────────────────────────────────────
  if (config.dryRun) {
    const entryPrice = await getPrice(symbol).catch(() => 1);
    const qty        = parseFloat(((margin * leverage) / entryPrice).toFixed(6));
    const stopPrice  = calcStopPrice(side, entryPrice, qty, maxLoss);

    const pos = {
      symbol, side, leverage, entryPrice, qty, margin, stopPrice,
      orderId: 'dry-run', stopOrderId: 'dry-run',
      tp1: decision.targets?.tp1 || null,
      tp2: decision.targets?.tp2 || null,
      tp3: decision.targets?.tp3 || null,
      entryZone: decision.entryZone || null,
    };

    state.openPosition(symbol, pos);
    log.info('[DRY RUN] Position opened', {
      symbol, side, leverage, entryPrice, stopPrice, qty,
      tp1: pos.tp1, tp2: pos.tp2,
    });
    return pos;
  }

  // ── Live trading ────────────────────────────────────────────────────────────
  const ex = getExchange();
  await prepareSymbol(symbol, leverage);

  const ccxtSym    = toCcxtSymbol(symbol);
  const entryPrice = await getPrice(symbol);
  const qty        = parseFloat(((margin * leverage) / entryPrice).toFixed(6));
  const ccxtSide   = side === 'LONG' ? 'buy' : 'sell';
  const stopPrice  = decision.stopLoss || calcStopPrice(side, entryPrice, qty, maxLoss);
  const tp1Price   = decision.targets?.tp1 || null;

  let order;
  try {
    order = await ex.createOrder(ccxtSym, 'market', ccxtSide, qty, undefined, {
      marginMode:  config.marginMode,
      posSide:     side === 'LONG' ? 'long' : 'short', // Bitget hedge mode
      // Bitget official v2 place-order fields for attached TP/SL.
      // `presetStopSurplusPrice` = take-profit trigger, `presetStopLossPrice` = stop-loss trigger.
      presetStopSurplusPrice: tp1Price ? String(tp1Price) : undefined,
      presetStopLossPrice: String(stopPrice),
    });
    log.info('Market order placed', {
      symbol,
      side,
      qty,
      entryPrice,
      orderId: order.id,
      presetTp: tp1Price,
      presetSl: stopPrice,
    });
  } catch (err) {
    log.error('Failed to open position', { symbol, error: err.message });
    return null;
  }

  // Place stop-loss order
  const stopSide   = side === 'LONG' ? 'sell' : 'buy';

  let stopOrder;
  try {
    stopOrder = await ex.createOrder(ccxtSym, 'stop_market', stopSide, qty, undefined, {
      stopPrice,
      reduceOnly:  true,
      posSide:     side === 'LONG' ? 'long' : 'short',
    });
    log.info('Stop-loss order placed', { symbol, stopPrice, stopOrderId: stopOrder.id });
  } catch (err) {
    log.warn('Failed to place stop-loss — MONITOR MANUALLY', { symbol, error: err.message });
    stopOrder = { id: 'failed' };
  }

  const pos = {
    symbol, side, leverage, entryPrice, qty, margin,
    stopPrice, orderId: order.id, stopOrderId: stopOrder?.id,
    tp1: decision.targets?.tp1 || null,
    tp2: decision.targets?.tp2 || null,
    tp3: decision.targets?.tp3 || null,
    entryZone: decision.entryZone || null,
  };

  state.openPosition(symbol, pos);
  return pos;
}

// ── Close position ────────────────────────────────────────────────────────────

/**
 * Close a position (market close).
 *
 * @param {string} symbol
 * @param {number} pnlUsdt  Realized PnL in USDT (for state tracking)
 */
async function closePosition(symbol, pnlUsdt = 0) {
  const positions = state.getOpenPositions();
  const pos = positions[symbol];
  if (!pos) { log.warn('closePosition: no open position found', { symbol }); return; }

  if (config.dryRun) {
    log.info('[DRY RUN] Position closed', { symbol, pnlUsdt });
    state.closePosition(symbol, pnlUsdt);
    return;
  }

  const ex      = getExchange();
  const ccxtSym = toCcxtSymbol(symbol);
  const side    = pos.side === 'LONG' ? 'sell' : 'buy';

  try {
    await ex.createOrder(ccxtSym, 'market', side, pos.qty, undefined, {
      reduceOnly: true,
      posSide:    pos.side === 'LONG' ? 'long' : 'short',
    });
    log.info('Position closed', { symbol, pnlUsdt });
  } catch (err) {
    log.error('Failed to close position', { symbol, error: err.message });
    return;
  }

  // Cancel stop-loss order if it still exists
  if (pos.stopOrderId && pos.stopOrderId !== 'failed' && pos.stopOrderId !== 'dry-run') {
    try {
      await ex.cancelOrder(pos.stopOrderId, ccxtSym);
    } catch {
      // Already triggered or filled — safe to ignore
    }
  }

  state.closePosition(symbol, pnlUsdt);
}

// ── Position monitor ──────────────────────────────────────────────────────────

/**
 * Monitor all open positions and enforce SL if exchange order is missed.
 * Called at the start of every cycle.
 */
async function monitorPositions() {
  const positions = state.getOpenPositions();
  if (Object.keys(positions).length === 0) return;

  for (const [symbol, pos] of Object.entries(positions)) {
    try {
      const price = await getPrice(symbol);
      const breachedSL =
        (pos.side === 'LONG'  && price < pos.stopPrice) ||
        (pos.side === 'SHORT' && price > pos.stopPrice);

      if (breachedSL) {
        const pnl = pos.side === 'LONG'
          ? (price - pos.entryPrice) * pos.qty
          : (pos.entryPrice - price) * pos.qty;

        log.warn('SL breached — emergency close', { symbol, price, stopPrice: pos.stopPrice, pnl });
        await closePosition(symbol, pnl);
      } else {
        const unrealizedPct = pos.side === 'LONG'
          ? ((price - pos.entryPrice) / pos.entryPrice * 100).toFixed(2)
          : ((pos.entryPrice - price) / pos.entryPrice * 100).toFixed(2);

        log.info('Position health check', {
          symbol, side: pos.side,
          entryPrice: pos.entryPrice, currentPrice: price,
          unrealizedPct: `${unrealizedPct}%`,
          stopPrice: pos.stopPrice,
          tp1: pos.tp1,
        });
      }
    } catch (err) {
      log.error('monitorPositions error', { symbol, error: err.message });
    }
  }
}

module.exports = { openPosition, closePosition, monitorPositions };
