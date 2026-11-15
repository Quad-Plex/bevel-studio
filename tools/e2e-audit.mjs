/**
 * Audit check for the worker contract: import through the new transferable
 * edge table, then change a parameter and confirm a preview round-trips.
 *
 *   node tools/e2e-audit.mjs
 * Requires `npm run preview -- --port 4173` to be serving `dist/`.
 */
import puppeteer from 'puppeteer-core';

const url = process.env.PREVIEW_URL ?? 'http://localhost:4173/?sample=1&audit=1';
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--hide-scrollbars'],
});

const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.inspector', { timeout: 45000 });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const before = await page.$eval('.stats', (element) => element.textContent ?? '');
  const slider = await page.$('input[type=range]');
  if (!slider) throw new Error('No slider found');
  await slider.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const after = await page.$eval('.stats', (element) => element.textContent ?? '');
  await page.screenshot({ path: 'renders/audit-preview.png' });

  console.log('before:', before.replace(/\s+/g, ' ').trim());
  console.log('after: ', after.replace(/\s+/g, ' ').trim());
  console.log('preview changed stats:', before !== after);
  console.log('page errors:', errors.length ? errors : 'none');
  if (before === after) process.exitCode = 1;
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
