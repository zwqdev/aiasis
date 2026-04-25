const test = require('node:test');
const assert = require('node:assert/strict');

const { createEventSearcher } = require('../scripts/trading-bot-bitget/data/event-search');

test('fast mode uses only lightweight source and caches repeated lookups', async () => {
  let calls = 0;
  const geckoGet = async (path) => {
    calls += 1;
    assert.match(path, /\/api\/v3\/search\?query=hyper/i);
    return {
      coins: [{ id: 'hyperliquid', name: 'Hyperliquid', symbol: 'hype', market_cap_rank: 35 }],
    };
  };

  const searchCoinEvents = createEventSearcher({ geckoGet, now: () => 1_000 });

  const first = await searchCoinEvents('HYPEUSDT', 'Hyper', 'fast');
  const second = await searchCoinEvents('HYPEUSDT', 'Hyper', 'fast');

  assert.equal(calls, 1);
  assert.equal(first.mode, 'fast');
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.deepEqual(first.checkedSources, ['coingecko-search', 'manual-exchange-announcements', 'manual-security-alerts', 'manual-unlock-calendars']);
  assert.equal(first.coinInfo.id, 'hyperliquid');
  assert.match(first.recommendation, /FAST_CHECK_ONLY/);
});

test('deep mode fetches detail data and returns tiered source guidance', async () => {
  const paths = [];
  const geckoGet = async (path) => {
    paths.push(path);
    if (path.startsWith('/api/v3/search')) {
      return {
        coins: [{ id: 'aave', name: 'Aave', symbol: 'aave', market_cap_rank: 42 }],
      };
    }
    return {
      id: 'aave',
      name: 'Aave',
      symbol: 'aave',
      genesis_date: '2020-01-01',
      market_cap_rank: 42,
      categories: ['Lending'],
      sentiment_votes_up_percentage: 82,
      sentiment_votes_down_percentage: 18,
      links: {
        homepage: ['https://aave.com'],
        repos_url: { github: ['https://github.com/aave'] },
      },
    };
  };

  const searchCoinEvents = createEventSearcher({ geckoGet, now: () => 10_000 });
  const result = await searchCoinEvents('AAVEUSDT', 'Aave', 'deep');

  assert.equal(paths.length, 2);
  assert.equal(result.mode, 'deep');
  assert.deepEqual(result.checkedSources, ['coingecko-search', 'coingecko-detail', 'manual-project-announcements', 'manual-onchain-wallet-check']);
  assert.equal(result.coinInfo.name, 'Aave');
  assert.match(result.recommendation, /manual verification/);
});

test('failed event search falls back quickly with degraded recommendation', async () => {
  const geckoGet = async () => {
    throw new Error('timeout after 2500ms');
  };

  const searchCoinEvents = createEventSearcher({ geckoGet, now: () => 100 });
  const result = await searchCoinEvents('TAOUSDT', 'Bittensor', 'fast');

  assert.equal(result.mode, 'fast');
  assert.equal(result.coinInfo, null);
  assert.match(result.riskNotes.join(' '), /timeout/);
  assert.match(result.recommendation, /DEGRADED/);
});