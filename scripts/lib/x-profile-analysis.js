const fs = require('node:fs');

const THEME_RULES = [
  {
    label: '事件驱动',
    patterns: [/新闻/i, /公告/i, /主网/i, /上线/i, /上币/i, /调查/i, /催化/i, /事件驱动/i],
  },
  {
    label: '赔率与成本框架',
    patterns: [/赔率/i, /成本/i, /回本/i, /龙头/i, /市值/i, /\b\d{2,4}x\b/i, /倍/i],
  },
  {
    label: '高波动机会',
    patterns: [/高波动/i, /起飞/i, /机会/i, /分流/i, /小票/i, /弹性/i],
  },
  {
    label: '风险意识',
    patterns: [/风险/i, /节奏/i, /仓位/i, /止损/i],
  },
  {
    label: 'AI工具实验',
    patterns: [/\bai\b/i, /agent/i, /prompt/i, /autoresearch/i, /claude/i],
  },
];

function parseJsonlFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function countBy(items) {
  const counts = new Map();
  for (const item of items) {
    if (!item) {
      continue;
    }

    counts.set(item, (counts.get(item) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])));
}

function extractTickers(text) {
  if (!text) {
    return [];
  }

  return Array.from(new Set(
    (String(text).match(/\$[A-Za-z][A-Za-z0-9_]{1,14}/g) || [])
      .map((value) => value.slice(1).toUpperCase())
  ));
}

function extractMentions(text) {
  if (!text) {
    return [];
  }

  return Array.from(new Set(
    (String(text).match(/@[A-Za-z0-9_]{1,15}/g) || [])
      .map((value) => value.slice(1))
  ));
}

function detectThemes(text) {
  if (!text) {
    return [];
  }

  return THEME_RULES
    .filter((theme) => theme.patterns.some((pattern) => pattern.test(text)))
    .map((theme) => theme.label);
}

function sumEngagement(record) {
  const metrics = record.metrics || {};
  return (metrics.reply || 0) + (metrics.repost || 0) + (metrics.like || 0) + (metrics.view || 0);
}

function toPercent(value, total) {
  if (!total) {
    return '0%';
  }

  return `${Math.round((value / total) * 100)}%`;
}

function analyzePosts(records, options = {}) {
  const postsWithText = records.filter((record) => record.text);
  const allTickers = postsWithText.flatMap((record) => extractTickers(record.text));
  const allMentions = postsWithText.flatMap((record) => extractMentions(record.text));
  const allThemes = postsWithText.flatMap((record) => detectThemes(record.text));
  const sortedByEngagement = [...postsWithText].sort((left, right) => sumEngagement(right) - sumEngagement(left));
  const typeCounts = countBy(records.map((record) => record.type || 'unknown'));
  const topTickers = countBy(allTickers).slice(0, 5);
  const topMentions = countBy(allMentions).slice(0, 5);
  const topThemes = countBy(allThemes).slice(0, 5);
  const startedAt = records.map((record) => record.postedAt).filter(Boolean).sort()[0] || null;
  const endedAt = records.map((record) => record.postedAt).filter(Boolean).sort().slice(-1)[0] || null;
  const quoteCount = records.filter((record) => record.type === 'quote').length;
  const inferenceItems = [];

  if (topTickers.length > 0) {
    inferenceItems.push({
      title: '关注资产谱系',
      detail: `高频提及资产集中在 ${topTickers.slice(0, 3).map(([ticker]) => `$${ticker}`).join('、')}，说明选题高度围绕少数高关注标的展开。`,
    });
  }

  if (topThemes.some(([label, count]) => label === '事件驱动' && count >= 2)) {
    inferenceItems.push({
      title: '机会偏好',
      detail: '明显偏事件驱动/催化驱动，倾向围绕新闻、主网、上线等触发器寻找短中期机会。',
    });
  }

  if (topThemes.some(([label, count]) => label === '赔率与成本框架' && count >= 2)) {
    inferenceItems.push({
      title: '判断信号',
      detail: '经常用赔率、成本、龙头和回报倍数来表达观点，说明更接近交易赔率框架，而不是长期价值叙事。',
    });
  }

  if (topThemes.some(([label, count]) => label === '高波动机会' && count >= 1)) {
    inferenceItems.push({
      title: '风险偏好',
      detail: '偏好高波动机会，愿意参与高弹性标的，但并不完全无视节奏和风险。',
    });
  }

  if (quoteCount / Math.max(records.length, 1) >= 0.25) {
    inferenceItems.push({
      title: '表达风格',
      detail: '较多使用引用帖进入话题，说明除了原创判断，也会主动借势已有叙事做扩散和位置表达。',
    });
  }

  if (topThemes.some(([label, count]) => label === 'AI工具实验' && count >= 1)) {
    inferenceItems.push({
      title: '研究方式',
      detail: '会把 AI 工具当成研究辅助，而不是只谈纯市场观点。',
    });
  }

  const summaryLines = [
    topTickers.length > 0
      ? `这是一类强主题型账号，当前讨论重心明显集中在 ${topTickers.slice(0, 2).map(([ticker]) => `$${ticker}`).join('、')} 等资产。`
      : '这是一类强主题型账号，但当前样本里没有形成稳定的资产集中度。',
    topThemes.some(([label]) => label === '事件驱动')
      ? '从语言模式看，判断更偏事件驱动，而不是慢变量研究。'
      : '从语言模式看，事件驱动特征不算特别强。',
    topThemes.some(([label]) => label === '赔率与成本框架')
      ? '表达里频繁出现成本、赔率、龙头等词，说明其交易框架偏向赔率比较。'
      : '表达里没有形成特别强的赔率框架信号。',
    topThemes.some(([label]) => label === '高波动机会')
      ? '总体风险偏好偏高，愿意讨论高波动机会。'
      : '总体风险偏好信号暂时不够强。',
  ];

  return {
    handle: options.handle || records[0]?.authorHandle || 'unknown',
    totalPosts: records.length,
    postsWithText: postsWithText.length,
    startedAt,
    endedAt,
    typeCounts,
    topTickers,
    topMentions,
    topThemes,
    topEvidence: sortedByEngagement.slice(0, 5),
    summaryLines,
    inferenceItems,
    uncertaintyItems: [
      records.length < 20
        ? '当前样本量偏小，结论更像阶段性风格切片，而不是长期稳定画像。'
        : '当前样本仍然只覆盖被抓取到的时间窗口，可能遗漏更长周期的风格变化。',
      records.some((record) => !record.text)
        ? '部分帖子正文缺失，可能低估某些主题频率。'
        : '当前样本中文本完整度尚可，但仍可能低估图片或截图类表达。',
    ],
  };
}

