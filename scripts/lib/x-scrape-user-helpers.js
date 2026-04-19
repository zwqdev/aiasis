const DEFAULTS = {
  profileDir: '.playwright/x-profile',
  limit: Infinity,
  headless: false,
  maxNoNewScrolls: 5,
  scrollDelayMs: 1200,
  startUrl: null,
};

function buildDefaultOutputPath(handle) {
  return `data/${handle}/posts.jsonl`;
}

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

    if (token === '--handle') {
      options.handle = value;
    } else if (token === '--out') {
      options.out = value;
    } else if (token === '--profile-dir') {
      options.profileDir = value;
    } else if (token === '--limit') {
      options.limit = Number(value);
    } else if (token === '--max-no-new-scrolls') {
      options.maxNoNewScrolls = Number(value);
    } else if (token === '--scroll-delay-ms') {
      options.scrollDelayMs = Number(value);
    } else if (token === '--start-url') {
      options.startUrl = value;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }

    index += 1;
  }

  if (!options.handle) {
    throw new Error('Missing required --handle');
  }

  if (!options.out) {
    options.out = buildDefaultOutputPath(options.handle);
  }

  return options;
}

function normalizePostUrl(value) {
  if (!value) {
    return null;
  }

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
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

function parseMetricValue(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).trim().replace(/,/g, '').toUpperCase();
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^(\d+(?:\.\d+)?)([KM])?$/);
  if (!match) {
    return null;
  }

  const base = Number(match[1]);
  const suffix = match[2];
  if (suffix === 'K') {
    return Math.round(base * 1000);
  }

  if (suffix === 'M') {
    return Math.round(base * 1000000);
  }

  return Math.round(base);
}

function dedupeKeyForRecord(record) {
  if (record.url) {
    return record.url;
  }

  if (record.id) {
    return `id:${record.id}`;
  }

  return null;
}

function normalizeHandle(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).trim().replace(/^@/, '');
  return normalized || null;
}

function normalizeType(value) {
  return ['post', 'reply', 'repost', 'quote', 'unknown'].includes(value) ? value : 'unknown';
}

function recoverAuthorNameFromHtml(rawHtmlSnippet) {
  if (!rawHtmlSnippet) {
    return null;
  }

  const match = rawHtmlSnippet.match(/data-testid="User-Name"[\s\S]*?<span[^>]*>([^<@][^<]*)<\/span>/i);
  return match ? match[1].trim() : null;
}

function sanitizeQuotedUrl(value) {
  const normalized = normalizePostUrl(value);
  if (!normalized || normalized.endsWith('/analytics')) {
    return null;
  }

  return normalized;
}

function sanitizeMediaList(media) {
  if (!Array.isArray(media)) {
    return [];
  }

  return media.filter((item) => {
    if (!item || !item.url) {
      return false;
    }

    return !/\/profile_images\//.test(item.url);
  });
}

function normalizeArticleRecord(raw) {
  const quotedUrl = sanitizeQuotedUrl(raw.quotedUrl);
  return {
    id: extractPostIdFromUrl(raw.url),
    url: normalizePostUrl(raw.url),
    authorHandle: normalizeHandle(raw.authorHandle),
    authorName: raw.authorName ? String(raw.authorName).trim() : recoverAuthorNameFromHtml(raw.rawHtmlSnippet),
    postedAt: raw.postedAt || null,
    text: raw.text ? String(raw.text).trim() : null,
    lang: raw.lang || null,
    type: quotedUrl ? normalizeType(raw.type) : (raw.type === 'quote' ? 'post' : normalizeType(raw.type)),
    replyTo: normalizeHandle(raw.replyTo),
    quotedUrl,
    metrics: {
      reply: parseMetricValue(raw.metrics?.reply),
      repost: parseMetricValue(raw.metrics?.repost),
      like: parseMetricValue(raw.metrics?.like),
      view: parseMetricValue(raw.metrics?.view),
    },
    media: sanitizeMediaList(raw.media),
    rawHtmlSnippet: raw.rawHtmlSnippet || null,
    scrapedAt: raw.scrapedAt || new Date().toISOString(),
  };
}

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
  const text = firstMatch(html, /<div[^>]*data-post-text="true"[^>]*>([\s\S]*?)<\/div>/i);
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

function buildMetadataPath(outputPath) {
  if (outputPath.endsWith('.jsonl')) {
    return outputPath.slice(0, -'.jsonl'.length) + '.meta.json';
  }

  return `${outputPath}.meta.json`;
}

module.exports = {
  parseArgs,
  buildDefaultOutputPath,
  normalizePostUrl,
  extractPostIdFromUrl,
  parseMetricValue,
  dedupeKeyForRecord,
  normalizeHandle,
  normalizeType,
  recoverAuthorNameFromHtml,
  sanitizeQuotedUrl,
  sanitizeMediaList,
  normalizeArticleRecord,
  extractArticleDataFromHtml,
  buildMetadataPath,
};