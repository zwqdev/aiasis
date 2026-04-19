'use strict';

/**
 * File-backed JSON state store for the Binance Futures trading bot.
 * Persists open positions, daily PnL, and scan history across restarts.
 */

const fs = require('node:fs');
const path = require('node:path');
const { makeLogger } = require('./logger');

const log = makeLogger('state');
const STATE_PATH = path.resolve(process.cwd(), 'data/.trading-bot-state.json');

const DEFAULT_STATE = {
  // { symbol → { openedAt, side, entryPrice, qty, margin, leverage, stopPrice, orderId, stopOrderId } }
  openPositions: {},
  // Array of closed trade records for PnL tracking
  closedTrades: [],
  // Running daily loss in USDT (reset at UTC midnight)
  dailyLossUsdt: 0,
  dailyLossDate: null,
  // ISO timestamp of last Binance Square scan
  lastSquareScan: null,
  // Cache: symbol → listingDate (to avoid repeated API calls)
  symbolListingDates: {},
};

let _state = null;

function load() {
  if (_state) return _state;
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    _state = { ...DEFAULT_STATE, ...JSON.parse(raw) };
    log.info('State loaded', { openPositions: Object.keys(_state.openPositions).length });
  } catch {
    _state = structuredClone(DEFAULT_STATE);
    log.info('Starting with fresh state');
  }
  return _state;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(_state, null, 2));
  } catch (err) {
    log.error('Failed to save state', { error: err.message });
  }
}

// ── Daily loss tracking ───────────────────────────────────────────────────

function getTodayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function getDailyLoss() {
  const s = load();
  if (s.dailyLossDate !== getTodayUtc()) {
    s.dailyLossUsdt = 0;
    s.dailyLossDate = getTodayUtc();
    save();
  }
  return s.dailyLossUsdt;
}

function addDailyLoss(lossUsdt) {
  const s = load();
  getDailyLoss(); // ensures date reset
  s.dailyLossUsdt += lossUsdt;
  save();
}

// ── Open positions ────────────────────────────────────────────────────────

function getOpenPositions() {
  return load().openPositions;
}

function hasOpenPosition(symbol) {
  return symbol in load().openPositions;
}

function openPosition(symbol, positionData) {
  const s = load();
  s.openPositions[symbol] = { ...positionData, openedAt: new Date().toISOString() };
  save();
  log.info('Position opened', { symbol, margin: positionData.margin, side: positionData.side });
}

function closePosition(symbol, closeData) {
  const s = load();
  const pos = s.openPositions[symbol];
  if (!pos) return null;
  delete s.openPositions[symbol];
  const closed = { ...pos, ...closeData, closedAt: new Date().toISOString() };
  s.closedTrades.push(closed);
  if (closeData.pnlUsdt < 0) addDailyLoss(Math.abs(closeData.pnlUsdt));
  save();
  log.info('Position closed', { symbol, reason: closeData.reason, pnlUsdt: closeData.pnlUsdt });
  return closed;
}

// ── Square scan timestamp ─────────────────────────────────────────────────

function getLastSquareScan() {
  return load().lastSquareScan;
}

function setLastSquareScan(iso) {
  load().lastSquareScan = iso;
  save();
}

// ── Listing date cache ────────────────────────────────────────────────────

function getListingDate(symbol) {
  return load().symbolListingDates[symbol] || null;
}

function setListingDate(symbol, dateIso) {
  load().symbolListingDates[symbol] = dateIso;
  save();
}

module.exports = {
  getOpenPositions,
  hasOpenPosition,
  openPosition,
  closePosition,
  getDailyLoss,
  addDailyLoss,
  getLastSquareScan,
  setLastSquareScan,
  getListingDate,
  setListingDate,
};