function renderProfileReport(analysis) {
  const facts = [
    `样本帖子数：${analysis.totalPosts}`,
    analysis.startedAt && analysis.endedAt ? `时间范围：${analysis.startedAt} -> ${analysis.endedAt}` : null,
    analysis.typeCounts.length > 0
      ? `发帖类型分布：${analysis.typeCounts.map(([type, count]) => `${type} ${count} (${toPercent(count, analysis.totalPosts)})`).join('，')}`
      : null,
    analysis.topTickers.length > 0
      ? `高频资产：${analysis.topTickers.map(([ticker, count]) => `$${ticker} (${count})`).join('，')}`
      : '高频资产：暂无显著集中资产',
    analysis.topThemes.length > 0
      ? `高频主题：${analysis.topThemes.map(([theme, count]) => `${theme} (${count})`).join('，')}`
      : '高频主题：暂无显著主题集中',
    analysis.topMentions.length > 0
      ? `高频互动对象：${analysis.topMentions.map(([handle, count]) => `@${handle} (${count})`).join('，')}`
      : '高频互动对象：暂无明显集中对象',
  ].filter(Boolean);

  const evidenceLines = analysis.topEvidence.length > 0
    ? analysis.topEvidence.map((record) => `- ${record.postedAt || 'unknown time'} | ${record.url}\n  - ${(record.text || '').slice(0, 140)}`)
    : ['- 暂无可用证据样本'];

  const inferenceLines = analysis.inferenceItems.length > 0
    ? analysis.inferenceItems.map((item) => `- ${item.title}：${item.detail}`)
    : ['- 当前样本不足以形成稳定的研究员判断。'];

  const uncertaintyLines = analysis.uncertaintyItems.map((item) => `- ${item}`);
  const oneLineConclusion = analysis.inferenceItems[0]
    ? `${analysis.handle} 更像一个围绕 ${analysis.topTickers[0] ? `$${analysis.topTickers[0][0]}` : '热点资产'} 寻找事件驱动高波动机会，并用赔率框架表达判断的交易型账号。`
    : `${analysis.handle} 当前样本不足，暂时只能看出阶段性热点跟踪倾向。`;

  return [
    `# ${analysis.handle} 画像报告`,
    '',
    '## 摘要',
    ...analysis.summaryLines.map((line) => `- ${line}`),
    '',
    '## 事实画像',
    ...facts.map((line) => `- ${line}`),
    '',
    '## 研究员判断',
    ...inferenceLines,
    '',
    '## 代表性证据',
    ...evidenceLines,
    '',
    '## 不确定性与反例',
    ...uncertaintyLines,
    '',
    '## 一句话结论',
    oneLineConclusion,
    '',
  ].join('\n');
}

module.exports = {
  parseJsonlFile,
  analyzePosts,
  renderProfileReport,
};