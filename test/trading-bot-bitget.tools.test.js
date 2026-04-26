'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadToolsWithMockApi(mockApi) {
  const toolsPath = require.resolve('../scripts/trading-bot-bitget/agent/tools');
  const apiPath = require.resolve('../scripts/trading-bot-bitget/data/bitget-api');

  const originalTools = require.cache[toolsPath];
  const originalApi = require.cache[apiPath];

  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: mockApi,
  };

  delete require.cache[toolsPath];
  const tools = require('../scripts/trading-bot-bitget/agent/tools');

  return {
    tools,
    restore() {
      delete require.cache[toolsPath];
      if (originalTools) require.cache[toolsPath] = originalTools;
      if (originalApi) require.cache[apiPath] = originalApi;
      else delete require.cache[apiPath];
    },
  };
}

test('get_top_gainers returns top 12 plus BTC/ETH/SOL', async () => {
  const ranked = [
    { symbol: 'A1USDT', changePercent24h: 12, volumeUsdt: 100 },
    { symbol: 'A2USDT', changePercent24h: 11, volumeUsdt: 100 },
    { symbol: 'A3USDT', changePercent24h: 10, volumeUsdt: 100 },
    { symbol: 'A4USDT', changePercent24h: 9, volumeUsdt: 100 },
    { symbol: 'A5USDT', changePercent24h: 8, volumeUsdt: 100 },
    { symbol: 'A6USDT', changePercent24h: 7, volumeUsdt: 100 },
    { symbol: 'A7USDT', changePercent24h: 6, volumeUsdt: 100 },
    { symbol: 'A8USDT', changePercent24h: 5, volumeUsdt: 100 },
    { symbol: 'A9USDT', changePercent24h: 4, volumeUsdt: 100 },
    { symbol: 'A10USDT', changePercent24h: 3, volumeUsdt: 100 },
    { symbol: 'A11USDT', changePercent24h: 2, volumeUsdt: 100 },
    { symbol: 'A12USDT', changePercent24h: 1, volumeUsdt: 100 },
    { symbol: 'A13USDT', changePercent24h: 0.5, volumeUsdt: 100 },
    { symbol: 'BTCUSDT', changePercent24h: -0.2, volumeUsdt: 100000 },
    { symbol: 'ETHUSDT', changePercent24h: -0.3, volumeUsdt: 80000 },
    { symbol: 'SOLUSDT', changePercent24h: -0.4, volumeUsdt: 60000 },
  ];

  const mockApi = {
    getTopGainers: async (limit) => ranked.slice(0, limit),
    getKlineData: async () => [],
    getOiData: async () => ({}),
    getFundingRate: async () => ({}),
    searchCoinEvents: async () => ({}),
  };

  const { tools, restore } = loadToolsWithMockApi(mockApi);
  try {
    const rows = await tools.executeTool('get_top_gainers', {
      limit: 12,
      min_change_percent: -100,
      min_volume_usdt: 0,
    });

    const symbols = rows.map((r) => r.symbol);

    assert.equal(rows.length, 15);
    assert.deepEqual(symbols.slice(0, 12), ranked.slice(0, 12).map((r) => r.symbol));
    assert.ok(symbols.includes('BTCUSDT'));
    assert.ok(symbols.includes('ETHUSDT'));
    assert.ok(symbols.includes('SOLUSDT'));
  } finally {
    restore();
  }
});
