const test = require('node:test');
const assert = require('node:assert/strict');

const { buildKlineStructureSummary } = require('../scripts/trading-bot-bitget/agent/kline-structure');

function makeCandle(index, values) {
  return {
    time: new Date(Date.UTC(2026, 3, 1, 0, index)).toISOString(),
    open: values.open,
    high: values.high,
    low: values.low,
    close: values.close,
    volume: values.volume || 1000,
    volumeUsdt: values.volumeUsdt || 100000,
  };
}

test('buildKlineStructureSummary identifies repeated resistance, breakout, retest, and nearest support', () => {
  const closes = [
    95.8, 96.3, 97.1, 98.4, 99.2,
    99.6, 99.1, 99.7, 98.8, 99.4,
    98.9, 99.8, 99.3, 99.6, 99.2,
    100.8, 102.2, 100.5, 101.4, 101.8,
  ];

  const candles = closes.map((close, index) => {
    if (index === 4 || index === 7 || index === 11) {
      return makeCandle(index, { open: close - 0.4, high: 100.05, low: close - 0.8, close });
    }
    if (index === 15) {
      return makeCandle(index, { open: 99.4, high: 101.3, low: 99.1, close: 100.8, volumeUsdt: 150000 });
    }
    if (index === 16) {
      return makeCandle(index, { open: 100.8, high: 102.5, low: 100.4, close: 102.2, volumeUsdt: 260000 });
    }
    if (index === 17) {
      return makeCandle(index, { open: 102.0, high: 102.1, low: 100.02, close: 100.5, volumeUsdt: 130000 });
    }
    return makeCandle(index, { open: close - 0.3, high: close + 0.5, low: close - 0.7, close });
  });

  const summary = buildKlineStructureSummary(candles, '15m');

  assert.equal(summary.resistanceLevel, 100.05);
  assert.equal(summary.supportLevel, 98.1);
  assert.equal(summary.breakout.detected, true);
  assert.equal(summary.breakout.retestConfirmed, true);
  assert.equal(summary.breakout.breakoutCandleTime, candles[15].time);
  assert.deepEqual(summary.pullbackZone, { low: 99.65, high: 100.45 });
  assert.equal(summary.latestStructureBias, 'bullish');
});

test('buildKlineStructureSummary does not force a breakout when price only makes a local high', () => {
  const candles = Array.from({ length: 20 }, (_, index) => {
    const close = 100 + Math.sin(index / 2) * 1.5;
    return makeCandle(index, {
      open: close - 0.2,
      high: close + 0.4,
      low: close - 0.5,
      close,
      volumeUsdt: 90000,
    });
  });

  const summary = buildKlineStructureSummary(candles, '15m');

  assert.equal(summary.breakout.detected, false);
  assert.equal(summary.breakout.retestConfirmed, false);
  assert.equal(summary.resistanceLevel, null);
  assert.equal(summary.pullbackZone, null);
});