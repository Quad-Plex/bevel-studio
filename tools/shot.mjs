/**
 * Screenshot helper for visual QA: waits for the app to actually finish its
 * worker round-trip before capturing, which `--virtual-time-budget` cannot do.
 *
 *   node tools/shot.mjs <url> <out.png> [waitSelector]
 */
import puppeteer from 'puppeteer-core';

const [url, out, waitSelector] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node tools/shot.mjs <url> <out.png> [waitSelector]');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: [
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith('DBG')) console.log('[console]', text);
  });
  page.on('pageerror', (error) => console.log('[pageerror]', error.message));

  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  if (waitSelector) await page.waitForSelector(waitSelector, { timeout: 45000 });
  await new Promise((resolve) => setTimeout(resolve, 600));

  await page.screenshot({ path: out });
  console.log('saved', out);
} finally {
  await browser.close();
}
