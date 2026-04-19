const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs,
  normalizePostUrl,
  extractPostIdFromUrl,
  parseMetricValue,
  dedupeKeyForRecord,
  buildDefaultOutputPath,
  hasAuthCookies,
  isClosedBrowserError,
  isIgnorableNavigationAbortError,
  resolveBrowserContextOptions,
} = require('../scripts/lib/x-scrape-user-helpers');

test('parseArgs requires handle', () => {
  assert.throws(() => parseArgs([]), /--handle/);
});

test('parseArgs uses a per-user default output path when out is omitted', () => {
  const args = parseArgs(['--handle', 'coolish']);
  assert.equal(args.out, 'data/coolish/posts.jsonl');
});

test('parseArgs defaults to the dedicated Playwright profile', () => {
  const args = parseArgs(['--handle', 'coolish']);

  assert.equal(args.useSystemChrome, false);
  assert.equal(args.usePlaywrightProfile, true);
  assert.equal(args.profileDir, '.playwright/x-profile');
});

test('parseArgs still accepts explicit playwright-profile mode', () => {
  const args = parseArgs(['--handle', 'coolish', '--use-playwright-profile']);

  assert.equal(args.useSystemChrome, false);
  assert.equal(args.usePlaywrightProfile, true);
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

test('buildDefaultOutputPath nests records under the user handle directory', () => {
  assert.equal(buildDefaultOutputPath('coolish'), 'data/coolish/posts.jsonl');
});

test('hasAuthCookies requires both auth_token and ct0', () => {
  assert.equal(hasAuthCookies([{ name: 'auth_token' }, { name: 'ct0' }]), true);
  assert.equal(hasAuthCookies([{ name: 'auth_token' }]), false);
  assert.equal(hasAuthCookies([{ name: 'ct0' }]), false);
  assert.equal(hasAuthCookies([]), false);
});

test('resolveBrowserContextOptions uses the dedicated Playwright profile by default', () => {
  const resolved = resolveBrowserContextOptions({
    useSystemChrome: false,
    usePlaywrightProfile: true,
    profileDir: '.playwright/x-profile',
  });

  assert.equal(resolved.userDataDir, '.playwright/x-profile');
  assert.equal(resolved.systemChromeUserDataDir, null);
  assert.deepEqual(resolved.launchArgs, ['--disable-blink-features=AutomationControlled']);
  assert.deepEqual(resolved.ignoreDefaultArgs, ['--enable-automation']);
  assert.equal(resolved.channel, 'chrome');
  assert.equal(resolved.sessionSource, 'playwright-profile');
});

test('resolveBrowserContextOptions preserves explicit playwright-profile mode', () => {
  const resolved = resolveBrowserContextOptions({
    useSystemChrome: false,
    usePlaywrightProfile: true,
    chromeProfile: 'Default',
    profileDir: '.playwright/x-profile',
  });

  assert.equal(resolved.userDataDir, '.playwright/x-profile');
  assert.deepEqual(resolved.launchArgs, ['--disable-blink-features=AutomationControlled']);
  assert.deepEqual(resolved.ignoreDefaultArgs, ['--enable-automation']);
  assert.equal(resolved.channel, 'chrome');
  assert.equal(resolved.sessionSource, 'playwright-profile');
});

test('isClosedBrowserError recognizes closed browser/context errors', () => {
  assert.equal(isClosedBrowserError(new Error('browserContext.cookies: Target page, context or browser has been closed')), true);
  assert.equal(isClosedBrowserError(new Error('page.goto: Target closed')), true);
  assert.equal(isClosedBrowserError(new Error('Timed out waiting for login')), false);
});

test('isIgnorableNavigationAbortError recognizes post-login navigation aborts', () => {
  assert.equal(isIgnorableNavigationAbortError(new Error('page.goto: net::ERR_ABORTED at https://x.com/home')), true);
  assert.equal(isIgnorableNavigationAbortError(new Error('page.goto: net::ERR_ABORTED at https://x.com/i/flow/login')), true);
  assert.equal(isIgnorableNavigationAbortError(new Error('page.goto: Timeout 30000ms exceeded')), false);
});