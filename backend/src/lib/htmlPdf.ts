import type { Browser, BrowserContext, Page } from 'playwright';
import { env } from '../config/env.js';
import { log } from './logger.js';

/** Clean, typed failures for the PDF renderer's resource controls. */
export class HtmlPdfError extends Error {
  readonly code: 'PDF_RENDER_TIMEOUT' | 'PDF_RENDER_BUSY';

  constructor(code: 'PDF_RENDER_TIMEOUT' | 'PDF_RENDER_BUSY', message: string) {
    super(message);
    this.name = 'HtmlPdfError';
    this.code = code;
  }
}

let browserPromise: Promise<Browser> | null = null;
let browserInstance: Browser | null = null;

// Bounded concurrency: one slot per active render, with a bounded wait queue.
let activeRenders = 0;
let activeContexts = 0;
interface Waiter {
  resolve: () => void;
  reject: (error: HtmlPdfError) => void;
}
const waitQueue: Waiter[] = [];

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
    browserInstance = null;
    return getBrowser();
  }
  browserInstance = browser;
  return browser;
}

/** Close the shared renderer so short-lived processes (tests, scripts) can exit. */
export async function closeHtmlPdfBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  const browser = await pending.catch(() => null);
  if (browser?.isConnected()) await browser.close();
  browserInstance = null;
}

function acquireRenderSlot(): Promise<void> {
  if (activeRenders < env.PDF_MAX_CONCURRENT_RENDERS) {
    activeRenders += 1;
    return Promise.resolve();
  }
  if (waitQueue.length >= env.PDF_MAX_QUEUE_SIZE) {
    return Promise.reject(
      new HtmlPdfError('PDF_RENDER_BUSY', 'The report renderer is busy. Please try again.'),
    );
  }
  return new Promise<void>((resolve, reject) => {
    waitQueue.push({ resolve, reject });
  });
}

function releaseRenderSlot(): void {
  const next = waitQueue.shift();
  if (next) {
    next.resolve();
    return;
  }
  activeRenders -= 1;
}

/** Read-only counters used by the resource-control tests. */
export function htmlPdfDiagnostics(): {
  activeRenders: number;
  queuedRenders: number;
  activeContexts: number;
  browserConnected: boolean;
} {
  return {
    activeRenders,
    queuedRenders: waitQueue.length,
    activeContexts,
    browserConnected: browserInstance?.isConnected() ?? false,
  };
}

/**
 * Render one page with a hard timeout. Closing the page on timeout cancels the
 * in-flight Chromium operation; `Promise.race` alone would only stop waiting.
 */
export async function renderPageWithTimeout(
  page: Page,
  html: string,
  format: 'Letter' | 'A4',
): Promise<Buffer> {
  let timer: NodeJS.Timeout | undefined;
  const render = (async () => {
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
  })();

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void page.close({ runBeforeUnload: false }).catch(() => undefined);
      reject(
        new HtmlPdfError(
          'PDF_RENDER_TIMEOUT',
          `PDF rendering exceeded ${env.PDF_RENDER_TIMEOUT_MS} ms.`,
        ),
      );
    }, env.PDF_RENDER_TIMEOUT_MS);
  });

  try {
    return await Promise.race([render, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  await acquireRenderSlot();
  let context: BrowserContext | null = null;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({ javaScriptEnabled: false });
    activeContexts += 1;
    const page = await context.newPage();
    return await renderPageWithTimeout(page, html, format);
  } finally {
    if (context) {
      try {
        await context.close();
      } catch (cleanupError) {
        // Never mask the render error (or failure) with a cleanup failure.
        log('warn', 'pdf.context_close_failed', {
          error: (cleanupError as Error)?.name ?? 'Error',
        });
      } finally {
        activeContexts -= 1;
      }
    }
    releaseRenderSlot();
  }
}
