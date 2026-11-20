import { vi } from 'vitest';
import type { AuthUser } from '../lib/types';
import { clinic } from './fixtures';

/**
 * Shared mock instances. Tests configure `authState.user` and the `apiMock.*`
 * functions; the `vi.mock(...)` factories in each test file import this module
 * dynamically so both the factory and the test see the same instances.
 */
export const authState: { user: AuthUser | null; loading: boolean } = {
  user: null,
  loading: false,
};

export function setUser(user: AuthUser | null, loading = false) {
  authState.user = user;
  authState.loading = loading;
}

export const apiMock = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

export const apiHelpers = {
  errorMessage: (err: unknown) => {
    const e = err as { response?: { data?: { error?: { message?: string } } }; message?: string };
    return e?.response?.data?.error?.message ?? e?.message ?? 'Request failed';
  },
  toApiFailure: (err: unknown) => {
    const e = err as {
      response?: { status?: number; data?: { error?: { code?: string; message?: string; details?: unknown } } };
      message?: string;
    };
    return {
      status: e?.response?.status,
      code: e?.response?.data?.error?.code,
      message: e?.response?.data?.error?.message ?? e?.message ?? 'Request failed',
      details: e?.response?.data?.error?.details,
    };
  },
  csvDownloadUrl: () => '/api/v1/financial-reports/accounting-export/run',
  downloadCsv: vi.fn().mockResolvedValue(undefined),
  fetchFileBlob: vi.fn(),
  downloadFile: vi.fn(),
  setAccessToken: vi.fn(),
  getAccessToken: vi.fn(() => null),
  setSessionExpiredHandler: vi.fn(),
  refreshAccessToken: vi.fn().mockResolvedValue(null),
};

export function useAuthValue() {
  const currentUser = authState.user;
  return {
    user: currentUser,
    loading: authState.loading,
    login: vi.fn().mockResolvedValue(currentUser),
    logout: vi.fn().mockResolvedValue(undefined),
    refreshMe: vi.fn().mockResolvedValue(undefined),
    completeSetup: vi.fn(),
    changePassword: vi.fn().mockResolvedValue(undefined),
    hasPermission: (permission: string) => Boolean(currentUser?.permissions?.includes(permission)),
    hasAnyPermission: (...permissions: string[]) =>
      permissions.some((permission) => Boolean(currentUser?.permissions?.includes(permission))),
  };
}

export function can(user: AuthUser | null, permission: string) {
  return Boolean(user?.permissions?.includes(permission));
}

export function useClinicValue() {
  return {
    clinic,
    clinicName: clinic.name,
    timezone: clinic.timezone,
    currency: clinic.currency,
    doctors: [{ id: 'user-doctor', firstName: 'Test', lastName: 'DOCTOR' }],
    services: [
      {
        id: 'svc-1',
        name: 'Ultrasound',
        durationMinutes: 15,
        priceMinor: 20000,
        description: null,
        isActive: true,
      },
    ],
    paymentMethods: [
      { id: 'pm-1', key: 'CASH', label: 'Cash', requiresReference: false, isActive: true, sortOrder: 1 },
      { id: 'pm-2', key: 'BANK', label: 'Bank transfer', requiresReference: true, isActive: true, sortOrder: 2 },
    ],
    expenseCategories: [{ id: 'ec-1', name: 'Supplies', isActive: true }],
    reload: vi.fn().mockResolvedValue(undefined),
    loading: false,
    error: null,
  };
}

export const toastMock = {
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

/** Standard mocks for auth + api; import this module and spread its helpers. */
export function resetMocks() {
  authState.user = null;
  authState.loading = false;
  for (const fn of Object.values(apiMock)) fn.mockReset();
  for (const fn of ['downloadCsv', 'fetchFileBlob', 'downloadFile'] as const) {
    (apiHelpers[fn] as ReturnType<typeof vi.fn>).mockReset();
  }
  apiHelpers.downloadCsv.mockResolvedValue(undefined);
  for (const fn of Object.values(toastMock)) fn.mockReset();
}
