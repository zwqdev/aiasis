'use strict';

/**
 * LLM Trading Agent with autonomous tool calling (agent/decision.js)
 *
 * Uses any OpenAI-compatible API endpoint (GPT-4o, Deepseek, Qwen, etc.)
 *
 * Flow:
 *  1. LLM receives system prompt (HaxKai breakout-pullback strategy)
 *  2. LLM autonomously calls tools in order it deems best:
 *     get_top_gainers → get_kline_data → get_oi_data → get_funding_rate
 *     → search_coin_events → get_open_positions → final decision
 *  3. We run a tool-calling loop until LLM stops calling tools
 *  4. LLM returns structured JSON decision
 */

const OpenAI = require('openai');
const { makeLogger } = require('../lib/logger');
const config = require('../lib/config');
const { TOOL_DEFINITIONS, executeTool } = require('./tools');

const log = makeLogger('agent');

let _client = null;

function traceLog(message, meta) {
  if (!config.llmTrace) return;
  log.info(message, meta);
}

function getClient() {
  if (!_client) {
    if (!config.llmApiKey) throw new Error('OPENAI_API_KEY (or LLM_API_KEY) is not set');
    _client = new OpenAI({
      apiKey:  config.llmApiKey,
      baseURL: config.llmBaseUrl,
    });
  }
  return _client;
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an autonomous crypto spot trading scanner agent.
Your strategy is the "Breakout-Pullback-Bounce" methodology used by professional technical traders.

## MANDATORY TOOL CALLING SEQUENCE
For each scan cycle, you MUST call tools in this order:
1. get_open_positions — check if new trades are even allowed
2. get_top_gainers(limit=15, min_change_percent=-100, min_volume_usdt=0) — fetch all-symbol 24h change ranking and take TOP 15 only
3. get_kline_data (1H) — confirm trend direction (must align with LONG bias)
4. get_kline_data (15m) — find breakout-pullback-bounce entry timing
5. get_oi_data — check OI divergence for candidates that pass kline analysis
6. get_funding_rate — check funding sentiment for top candidates
7. Return final JSON decision (no more tool calls)

## ENTRY CRITERIA (ALL must be satisfied for BUY)
- Use the deterministic structure fields from get_kline_data first. Prefer structure.resistanceLevel, structure.supportLevel, structure.pullbackZone, structure.breakout.detected, and structure.breakout.retestConfirmed over free-form chart guessing.
- [ ] 1H trend confirmation: trend is bullish (higher highs/higher lows) or price holds above key 1H support
- [ ] 15m breakout: price has closed ABOVE a significant horizontal resistance on the 15m chart
- [ ] Volume confirmation: 15m breakout candle volume is ≥1.5x the 20-period average on 15m
- [ ] 15m pullback present: price retraces toward the 15m breakout level (yellow zone)
- [ ] Structure intact: price has NOT closed below the 15m breakout level
- [ ] OI neutral or rising (not collapsing — would indicate distribution)
- [ ] Funding rate: not severely overheated (>0.1% per 8h)
- [ ] Risk/reward ≥ 1:2 (TP1 distance ≥ 2× SL distance from entry)
- [ ] Portfolio: open position slots available, daily loss limit not hit

## PRICE LEVEL IDENTIFICATION
- Blue line (breakout level): use structure.resistanceLevel from 15m when available
- Yellow zone (entry zone): use structure.pullbackZone from 15m when available
- Red line (stop loss): below the yellow zone; prefer structure.supportLevel or the next lower 15m support as the invalidation level
  → SL is typically 1-4% below entry, set at the next lower key 15m support while respecting 1H trend context
- Green lines (take profit):
  → TP1 = next overhead resistance on 15m (closest significant level above entry)
  → TP2 = next resistance above TP1 on 1H
  → TP3 = major target on 4H/1D

## POSITION MANAGEMENT RULES (embed in your reason)
- TP1 hit: close 50% position, move SL to entry (zero risk)
- TP2 hit: close 30% more, move SL to just below TP1
- Remaining 20%: moon bag — let it run with trailing SL
- If price stalls without reaching TP1 after expected time: exit at breakeven
- SL trigger: 15m CANDLE CLOSE below red line (not intraday wick)

## OUTPUT FORMAT
You MUST return valid JSON only (no markdown, no extra text):
{
  "action": "BUY" | "WATCH" | "SKIP",
  "symbol": "ETHUSDT",
  "side": "LONG",
  "entryZone": { "low": 2000, "high": 2100 },
  "stopLoss": 1850,
  "targets": {
    "tp1": 2400,
    "tp2": 2800,
    "tp3": 3500
  },
  "positionManagement": "Close 50% at TP1 and move SL to entry. Close 30% at TP2 and trail SL to TP1. Let 20% run to TP3.",
  "reason": "Concise explanation: breakout level, volume, pullback, OI, events checked",
  "confidence": 1,
  "riskRewardRatio": 2.5,
  "watchReason": "...",
  "skipReason": "..."
}

## HARD RULES
- NEVER recommend BUY if portfolio slots are full or daily loss limit is hit
- NEVER recommend BUY if confidence < 3
- NEVER add markdown code fences to your JSON output
- If no candidate meets all criteria, return action=SKIP with skipReason
- If a candidate is close but needs one more confirmation: return action=WATCH`;

// ── Agent loop ────────────────────────────────────────────────────────────────

/**
 * Run the LLM agent with autonomous tool calling.
 * The agent will call tools as needed and return a final decision.
 *
 * @returns {Promise<object|null>} Parsed decision object or null on failure
 */
async function getTradeDecision() {
  const client = getClient();

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Start a new scan cycle. Current time: ${new Date().toISOString()}. ` +
        `Begin with get_open_positions, then get_top_gainers(limit=15, min_change_percent=-100, min_volume_usdt=0). ` +
        `Analyze symbols from this TOP 15 pool with kline, OI, and funding tools. ` +
        `Return your final JSON decision when done.`,
    },
  ];

  const maxTurns = config.maxAgentTurns;
  let toolCallCount = 0;

  log.info('Agent scan started', { model: config.llmModel, maxTurns });

  for (let turn = 0; turn < maxTurns; turn++) {
    let response;
    try {
      response = await client.chat.completions.create({
        model:       config.llmModel,
        messages,
        tools:       TOOL_DEFINITIONS,
        tool_choice: 'auto',
      });
    } catch (err) {
      log.error('LLM API error', { error: err.message, turn });
      return null;
    }

    const choice = response.choices[0];
    const msg    = choice.message;

    if (msg.content && msg.content.trim()) {
      traceLog(`Turn ${turn + 1}: assistant message`, {
        content: msg.content,
      });
    }

    // Add assistant message to history
    messages.push(msg);

    // ── Tool calls requested ──────────────────────────────────────────────────
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      log.info(`Turn ${turn + 1}: LLM calling ${msg.tool_calls.length} tool(s)`, {
        tools: msg.tool_calls.map((tc) => tc.function.name),
      });

      // Execute all tool calls (sequentially to avoid API rate limits)
      for (const toolCall of msg.tool_calls) {
        const name = toolCall.function.name;
        let args;

        try {
          args = JSON.parse(toolCall.function.arguments || '{}');
        } catch {
          args = {};
        }

        traceLog(`Turn ${turn + 1}: tool call`, {
          name,
          args,
        });

        log.debug('Executing tool', { name, args });
        toolCallCount++;

        let result;
        try {
          result = await executeTool(name, args);
          log.debug('Tool result', { name, resultSize: JSON.stringify(result).length });
          traceLog(`Turn ${turn + 1}: tool result`, {
            name,
            result,
          });
        } catch (err) {
          log.warn('Tool execution failed', { name, error: err.message });
          result = { error: err.message, toolName: name };
          traceLog(`Turn ${turn + 1}: tool error`, {
            name,
            error: err.message,
          });
        }

        messages.push({
          role:         'tool',
          tool_call_id: toolCall.id,
          content:      JSON.stringify(result),
        });

        // ✅ Small delay between tool calls to reduce connection churn on proxy
        await new Promise((r) => setTimeout(r, 50));
      }

      continue; // Next turn
    }

    // ── No more tool calls — parse final decision ─────────────────────────────
    const raw = (msg.content || '').trim();
    log.info('Agent finished', { turns: turn + 1, totalToolCalls: toolCallCount });
    log.debug('Raw LLM response', { raw: raw.slice(0, 500) });
    traceLog(`Turn ${turn + 1}: final raw response`, { raw });

    // Strip markdown code fences if LLM added them despite instructions
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn('No JSON found in LLM response', { raw: raw.slice(0, 300) });
      return null;
    }

    try {
      const decision = JSON.parse(jsonMatch[0]);
      log.info('Decision parsed', {
        action:     decision.action,
        symbol:     decision.symbol,
        confidence: decision.confidence,
        rr:         decision.riskRewardRatio,
        reason:     (decision.reason || '').slice(0, 120),
      });
      traceLog('Decision full JSON', {
        decision,
      });
      return decision;
    } catch (err) {
      log.error('Failed to parse LLM JSON', { error: err.message, raw: raw.slice(0, 300) });
      traceLog('Failed to parse LLM JSON (raw)', { raw });
      return null;
    }
  }

  log.warn('Max agent turns reached without final decision', { maxTurns });
  return null;
}

module.exports = { getTradeDecision };
