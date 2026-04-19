const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const { scrollTimelineForMore } = require('../scripts/lib/x-scrape-user-browser');

test('scrollTimelineForMore triggers lazy timeline loading', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    const fixturePath = pathToFileURL(path.join(__dirname, 'fixtures', 'lazy-timeline.html')).toString();
    await page.goto(fixturePath);
    await page.waitForSelector('article');

    const beforeCount = await page.locator('article').count();
    assert.equal(beforeCount, 5);

    const result = await scrollTimelineForMore(page, { scrollDelayMs: 1200 });
    const afterCount = await page.locator('article').count();

    assert.equal(result.loadedMore, true);
    assert.ok(afterCount > beforeCount);
  } finally {
    await browser.close();
  }
});