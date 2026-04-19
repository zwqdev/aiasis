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

test('normalizeArticleRecord filters analytics links and avatar images and recovers authorName from html', () => {
  const record = normalizeArticleRecord({
    url: 'https://x.com/coolish/status/1662210151057854466',
    authorHandle: '@coolish',
    authorName: null,
    quotedUrl: 'https://x.com/coolish/status/1662210151057854466/analytics',
    type: 'quote',
    metrics: {},
    media: [
      { type: 'image', url: 'https://pbs.twimg.com/profile_images/1548729057994452992/Kcs8r3YR_normal.jpg' },
      { type: 'image', url: 'https://pbs.twimg.com/ext_tw_video_thumb/1662209693635448832/pu/img/oW-Qhlcxz70ZPt1Q.jpg' },
    ],
    rawHtmlSnippet: '<div data-testid="User-Name"><span>paulwei</span><span>@coolish</span></div>',
  });

  assert.equal(record.authorName, 'paulwei');
  assert.equal(record.quotedUrl, null);
  assert.deepEqual(record.media, [
    { type: 'image', url: 'https://pbs.twimg.com/ext_tw_video_thumb/1662209693635448832/pu/img/oW-Qhlcxz70ZPt1Q.jpg' },
  ]);
  assert.equal(record.type, 'post');
});