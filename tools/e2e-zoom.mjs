/** Zoomed screenshot of the rounded hook edge to check overlay artifacts. */
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

  // Trigger a preview through the width slider (keyboard so React sees it).
  await page.focus('input[type=range]');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(
    () => {
      const first = document.querySelector('.stats dd');
      return first && first.textContent && first.textContent.trim() !== '140';
    },
    { timeout: 30000 },
  );

  await page.mouse.move(520, 300);
  await page.mouse.wheel({ deltaY: Number(process.env.ZOOM ?? -900) });
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.screenshot({ path: 'renders/zoom-edge.png' });
  console.log('saved renders/zoom-edge.png');
} finally {
  await browser.close();
}
