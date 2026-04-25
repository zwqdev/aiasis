'use strict';

/**
 * Bitget Trading Bot — Main Loop (index.js)
 *
 * Runs on a cron schedule (default: every 30 min).
 * Each cycle:
 *  1. Monitor existing positions (enforce SL)
 *  2. Check daily loss limit and position cap
 *  3. Run LLM agent with tool-calling:
 *     → Agent autonomously fetches gainers, K-lines, OI, events
 *     → Agent returns structured BUY / WATCH / SKIP decision
 *  4. Execute BUY decisions via Bitget Futures
 *
 * Usage:
 *   node scripts/trading-bot-bitget/index.js          # cron mode
 *   node scripts/trading-bot-bitget/index.js --once   # single cycle
 *
 * Required env vars (.env):
 *   BITGET_API_KEY, BITGET_API_SECRET, BITGET_PASSPHRASE
 *   OPENAI_API_KEY (or LLM_API_KEY)
 *   OPENAI_BASE_URL (optional, for non-OpenAI endpoints like Deepseek)
 *   LLM_MODEL      (default: gpt-4o)
 *   DRY_RUN=false  (set to false for live trading; default is dry run)
 */

require('dotenv').config();

const cron = require('node-cron');
const { makeLogger } = require('./lib/logger');
const config = require('./lib/config');
const state  = require('./lib/state');
const { getTradeDecision }              = require('./agent/decision');
const { openPosition, monitorPositions } = require('./exchange/executor');

const log = makeLogger('bot');

// ── Single trading cycle ──────────────────────────────────────────────────────

async function runCycle() {
  log.info('═══ Cycle start ═══', {
    time:    new Date().toISOString(),
    dryRun:  config.dryRun,
    model:   config.llmModel,
    baseUrl: config.llmBaseUrl,
  });

  // ── Step 1: Monitor existing positions ─────────────────────────────────────
  try {
    await monitorPositions();
  } catch (err) {
    log.error('monitorPositions failed', { error: err.message });
  }

  // ── Step 2: Gate checks ────────────────────────────────────────────────────
  const dailyLoss = state.getDailyLoss();
  if (dailyLoss >= config.dailyLossLimitUsdt) {
    log.warn('Daily loss limit reached — skipping scan', {
      dailyLoss: dailyLoss.toFixed(2),
      limit:     config.dailyLossLimitUsdt,
    });
    return;
  }

  const openPositions = state.getOpenPositions();
  if (Object.keys(openPositions).length >= config.maxOpenPositions) {
    log.info('Max open positions reached — skipping scan', {
      open: Object.keys(openPositions).length,
      max:  config.maxOpenPositions,
    });
    return;
  }

  // ── Step 3: Run LLM agent ──────────────────────────────────────────────────
  log.info('Starting LLM agent scan...');
  let decision;
  try {
    decision = await getTradeDecision();
  } catch (err) {
    log.error('Agent error', { error: err.message });
    return;
  }

  if (!decision) {
    log.warn('Agent returned no decision — skipping cycle');
    return;
  }

  log.info('Agent decision received', {
    action:     decision.action,
    symbol:     decision.symbol || '—',
    confidence: decision.confidence || '—',
    rr:         decision.riskRewardRatio || '—',
  });

  // ── Step 4: Execute decision ───────────────────────────────────────────────
  if (decision.action === 'SKIP') {
    log.info('Agent chose SKIP', { reason: (decision.skipReason || '').slice(0, 200) });
    return;
  }

  if (decision.action === 'WATCH') {
    log.info('Agent chose WATCH', {
      symbol: decision.symbol,
      reason: (decision.watchReason || '').slice(0, 200),
    });
    return;
  }

  if (decision.action !== 'BUY') {
    log.warn('Unknown action from agent', { action: decision.action });
    return;
  }

  // Validate BUY decision
  if (!decision.symbol) {
    log.warn('BUY decision missing symbol — skipping');
    return;
  }
  if (!decision.confidence || decision.confidence < 3) {
    log.warn('BUY confidence too low — skipping', { confidence: decision.confidence });
    return;
  }
  if (!decision.riskRewardRatio || decision.riskRewardRatio < 2) {
    log.warn('Risk/reward ratio too low — skipping', { rr: decision.riskRewardRatio });
    return;
  }

  // Double-check: symbol not already open
  if (openPositions[decision.symbol]) {
    log.warn('Symbol already in open positions — skipping', { symbol: decision.symbol });
    return;
  }

  // Execute
  log.info('Executing BUY', {
    symbol:     decision.symbol,
    side:       decision.side || 'LONG',
    leverage:   config.leverage,
    entryZone:  decision.entryZone,
    tp1:        decision.targets?.tp1,
    tp2:        decision.targets?.tp2,
    stopLoss:   decision.stopLoss,
    confidence: decision.confidence,
  });

  const pos = await openPosition(
    decision.symbol,
    decision.side || 'LONG',
    config.leverage,
    decision,
  );

  if (pos) {
    log.info('Position opened successfully', {
      symbol:     pos.symbol,
      entryPrice: pos.entryPrice,
      stopPrice:  pos.stopPrice,
      tp1:        pos.tp1,
      qty:        pos.qty,
      margin:     pos.margin,
    });
  } else {
    log.error('Failed to open position', { symbol: decision.symbol });
  }

  log.info('═══ Cycle end ═══');
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  // Validate required config
  if (!config.llmApiKey) {
    log.error('Missing LLM API key. Set OPENAI_API_KEY or LLM_API_KEY in .env');
    process.exit(1);
  }

  log.info('Trading bot starting', {
    dryRun:  config.dryRun,
    model:   config.llmModel,
    baseUrl: config.llmBaseUrl,
    maxPos:  config.maxOpenPositions,
    lever:   config.leverage,
    cron:    config.cronSchedule,
  });

  if (config.dryRun) {
    log.info('⚠️  DRY RUN MODE — no real orders will be placed (set DRY_RUN=false to go live)');
  }

  const runOnce = process.argv.includes('--once');

  if (runOnce) {
    await runCycle();
    process.exit(0);
  }

  // Run one cycle immediately on startup, then follow cron
  await runCycle().catch((err) => log.error('Initial cycle failed', { error: err.message }));

  cron.schedule(config.cronSchedule, async () => {
    await runCycle().catch((err) => log.error('Scheduled cycle failed', { error: err.message }));
  });

  log.info(`Bot running on schedule: ${config.cronSchedule}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
