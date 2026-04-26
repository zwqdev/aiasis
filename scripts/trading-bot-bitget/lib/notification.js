'use strict';

const { execFile } = require('node:child_process');

function escapeAppleScript(value) {
  return String(value).replace(/"/g, '\\"');
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function notifyTradeSignal(title, message, options = {}) {
  const {
    enabled = true,
    platform = process.platform,
    execFileImpl = execFile,
    logger = { debug() {} },
  } = options;

  if (!enabled) return;

  if (platform === 'darwin') {
    execFileImpl('osascript', [
      '-e',
      `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`,
    ], (err) => {
      if (err) logger.debug('macOS notification failed', { error: err.message });
    });
    return;
  }

  if (platform === 'win32') {
    const safeTitle = escapePowerShellSingleQuoted(title);
    const safeMessage = escapePowerShellSingleQuoted(message);
    const command = [
      "Add-Type -AssemblyName PresentationFramework;",
      `[System.Windows.MessageBox]::Show('${safeMessage}', '${safeTitle}') | Out-Null`,
    ].join(' ');

    execFileImpl('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      command,
    ], (err) => {
      if (err) logger.debug('Windows notification failed', { error: err.message });
    });
  }
}

module.exports = {
  notifyTradeSignal,
};
