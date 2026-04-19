const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs,
  normalizePostUrl,
  extractPostIdFromUrl,
  parseMetricValue,
  dedupeKeyForRecord,
} = require('../scripts/lib/x-scrape-user-helpers');

test('parseArgs requires handle and out', () => {
  assert.throws(() => parseArgs([]), /--handle/);
  assert.throws(() => parseArgs(['--handle', 'coolish']), /--out/);
});

test('parseArgs accepts explicit options', () => {
  const args = parseArgs([
    '--handle', 'coolish',
    '--out', 'data/coolish.posts.jsonl',
    '--profile-dir', '.playwright/x-profile',
    '--limit', '25',
    '--headless',
    '--max-no-new-scrolls', '3',
    '--scroll-delay-ms', '1500',
  ]);

  assert.equal(args.handle, 'coolish');
  assert.equal(args.out, 'data/coolish.posts.jsonl');
  assert.equal(args.profileDir, '.playwright/x-profile');
  assert.equal(args.limit, 25);
  assert.equal(args.headless, true);
  assert.equal(args.maxNoNewScrolls, 3);
  assert.equal(args.scrollDelayMs, 1500);
});

test('normalizePostUrl removes query strings and normalizes host', () => {
  assert.equal(
    normalizePostUrl('https://twitter.com/someuser/status/12345?s=20&t=abc'),
    'https://x.com/someuser/status/12345'
  );
});

test('extractPostIdFromUrl returns null for non-status urls', () => {
  assert.equal(extractPostIdFromUrl('https://x.com/someuser'), null);
  assert.equal(extractPostIdFromUrl('https://x.com/someuser/status/12345'), '12345');
});

test('parseMetricValue supports compact x labels', () => {
  assert.equal(parseMetricValue('1,234'), 1234);
  assert.equal(parseMetricValue('5.6K'), 5600);
  assert.equal(parseMetricValue('7M'), 7000000);
  assert.equal(parseMetricValue(''), null);
});

test('dedupeKeyForRecord prefers url and falls back to id', () => {
  assert.equal(dedupeKeyForRecord({ url: 'https://x.com/a/status/1', id: '1' }), 'https://x.com/a/status/1');
  assert.equal(dedupeKeyForRecord({ url: null, id: '1' }), 'id:1');
  assert.equal(dedupeKeyForRecord({ url: null, id: null }), null);
});