'use strict';

/**
 * Twitter Signal Scanner
 *
 * Strategy origin: lana's insight that MMs seeking "币安合约壳" (Binance contract
 * shells) + Aster DEX activity are reliable pre-listing leading indicators.
 *
 * This scanner uses the existing Playwright browser profile to:
 * 1. Search X for listing-signal keywords and parse any token cashtags mentioned.
 * 2. Monitor configured signal-source handles for recent posts.
 * 3. Emit { tokenAddress, tokenSymbol, source, confidence, rawText } signals.
 */

const { chromium } = require('playwright');
const { makeLogger } = require('../lib/logger');
const { addSignal, setLastTwitterScan } = require('../lib/state');
const config = require('../lib/config');

const log = makeLogger('twitter-scanner');

// Keywords that indicate a pre-Binance-listing opportunity based on the strategy
const SIGNAL_KEYWORDS = [
  '币安合约壳',
  '合约壳',
  'binance contract shell',
  '即将上币安',
  '上币安合约',
  'binance listing',
  '币安上线',
  'MM在买',
  'MM在囤',
  'aster dex',
  'asterdex',
];

// Cashtag pattern: $TOKEN (2–10 uppercase letters, no numbers to avoid false positives)
const CASHTAG_RE = /\$([A-Z]{2,10})\b/g;

// Common non-token cashtags to ignore
const IGNORE_SYMBOLS = new Set([
  'BTC', 'ETH', 'BNB', 'SOL', 'USDT', 'USDC', 'BUSD', 'DAI',
  'USD', 'EUR', 'CNY', 'HKD', 'P', 'A',
]);

function extractCashtags(text) {
  const symbols = [];
  let match;
  CASHTAG_RE.lastIndex = 0;
  while ((match = CASHTAG_RE.exec(text)) !== null) {
    const sym = match[1];
    if (!IGNORE_SYMBOLS.has(sym)) symbols.push(sym);
  }
  return [...new Set(symbols)];
}

function hasSignalKeyword(text) {
  const lower = text.toLowerCase();
  return SIGNAL_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Score a tweet text for confidence (0–3).
 * Higher = more signal keywords + cashtags present.
 */
function scoreText(text) {
  let score = 0;
  const lower = text.toLowerCase();
  for (const kw of SIGNAL_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) score += 1;
  }
  const tags = extractCashtags(text);
  if (tags.length > 0) score += 1;
  return Math.min(score, 3);
}

async function launchBrowser() {
  return chromium.launchPersistentContext(config.twitterProfileDir, {
    headless: true,
    viewport: { width: 1440, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

/**
 * Extract visible tweet texts from the current search results page.
 */
async function extractTweetTexts(page) {
  return page.evaluate(() => {
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    return articles.map((el) => {
      const textEl = el.querySelector('[data-testid="tweetText"]');
      return textEl ? textEl.innerText : '';
    }).filter(Boolean);
  });
}

/**
 * Search X for a keyword and collect matching tweets.
 * Returns array of { text, symbols, score }.
 */
async function searchKeyword(page, keyword) {
  const url = `https://x.com/search?q=${encodeURIComponent(keyword)}&f=live&src=typed_query`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    const texts = await extractTweetTexts(page);
    return texts
      .filter((t) => hasSignalKeyword(t) || extractCashtags(t).length > 0)
      .map((text) => ({
        text,
        symbols: extractCashtags(text),
        score: scoreText(text),
        keyword,
      }));
  } catch (err) {
    log.warn('Search failed for keyword', { keyword, error: err.message });
    return [];
  }
}

/**
 * Scrape the timeline of a specific handle and look for signal tweets.
 */
async function scrapeHandleTimeline(page, handle) {
  const url = `https://x.com/${handle}`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    const texts = await extractTweetTexts(page);
    return texts
      .filter((t) => hasSignalKeyword(t) || extractCashtags(t).length > 0)
      .map((text) => ({
        text,
        symbols: extractCashtags(text),
        score: scoreText(text),
        handle,
        source: `twitter:${handle}`,
      }));
  } catch (err) {
    log.warn('Timeline scrape failed', { handle, error: err.message });
    return [];
  }
}

/**
 * Main scan: search top keywords + monitored handles.
 * Emits signals into state for each discovered cashtag.
 */
async function runScan() {
  log.info('Starting Twitter scan');
  let browser;
  const discovered = [];

  try {
    browser = await launchBrowser();
    const page = browser.pages()[0] || await browser.newPage();

    // Apply anti-detection
    await browser.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Search top signal keywords (sample a few per run to avoid rate limiting)
    const keywordsThisRun = SIGNAL_KEYWORDS.slice(0, 3);
    for (const kw of keywordsThisRun) {
      const results = await searchKeyword(page, kw);
      for (const r of results) {
        for (const sym of r.symbols) {
          const signal = {
            source: `twitter:keyword:${kw}`,
            confidence: r.score,
            tokenSymbol: sym,
            rawText: r.text.slice(0, 280),
          };
          // We don't have the contract address at this stage; store by symbol
          // Signal aggregator will resolve address via DEX lookup
          addSignal(`symbol:${sym}`, signal);
          discovered.push({ sym, signal });
          log.info('Twitter signal', { sym, score: r.score, keyword: kw });
        }
      }
    }

    // Scrape monitored handles
    for (const handle of config.twitterSignalHandles) {
      const results = await scrapeHandleTimeline(page, handle);
      for (const r of results) {
        for (const sym of r.symbols) {
          const signal = {
            source: `twitter:handle:${handle}`,
            confidence: r.score,
            tokenSymbol: sym,
            rawText: r.text.slice(0, 280),
          };
          addSignal(`symbol:${sym}`, signal);
          discovered.push({ sym, signal });
          log.info('Handle signal', { sym, handle, score: r.score });
        }
      }
    }

  } catch (err) {
    log.error('Twitter scan error', { error: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
    setLastTwitterScan(new Date().toISOString());
  }

  log.info('Twitter scan complete', { signals: discovered.length });
  return discovered;
}

module.exports = { runScan, extractCashtags, hasSignalKeyword };
