'use strict';

require('dotenv').config();

function env(key, fallback) { return process.env[key] || fallback; }
function envFloat(key, fallback) { const v = process.env[key]; return v ? parseFloat(v) : fallback; }
function envInt(key, fallback) { const v = process.env[key]; return v ? parseInt(v, 10) : fallback; }

module.exports = {
  // ── Mode ───────────────────────────────────────────────────────────────────
  dryRun: process.env.DRY_RUN !== 'false',

  // ── Bitget credentials ─────────────────────────────────────────────────────
  get bitgetApiKey()    { return process.env.BITGET_API_KEY    || null; },
  get bitgetApiSecret() { return process.env.BITGET_API_SECRET || null; },
  get bitgetPassphrase(){ return process.env.BITGET_PASSPHRASE || null; },

  // ── LLM (OpenAI-compatible) ────────────────────────────────────────────────
  // Set OPENAI_BASE_URL to use any compatible endpoint (Deepseek, Qwen, etc.)
  get llmApiKey()  { return process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || null; },
  llmBaseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
  llmModel:   env('LLM_MODEL', 'gpt-4o'),

  // ── Risk params ────────────────────────────────────────────────────────────
  // Max USDT margin per trade
  maxPositionMarginUsdt: envFloat('MAX_POSITION_MARGIN_USDT', 100),
  // Max loss per position before forced SL close
  maxLossPerPositionUsdt: envFloat('MAX_LOSS_PER_POSITION_USDT', 100),
  // Daily loss limit: pause new trades after this loss
  dailyLossLimitUsdt: envFloat('DAILY_LOSS_LIMIT_USDT', 300),
  // Max simultaneous positions
  maxOpenPositions: envInt('MAX_OPEN_POSITIONS', 3),
  // Default leverage (Bitget will cap at symbol max)
  leverage: envInt('LEVERAGE', 10),
  // Margin mode: isolated | cross
  marginMode: env('MARGIN_MODE', 'cross'),

  // ── Scanner thresholds ─────────────────────────────────────────────────────
  // Min 24h gain % for gainer scan (default -100 = include all symbols, then rank)
  minGainerPercent: envFloat('MIN_GAINER_PERCENT', -100),
  // Min 24h USDT volume (default 0 = no volume filter)
  minVolumeUsdt: envFloat('MIN_VOLUME_USDT', 0),
  // How many top gainers to pass to LLM
  topGainersLimit: envInt('TOP_GAINERS_LIMIT', 15),

  // ── Schedule ───────────────────────────────────────────────────────────────
  cronSchedule: env('CRON_SCHEDULE', '*/30 * * * *'),

  // ── LLM agent ─────────────────────────────────────────────────────────────
  // Max tool-call turns before aborting
  maxAgentTurns: envInt('MAX_AGENT_TURNS', 20),
  // Print detailed LLM/tool reasoning trace logs (set LLM_TRACE=false to disable)
  llmTrace: env('LLM_TRACE', 'true') !== 'false',

  // ── UX notifications ──────────────────────────────────────────────────────
  // macOS popup notification on BUY signal / execution
  buyNotification: env('BUY_NOTIFICATION', 'true') !== 'false',
};
