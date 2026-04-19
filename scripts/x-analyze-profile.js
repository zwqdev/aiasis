#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  parseJsonlFile,
  analyzePosts,
  renderProfileReport,
} = require('./lib/x-profile-analysis');

function parseArgs(argv) {
  const options = {
    handle: null,
    input: null,
    out: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];

    if (!value) {
      throw new Error(`Missing value for ${token}`);
    }

    if (token === '--handle') {
      options.handle = value;
    } else if (token === '--input') {
      options.input = value;
    } else if (token === '--out') {
      options.out = value;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }

    index += 1;
  }

  if (!options.handle && !options.input) {
    throw new Error('Missing required --handle or --input');
  }

  if (!options.input) {
    options.input = path.join('data', options.handle, 'posts.jsonl');
  }

  if (!options.handle) {
    options.handle = path.basename(path.dirname(options.input));
  }

  if (!options.out) {
    options.out = path.join('data', options.handle, 'profile.report.md');
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const records = parseJsonlFile(options.input);

  if (records.length === 0) {
    throw new Error(`No records found in ${options.input}`);
  }

  const analysis = analyzePosts(records, { handle: options.handle });
  const report = renderProfileReport(analysis);

  await fs.promises.mkdir(path.dirname(options.out), { recursive: true });
  await fs.promises.writeFile(options.out, report, 'utf8');

  console.error(`profile report written to ${options.out}`);
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});