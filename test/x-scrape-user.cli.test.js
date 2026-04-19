const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildMetadataPath, buildRunMetadata } = require('../scripts/lib/x-scrape-user-helpers');

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

test('package.json exposes a login:x alias', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  );

  assert.equal(packageJson.scripts['login:x'], 'node scripts/x-login.js');
});

test('x login bootstrap script exists', () => {
  const loginScriptPath = path.join(__dirname, '..', 'scripts', 'x-login.js');
  assert.equal(fs.existsSync(loginScriptPath), true);
});

test('x login bootstrap script uses the stable X landing page', () => {
  const loginScriptPath = path.join(__dirname, '..', 'scripts', 'x-login.js');
  const content = fs.readFileSync(loginScriptPath, 'utf8');

  assert.equal(content.includes("const LOGIN_URL = 'https://x.com/'"), true);
});

test('buildRunMetadata records session source and chrome profile', () => {
  const metadata = buildRunMetadata(
    { handle: 'coolish', profileDir: '.playwright/x-profile' },
    {
      targetUrl: 'https://x.com/coolish',
      startedAt: '2026-04-19T00:00:00.000Z',
      finishedAt: '2026-04-19T01:00:00.000Z',
      totalWritten: 1,
      scrollRounds: 2,
      stopReason: 'limit-reached',
      sessionSource: 'playwright-profile',
    }
  );

  assert.equal(metadata.sessionSource, 'playwright-profile');
  assert.equal(metadata.chromeProfile, null);
  assert.equal(metadata.profileDir, '.playwright/x-profile');
  assert.equal(metadata.totalUniqueItemsWritten, 1);
});