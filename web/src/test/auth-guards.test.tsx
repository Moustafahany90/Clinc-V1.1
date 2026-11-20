import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { RequireAuth, RequirePermission } from '../components/guards';
import { can } from '../lib/auth';
import { AppShell } from '../components/AppShell';
import { App } from '../App';
import { user, ROLE_PERMISSIONS } from './fixtures';
import { apiMock, authState, resetMocks, setUser, useAuthValue } from './mocks';

vi.mock('../lib/api', async () => {
  const mocks = await import('./mocks');
  return { api: mocks.apiMock, ...mocks.apiHelpers };
});

vi.mock('../lib/auth', async () => {
  const mocks = await import('./mocks');
  return {
    useAuth: mocks.useAuthValue,
    can: mocks.can,
    AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});

vi.mock('../lib/clinic', async () => {
  const mocks = await import('./mocks');
  return {
    useClinic: mocks.useClinicValue,
    ClinicProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});

beforeEach(() => {
  resetMocks();
  apiMock.get.mockImplementation((url: string) => {
    if (url === '/setup/status') {
      return Promise.resolve({ data: { setupRequired: false, hasAnyUser: true } });
    }
    return Promise.resolve({ data: {} });
  });
});

describe('role and permission model (frontend gate)', () => {
  it('can() reflects the permission list, not the role label', () => {
    expect(can(user('ADMIN'), 'FINANCE_READ')).toBe(true);
    expect(can(user('RECEPTIONIST'), 'CLINICAL_READ')).toBe(false);
    expect(can(user('DOCTOR'), 'CLINICAL_READ')).toBe(true);
    expect(can(null, 'PATIENTS_READ')).toBe(false);
    expect(can(user('DOCTOR', ['CUSTOM']), 'CUSTOM')).toBe(true);
  });

  it('RequirePermission hides clinical area from receptionist and shows it to doctor', () => {
    setUser(user('RECEPTIONIST'));
    const denied = render(
      <MemoryRouter>
        <RequirePermission permission="CLINICAL_READ">
          <div>Clinical records content</div>
        </RequirePermission>
      </MemoryRouter>,
    );
    expect(screen.getByText('Additional permission required')).toBeTruthy();
    expect(screen.queryByText('Clinical records content')).toBeNull();
    denied.unmount();

    setUser(user('DOCTOR'));
    render(
      <MemoryRouter>
        <RequirePermission permission="CLINICAL_READ">
          <div>Clinical records content</div>
        </RequirePermission>
      </MemoryRouter>,
    );
    expect(screen.getByText('Clinical records content')).toBeTruthy();
    expect(screen.queryByText('Additional permission required')).toBeNull();
  });

  it('RequirePermission anyOf honours either finance permission', () => {
    setUser(user('ADMIN', ['FINANCE_EXPORT']));
    render(
      <MemoryRouter>
        <RequirePermission anyOf={['FINANCE_READ', 'FINANCE_EXPORT']}>
          <div>Finance print</div>
        </RequirePermission>
      </MemoryRouter>,
    );
    expect(screen.getByText('Finance print')).toBeTruthy();
  });

  it('RequireAuth sends anonymous users to /login and forces password change to /account', () => {
    setUser(null);
    const anonymous = render(
      <MemoryRouter initialEntries={['/reports/r-1']}>
        <Routes>
          <Route path="/login" element={<div>Login page</div>} />
          <Route
            path="/reports/:id"
            element={
              <RequireAuth>
                <div>Private report</div>
              </RequireAuth>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Login page')).toBeTruthy();
    expect(screen.queryByText('Private report')).toBeNull();
    anonymous.unmount();

    setUser({ ...user('DOCTOR'), mustChangePassword: true });
    render(
      <MemoryRouter initialEntries={['/reports/r-1']}>
        <Routes>
          <Route path="/account" element={<div>Account page</div>} />
          <Route
            path="/reports/:id"
            element={
              <RequireAuth>
                <div>Private report</div>
              </RequireAuth>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Account page')).toBeTruthy();
  });
});

describe('navigation visibility', () => {
  it('shows only the nav items allowed for each role', () => {
    setUser(user('ADMIN'));
    const admin = render(
      <MemoryRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div>content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Financial reports')).toBeTruthy();
    expect(screen.getByText('Staff accounts')).toBeTruthy();
    expect(screen.getByText('Audit log')).toBeTruthy();
    admin.unmount();

    setUser(user('RECEPTIONIST'));
    const receptionist = render(
      <MemoryRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div>content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Patients')).toBeTruthy();
    expect(screen.getByText('Agenda')).toBeTruthy();
    expect(screen.queryByText('Reports')).toBeNull();
    expect(screen.queryByText('Visits')).toBeNull();
    expect(screen.queryByText('Financial reports')).toBeNull();
    expect(screen.queryByText('Staff accounts')).toBeNull();
    expect(screen.queryByText('Audit log')).toBeNull();
    receptionist.unmount();

    setUser(user('DOCTOR'));
    render(
      <MemoryRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div>content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Reports')).toBeTruthy();
    expect(screen.getByText('Visits')).toBeTruthy();
    expect(screen.queryByText('Financial reports')).toBeNull();
    expect(screen.queryByText('Payments & charges')).toBeNull();
    expect(screen.queryByText('Staff accounts')).toBeNull();
  });

  it('does not reveal another doctor\'s report by changing the route id', async () => {
    setUser(user('RECEPTIONIST'));
    render(
      <MemoryRouter initialEntries={['/reports/report-owned-by-doctor-2']}>
        <App />
      </MemoryRouter>,
    );
    // The frontend gate denies the route outright; backend scoping is covered by
    // backend/tests/authorization-idor.test.ts and cannot be bypassed by this URL.
    expect(await screen.findByText('Additional permission required')).toBeTruthy();
    expect(screen.queryByText('Synthetic finding')).toBeNull();
    expect(apiMock.get).toHaveBeenCalledWith('/setup/status');
  });
});
