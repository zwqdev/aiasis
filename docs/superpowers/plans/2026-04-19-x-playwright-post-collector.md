# X Playwright Post Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Playwright-based CLI that collects visible X profile timeline content into JSONL using a persistent logged-in browser profile.

**Architecture:** Use a DOM-first collector that launches a persistent Chromium context, navigates to a profile timeline, repeatedly extracts normalized records from rendered article cards, deduplicates them in memory, and writes JSONL plus crawl metadata. Keep page extraction logic and pure normalization helpers separate so most behavior can be tested without a live browser.

**Tech Stack:** Node.js CommonJS, Playwright, Node built-in `node:test`, Node built-in `fs` and `path`

---

### Task 1: Prepare local project wiring

**Files:**
- Modify: `/Users/mac/Desktop/proj/sys/package.json`
- Modify: `/Users/mac/Desktop/proj/sys/.gitignore`

- [ ] **Step 1: Write the failing test expectation into the plan for package scripts**

```json
{
  "scripts": {
    "test": "node --test",
    "scrape:x-user": "node scripts/x-scrape-user.js"
  }
}
```

- [ ] **Step 2: Update `package.json` to replace the placeholder test script and add the collector command**

```json
{
  "scripts": {
    "test": "node --test",
    "scrape:x-user": "node scripts/x-scrape-user.js"
  }
}
```

- [ ] **Step 3: Update `.gitignore` to keep local browser state and collected artifacts out of git**

```gitignore
.playwright/
data/
```

- [ ] **Step 4: Run tests to verify the new script wiring does not break the workspace**

Run: `npm test`
Expected: PASS with either zero tests or only the currently implemented test files.

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: prepare x scraper project wiring"
```

### Task 2: Add failing tests for pure collector helpers

**Files:**
- Create: `/Users/mac/Desktop/proj/sys/test/x-scrape-user.helpers.test.js`
- Create: `/Users/mac/Desktop/proj/sys/scripts/lib/x-scrape-user-helpers.js`

- [ ] **Step 1: Write the failing helper tests**

```javascript
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
```

- [ ] **Step 2: Run the helper test file to verify it fails because the helper module is missing or incomplete**

Run: `node --test test/x-scrape-user.helpers.test.js`
Expected: FAIL with module export or missing function errors.

- [ ] **Step 3: Write the minimal helper implementation**

```javascript
const DEFAULTS = {
  profileDir: '.playwright/x-profile',
  limit: Infinity,
  headless: false,
  maxNoNewScrolls: 5,
  scrollDelayMs: 1200,
  startUrl: null,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--headless') {
      options.headless = true;
      continue;
    }
    const value = argv[index + 1];
    if (value == null) {
      throw new Error(`Missing value for ${token}`);
    }
    if (token === '--handle') options.handle = value;
    else if (token === '--out') options.out = value;
    else if (token === '--profile-dir') options.profileDir = value;
    else if (token === '--limit') options.limit = Number(value);
    else if (token === '--max-no-new-scrolls') options.maxNoNewScrolls = Number(value);
    else if (token === '--scroll-delay-ms') options.scrollDelayMs = Number(value);
    else if (token === '--start-url') options.startUrl = value;
    else throw new Error(`Unknown argument: ${token}`);
    index += 1;
  }
  if (!options.handle) throw new Error('Missing required --handle');
  if (!options.out) throw new Error('Missing required --out');
  return options;
}

function normalizePostUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    parsed.host = 'x.com';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function extractPostIdFromUrl(value) {
  const normalized = normalizePostUrl(value);
  if (!normalized) return null;
  const match = normalized.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

function parseMetricValue(value) {
  if (!value) return null;
  const normalized = String(value).trim().replace(/,/g, '').toUpperCase();
  if (!normalized) return null;
  const match = normalized.match(/^(\d+(?:\.\d+)?)([KM])?$/);
  if (!match) return null;
  const base = Number(match[1]);
  const suffix = match[2];
  if (suffix === 'K') return Math.round(base * 1000);
  if (suffix === 'M') return Math.round(base * 1000000);
  return Math.round(base);
}

function dedupeKeyForRecord(record) {
  if (record.url) return record.url;
  if (record.id) return `id:${record.id}`;
  return null;
}

module.exports = {
  parseArgs,
  normalizePostUrl,
  extractPostIdFromUrl,
  parseMetricValue,
  dedupeKeyForRecord,
};
```

- [ ] **Step 4: Run the helper test file to verify it passes**

Run: `node --test test/x-scrape-user.helpers.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/x-scrape-user.helpers.test.js scripts/lib/x-scrape-user-helpers.js
git commit -m "test: cover x scraper helper utilities"
```

### Task 3: Add failing tests for record normalization

**Files:**
- Create: `/Users/mac/Desktop/proj/sys/test/x-scrape-user.normalize.test.js`
- Modify: `/Users/mac/Desktop/proj/sys/scripts/lib/x-scrape-user-helpers.js`

- [ ] **Step 1: Write the failing normalization tests**

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeArticleRecord } = require('../scripts/lib/x-scrape-user-helpers');

test('normalizeArticleRecord converts raw page data into stable output schema', () => {
  const record = normalizeArticleRecord({
    url: 'https://twitter.com/someuser/status/12345?t=1',
    authorHandle: '@someuser',
    authorName: 'Some User',
    postedAt: '2026-04-19T10:00:00.000Z',
    text: ' hello world ',
    lang: 'en',
    replyTo: null,
    quotedUrl: 'https://twitter.com/other/status/999?t=2',
    type: 'quote',
    metrics: { reply: '1.2K', repost: '3', like: '44', view: '5.1K' },
    media: [{ type: 'image', url: 'https://pbs.twimg.com/media/a.jpg?name=small' }],
    rawHtmlSnippet: '<article>...</article>',
    scrapedAt: '2026-04-19T12:00:00.000Z',
  });

  assert.deepEqual(record, {
    id: '12345',
    url: 'https://x.com/someuser/status/12345',
    authorHandle: 'someuser',
    authorName: 'Some User',
    postedAt: '2026-04-19T10:00:00.000Z',
    text: 'hello world',
    lang: 'en',
    type: 'quote',
    replyTo: null,
    quotedUrl: 'https://x.com/other/status/999',
    metrics: { reply: 1200, repost: 3, like: 44, view: 5100 },
    media: [{ type: 'image', url: 'https://pbs.twimg.com/media/a.jpg?name=small' }],
    rawHtmlSnippet: '<article>...</article>',
    scrapedAt: '2026-04-19T12:00:00.000Z',
  });
});

test('normalizeArticleRecord falls back to unknown type and null metrics', () => {
  const record = normalizeArticleRecord({ url: null, type: 'weird', metrics: {} });
  assert.equal(record.type, 'unknown');
  assert.equal(record.metrics.reply, null);
  assert.equal(record.id, null);
});
```

- [ ] **Step 2: Run the normalization test file to verify it fails because `normalizeArticleRecord` is missing**

Run: `node --test test/x-scrape-user.normalize.test.js`
Expected: FAIL with `normalizeArticleRecord is not a function`.

- [ ] **Step 3: Extend the helper module with minimal normalization logic**

```javascript
function normalizeHandle(value) {
  if (!value) return null;
  return String(value).trim().replace(/^@/, '') || null;
}

function normalizeType(value) {
  return ['post', 'reply', 'repost', 'quote', 'unknown'].includes(value) ? value : 'unknown';
}

function normalizeArticleRecord(raw) {
  return {
    id: extractPostIdFromUrl(raw.url),
    url: normalizePostUrl(raw.url),
    authorHandle: normalizeHandle(raw.authorHandle),
    authorName: raw.authorName ? String(raw.authorName).trim() : null,
    postedAt: raw.postedAt || null,
    text: raw.text ? String(raw.text).trim() : null,
    lang: raw.lang || null,
    type: normalizeType(raw.type),
    replyTo: normalizeHandle(raw.replyTo),
    quotedUrl: normalizePostUrl(raw.quotedUrl),
    metrics: {
      reply: parseMetricValue(raw.metrics?.reply),
      repost: parseMetricValue(raw.metrics?.repost),
      like: parseMetricValue(raw.metrics?.like),
      view: parseMetricValue(raw.metrics?.view),
    },
    media: Array.isArray(raw.media) ? raw.media : [],
    rawHtmlSnippet: raw.rawHtmlSnippet || null,
    scrapedAt: raw.scrapedAt || new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run both helper test files to verify they pass together**

Run: `node --test test/x-scrape-user.helpers.test.js test/x-scrape-user.normalize.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/x-scrape-user.normalize.test.js scripts/lib/x-scrape-user-helpers.js
git commit -m "test: add x scraper record normalization coverage"
```

### Task 4: Add fixture-driven extraction tests

**Files:**
- Create: `/Users/mac/Desktop/proj/sys/test/fixtures/x-article-original.html`
- Create: `/Users/mac/Desktop/proj/sys/test/fixtures/x-article-quote.html`
- Create: `/Users/mac/Desktop/proj/sys/test/fixtures/x-article-reply.html`
- Create: `/Users/mac/Desktop/proj/sys/test/x-scrape-user.extract.test.js`
- Modify: `/Users/mac/Desktop/proj/sys/scripts/lib/x-scrape-user-helpers.js`

- [ ] **Step 1: Write representative article fixtures and failing extraction tests**

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractArticleDataFromHtml } = require('../scripts/lib/x-scrape-user-helpers');

function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

test('extractArticleDataFromHtml parses an original post fixture', () => {
  const result = extractArticleDataFromHtml(readFixture('x-article-original.html'));
  assert.equal(result.url, 'https://x.com/someuser/status/12345');
  assert.equal(result.authorHandle, 'someuser');
  assert.equal(result.type, 'post');
  assert.match(result.text, /Hello/);
});

test('extractArticleDataFromHtml parses a quote post fixture', () => {
  const result = extractArticleDataFromHtml(readFixture('x-article-quote.html'));
  assert.equal(result.type, 'quote');
  assert.equal(result.quotedUrl, 'https://x.com/other/status/999');
});

test('extractArticleDataFromHtml parses a reply fixture', () => {
  const result = extractArticleDataFromHtml(readFixture('x-article-reply.html'));
  assert.equal(result.type, 'reply');
  assert.equal(result.replyTo, 'other');
});
```

- [ ] **Step 2: Run the extraction test file to verify it fails because fixture parsing is not implemented**

Run: `node --test test/x-scrape-user.extract.test.js`
Expected: FAIL with missing export or incorrect parsing output.

- [ ] **Step 3: Add minimal fixture parsing helpers that use regex heuristics compatible with saved HTML snippets**

```javascript
function firstMatch(value, pattern) {
  const match = value.match(pattern);
  return match ? match[1] : null;
}

function extractArticleDataFromHtml(html) {
  const url = normalizePostUrl(firstMatch(html, /href="([^"]*\/status\/\d+[^"]*)"/i));
  const quotedUrl = normalizePostUrl(firstMatch(html, /data-quoted-url="([^"]+)"/i));
  const replyTo = normalizeHandle(firstMatch(html, /data-reply-to="([^"]+)"/i));
  const authorHandle = normalizeHandle(firstMatch(html, /data-author-handle="([^"]+)"/i));
  const authorName = firstMatch(html, /data-author-name="([^"]+)"/i);
  const postedAt = firstMatch(html, /datetime="([^"]+)"/i);
  const lang = firstMatch(html, /lang="([^"]+)"/i);
  const text = firstMatch(html, /data-post-text="([\s\S]*?)"\sdata-post-end/i) || firstMatch(html, /<div data-post-text="true">([\s\S]*?)<\/div>/i);
  const type = quotedUrl ? 'quote' : (replyTo ? 'reply' : 'post');
  return {
    url,
    authorHandle,
    authorName,
    postedAt,
    text: text ? text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null,
    lang,
    type,
    replyTo,
    quotedUrl,
    metrics: {},
    media: [],
    rawHtmlSnippet: html.slice(0, 5000),
  };
}
```

- [ ] **Step 4: Run all current tests to verify fixture extraction passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/fixtures test/x-scrape-user.extract.test.js scripts/lib/x-scrape-user-helpers.js
git commit -m "test: add x scraper extraction fixtures"
```

### Task 5: Implement the CLI collector script

**Files:**
- Create: `/Users/mac/Desktop/proj/sys/scripts/x-scrape-user.js`
- Modify: `/Users/mac/Desktop/proj/sys/scripts/lib/x-scrape-user-helpers.js`

- [ ] **Step 1: Write a focused smoke-style test for metadata filename generation and stop-reason plumbing**

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMetadataPath } = require('../scripts/lib/x-scrape-user-helpers');

test('buildMetadataPath swaps jsonl suffix for meta json', () => {
  assert.equal(
    buildMetadataPath('data/coolish.posts.jsonl'),
    'data/coolish.posts.meta.json'
  );
});
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `node --test test/x-scrape-user.cli.test.js`
Expected: FAIL with missing helper export.

- [ ] **Step 3: Implement the collector CLI with persistent browser, extraction loop, dedupe, JSONL writing, and metadata output**

```javascript
#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const {
  parseArgs,
  normalizeArticleRecord,
  dedupeKeyForRecord,
  buildMetadataPath,
} = require('./lib/x-scrape-user-helpers');

