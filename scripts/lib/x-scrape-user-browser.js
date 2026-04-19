async function getTimelineStats(page) {
  return page.evaluate(() => ({
    scrollY: window.scrollY,
    innerHeight: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
    articleCount: document.querySelectorAll('article').length,
  }));
}

async function scrollTimelineForMore(page, options = {}) {
  const scrollDelayMs = options.scrollDelayMs ?? 1200;
  const before = await getTimelineStats(page);

  const lastArticle = page.locator('article').last();
  if (await lastArticle.count()) {
    await lastArticle.scrollIntoViewIfNeeded();
  }

  await page.mouse.wheel(0, Math.max(before.innerHeight, 1600));

  try {
    await page.waitForFunction(
      ({ previousScrollY }) => {
        return window.scrollY > previousScrollY;
      },
      {
        previousScrollY: before.scrollY,
      },
      { timeout: 500 }
    );
  } catch {
    // Reaching the bottom can leave scrollY unchanged; continue to content wait.
  }

  try {
    await page.waitForFunction(
      ({ previousArticleCount, previousScrollHeight }) => {
        return document.querySelectorAll('article').length > previousArticleCount
          || document.documentElement.scrollHeight > previousScrollHeight;
      },
      {
        previousArticleCount: before.articleCount,
        previousScrollHeight: before.scrollHeight,
      },
      { timeout: scrollDelayMs }
    );
  } catch {
    await page.waitForTimeout(100);
  }

  const after = await getTimelineStats(page);
  return {
    before,
    after,
    loadedMore: after.articleCount > before.articleCount || after.scrollHeight > before.scrollHeight,
    scrolled: after.scrollY > before.scrollY,
  };
}

module.exports = {
  getTimelineStats,
  scrollTimelineForMore,
};