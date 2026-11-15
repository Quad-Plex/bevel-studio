/**
 * End-to-end 1M-triangle test in a real browser: uploads the generated STL,
 * waits for the inspector, then screenshots the rendered result.
 *
 *   node tools/e2e-1m.mjs <file.stl>
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';

const file = process.argv[2] ?? join(tmpdir(), 'bevel-bench', 'cube-1m.stl');
const url = 'http://localhost:4173/';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--hide-scrollbars', '--no-first-run'],
  protocolTimeout: 300000,
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.vp-card', { timeout: 30000 });

  const input = await page.$('input[type=file]');
  const started = Date.now();
  await input.uploadFile(file);

  await page.waitForSelector('.inspector', { timeout: 180000 });
  const importMs = Date.now() - started;

  // The loading card stays up until the renderer has built the shaded mesh.
  await page.waitForFunction(() => !document.querySelector('.vp-card'), { timeout: 180000 });
  const renderMs = Date.now() - started;

  await page.screenshot({ path: 'renders/e2e-1m.png' });

  const title = await page.$eval('.inspector-title', (el) => el.textContent);
  const stats = await page.$$eval('.stats dd', (els) => els.map((el) => el.textContent?.trim()));
  console.log(JSON.stringify({ importMs, renderMs, title, stats, errors }, null, 2));
} finally {
  await browser.close();
}
