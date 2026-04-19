const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildMetadataPath } = require('../scripts/lib/x-scrape-user-helpers');

test('buildMetadataPath swaps jsonl suffix for meta json', () => {
  assert.equal(
    buildMetadataPath('data/coolish.posts.jsonl'),
    'data/coolish.posts.meta.json'
  );
});

test('package.json exposes a download:posts alias', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  );

  assert.equal(packageJson.scripts['download:posts'], 'node scripts/x-scrape-user.js');
});