import type { Browser } from 'playwright';

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = import('playwright').then(({ chromium }) =>
      chromium.launch({ args: ['--no-sandbox'] }),
    );
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  const browser = await browserPromise;
  if (!browser.isConnected()) {
    browserPromise = null;
    return getBrowser();
  }
  return browser;
}

/**
 * One Chromium renderer for every HTML-based report design (legacy gyn4d and
 * block templates). JavaScript is off and every non-data request is blocked:
 * the HTML is static and must never reach out to the network while rendering
 * clinical data.
 */
export async function renderHtmlToPdf(
  html: string,
  format: 'Letter' | 'A4' = 'Letter',
): Promise<Buffer> {
  const browser = await getBrowser();
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.route('**/*', (route) =>
      route.request().url().startsWith('data:') ? route.continue() : route.abort(),
    );
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({
      format,
      printBackground: true,
      preferCSSPageSize: true,
    });
    return Buffer.from(pdf);
  } finally {
    await context.close();
  }
}