async function ensureParentDir(filePath) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

async function appendJsonlRecord(stream, record) {
  stream.write(`${JSON.stringify(record)}\n`);
}

async function extractVisibleArticles(page) {
  return page.evaluate(() => {
    const articles = Array.from(document.querySelectorAll('article'));
    return articles.map((article) => {
      const html = article.outerHTML;
      const statusLink = article.querySelector('a[href*="/status/"]');
      const time = article.querySelector('time');
      const textNode = article.querySelector('[data-testid="tweetText"]');
      const images = Array.from(article.querySelectorAll('img[src*="pbs.twimg.com"]')).map((img) => ({
        type: 'image',
        url: img.getAttribute('src'),
      }));
      const handleNode = Array.from(article.querySelectorAll('a[role="link"], span')).find((node) => {
        const text = node.textContent?.trim();
        return text && text.startsWith('@');
      });
      const socialText = article.textContent || '';
      const replyMatch = socialText.match(/replying to\s+@([A-Za-z0-9_]+)/i);
      const quotedAnchor = Array.from(article.querySelectorAll('a[href*="/status/"]')).find((anchor) => anchor !== statusLink);
      const langNode = article.querySelector('[lang]');
      const type = quotedAnchor ? 'quote' : (replyMatch ? 'reply' : 'post');
      return {
        url: statusLink ? statusLink.href : null,
        authorHandle: handleNode ? handleNode.textContent : null,
        authorName: null,
        postedAt: time ? time.dateTime : null,
        text: textNode ? textNode.textContent : null,
        lang: langNode ? langNode.getAttribute('lang') : null,
        type,
        replyTo: replyMatch ? replyMatch[1] : null,
        quotedUrl: quotedAnchor ? quotedAnchor.href : null,
        metrics: {},
        media: images,
        rawHtmlSnippet: html.slice(0, 5000),
      };
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const targetUrl = options.startUrl || `https://x.com/${options.handle}`;
  const startedAt = new Date().toISOString();
  const seen = new Set();
  let totalWritten = 0;
  let scrollRounds = 0;
  let noNewRounds = 0;
  let stopReason = 'unknown';

  await ensureParentDir(options.out);
  const stream = fs.createWriteStream(options.out, { flags: 'a' });
  const context = await chromium.launchPersistentContext(options.profileDir, {
    headless: options.headless,
    viewport: { width: 1440, height: 1200 },
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    console.error('browser launched');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    console.error('profile opened');

    while (totalWritten < options.limit) {
      const visible = await extractVisibleArticles(page);
      console.error(`extracted ${visible.length} visible cards`);
      let newCount = 0;
      for (const raw of visible) {
        const record = normalizeArticleRecord({ ...raw, scrapedAt: new Date().toISOString() });
        const key = dedupeKeyForRecord(record);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        await appendJsonlRecord(stream, record);
        totalWritten += 1;
        newCount += 1;
        if (totalWritten >= options.limit) {
          stopReason = 'limit-reached';
          break;
        }
      }

      console.error(`wrote ${newCount} new unique items`);
      if (stopReason === 'limit-reached') break;
      if (newCount === 0) noNewRounds += 1;
      else noNewRounds = 0;
      if (noNewRounds >= options.maxNoNewScrolls) {
        stopReason = 'no-new-items';
        break;
      }
      scrollRounds += 1;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(options.scrollDelayMs);
    }

    const metadata = {
      handle: options.handle,
      effectiveUrl: targetUrl,
      startedAt,
      finishedAt: new Date().toISOString(),
      totalUniqueItemsWritten: totalWritten,
      scrollRounds,
      stopReason,
      profileDir: options.profileDir,
      args: options,
    };
    await fs.promises.writeFile(buildMetadataPath(options.out), JSON.stringify(metadata, null, 2));
  } finally {
    stream.end();
    await context.close();
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
```

- [ ] **Step 4: Run the full test suite to verify helpers and CLI support code pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/x-scrape-user.cli.test.js scripts/x-scrape-user.js scripts/lib/x-scrape-user-helpers.js
git commit -m "feat: add x timeline collector cli"
```

### Task 6: Run a live smoke verification

**Files:**
- Modify: `/Users/mac/Desktop/proj/sys/docs/superpowers/specs/2026-04-19-x-playwright-post-collector-design.md`

- [ ] **Step 1: Run the collector against a real logged-in handle with a small limit**

Run: `node scripts/x-scrape-user.js --handle coolish --out data/coolish.posts.jsonl --profile-dir .playwright/x-profile --limit 5`
Expected: Browser opens or reuses session, at least one record is written, and metadata is emitted.

- [ ] **Step 2: Inspect the first few lines of the JSONL output and the metadata file**

Run: `sed -n '1,3p' data/coolish.posts.jsonl && cat data/coolish.posts.meta.json`
Expected: Valid JSON lines and a metadata file with a non-empty stop reason.

- [ ] **Step 3: Record any selector caveats back into the design doc if live verification reveals them**

```markdown
## Live Verification Notes

- Record any selector drift or login-specific caveats discovered during manual smoke testing.
```

- [ ] **Step 4: Run the full automated test suite one last time**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add data/coolish.posts.meta.json docs/superpowers/specs/2026-04-19-x-playwright-post-collector-design.md
 git commit -m "docs: capture x collector smoke verification notes"
```
