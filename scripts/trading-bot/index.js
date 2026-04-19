'use strict';

/**
 * Trading bot main loop (index.js)
 *
 * Runs on a cron schedule (default: every 15 min).
 * Each cycle:
 *  1. Monitor existing positions (enforce stop-loss)
 *  2. Gather signals: Binance Square + OI divergence + top gainers
 *  3. Ask Claude to decide: BUY symbol X or SKIP
 *  4. Execute the decision via Binance Futures
 *
 * Start: node scripts/trading-bot/index.js
 * One-shot: node scripts/trading-bot/index.js --once
 */

require('dotenv').config();

const cron = require('node-cron');
const { makeLogger } = require('./lib/logger');
const config = require('./lib/config');
const state = require('./lib/state');
const { scanBinanceSquare } = require('./data/binance-square');
const { getTopGainers, getOiDivergence } = require('./data/binance-api');
const { getTradeDecision } = require('./agent/decision');
const { openPosition, closePosition, monitorPositions } = require('./exchange/executor');

const log = makeLogger('bot');

// ─────────────────────────────────────────────────────────────────────────────
// Single trading cycle
// ─────────────────────────────────────────────────────────────────────────────

async function runCycle() {
  log.info('═══ Cycle start ═══', { dryRun: config.dryRun, time: new Date().toISOString() });

  // ── Step 1: Monitor existing positions ─────────────────────────────────────
  try {
    await monitorPositions();
  } catch (err) {
    log.error('monitorPositions failed', { error: err.message });
  }

  // ── Step 2: Check daily loss limit ─────────────────────────────────────────
  const dailyLoss = state.getDailyLoss();
  if (dailyLoss >= config.dailyLossLimitUsdt) {
    log.warn('Daily loss limit reached — skipping new trades', {
      dailyLoss,
      limit: config.dailyLossLimitUsdt,
    });
    return;
  }

  // ── Step 3: Check open position cap ────────────────────────────────────────
  const openPositions = state.getOpenPositions();
  if (Object.keys(openPositions).length >= config.maxOpenPositions) {
    log.info('Max open positions reached — skipping entry scan', {
      open: Object.keys(openPositions).length,
      max: config.maxOpenPositions,
    });
    return;
  }

  // ── Step 4: Gather market signals ──────────────────────────────────────────
  log.info('Gathering signals...');

  let squareSymbols = [];
  let topGainers = [];
  let oiDivergence = [];

  // Run all data fetches in parallel
  const [squareResult, gainersResult, oiResult] = await Promise.allSettled([
    scanBinanceSquare(),
    getTopGainers(),
    getOiDivergence(),
  ]);

  if (squareResult.status === 'fulfilled') {
    squareSymbols = squareResult.value;
    state.setLastSquareScan(new Date().toISOString());
    log.info('Square signals', { count: squareSymbols.length });
  } else {
    log.warn('Square scan failed', { error: squareResult.reason?.message });
  }

  if (gainersResult.status === 'fulfilled') {
    topGainers = gainersResult.value;
    log.info('Gainer signals', { count: topGainers.length });
  } else {
    log.warn('Gainers fetch failed', { error: gainersResult.reason?.message });
  }

  if (oiResult.status === 'fulfilled') {
    oiDivergence = oiResult.value;
    log.info('OI divergence signals', { count: oiDivergence.length });
  } else {
    log.warn('OI divergence failed', { error: oiResult.reason?.message });
  }

  // ── Step 5: Claude decision ────────────────────────────────────────────────
  const signals = {
    squareSymbols,
    topGainers,
    oiDivergence,
    openPositions,
    isDryRun: config.dryRun,
    dailyLossUsdt: dailyLoss,
    dailyLossLimit: config.dailyLossLimitUsdt,
  };

  const decision = await getTradeDecision(signals);

  if (!decision) {
    log.warn('No decision returned from Claude');
    return;
  }

  if (decision.action !== 'BUY') {
    log.info('Claude says SKIP', { reason: decision.skipReason || decision.reason });
    return;
  }

  // ── Step 6: Validate decision ─────────────────────────────────────────────
  const { symbol, side, leverage, confidence } = decision;

  if (!symbol || !side || !leverage) {
    log.warn('Incomplete decision from Claude', { decision });
    return;
  }

  if (confidence < 3) {
    log.info('Confidence too low, skipping', { symbol, confidence });
    return;
  }

  if (state.hasOpenPosition(symbol)) {
    log.info('Already have open position, skipping', { symbol });
    return;
  }

  if (Object.keys(state.getOpenPositions()).length >= config.maxOpenPositions) {
    log.info('Max positions reached (race condition check)', { symbol });
    return;
  }

  // ── Step 7: Execute ───────────────────────────────────────────────────────
  log.info('Executing trade', { symbol, side, leverage, confidence, reason: decision.reason });

  const position = await openPosition(symbol, side, leverage);

  if (position) {
    log.info('Trade executed successfully', {
      symbol,
      side,
      entryPrice: position.entryPrice,
      stopPrice: position.stopPrice,
      maxLoss: config.maxLossPerPositionUsdt,
      dryRun: config.dryRun,
    });
  } else {
    log.error('Trade execution failed', { symbol });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log.info('Trading bot starting', {
    dryRun: config.dryRun,
    model: config.claudeModel,
    maxPositionMargin: config.maxPositionMarginUsdt,
    maxLossPerPosition: config.maxLossPerPositionUsdt,
    dailyLossLimit: config.dailyLossLimitUsdt,
    schedule: config.cronSchedule,
  });

  if (config.dryRun) {
    log.warn('DRY RUN mode — no real orders will be placed. Set DRY_RUN=false to trade live.');
  }

  if (!config.anthropicApiKey) {
    log.error('ANTHROPIC_API_KEY not set — cannot run decision agent');
    process.exit(1);
  }

  const runOnce = process.argv.includes('--once');

  if (runOnce) {
    log.info('Running single cycle (--once)');
    await runCycle();
    log.info('Single cycle complete');
    return;
  }

  // Immediate first run
  await runCycle().catch((err) => {
    log.error('Cycle error', { error: err.message, stack: err.stack });
  });

  // Scheduled runs
  log.info('Scheduling recurring cycles', { cron: config.cronSchedule });
  cron.schedule(config.cronSchedule, async () => {
    await runCycle().catch((err) => {
      log.error('Scheduled cycle error', { error: err.message });
    });
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    log.info('Shutting down');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    log.info('Shutting down');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
