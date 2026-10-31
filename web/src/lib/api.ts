import axios, { AxiosError, type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios';

const baseURL = (import.meta.env.VITE_API_URL as string | undefined)?.trim() || '/api/v1';

let accessToken: string | null = null;
let onSessionExpired: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setSessionExpiredHandler(handler: (() => void) | null): void {
  onSessionExpired = handler;
}

export const api = axios.create({
  baseURL,
  withCredentials: true,
  timeout: 30_000,
});

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (accessToken) {
    config.headers.set('Authorization', `Bearer ${accessToken}`);
  }
  return config;
});

let refreshPromise: Promise<string | null> | null = null;

/** Uses a bare axios call so a failed refresh cannot recurse through the interceptor. */
export async function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = axios
      .post<{ accessToken: string; user: unknown }>(
        `${baseURL}/auth/refresh`,
        {},
        { withCredentials: true, timeout: 20_000 },
      )
      .then((res) => {
        accessToken = res.data.accessToken;
        return accessToken;
      })
      .catch(() => {
        accessToken = null;
        return null;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean };

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as RetriableConfig | undefined;
    const status = error.response?.status;
    const url = config?.url ?? '';
    const isAuthCall = url.includes('/auth/login') || url.includes('/auth/refresh') || url.includes('/auth/password-setup');

    if (status === 401 && config && !config._retried && !isAuthCall) {
      config._retried = true;
      const token = await refreshAccessToken();
      if (token) {
        config.headers.set('Authorization', `Bearer ${token}`);
        return api(config as AxiosRequestConfig);
      }
      setAccessToken(null);
      onSessionExpired?.();
    }

    return Promise.reject(error);
  },
);

export interface ApiFailure {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export function toApiFailure(error: unknown): ApiFailure {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as
      | { error?: { code?: string; message?: string; details?: unknown } }
      | undefined;
    const details = data?.error?.details;
    let message = data?.error?.message ?? error.message ?? 'Request failed';
    if (Array.isArray(details) && details.length > 0) {
      const first = details[0] as { path?: string; message?: string };
      if (first?.message) {
        message = first.path ? `${first.path}: ${first.message}` : first.message;
      }
    }
    return {
      status: error.response?.status ?? 0,
      code: data?.error?.code ?? 'NETWORK',
      message,
      details,
    };
  }
  if (error instanceof Error) {
    return { status: 0, code: 'UNKNOWN', message: error.message };
  }
  return { status: 0, code: 'UNKNOWN', message: 'Something went wrong.' };
}

export function errorMessage(error: unknown): string {
  return toApiFailure(error).message;
}

export function errorDetails(error: unknown): unknown {
  return toApiFailure(error).details;
}

/** Small helper for endpoints that return 204. */
export async function apiDelete(url: string): Promise<void> {
  await api.delete(url);
}

export function apiOrigin(): string {
  if (baseURL.startsWith('http')) return baseURL.replace(/\/api\/v1\/?$/, '');
  return '';
}

/** File URLs still require the bearer token, so downloads go through axios blobs. */
export async function fetchFileBlob(fileId: string): Promise<Blob> {
  const res = await api.get(`/files/${fileId}`, { responseType: 'blob' });
  return res.data as Blob;
}

export async function downloadFile(fileId: string, filename: string): Promise<void> {
  const blob = await fetchFileBlob(fileId);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function csvDownloadUrl(from: string, to: string): string {
  return `${baseURL}/financial-reports/accounting-export/run?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

export async function downloadCsv(from: string, to: string): Promise<void> {
  const res = await api.get('/financial-reports/accounting-export/run', {
    params: { from, to },
    responseType: 'blob',
  });
  const blob = new Blob([res.data as BlobPart], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `accounting-${from}-to-${to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
