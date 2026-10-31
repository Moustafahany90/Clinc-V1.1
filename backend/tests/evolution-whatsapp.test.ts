import assert from 'node:assert/strict';
import test from 'node:test';

process.env.EVOLUTION_API_ENABLED = 'true';
process.env.EVOLUTION_API_URL = 'http://evolution-mock.test:8080';
process.env.EVOLUTION_API_KEY = 'test-only-evolution-api-key';
process.env.EVOLUTION_INSTANCE_NAME = 'test_clinic';
process.env.EVOLUTION_API_TIMEOUT_MS = '2000';
process.env.EVOLUTION_DEFAULT_COUNTRY_CODE = '20';

const { env } = await import('../src/config/env.js');
const {
  sendWhatsAppDocument,
  toWhatsAppRecipient,
  getEvolutionStatus,
  getEvolutionQrCode,
  disconnectEvolution,
  whatsappConfigured,
  WhatsAppError,
} = await import('../src/lib/whatsapp.js');

test('phone conversion normalizes Egyptian local numbers to international format', () => {
  assert.equal(toWhatsAppRecipient('01012345678'), '201012345678');
  assert.equal(toWhatsAppRecipient('01112345678'), '201112345678');
  assert.equal(toWhatsAppRecipient('01212345678'), '201212345678');
  assert.equal(toWhatsAppRecipient('01512345678'), '201512345678');
  assert.equal(toWhatsAppRecipient('+20 101 234 5678'), '201012345678');
  assert.equal(toWhatsAppRecipient('0020 101 234 5678'), '201012345678');
  assert.equal(toWhatsAppRecipient('123'), null);
  assert.equal(toWhatsAppRecipient(''), null);
  assert.equal(toWhatsAppRecipient(null), null);
  assert.equal(toWhatsAppRecipient(undefined), null);
});

test('whatsappConfigured checks all mandatory Evolution API settings', () => {
  assert.equal(whatsappConfigured(), true);

  const origKey = env.EVOLUTION_API_KEY;
  env.EVOLUTION_API_KEY = '';
  assert.equal(whatsappConfigured(), false);
  env.EVOLUTION_API_KEY = origKey;

  const origEnabled = env.EVOLUTION_API_ENABLED;
  env.EVOLUTION_API_ENABLED = false;
  assert.equal(whatsappConfigured(), false);
  env.EVOLUTION_API_ENABLED = origEnabled;
});

