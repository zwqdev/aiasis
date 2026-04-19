const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('x profile analysis script renders a markdown report from posts jsonl', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'profile-sample-posts.jsonl');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-profile-analysis-'));
  const outputPath = path.join(outputDir, 'profile.report.md');

  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '..', 'scripts', 'x-analyze-profile.js'),
      '--input', fixturePath,
      '--out', outputPath,
      '--handle', 'demo',
    ],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const report = fs.readFileSync(outputPath, 'utf8');
  assert.match(report, /^# demo 画像报告/m);
  assert.match(report, /^## 摘要$/m);
  assert.match(report, /^## 事实画像$/m);
  assert.match(report, /^## 研究员判断$/m);
  assert.match(report, /^## 代表性证据$/m);
  assert.match(report, /^## 不确定性与反例$/m);
  assert.match(report, /^## 一句话结论$/m);
  assert.match(report, /ASTEROID/);
  assert.match(report, /事件驱动/);
  assert.match(report, /高波动/);
});