const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMetadataPath } = require('../scripts/lib/x-scrape-user-helpers');

test('buildMetadataPath swaps jsonl suffix for meta json', () => {
  assert.equal(
    buildMetadataPath('data/coolish.posts.jsonl'),
    'data/coolish.posts.meta.json'
  );
});