const test = require('node:test');
const assert = require('node:assert/strict');

const { notifyTradeSignal } = require('../scripts/trading-bot-bitget/lib/notification');

test('notifyTradeSignal uses osascript on macOS when enabled', () => {
  const calls = [];
  const fakeExecFile = (bin, args, cb) => {
    calls.push({ bin, args });
    cb(null);
  };

  notifyTradeSignal('BUY', 'BTCUSDT LONG', {
    enabled: true,
    platform: 'darwin',
    execFileImpl: fakeExecFile,
    logger: { debug() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'osascript');
  assert.equal(calls[0].args[0], '-e');
  assert.match(calls[0].args[1], /display notification/);
});

test('notifyTradeSignal uses PowerShell popup on Windows when enabled', () => {
  const calls = [];
  const fakeExecFile = (bin, args, cb) => {
    calls.push({ bin, args });
    cb(null);
  };

  notifyTradeSignal('Order Opened', 'ETHUSDT qty=10', {
    enabled: true,
    platform: 'win32',
    execFileImpl: fakeExecFile,
    logger: { debug() {} },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'powershell');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-WindowStyle']);
  assert.equal(calls[0].args[3], 'Hidden');
  assert.equal(calls[0].args[4], '-Command');
  assert.match(calls[0].args[5], /MessageBox/);
});

test('notifyTradeSignal is a no-op when disabled', () => {
  let called = false;
  const fakeExecFile = () => { called = true; };

  notifyTradeSignal('BUY', 'XRPUSDT LONG', {
    enabled: false,
    platform: 'darwin',
    execFileImpl: fakeExecFile,
    logger: { debug() {} },
  });

  assert.equal(called, false);
});
