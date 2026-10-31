import { env } from '../config/env.js';

export class WhatsAppError extends Error {
  readonly code: string;
  readonly providerStatus?: number;

  constructor(code: string, message: string, providerStatus?: number) {
    super(message);
    this.name = 'WhatsAppError';
    this.code = code;
    this.providerStatus = providerStatus;
  }
}

export function whatsappConfigured(): boolean {
  return Boolean(
    env.EVOLUTION_API_ENABLED &&
      env.EVOLUTION_API_URL &&
      env.EVOLUTION_API_KEY &&
      env.EVOLUTION_INSTANCE_NAME,
  );
}

/**
 * Convert the clinic's local phone format to the international digits-only
 * form required by WhatsApp (Evolution API / Baileys). Egyptian local numbers
 * are 0-prefixed by default (e.g. 010... -> 2010...); numbers that already include
 * a country code are left untouched.
 */
export function toWhatsAppRecipient(
  phone: string | null | undefined,
  defaultCountryCode = env.EVOLUTION_DEFAULT_COUNTRY_CODE || env.WHATSAPP_DEFAULT_COUNTRY_CODE,
): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `${defaultCountryCode}${digits.slice(1)}`;
  if (!/^\d{8,15}$/.test(digits)) return null;
  return digits;
}

export interface SendDocumentInput {
  to: string;
  filename: string;
  pdf: Buffer;
  caption: string;
}

export interface WhatsAppSendResult {
  messageId: string;
  mediaId?: string;
}

export type EvolutionConnectionState = 'open' | 'connecting' | 'close' | 'unconfigured';

export interface EvolutionStatusResult {
  configured: boolean;
  state: EvolutionConnectionState;
  instanceName: string;
}

export interface EvolutionQrResult {
  base64: string | null;
  code: string | null;
  pairingCode: string | null;
  state: EvolutionConnectionState;
}

