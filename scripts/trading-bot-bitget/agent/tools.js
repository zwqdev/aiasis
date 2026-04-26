'use strict';

/**
 * Tool definitions and handlers for the LLM trading agent (agent/tools.js)
 *
 * Each tool has:
 *  - A JSON Schema definition (passed to the LLM)
 *  - An async handler function (called when the LLM invokes the tool)
 *
 * The LLM decides autonomously which tools to call and in what order.
 */

const api   = require('../data/bitget-api');
const state = require('../lib/state');
const config = require('../lib/config');
const { buildKlineStructureSummary } = require('./kline-structure');

const MANDATORY_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

// ── Tool definitions (OpenAI function-calling format) ─────────────────────────

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_top_gainers',
      description:
        'Fetch the top 24h price gainers from Bitget USDT-M futures. ' +
        'Always call this FIRST at the start of each scan cycle to get the candidate list. ' +
        'Returns symbols sorted by 24h change %, with volume and price info.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Number of top gainers to include before adding mandatory majors. Default 12.',
          },
          min_change_percent: {
            type: 'number',
            description: 'Min 24h price change % to include. Default -100 (include all symbols, then rank by change).',
          },
          min_volume_usdt: {
            type: 'number',
            description: 'Min 24h USDT volume to include. Default 0 (no volume filter).',
          },
        },
        required: [],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'get_kline_data',
      description:
        'Fetch OHLCV candlestick data for a symbol to analyze chart structure. ' +
        'Use granularity=1H to confirm trend direction (higher highs/lows or key-level hold). ' +
        'Use granularity=15m to find precise entry timing with breakout/pullback/bounce rules. ' +
        'Use granularity=4H/1D only for broader context if needed. ' +
        'Look for: trend-aligned breakout above horizontal resistance on 15m, pullback to the breakout level, ' +
        'bounce signs (higher low, volume contraction on pullback then expansion on bounce). ' +
        'The result includes deterministic structure fields under summary.structure and top-level structure: ' +
        'resistanceLevel, supportLevel, pullbackZone, breakout.detected, breakout.retestConfirmed, latestStructureBias. ' +
        'Returns candles ordered oldest → newest.',
      parameters: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description: 'Futures symbol e.g. BTCUSDT',
          },
          granularity: {
            type: 'string',
            enum: ['15m', '1H', '4H', '1D', '1W'],
            description: '15m = entry timing. 1H = trend confirmation. 4H/1D = macro context. 1W = long-term structure.',
          },
          limit: {
            type: 'number',
            description: 'Number of candles to return. Default 1000 (Bitget API max). For 15m: ~10 days, 1H: ~42 days, 1D: ~1000 days (~3 years).',
          },
        },
        required: ['symbol', 'granularity'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'get_oi_data',
      description:
        'Get Open Interest data for a symbol and compare to the previous snapshot. ' +
        'OI rising while price stays flat = smart money accumulating (bullish divergence). ' +
        'OI rising while price dumps = distribution (bearish). ' +
        'Call this for any candidate that passes the kline structure check.',
      parameters: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description: 'Symbol e.g. BTCUSDT',
          },
        },
        required: ['symbol'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'get_funding_rate',
      description:
        'Get current funding rate for a symbol. ' +
        'Funding > +0.05% = overheated longs — crowded, high squeeze risk if it reverses. ' +
        'Funding < -0.01% = crowded shorts — potential short squeeze fuel. ' +
        'Neutral funding = healthy. Call this before finalizing any BUY decision.',
      parameters: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description: 'Symbol e.g. BTCUSDT',
          },
        },
        required: ['symbol'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'get_open_positions',
      description:
        'Get current open positions and portfolio status. ' +
        'Call this before making any BUY decision to check: ' +
        '(1) Is this symbol already in a position? ' +
        '(2) Is the max position count reached? ' +
        '(3) How much daily loss has occurred?',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleGetTopGainers(args) {
  const limit = (args.limit !== undefined) ? args.limit : 12;
  const minVolumeUsdt = (args.min_volume_usdt !== undefined)
    ? args.min_volume_usdt
    : 0;
  const requestedMinChange = (args.min_change_percent !== undefined)
    ? args.min_change_percent
    : -100;

  async function withMandatorySymbols(rows) {
    const merged = [...rows];
    const seen = new Set(rows.map((r) => r.symbol));

    const universe = await api.getTopGainers(1000, -100, 0);
    for (const symbol of MANDATORY_SYMBOLS) {
      if (seen.has(symbol)) continue;
      const row = universe.find((r) => r.symbol === symbol);
      if (row) {
        merged.push(row);
        seen.add(symbol);
      }
    }

    return merged;
  }

  // If caller explicitly asks to include all symbols (<= 0 threshold), return directly.
  if (requestedMinChange <= 0) {
    const rows = await api.getTopGainers(limit, requestedMinChange, minVolumeUsdt);
    return withMandatorySymbols(rows);
  }

  // Adaptive fallback: in low-volatility markets, relax threshold to avoid empty candidate pool.
  const fallbackThresholds = [requestedMinChange, 1, 0.5, 0]
    .filter((v, idx, arr) => v >= 0 && arr.indexOf(v) === idx)
    .sort((a, b) => b - a);

  for (const minChange of fallbackThresholds) {
    const rows = await api.getTopGainers(limit, minChange, minVolumeUsdt);
    if (rows.length > 0 || minChange === 0) {
      return withMandatorySymbols(rows);
    }
  }

  return withMandatorySymbols([]);
}

async function handleGetKlineData(args) {
  const candles = await api.getKlineData(
    args.symbol,
    args.granularity || '1H',
    args.limit       || 1000,  // ✅ Max Bitget API limit: 1000 candles per request
  );

  const structure = buildKlineStructureSummary(candles, args.granularity || '1H');

  // Return summarized structure analysis instead of raw candles
  // (saves tokens; LLM gets what it needs for HTF analysis)
  const last = candles[candles.length - 1];
  const prev20 = candles.slice(-20);

  const high20  = Math.max(...prev20.map((c) => c.high));
  const low20   = Math.min(...prev20.map((c) => c.low));
  const avgVol  = prev20.reduce((s, c) => s + c.volumeUsdt, 0) / prev20.length;

  // Detect potential breakout: last close > 20-period high (excluding last candle)
  const resistanceLevel = Math.max(...prev20.slice(0, -1).map((c) => c.high));
  const possibleBreakout = last.close > resistanceLevel;

  // Detect pullback: last few candles pulled back after a recent new high
  const last5  = candles.slice(-5);
  const peak5  = Math.max(...last5.map((c) => c.high));
  const pullbackPercent = ((peak5 - last.close) / peak5 * 100).toFixed(2);

  return {
    symbol:           args.symbol,
    granularity:      args.granularity || '1H',
    totalCandles:     candles.length,
    latestCandle:     last,
    structure,
    summary: {
      high20Period:      high20,
      low20Period:       low20,
      avgVolumeUsdt20:   Math.round(avgVol),
      latestVolumeUsdt:  last.volumeUsdt,
      volumeVsAvg:       parseFloat((last.volumeUsdt / avgVol).toFixed(2)),
      resistanceLevel:   parseFloat(resistanceLevel.toFixed(8)),
      possibleBreakout,
      pullbackFromPeakPercent: parseFloat(pullbackPercent),
      structure,
    },
    // Include last 10 candles in full for detailed analysis
    recentCandles: candles.slice(-10),
  };
}

async function handleGetOiData(args) {
  return api.getOiData(args.symbol);
}

async function handleGetFundingRate(args) {
  return api.getFundingRate(args.symbol);
}

async function handleSearchCoinEvents(args) {
  return api.searchCoinEvents(args.symbol, args.coin_name, args.mode || 'fast');
}

async function handleGetOpenPositions() {
  const positions = state.getOpenPositions();
  const dailyLoss = state.getDailyLoss();
  const openCount = Object.keys(positions).length;

  return {
    openPositions:   positions,
    openCount,
    maxPositions:    config.maxOpenPositions,
    slotsAvailable:  config.maxOpenPositions - openCount,
    dailyLossUsdt:   parseFloat(dailyLoss.toFixed(2)),
    dailyLossLimit:  config.dailyLossLimitUsdt,
    dailyLossRemaining: parseFloat((config.dailyLossLimitUsdt - dailyLoss).toFixed(2)),
    canOpenNewTrade: openCount < config.maxOpenPositions && dailyLoss < config.dailyLossLimitUsdt,
  };
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

const HANDLERS = {
  get_top_gainers:    handleGetTopGainers,
  get_kline_data:     handleGetKlineData,
  get_oi_data:        handleGetOiData,
  get_funding_rate:   handleGetFundingRate,
  search_coin_events: handleSearchCoinEvents,
  get_open_positions: handleGetOpenPositions,
};

/**
 * Execute a tool call from the LLM.
 * @param {string} name - tool name
 * @param {object} args - parsed arguments
 * @returns {Promise<object>} - result to send back to LLM
 */
async function executeTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(args);
}

module.exports = { TOOL_DEFINITIONS, executeTool };
