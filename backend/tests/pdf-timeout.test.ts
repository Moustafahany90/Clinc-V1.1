import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';

/**
 * Phase 9.1 PDF timeout tests. A short timeout is configured before the
 * renderer module is imported (node:test runs each test file in its own
 * process). The fake page proves the Chromium operation is closed, not merely
 * abandoned by Promise.race.
 */
process.env.PDF_RENDER_TIMEOUT_MS = '1000';
process.env.PDF_MAX_CONCURRENT_RENDERS = '2';
process.env.PDF_MAX_QUEUE_SIZE = '2';

const { HtmlPdfError, closeHtmlPdfBrowser, htmlPdfDiagnostics, renderPageWithTimeout } =
  await import('../src/lib/htmlPdf.js');

interface FakePageOptions {
  closeError?: Error;
  setContentError?: Error;
  hang?: boolean;
}

function fakePage(options: FakePageOptions = {}): { page: Page; closeCalls: () => number } {
  let closeCalls = 0;
  const page = {
    route: async () => undefined,
    setContent: async () => {
      if (options.setContentError) throw options.setContentError;
      if (options.hang) return new Promise<never>(() => undefined);
      return undefined;
    },
    pdf: async () => Buffer.from('%PDF-1.4 fake'),
    close: async () => {
      closeCalls += 1;
      if (options.closeError) throw options.closeError;
    },
  } as unknown as Page;
  return { page, closeCalls: () => closeCalls };
}

test('timeout closes the active page and rejects with PDF_RENDER_TIMEOUT', async () => {
  const { page, closeCalls } = fakePage({ hang: true });
  const started = Date.now();
  await assert.rejects(
    () => renderPageWithTimeout(page, '<html><body>stuck</body></html>', 'A4'),
    (error: unknown) => error instanceof HtmlPdfError && error.code === 'PDF_RENDER_TIMEOUT',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900, `timeout fired too early after ${elapsed} ms`);
  assert.equal(closeCalls(), 1, 'the in-flight Chromium page must be closed');
  assert.deepEqual(htmlPdfDiagnostics(), {
    activeRenders: 0,
    queuedRenders: 0,
    activeContexts: 0,
    browserConnected: false,
  });
});

test('cleanup failure during timeout does not mask the timeout error', async () => {
  const { page, closeCalls } = fakePage({ hang: true, closeError: new Error('close failed') });
  await assert.rejects(
    () => renderPageWithTimeout(page, '<html><body>stuck</body></html>', 'Letter'),
    (error: unknown) => error instanceof HtmlPdfError && error.code === 'PDF_RENDER_TIMEOUT',
  );
  assert.equal(closeCalls(), 1);
  await closeHtmlPdfBrowser();
  await closeHtmlPdfBrowser();
});
