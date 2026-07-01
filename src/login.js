import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';
import { loadConfig } from './config.js';

async function ensureParentDirectory(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function waitForLogin(page) {
  await page.waitForFunction(
    () => !window.location.pathname.toLowerCase().includes('/account/login'),
    null,
    { timeout: 10 * 60 * 1000 }
  );
}

async function maybeAutoLogin(page) {
  const email = process.env.BOOKING_EMAIL || process.env.CIVIC_PERMITS_EMAIL || '';
  const password = process.env.BOOKING_PASSWORD || process.env.CIVIC_PERMITS_PASSWORD || '';

  if (!email || !password) {
    console.log('No BOOKING_EMAIL/BOOKING_PASSWORD provided. Log in manually in the opened browser.');
    return;
  }

  const emailField = page.locator('#loginEmail');
  const passwordField = page.locator('#loginPassword');
  const signInButton = page.getByRole('button', { name: /sign in/i });

  await emailField.fill(email);
  await passwordField.fill(password);
  await signInButton.click();
}

async function main() {
  const config = loadConfig();
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  console.log('Opening login page. Sign in manually; the session will be saved after redirect.');
  await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });
  await maybeAutoLogin(page);
  await waitForLogin(page);
  await ensureParentDirectory(config.statePath);
  await page.context().storageState({ path: config.statePath });
  console.log(`Saved authenticated session to ${config.statePath}`);

  await browser.close();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});