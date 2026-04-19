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