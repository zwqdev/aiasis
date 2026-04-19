'use strict';

require('dotenv').config();

function optionalEnv(key, defaultValue) {
  return process.env[key] || defaultValue;
}

function optionalEnvFloat(key, defaultValue) {
  const v = process.env[key];
  return v ? parseFloat(v) : defaultValue;
}

function optionalEnvInt(key, defaultValue) {
  const v = process.env[key];
  return v ? parseInt(v, 10) : defaultValue;
}

module.exports = {
  // ── Mode ───────────────────────────────────────────────────────────────────
  // DRY_RUN=false to enable real order execution
  dryRun: process.env.DRY_RUN !== 'false',

  // ── Binance credentials ────────────────────────────────────────────────────
  get binanceApiKey() { return process.env.BINANCE_API_KEY || null; },
  get binanceApiSecret() { return process.env.BINANCE_API_SECRET || null; },
  // Set to true to use Binance testnet
  binanceTestnet: process.env.BINANCE_TESTNET === 'true',

  // ── Claude API ─────────────────────────────────────────────────────────────
  get anthropicApiKey() { return process.env.ANTHROPIC_API_KEY || null; },
  claudeModel: optionalEnv('CLAUDE_MODEL', 'claude-opus-4-6'),

  // ── Strategy params ────────────────────────────────────────────────────────
  // Max USDT margin allocated per trade
  maxPositionMarginUsdt: optionalEnvFloat('MAX_POSITION_MARGIN_USDT', 50),
  // Hard stop: max USDT loss per position before forced close (200U rule)
  maxLossPerPositionUsdt: optionalEnvFloat('MAX_LOSS_PER_POSITION_USDT', 200),
  // Daily loss limit: pause trading after this much total loss in a day
  dailyLossLimitUsdt: optionalEnvFloat('DAILY_LOSS_LIMIT_USDT', 600),
  // Max simultaneous open positions
  maxOpenPositions: optionalEnvInt('MAX_OPEN_POSITIONS', 3),
  // Leverage to request (Binance will cap at symbol max)
  leverage: optionalEnvInt('LEVERAGE', 20),
  // Margin mode: ISOLATED or CROSSED
  marginType: optionalEnv('MARGIN_TYPE', 'ISOLATED'),

  // ── Binance Square scraping ────────────────────────────────────────────────
  squareProfileDir: optionalEnv('SQUARE_PROFILE_DIR', '.playwright/x-profile'),
  squareScanIntervalMs: optionalEnvInt('SQUARE_SCAN_INTERVAL_MS', 15 * 60 * 1000),
  // How many top posts to analyse per scan
  squareTopPostsLimit: optionalEnvInt('SQUARE_TOP_POSTS_LIMIT', 30),

  // ── Signal thresholds ──────────────────────────────────────────────────────
  // Minimum 24h price gain % to appear on gainer radar
  minGainerPercent: optionalEnvFloat('MIN_GAINER_PERCENT', 5),
  // OI increase % over 48h to qualify as OI-divergence signal
  minOiIncreasePercent: optionalEnvFloat('MIN_OI_INCREASE_PERCENT', 20),
  // Minimum price change % over same window to disqualify (price already moved)
  maxPriceChangeForOiSignal: optionalEnvFloat('MAX_PRICE_CHANGE_FOR_OI_SIGNAL', 3),
  // Only consider symbols listed within this many days
  newListingDays: optionalEnvInt('NEW_LISTING_DAYS', 180),
  // Scheduling cron expression (default: every 15 min)
  cronSchedule: optionalEnv('CRON_SCHEDULE', '*/15 * * * *'),
};
