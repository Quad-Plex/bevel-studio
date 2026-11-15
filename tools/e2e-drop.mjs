/** Verifies the HTML5 drop path the Tauri shell now forwards to the webview. */
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

  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.vp-card', { timeout: 30000 });

  await page.evaluate(async () => {
    const buffer = await (await fetch('/fixtures/hook-base.stl')).arrayBuffer();
    const file = new File([buffer], 'hook-drop.stl', { type: 'model/stl' });
    const data = new DataTransfer();
    data.items.add(file);
    const target = document.querySelector('.vp');
    target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data }));
  });

  await page.waitForSelector('.inspector', { timeout: 60000 });
  const file = await page.$eval('.topbar-file', (el) => el.textContent);
  console.log(JSON.stringify({ dropped: file, errors }, null, 2));
} finally {
  await browser.close();
}
