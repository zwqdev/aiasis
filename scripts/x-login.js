#!/usr/bin/env node

const { chromium } = require('playwright');
const { isIgnorableNavigationAbortError } = require('./lib/x-scrape-user-helpers');

const PROFILE_DIR = '.playwright/x-profile';
const LOGIN_URL = 'https://x.com/i/flow/login';
const SUCCESS_URL = 'https://x.com/home';

async function applyLowAutomationPageDefaults(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });
  });
}

function hasAuthCookies(cookies) {
  const names = new Set((cookies || []).map((cookie) => cookie.name));
  return names.has('auth_token') && names.has('ct0');
}

async function waitForAuthenticatedSession(context, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    let cookies;
    try {
      cookies = await context.cookies('https://x.com');
    } catch (error) {
      if (isClosedBrowserError(error)) {
        throw new Error('Login window was closed before authentication completed. Re-run npm run login:x and finish the X login flow.');
      }

      throw error;
    }

    if (hasAuthCookies(cookies)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return false;
}

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1440, height: 1200 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    await applyLowAutomationPageDefaults(context);
    const page = context.pages()[0] || await context.newPage();
    const cookies = await context.cookies('https://x.com');
    if (hasAuthCookies(cookies)) {
      console.error('existing X login session found in .playwright/x-profile');
      try {
        await page.goto(SUCCESS_URL, { waitUntil: 'domcontentloaded' });
      } catch (error) {
        if (!isIgnorableNavigationAbortError(error)) {
          throw error;
        }
      }
      return;
    }

    console.error('opening X login flow in .playwright/x-profile');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    const authenticated = await waitForAuthenticatedSession(context, 10 * 60 * 1000);
    if (!authenticated) {
      throw new Error('Timed out waiting for X login to complete in .playwright/x-profile');
    }

    console.error('X login captured and saved to .playwright/x-profile');
    try {
      await page.goto(SUCCESS_URL, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      if (!isIgnorableNavigationAbortError(error)) {
        throw error;
      }
    }
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});