import assert from 'node:assert/strict';
import test, { after } from 'node:test';

/**
 * Phase 9.1 PDF resource-control tests against the real shared Chromium
 * renderer. A small timeout is not needed here; the bounded queue is exercised
 * with 10 parallel renders under a cap of 2 and a queue of 2.
 */
process.env.PDF_RENDER_TIMEOUT_MS = '30000';
process.env.PDF_MAX_CONCURRENT_RENDERS = '2';
process.env.PDF_MAX_QUEUE_SIZE = '2';

const { HtmlPdfError, closeHtmlPdfBrowser, htmlPdfDiagnostics, renderHtmlToPdf } =
  await import('../src/lib/htmlPdf.js');

after(async () => {
  await closeHtmlPdfBrowser();
});

function syntheticHtml(rows: number): string {
  const body = Array.from(
    { length: rows },
    (_, index) => `<tr><td>P91-${index}</td><td>synthetic clinic data</td></tr>`,
  ).join('');
  return `<!doctype html><html><body><h1>Phase 9.1 synthetic report</h1><table>${body}</table></body></html>`;
}

test('normal PDF render is unchanged, has sane bytes and cleans up', async () => {
  const pdf = await renderHtmlToPdf(syntheticHtml(10), 'A4');
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(pdf.length > 1_000, `unexpectedly small PDF: ${pdf.length} bytes`);
  assert.deepEqual(
    {
      activeRenders: htmlPdfDiagnostics().activeRenders,
      queuedRenders: htmlPdfDiagnostics().queuedRenders,
      activeContexts: htmlPdfDiagnostics().activeContexts,
    },
    { activeRenders: 0, queuedRenders: 0, activeContexts: 0 },
  );
  assert.equal(htmlPdfDiagnostics().browserConnected, true);
});

test('10 parallel renders hold the cap of 2 and a bounded queue of 2', async () => {
  let maxActiveRenders = 0;
  const monitor = setInterval(() => {
    maxActiveRenders = Math.max(maxActiveRenders, htmlPdfDiagnostics().activeRenders);
  }, 2);
  let results: PromiseSettledResult<Buffer>[];
  try {
    results = await Promise.allSettled(
      Array.from({ length: 10 }, () => renderHtmlToPdf(syntheticHtml(2_000), 'A4')),
    );
  } finally {
    clearInterval(monitor);
  }

  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 4, 'only 2 active + 2 queued renders may be accepted');
  assert.equal(rejected.length, 6, 'excess waiters must fail fast');
  for (const result of rejected) {
    if (result.status === 'rejected') {
      assert.ok(result.reason instanceof HtmlPdfError);
      assert.equal(result.reason.code, 'PDF_RENDER_BUSY');
    }
  }
  for (const result of fulfilled) {
    if (result.status === 'fulfilled') {
      assert.equal(result.value.subarray(0, 5).toString('latin1'), '%PDF-');
      assert.ok(result.value.length > 1_000);
    }
  }
  assert.ok(
    maxActiveRenders <= 2,
    `concurrency cap exceeded: observed ${maxActiveRenders} active renders`,
  );
  assert.deepEqual(
    {
      activeRenders: htmlPdfDiagnostics().activeRenders,
      queuedRenders: htmlPdfDiagnostics().queuedRenders,
      activeContexts: htmlPdfDiagnostics().activeContexts,
    },
    { activeRenders: 0, queuedRenders: 0, activeContexts: 0 },
  );
});

test('repeated close calls are safe and leave no browser connected', async () => {
  await renderHtmlToPdf(syntheticHtml(5), 'Letter');
  assert.equal(htmlPdfDiagnostics().browserConnected, true);
  await closeHtmlPdfBrowser();
  await closeHtmlPdfBrowser();
  assert.equal(htmlPdfDiagnostics().browserConnected, false);
  assert.equal(htmlPdfDiagnostics().activeContexts, 0);
});
