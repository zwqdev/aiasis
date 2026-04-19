# X System Chrome Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the X scraper use macOS system Chrome by default, while preserving an explicit fallback to the dedicated Playwright profile.

**Architecture:** Keep the current single CLI entrypoint and helper module structure. Add argument parsing and launch-option helpers for session-source selection, then thread the selected session source through browser launch, auth checks, and metadata writing.

**Tech Stack:** Node.js, CommonJS, Playwright, node:test

---

### Task 1: Lock CLI Defaults In Tests

**Files:**
- Modify: `/Users/mac/Desktop/proj/sys/test/x-scrape-user.helpers.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('parseArgs defaults to system chrome and Default profile', () => {
  const options = parseArgs(['--handle', 'coolish']);

  assert.equal(options.useSystemChrome, true);
  assert.equal(options.usePlaywrightProfile, false);
  assert.equal(options.chromeProfile, 'Default');
});

test('parseArgs allows explicit playwright-profile fallback', () => {
  const options = parseArgs(['--handle', 'coolish', '--use-playwright-profile']);

  assert.equal(options.useSystemChrome, false);
  assert.equal(options.usePlaywrightProfile, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mac/Desktop/proj/sys && node --test test/x-scrape-user.helpers.test.js`
Expected: FAIL because the new flags/defaults are not implemented.

- [ ] **Step 3: Write minimal implementation**

Update `parseArgs()` defaults and parsing so the new session-source booleans and `chromeProfile` are returned.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/mac/Desktop/proj/sys && node --test test/x-scrape-user.helpers.test.js`
Expected: PASS for the new parse tests.

### Task 2: Add Launch-Option Helpers And Tests

**Files:**
- Modify: `/Users/mac/Desktop/proj/sys/test/x-scrape-user.helpers.test.js`
- Modify: `/Users/mac/Desktop/proj/sys/scripts/lib/x-scrape-user-helpers.js`

- [ ] **Step 1: Write the failing test**

```js
test('resolveBrowserContextOptions uses macOS system chrome by default', () => {
  const resolved = resolveBrowserContextOptions({
    useSystemChrome: true,
    usePlaywrightProfile: false,
    chromeProfile: 'Default',
    profileDir: '.playwright/x-profile',
  });

  assert.match(resolved.userDataDir, /Google\/Chrome$/);
  assert.deepEqual(resolved.launchArgs, ['--profile-directory=Default']);
  assert.equal(resolved.sessionSource, 'system-chrome');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mac/Desktop/proj/sys && node --test test/x-scrape-user.helpers.test.js`
Expected: FAIL because the helper does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Add helpers that:
- resolve the macOS Chrome user-data root
- return launch args for `--profile-directory=<chromeProfile>`
- preserve `.playwright/x-profile` when fallback mode is requested

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/mac/Desktop/proj/sys && node --test test/x-scrape-user.helpers.test.js`
Expected: PASS for the new launch-option helper test.

### Task 3: Wire Browser Launch And Metadata

**Files:**
- Modify: `/Users/mac/Desktop/proj/sys/test/x-scrape-user.cli.test.js`
- Modify: `/Users/mac/Desktop/proj/sys/scripts/x-scrape-user.js`

- [ ] **Step 1: Write the failing test**

```js
test('buildRunMetadata records session source and chrome profile', () => {
  const metadata = buildRunMetadata(
    { handle: 'coolish', chromeProfile: 'Default' },
    { targetUrl: 'https://x.com/coolish', startedAt: '2026-04-19T00:00:00.000Z', totalWritten: 1, scrollRounds: 2, stopReason: 'limit-reached', sessionSource: 'system-chrome' }
  );

  assert.equal(metadata.sessionSource, 'system-chrome');
  assert.equal(metadata.chromeProfile, 'Default');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/mac/Desktop/proj/sys && node --test test/x-scrape-user.cli.test.js`
Expected: FAIL because metadata builder does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Add a small metadata builder and use the resolved browser context options in `scripts/x-scrape-user.js` when calling `launchPersistentContext`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/mac/Desktop/proj/sys && node --test test/x-scrape-user.cli.test.js`
Expected: PASS for the new metadata test.

### Task 4: Verify End-To-End Regressions

**Files:**
- Modify: `/Users/mac/Desktop/proj/sys/package.json` (only if command text/help needs to change)

- [ ] **Step 1: Run the full automated suite**

Run: `cd /Users/mac/Desktop/proj/sys && npm test`
Expected: PASS with all tests green.

- [ ] **Step 2: Run the headless unauthenticated guard in default mode**

Run: `cd /Users/mac/Desktop/proj/sys && node scripts/x-scrape-user.js --handle lanaaielsa --limit 10 --headless`
Expected: FAIL with an explicit authentication or Chrome-profile access message, not a silent partial scrape.

- [ ] **Step 3: Run the explicit fallback smoke check**

Run: `cd /Users/mac/Desktop/proj/sys && node scripts/x-scrape-user.js --handle lanaaielsa --limit 10 --headless --use-playwright-profile`
Expected: FAIL with the existing Playwright-profile authentication guidance if the fallback profile is not logged in.

## Self-Review

- Spec coverage: CLI defaults, session-source selection, launch args, metadata, and fallback mode are all covered.
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency: `useSystemChrome`, `usePlaywrightProfile`, `chromeProfile`, and `sessionSource` are used consistently across tasks.