/**
 * Verifies the mouse contract in a real browser: right-click removes an edge,
 * the legend is present, middle-drag does not throw.
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--hide-scrollbars', '--no-first-run'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('http://localhost:4173/?sample=1', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.inspector', { timeout: 60000 });

  const count = async () => {
    const text = await page.$eval('.statusbar', (el) => el.textContent ?? '');
    const match = text.match(/(\d+) of (\d+) candidates/);
    return match ? Number(match[1]) : -1;
  };

  const before = await count();
  const points = [
    [350, 240], [450, 200], [600, 250], [800, 300], [950, 280],
    [300, 400], [300, 550], [880, 400], [880, 500], [500, 720],
    [650, 740], [750, 700], [1050, 480], [400, 330], [700, 330],
  ];

  let after = before;
  let hit = null;
  const attempts = [];
  for (const [x, y] of points) {
    await page.mouse.click(x, y, { button: 'right' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    after = await count();
    attempts.push([x, y, after]);
    if (after < before) {
      hit = [x, y];
      break;
    }
  }

  // Left-click on the same edge must put it back.
  let readded = after;
  if (hit) {
    await page.mouse.click(hit[0], hit[1], { button: 'left' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    readded = await count();
  }

  // Middle-drag pan should not throw or select anything.
  await page.screenshot({ path: 'renders/controls-before-pan.png' });
  await page.mouse.move(700, 500);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(780, 560, { steps: 10 });
  await page.mouse.up({ button: 'middle' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.screenshot({ path: 'renders/controls-after-pan.png' });

  const legend = await page.$eval('.hintbar', (el) => el.textContent ?? '');
  const afterPan = await count();
  await page.screenshot({ path: 'renders/controls.png' });

  console.log(JSON.stringify({ before, after, hit, readded, attempts, afterPan, legend, errors }, null, 2));
} finally {
  await browser.close();
}
