'use strict';

/**
 * Claude Opus decision agent (agent/decision.js)
 *
 * Takes aggregated market signals and asks Claude to:
 * 1. Score each candidate symbol
 * 2. Pick the best trade (if any)
 * 3. Return structured JSON: { symbol, side, leverage, reason, confidence }
 *
 * Uses adaptive thinking + streaming for reliability.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { makeLogger } = require('../lib/logger');
const config = require('../lib/config');

const log = makeLogger('agent');

let _client = null;

function getClient() {
  if (!_client) {
    if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    _client = new Anthropic.default({ apiKey: config.anthropicApiKey });
  }
  return _client;
}

const SYSTEM_PROMPT = `You are an expert crypto futures trading agent running on Binance USDT-M perpetuals.

Your strategy is derived from observing how market makers (MMs) behave before a Binance listing pump:
- MMs buy into "Binance contract shells" 48-72h before a listing becomes public
- Open interest rises significantly while price barely moves (they're accumulating quietly)
- Binance Square social volume spikes with real user discussion (not bots)
- The coin appears on the 24h gainers board with unusual momentum

Your job each cycle:
1. Review the signals provided: Square social data, OI divergence candidates, top gainers, open positions
2. Identify the SINGLE best trade candidate if one meets the criteria
3. Return a JSON decision object

MANDATORY OUTPUT FORMAT (return only valid JSON, no markdown):
{
  "action": "BUY" | "SKIP",
  "symbol": "BTCUSDT",         // only when action=BUY
  "side": "LONG" | "SHORT",    // only LONG unless clear bearish confluence
  "leverage": 20,               // suggested leverage (integer, 1-125)
  "reason": "brief explanation",
  "confidence": 1-5,            // 1=low, 5=very high
  "skipReason": "..."           // only when action=SKIP
}

HARD RULES you must always follow:
- Never suggest opening a position if max open positions (${config.maxOpenPositions}) would be exceeded
- Never suggest a symbol already in open_positions
- Prefer symbols matching: new listing (<180 days) OR historical high volatility
- Confidence must be ≥3 to suggest BUY; if best candidate is <3, return SKIP
- In dry_run mode, still return realistic decisions (they won't be executed)
- Default to LONG (trend-following, not counter-trend)`;

/**
 * Build the user message with all current signal data.
 */
function buildSignalMessage(signals) {
  const {
    squareSymbols,
    topGainers,
    oiDivergence,
    openPositions,
    isDryRun,
    dailyLossUsdt,
    dailyLossLimit,
  } = signals;

  const openSymbols = Object.keys(openPositions);
  const openCount = openSymbols.length;

  return `## Current Market Signals — ${new Date().toISOString()}

**Mode:** ${isDryRun ? 'DRY RUN (no real orders)' : 'LIVE TRADING'}
**Open positions (${openCount}/${config.maxOpenPositions}):** ${openCount === 0 ? 'none' : openSymbols.join(', ')}
**Daily loss so far:** ${dailyLossUsdt.toFixed(2)} USDT / ${dailyLossLimit} USDT limit

---

### 1. Binance Square — Hot symbols (real-user post count, bot-filtered)
${squareSymbols.length === 0
    ? 'No data available this cycle.'
    : squareSymbols.slice(0, 20).map((s) =>
        `- $${s.symbol}: ${s.realPostCount} real posts, ${s.totalLikes} likes${s.isHot ? ' 🔥' : ''}`
      ).join('\n')}

---

### 2. OI Divergence — OI rising, price flat (48h window)
${oiDivergence.length === 0
    ? 'No divergence signals this cycle.'
    : oiDivergence.slice(0, 10).map((s) =>
        `- ${s.symbol}: OI +${s.oiChangePercent}%, price change: ${s.priceChangePercent}%, last: $${s.lastPrice}`
      ).join('\n')}

---

### 3. Top 24h Gainers (momentum)
${topGainers.length === 0
    ? 'No gainer data.'
    : topGainers.slice(0, 15).map((s) =>
        `- ${s.symbol}: +${s.priceChangePercent}%, last: $${s.lastPrice}, volume: $${(s.quoteVolume / 1e6).toFixed(1)}M`
      ).join('\n')}

---

Analyze these signals. For each candidate symbol, check: 
1. Does it appear in multiple signal categories? (Square + OI + gainers = strongest signal)
2. Is it a new listing or historically volatile coin?
3. Is price action suggesting accumulation (OI up, price quiet)?

Return your JSON decision.`;
}

/**
 * Ask Claude to decide on the best trade.
 * Returns parsed decision object or null on failure.
 */
async function getTradeDecision(signals) {
  const client = getClient();
  const userMessage = buildSignalMessage(signals);

  log.info('Requesting Claude decision');

  try {
    const stream = await client.messages.stream({
      model: config.claudeModel,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const message = await stream.finalMessage();

    // Extract text content
    const textBlock = message.content.find((b) => b.type === 'text');
    if (!textBlock) {
      log.warn('Claude returned no text block');
      return null;
    }

    const raw = textBlock.text.trim();
    log.debug('Claude raw response', { raw: raw.slice(0, 500) });

    // Parse JSON - handle possible markdown code fences
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn('No JSON found in Claude response', { raw: raw.slice(0, 200) });
      return null;
    }

    const decision = JSON.parse(jsonMatch[0]);
    log.info('Claude decision', {
      action: decision.action,
      symbol: decision.symbol,
      confidence: decision.confidence,
      reason: decision.reason?.slice(0, 100),
    });

    return decision;

  } catch (err) {
    log.error('Claude API error', { error: err.message });
    return null;
  }
}

module.exports = { getTradeDecision };
