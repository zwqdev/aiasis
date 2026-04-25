'use strict';

/**
 * File-backed JSON state store for the Bitget trading bot.
 * Persists open positions, daily PnL, and OI history across restarts.
 */

const fs   = require('node:fs');
const path = require('node:path');
const { makeLogger } = require('./logger');

const log = makeLogger('state');
const STATE_PATH = path.resolve(process.cwd(), 'data/.bitget-bot-state.json');

const DEFAULT_STATE = {
  // { symbol → { openedAt, side, entryPrice, qty, margin, leverage, stopPrice, orderId } }
  openPositions: {},
  // Closed trade records for PnL history
  closedTrades: [],
  // Running daily loss in USDT (reset at UTC midnight)
  dailyLossUsdt: 0,
  dailyLossDate: null,
  // OI snapshot cache { symbol → { oiUsdt, capturedAt } }
  oiSnapshots: {},
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

// ── Daily loss ────────────────────────────────────────────────────────────────

function todayUtc() { return new Date().toISOString().slice(0, 10); }

function getDailyLoss() {
  const s = load();
  if (s.dailyLossDate !== todayUtc()) { s.dailyLossUsdt = 0; s.dailyLossDate = todayUtc(); save(); }
  return s.dailyLossUsdt;
}

function addDailyLoss(amount) {
  const s = load();
  if (s.dailyLossDate !== todayUtc()) { s.dailyLossUsdt = 0; s.dailyLossDate = todayUtc(); }
  s.dailyLossUsdt += amount;
  save();
}

// ── Positions ─────────────────────────────────────────────────────────────────

function getOpenPositions() { return load().openPositions; }

function openPosition(symbol, record) {
  const s = load();
  s.openPositions[symbol] = { ...record, openedAt: new Date().toISOString() };
  save();
}

function closePosition(symbol, pnl = 0) {
  const s = load();
  const pos = s.openPositions[symbol];
  if (!pos) return;
  s.closedTrades.push({ ...pos, closedAt: new Date().toISOString(), pnl });
  delete s.openPositions[symbol];
  if (pnl < 0) addDailyLoss(Math.abs(pnl));
  save();
}

// ── OI snapshots (for divergence detection) ───────────────────────────────────

function saveOiSnapshot(symbol, oiUsdt) {
  const s = load();
  s.oiSnapshots[symbol] = { oiUsdt, capturedAt: new Date().toISOString() };
  save();
}

function getOiSnapshot(symbol) { return load().oiSnapshots[symbol] || null; }

module.exports = {
  getDailyLoss, addDailyLoss,
  getOpenPositions, openPosition, closePosition,
  saveOiSnapshot, getOiSnapshot,
};
