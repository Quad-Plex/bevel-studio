/** Same zoom, selection cleared: isolates overlay artifacts from mesh artifacts. */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--hide-scrollbars', '--no-first-run'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('http://localhost:4173/?sample=1', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.inspector', { timeout: 60000 });

  await page.keyboard.down('Shift');
  await page.keyboard.press('A');
  await page.keyboard.up('Shift');

  await page.mouse.move(520, 300);
  await page.mouse.wheel({ deltaY: -900 });
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.screenshot({ path: 'renders/zoom-clean.png' });
  console.log('saved renders/zoom-clean.png');
} finally {
  await browser.close();
}
