import playwrightPkg from 'playwright';

const { firefox } = playwrightPkg;
const targetUrl = process.env.WORKABLE_URL;
if (!targetUrl) throw new Error('WORKABLE_URL is required');

const browser = await firefox.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 2000 } });
await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: /accept all/i }).click().catch(() => {});
const data = await page.evaluate(() => ({
  title: document.title,
  url: location.href,
  bodyPreview: document.body.innerText.slice(0, 2000),
}));
console.log(JSON.stringify(data, null, 2));
await browser.close();
