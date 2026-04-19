'use strict';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 1;

function fmt(level, module, message, meta) {
  const ts = new Date().toISOString();
  const base = `${ts} [${level.toUpperCase().padEnd(5)}] [${module}] ${message}`;
  return meta ? `${base} ${JSON.stringify(meta)}` : base;
}

function makeLogger(module) {
  return {
    debug: (msg, meta) => {
      if (currentLevel <= LEVELS.debug) console.debug(fmt('debug', module, msg, meta));
    },
    info: (msg, meta) => {
      if (currentLevel <= LEVELS.info) console.log(fmt('info', module, msg, meta));
    },
    warn: (msg, meta) => {
      if (currentLevel <= LEVELS.warn) console.warn(fmt('warn', module, msg, meta));
    },
    error: (msg, meta) => {
      if (currentLevel <= LEVELS.error) console.error(fmt('error', module, msg, meta));
    },
  };
}

module.exports = { makeLogger };
