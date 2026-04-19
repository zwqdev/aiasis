#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const {
  parseArgs,
  normalizeArticleRecord,
  dedupeKeyForRecord,
  buildMetadataPath,
  buildRunMetadata,
  hasAuthCookies,
  isClosedBrowserError,
  resolveBrowserContextOptions,
} = require('./lib/x-scrape-user-helpers');
const { scrollTimelineForMore } = require('./lib/x-scrape-user-browser');

async function applyLowAutomationPageDefaults(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });
  });
}

async function ensureParentDir(filePath) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

function writeJsonLine(stream, record) {
  return new Promise((resolve, reject) => {
    stream.write(`${JSON.stringify(record)}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function closeStream(stream) {
  return new Promise((resolve, reject) => {
    stream.end((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function waitForTimeline(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2500);
  const articleLocator = page.locator('article');
  const articleCount = await articleLocator.count();
  if (articleCount > 0) {
    return;
  }

  const loginPrompt = await page.locator('input[name="text"]').count();
  if (loginPrompt > 0) {
    throw new Error('Login required before the profile timeline can be scraped');
  }

  await articleLocator.first().waitFor({ timeout: 15000 });
}

async function extractVisibleArticles(page) {
  return page.evaluate(() => {
    const normalizeAbsoluteUrl = (value) => {
      if (!value) {
        return null;
      }

      try {
        return new URL(value, window.location.origin).toString();
      } catch {
        return null;
      }
    };

    const parseMetricMap = (article) => {
      const metrics = {};
      const keys = ['reply', 'repost', 'like', 'view'];
      for (const key of keys) {
        const button = article.querySelector(`[data-testid="${key}"]`);
        if (!button) {
          metrics[key] = null;
          continue;
        }

        const metricText = button.getAttribute('aria-label') || button.textContent || '';
        const match = metricText.match(/([\d.,]+\s*[KMkm]?)/);
        metrics[key] = match ? match[1].replace(/\s+/g, '') : null;
      }
      return metrics;
    };

    const parseType = (article, socialText, quotedUrl, replyTo) => {
      if (quotedUrl) {
        return 'quote';
      }

      if (replyTo) {
        return 'reply';
      }

      if (/\breposted\b/i.test(socialText) || /\srepost(ed)?\s/i.test(socialText)) {
        return 'repost';
      }

      return 'post';
    };

    return Array.from(document.querySelectorAll('article')).map((article) => {
      const rawHtmlSnippet = article.outerHTML.slice(0, 5000);
      const statusLinks = Array.from(article.querySelectorAll('a[href*="/status/"]'));
      const primaryLink = statusLinks[0] || null;
      const quotedLink = statusLinks.find((link) => link !== primaryLink) || null;
      const timeNode = article.querySelector('time');
      const textNode = article.querySelector('[data-testid="tweetText"]');
      const langNode = article.querySelector('[data-testid="tweetText"] [lang], [lang]');
      const handleNode = Array.from(article.querySelectorAll('a[role="link"], span')).find((node) => {
        const text = node.textContent ? node.textContent.trim() : '';
        return text.startsWith('@');
      });
      const socialText = article.textContent || '';
      const replyMatch = socialText.match(/replying to\s+@([A-Za-z0-9_]+)/i);
      const authorNameNode = handleNode && handleNode.parentElement ? handleNode.parentElement.previousElementSibling : null;
      const media = Array.from(article.querySelectorAll('img[src*="pbs.twimg.com"], video[poster]')).map((node) => {
        if (node.tagName.toLowerCase() === 'video') {
          return { type: 'video', url: node.getAttribute('poster') };
        }

        return { type: 'image', url: node.getAttribute('src') };
      }).filter((item) => item.url);

      const quotedUrl = normalizeAbsoluteUrl(quotedLink ? quotedLink.getAttribute('href') : null);
      const replyTo = replyMatch ? replyMatch[1] : null;

      return {
        url: normalizeAbsoluteUrl(primaryLink ? primaryLink.getAttribute('href') : null),
        authorHandle: handleNode ? handleNode.textContent : null,
        authorName: authorNameNode ? authorNameNode.textContent : null,
        postedAt: timeNode ? timeNode.dateTime : null,
        text: textNode ? textNode.textContent : null,
        lang: langNode ? langNode.getAttribute('lang') : null,
        type: parseType(article, socialText, quotedUrl, replyTo),
        replyTo,
        quotedUrl,
        metrics: parseMetricMap(article),
        media,
        rawHtmlSnippet,
      };
    });
  });
}

async function writeMetadata(options, metadata) {
  await ensureParentDir(options.out);
  await fs.promises.writeFile(buildMetadataPath(options.out), JSON.stringify(metadata, null, 2));
}

function rewriteLaunchError(error, contextOptions) {
  const message = String(error && error.message ? error.message : error);
  if (/ProcessSingleton|SingletonLock|profile directory is already in use|profile is already in use/i.test(message)) {
    return new Error('Persistent Playwright profile is currently locked by another browser process. Close the existing .playwright/x-profile browser window and retry.');
  }

  return error;
}

async function waitForAuthenticatedSession(context, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    let cookies;
    try {
      cookies = await context.cookies('https://x.com');
    } catch (error) {
      if (isClosedBrowserError(error)) {
        throw new Error('Login window was closed before authentication completed. Run npm run login:x to initialize .playwright/x-profile, then rerun the download command.');
      }

      throw error;
    }

    if (hasAuthCookies(cookies)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return false;
}

async function ensureAuthenticatedSession(context, page, options, contextOptions) {
  const cookies = await context.cookies('https://x.com');
  if (hasAuthCookies(cookies)) {
    return;
  }

  if (options.headless) {
    throw new Error('Authenticated X session required in headless mode. Re-run without --headless and log in once using the persistent profile.');
  }

  console.error('no authenticated X session found; opening login page');
  await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded' });
  const authenticated = await waitForAuthenticatedSession(context, 5 * 60 * 1000);
  if (!authenticated) {
    throw new Error('Timed out waiting for X login to complete in the persistent profile');
  }
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
  const contextOptions = resolveBrowserContextOptions(options);

  await ensureParentDir(options.out);
  const outputStream = fs.createWriteStream(options.out, { flags: 'a' });
  let context;
  const activeContextOptions = contextOptions;
  try {
    context = await chromium.launchPersistentContext(activeContextOptions.userDataDir, {
      channel: activeContextOptions.channel || undefined,
      headless: options.headless,
      viewport: { width: 1440, height: 1200 },
      ignoreDefaultArgs: activeContextOptions.ignoreDefaultArgs,
      args: activeContextOptions.launchArgs,
    });
  } catch (error) {
    throw rewriteLaunchError(error, activeContextOptions);
  }

  try {
    await applyLowAutomationPageDefaults(context);
    const page = context.pages()[0] || await context.newPage();
    console.error('browser launched');
    await ensureAuthenticatedSession(context, page, options, activeContextOptions);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await waitForTimeline(page);
    console.error('profile opened');

    while (totalWritten < options.limit) {
      const rawArticles = await extractVisibleArticles(page);
      console.error(`extracted ${rawArticles.length} visible cards`);

      let newCount = 0;
      for (const rawArticle of rawArticles) {
        const record = normalizeArticleRecord({
          ...rawArticle,
          scrapedAt: new Date().toISOString(),
        });
        const key = dedupeKeyForRecord(record);
        if (!key || seen.has(key)) {
          continue;
        }

        seen.add(key);
        await writeJsonLine(outputStream, record);
        totalWritten += 1;
        newCount += 1;

        if (totalWritten >= options.limit) {
          stopReason = 'limit-reached';
          break;
        }
      }

      console.error(`wrote ${newCount} new unique items`);

      if (stopReason === 'limit-reached') {
        break;
      }

      const scrollResult = await scrollTimelineForMore(page, { scrollDelayMs: options.scrollDelayMs });

      if (newCount === 0 && !scrollResult.loadedMore && !scrollResult.scrolled) {
        noNewRounds += 1;
      } else {
        noNewRounds = 0;
      }

      if (noNewRounds >= options.maxNoNewScrolls) {
        stopReason = 'no-new-items';
        break;
      }

      scrollRounds += 1;
    }
  } catch (error) {
    stopReason = `error:${error.message}`;
    throw error;
  } finally {
    await closeStream(outputStream);
    await writeMetadata(options, {
      ...buildRunMetadata(options, {
        targetUrl,
        startedAt,
        finishedAt: new Date().toISOString(),
        totalWritten,
        scrollRounds,
        stopReason,
        sessionSource: activeContextOptions.sessionSource,
      }),
    });
    await context.close();
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});