/**
 * Verifies swept stroke selection: a coarse (fast) left drag must add every
 * edge it crosses, and the same right drag must remove them again.
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('http://localhost:4173/?sample=1', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.inspector', { timeout: 60000 });

  const count = async () => {
    const text = await page.$eval('.statusbar', (el) => el.textContent ?? '');
    const match = text.match(/(\d+) of (\d+) candidates/);
    return match ? Number(match[1]) : -1;
  };

  // Clear the auto-selection.
  await page.keyboard.down('Shift');
  await page.keyboard.press('A');
  await page.keyboard.up('Shift');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const cleared = await count();

  // Coarse left drag along the top ridge: few pointer events, many edges crossed.
  await page.mouse.move(500, 190);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(880, 320, { steps: 1 });
  await page.mouse.up({ button: 'left' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const added = await count();

  // Same path with the right button.
  await page.mouse.move(500, 190);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(880, 320, { steps: 1 });
  await page.mouse.up({ button: 'right' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const removed = await count();

  await page.screenshot({ path: 'renders/stroke.png' });
  console.log(JSON.stringify({ cleared, added, removed, errors }, null, 2));
} finally {
  await browser.close();
}