function evolutionUrl(path: string): string {
  const base = env.EVOLUTION_API_URL.replace(/\/+$/, '');
  const cleanPath = path.replace(/^\/+/, '');
  return `${base}/${cleanPath}`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function evolutionRequest(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(env.EVOLUTION_API_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new WhatsAppError(
      timedOut ? 'WHATSAPP_TIMEOUT' : 'WHATSAPP_NETWORK_ERROR',
      timedOut ? 'WhatsApp service timed out.' : 'WhatsApp service could not be reached.',
    );
  }
}

/**
 * Check the connection status of the clinic's Evolution API instance.
 */
export async function getEvolutionStatus(
  fetchImpl: typeof fetch = fetch,
): Promise<EvolutionStatusResult> {
  if (!whatsappConfigured()) {
    return {
      configured: false,
      state: 'unconfigured',
      instanceName: env.EVOLUTION_INSTANCE_NAME,
    };
  }

  const url = evolutionUrl(`instance/connectionState/${encodeURIComponent(env.EVOLUTION_INSTANCE_NAME)}`);
  const response = await evolutionRequest(fetchImpl, url, {
    method: 'GET',
    headers: {
      apikey: env.EVOLUTION_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new WhatsAppError(
      'WHATSAPP_AUTH_FAILED',
      'Evolution API authentication failed. Verify EVOLUTION_API_KEY.',
      response.status,
    );
  }

  if (response.status === 404) {
    return {
      configured: true,
      state: 'close',
      instanceName: env.EVOLUTION_INSTANCE_NAME,
    };
  }

  const body = (await readJson(response)) as Record<string, unknown> | null;
  const rawState =
    typeof body?.instance === 'object' && body?.instance !== null
      ? (body.instance as Record<string, unknown>).state
      : body?.state;

  const stateStr = typeof rawState === 'string' ? rawState.toLowerCase() : 'close';
  const state: EvolutionConnectionState =
    stateStr === 'open' ? 'open' : stateStr === 'connecting' ? 'connecting' : 'close';

  return {
    configured: true,
    state,
    instanceName: env.EVOLUTION_INSTANCE_NAME,
  };
}

/**
 * Create instance if necessary and fetch the QR code for pairing WhatsApp.
 */
export async function getEvolutionQrCode(
  fetchImpl: typeof fetch = fetch,
): Promise<EvolutionQrResult> {
  if (!whatsappConfigured()) {
    throw new WhatsAppError('WHATSAPP_NOT_CONFIGURED', 'WhatsApp delivery is not configured.');
  }

  const instanceName = env.EVOLUTION_INSTANCE_NAME;

  // 1. Check if instance exists, create if not found
  const checkUrl = evolutionUrl(`instance/connectionState/${encodeURIComponent(instanceName)}`);
  const checkRes = await evolutionRequest(fetchImpl, checkUrl, {
    method: 'GET',
    headers: { apikey: env.EVOLUTION_API_KEY },
  });

  if (checkRes.status === 401 || checkRes.status === 403) {
    throw new WhatsAppError(
      'WHATSAPP_AUTH_FAILED',
      'Evolution API authentication failed. Verify EVOLUTION_API_KEY.',
      checkRes.status,
    );
  }

  if (checkRes.status === 404) {
    const createUrl = evolutionUrl('instance/create');
    const createRes = await evolutionRequest(fetchImpl, createUrl, {
      method: 'POST',
      headers: {
        apikey: env.EVOLUTION_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instanceName,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
      }),
    });

    if (createRes.status === 401 || createRes.status === 403) {
      throw new WhatsAppError(
        'WHATSAPP_AUTH_FAILED',
        'Evolution API authentication failed.',
        createRes.status,
      );
    }

    if (!createRes.ok && createRes.status !== 409) {
      throw new WhatsAppError(
        'WHATSAPP_INSTANCE_CREATE_FAILED',
        'Failed to initialize WhatsApp instance in Evolution API.',
        createRes.status,
      );
    }
  }

  // 2. Request connection / QR code
  const connectUrl = evolutionUrl(`instance/connect/${encodeURIComponent(instanceName)}`);
  const connectRes = await evolutionRequest(fetchImpl, connectUrl, {
    method: 'GET',
    headers: { apikey: env.EVOLUTION_API_KEY },
  });

  if (!connectRes.ok) {
    throw new WhatsAppError(
      'WHATSAPP_CONNECT_FAILED',
      'Failed to obtain WhatsApp QR code from Evolution API.',
      connectRes.status,
    );
  }

  const body = (await readJson(connectRes)) as Record<string, unknown> | null;
  const qrcodeObj =
    typeof body?.qrcode === 'object' && body?.qrcode !== null
      ? (body.qrcode as Record<string, unknown>)
      : null;

  const base64 =
    typeof body?.base64 === 'string'
      ? body.base64
      : typeof qrcodeObj?.base64 === 'string'
        ? qrcodeObj.base64
        : null;

  const code =
    typeof body?.code === 'string'
      ? body.code
      : typeof qrcodeObj?.code === 'string'
        ? qrcodeObj.code
        : null;

  const pairingCode = typeof body?.pairingCode === 'string' ? body.pairingCode : null;

  const rawState =
    typeof body?.instance === 'object' && body?.instance !== null
      ? (body.instance as Record<string, unknown>).state
      : body?.state;
  const stateStr = typeof rawState === 'string' ? rawState.toLowerCase() : 'connecting';
  const state: EvolutionConnectionState =
    stateStr === 'open' ? 'open' : stateStr === 'close' ? 'close' : 'connecting';

  return {
    base64,
    code,
    pairingCode,
    state,
  };
}

/**
 * Disconnect (logout) the active WhatsApp session.
 */
export async function disconnectEvolution(
  fetchImpl: typeof fetch = fetch,
): Promise<{ success: boolean }> {
  if (!whatsappConfigured()) {
    throw new WhatsAppError('WHATSAPP_NOT_CONFIGURED', 'WhatsApp delivery is not configured.');
  }

  const url = evolutionUrl(`instance/logout/${encodeURIComponent(env.EVOLUTION_INSTANCE_NAME)}`);
  const response = await evolutionRequest(fetchImpl, url, {
    method: 'DELETE',
    headers: { apikey: env.EVOLUTION_API_KEY },
  });

  if (response.status === 401 || response.status === 403) {
    throw new WhatsAppError(
      'WHATSAPP_AUTH_FAILED',
      'Evolution API authentication failed.',
      response.status,
    );
  }

  if (!response.ok && response.status !== 404) {
    throw new WhatsAppError(
      'WHATSAPP_DISCONNECT_FAILED',
      'Failed to disconnect WhatsApp session.',
      response.status,
    );
  }

  return { success: true };
}

/**
 * Send a PDF as a WhatsApp document through Evolution API (WHATSAPP-BAILEYS).
 *
 * The PDF buffer is Base64-encoded and transmitted directly to Evolution API.
 * Caller reports and audit logs never persist report binaries or phone numbers.
 */
export async function sendWhatsAppDocument(
  input: SendDocumentInput,
  fetchImpl: typeof fetch = fetch,
): Promise<WhatsAppSendResult> {
  if (!whatsappConfigured()) {
    throw new WhatsAppError('WHATSAPP_NOT_CONFIGURED', 'WhatsApp delivery is not configured.');
  }

  const instanceName = env.EVOLUTION_INSTANCE_NAME;
  const base64Pdf = input.pdf.toString('base64');

  const payload = {
    number: input.to,
    mediatype: 'document',
    mimetype: 'application/pdf',
    caption: input.caption,
    // Evolution API accepts a data URI; including the MIME type avoids the
    // provider having to guess the document type from raw base64.
    media: `data:application/pdf;base64,${base64Pdf}`,
    fileName: input.filename,
  };

  const url = evolutionUrl(`message/sendMedia/${encodeURIComponent(instanceName)}`);
  const response = await evolutionRequest(fetchImpl, url, {
    method: 'POST',
    headers: {
      apikey: env.EVOLUTION_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 401 || response.status === 403) {
    throw new WhatsAppError(
      'WHATSAPP_AUTH_FAILED',
      'Evolution API authentication failed.',
      response.status,
    );
  }

  const body = (await readJson(response)) as Record<string, unknown> | null;

  if (!response.ok) {
    const errorMsg =
      typeof body?.message === 'string'
        ? body.message
        : Array.isArray(body?.message)
          ? body.message.join(', ')
          : '';

    if (
      response.status === 400 &&
      (errorMsg.toLowerCase().includes('not connected') ||
        errorMsg.toLowerCase().includes('close') ||
        errorMsg.toLowerCase().includes('connection'))
    ) {
      throw new WhatsAppError(
        'WHATSAPP_INSTANCE_DISCONNECTED',
        'WhatsApp is disconnected. Scan the QR code in Settings before sending.',
        response.status,
      );
    }

    throw new WhatsAppError(
      'WHATSAPP_MESSAGE_FAILED',
      'WhatsApp did not accept the report message.',
      response.status,
    );
  }

  const responseObj =
    typeof body?.response === 'object' && body?.response !== null
      ? (body.response as Record<string, unknown>)
      : null;

  const keyObj =
    typeof body?.key === 'object' && body?.key !== null
      ? (body.key as Record<string, unknown>)
      : typeof responseObj?.key === 'object' && responseObj?.key !== null
        ? (responseObj.key as Record<string, unknown>)
        : null;

  const messageId =
    (typeof keyObj?.id === 'string' && keyObj.id) ||
    (typeof body?.id === 'string' && body.id) ||
    (typeof body?.messageId === 'string' && body.messageId) ||
    null;

  if (!messageId) {
    throw new WhatsAppError(
      'WHATSAPP_MESSAGE_FAILED',
      'WhatsApp did not return a valid message confirmation ID.',
      response.status,
    );
  }

  return { messageId };
}
