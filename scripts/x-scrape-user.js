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
  const outputStream = fs.createWriteStream(options.out, { flags: 'a' });
  const context = await chromium.launchPersistentContext(options.profileDir, {
    headless: options.headless,
    viewport: { width: 1440, height: 1200 },
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    console.error('browser launched');
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

      if (newCount === 0) {
        noNewRounds += 1;
      } else {
        noNewRounds = 0;
      }

      if (noNewRounds >= options.maxNoNewScrolls) {
        stopReason = 'no-new-items';
        break;
      }

      scrollRounds += 1;
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight);
      });
      await page.waitForTimeout(options.scrollDelayMs);
    }
  } catch (error) {
    stopReason = `error:${error.message}`;
    throw error;
  } finally {
    await closeStream(outputStream);
    await writeMetadata(options, {
      handle: options.handle,
      effectiveUrl: targetUrl,
      startedAt,
      finishedAt: new Date().toISOString(),
      totalUniqueItemsWritten: totalWritten,
      scrollRounds,
      stopReason,
      profileDir: options.profileDir,
      args: options,
    });
    await context.close();
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});