test('getEvolutionStatus parses open, connecting, and close states', async () => {
  const openFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get('apikey'), 'test-only-evolution-api-key');
    return new Response(
      JSON.stringify({ instance: { instanceName: 'test_clinic', state: 'open' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const openStatus = await getEvolutionStatus(openFetch);
  assert.equal(openStatus.configured, true);
  assert.equal(openStatus.state, 'open');
  assert.equal(openStatus.instanceName, 'test_clinic');

  const closeFetch = (async () => {
    return new Response(
      JSON.stringify({ instance: { instanceName: 'test_clinic', state: 'close' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const closeStatus = await getEvolutionStatus(closeFetch);
  assert.equal(closeStatus.state, 'close');

  const notFoundFetch = (async () => {
    return new Response(JSON.stringify({ error: 'Instance not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const notFoundStatus = await getEvolutionStatus(notFoundFetch);
  assert.equal(notFoundStatus.state, 'close');
});

test('getEvolutionStatus throws WHATSAPP_AUTH_FAILED on 401 or 403', async () => {
  const authFailingFetch = (async () => {
    return new Response(JSON.stringify({ error: 'Unauthorized', message: 'Invalid apikey' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  await assert.rejects(
    getEvolutionStatus(authFailingFetch),
    (err: unknown) =>
      err instanceof WhatsAppError &&
      err.code === 'WHATSAPP_AUTH_FAILED' &&
      err.providerStatus === 401,
  );
});

test('getEvolutionQrCode auto-creates instance if 404 and returns QR details', async () => {
  const requests: Array<{ url: string; method?: string; body?: any }> = [];
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null });

    if (url.includes('/instance/connectionState/')) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.includes('/instance/create')) {
      return new Response(
        JSON.stringify({
          instance: { instanceName: 'test_clinic', state: 'close' },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }

    if (url.includes('/instance/connect/')) {
      return new Response(
        JSON.stringify({
          base64: 'data:image/png;base64,mockBase64QrString',
          code: 'mockPairingCode2@...',
          pairingCode: '5555-4444',
          instance: { state: 'connecting' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const qr = await getEvolutionQrCode(mockFetch);
  assert.equal(qr.base64, 'data:image/png;base64,mockBase64QrString');
  assert.equal(qr.code, 'mockPairingCode2@...');
  assert.equal(qr.pairingCode, '5555-4444');
  assert.equal(qr.state, 'connecting');

  assert.equal(requests.length, 3);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[1].method, 'POST');
  assert.equal(requests[1].body?.integration, 'WHATSAPP-BAILEYS');
  assert.equal(requests[1].body?.instanceName, 'test_clinic');
  assert.equal(requests[2].method, 'GET');
});

test('disconnectEvolution calls instance/logout with apikey header', async () => {
  let calledUrl = '';
  let calledKey = '';
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calledUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calledKey = new Headers(init?.headers).get('apikey') ?? '';
    return new Response(
      JSON.stringify({ status: true, response: { message: 'Logged out successfully' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const result = await disconnectEvolution(mockFetch);
  assert.equal(result.success, true);
  assert.ok(calledUrl.endsWith('/instance/logout/test_clinic'));
  assert.equal(calledKey, 'test-only-evolution-api-key');
});

test('sendWhatsAppDocument sends Base64-encoded PDF and returns messageId', async () => {
  let sentPayload: any = null;
  let sentHeaders: Headers | null = null;
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sentHeaders = new Headers(init?.headers);
    sentPayload = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        key: {
          id: 'evo-msg-abc-123',
          remoteJid: '201012345678@s.whatsapp.net',
          fromMe: true,
        },
        messageTimestamp: 1718812345,
        status: 'PENDING',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const pdfBuffer = Buffer.from('%PDF-1.4 Ultrasound Report Test Content');
  const result = await sendWhatsAppDocument(
    {
      to: '201012345678',
      filename: 'report-p101.pdf',
      pdf: pdfBuffer,
      caption: 'Your ultrasound report is ready.',
    },
    mockFetch,
  );

  assert.equal(result.messageId, 'evo-msg-abc-123');
  assert.equal(sentHeaders?.get('apikey'), 'test-only-evolution-api-key');
  assert.equal(sentHeaders?.get('content-type'), 'application/json');
  assert.equal(sentPayload.number, '201012345678');
  assert.equal(sentPayload.mediatype, 'document');
  assert.equal(sentPayload.mimetype, 'application/pdf');
  assert.equal(sentPayload.fileName, 'report-p101.pdf');
  assert.equal(sentPayload.caption, 'Your ultrasound report is ready.');
  assert.equal(
    sentPayload.media,
    `data:application/pdf;base64,${pdfBuffer.toString('base64')}`,
  );
});

test('sendWhatsAppDocument rejects when instance is disconnected', async () => {
  const disconnectedFetch = (async () => {
    return new Response(
      JSON.stringify({
        status: 400,
        message: 'The connection is closed. Please connect the instance first.',
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  await assert.rejects(
    sendWhatsAppDocument(
      {
        to: '201012345678',
        filename: 'report.pdf',
        pdf: Buffer.from('%PDF-1.4\n'),
        caption: 'Report',
      },
      disconnectedFetch,
    ),
    (err: unknown) =>
      err instanceof WhatsAppError &&
      err.code === 'WHATSAPP_INSTANCE_DISCONNECTED' &&
      err.providerStatus === 400,
  );
});

test('sendWhatsAppDocument handles timeouts gracefully without leaking recipient', async () => {
  const timeoutFetch = (async () => {
    const error = new Error('Request timed out');
    error.name = 'TimeoutError';
    throw error;
  }) as typeof fetch;

  await assert.rejects(
    sendWhatsAppDocument(
      {
        to: '201012345678',
        filename: 'report.pdf',
        pdf: Buffer.from('%PDF-1.4\n'),
        caption: 'Report',
      },
      timeoutFetch,
    ),
    (err: unknown) =>
      err instanceof WhatsAppError &&
      err.code === 'WHATSAPP_TIMEOUT' &&
      !err.message.includes('201012345678'),
  );
});

