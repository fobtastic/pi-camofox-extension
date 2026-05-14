import playwrightPkg from 'playwright';
import { launchOptions } from '@askjo/camofox-browser';

const { firefox } = playwrightPkg;

const proxyUrl = process.env.CAMOFOX_PROXY_URL;
const targetUrl = process.env.WORKABLE_URL;
const resumePath = process.env.RESUME_PATH;
const email = process.env.TEST_EMAIL || 'test@example.com';

if (!proxyUrl) throw new Error('CAMOFOX_PROXY_URL is required');
if (!targetUrl) throw new Error('WORKABLE_URL is required');
if (!resumePath) throw new Error('RESUME_PATH is required');

const parsed = new URL(proxyUrl);
const proxy = {
  server: `${parsed.protocol}//${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`,
  username: decodeURIComponent(parsed.username || ''),
  password: decodeURIComponent(parsed.password || ''),
};

const options = await launchOptions({ headless: true, os: 'windows', humanize: true, enable_cache: true, proxy, geoip: true });
options.proxy = proxy;

const browser = await firefox.launch(options);
const page = await browser.newPage({ viewport: { width: 1400, height: 2000 } });
page.setDefaultTimeout(15000);

try {
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /accept all/i }).click().catch(() => {});
  await page.locator('[name="firstname"]').fill('Test');
  await page.locator('[name="lastname"]').fill('Candidate');
  await page.locator('[name="email"]').fill(email);
  await page.locator('input[type="file"]').first().setInputFiles(resumePath);
  console.log(JSON.stringify({ ok: true, url: page.url() }));
} finally {
  await browser.close();
}
