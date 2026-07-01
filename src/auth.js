import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';

async function ensureParentDirectory(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export function getLoginCredentials() {
  const email = process.env.BOOKING_EMAIL || process.env.CIVIC_PERMITS_EMAIL || '';
  const password = process.env.BOOKING_PASSWORD || process.env.CIVIC_PERMITS_PASSWORD || '';
  return { email, password };
}

export async function refreshAuthState(config) {
  const { email, password } = getLoginCredentials();

  if (!email || !password) {
    throw new Error('Missing BOOKING_EMAIL/BOOKING_PASSWORD. Cannot refresh auth state for this run.');
  }

  const browser = await chromium.launch({ headless: config.headless });
  const page = await browser.newPage();

  try {
    await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });

    const emailField = page.locator('#loginEmail');
    const passwordField = page.locator('#loginPassword');
    const signInButton = page.getByRole('button', { name: /sign in/i });

    await emailField.fill(email);
    await passwordField.fill(password);
    await signInButton.click();

    await page.waitForFunction(
      () => !window.location.pathname.toLowerCase().includes('/account/login'),
      null,
      { timeout: 10 * 60 * 1000 }
    );

    await ensureParentDirectory(config.statePath);
    await page.context().storageState({ path: config.statePath });
    console.log(`[AUTH] Refreshed authenticated session at ${config.statePath}`);
    return true;
  } finally {
    await browser.close();
  }
}