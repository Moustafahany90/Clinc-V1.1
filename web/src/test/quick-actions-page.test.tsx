import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { QuickActionsPage } from '../routes/quick-actions/QuickActionsPage';
import { ALL_PERMISSIONS_FIXTURE, ROLE_PERMISSIONS, user } from './fixtures';
import { apiMock, resetMocks, setUser, useAuthValue } from './mocks';

vi.mock('../lib/api', async () => {
  const mocks = await import('./mocks');
  return { api: mocks.apiMock, ...mocks.apiHelpers };
});

vi.mock('../lib/auth', async () => {
  const mocks = await import('./mocks');
  return { useAuth: mocks.useAuthValue, can: mocks.can };
});

vi.mock('../lib/clinic', async () => {
  const mocks = await import('./mocks');
  return { useClinic: mocks.useClinicValue };
});

beforeEach(() => {
  resetMocks();
  // Panels only need to reach their loading state; responses are intentionally
  // never resolved so no synthetic fixture shape can make the test flaky.
  apiMock.get.mockImplementation(() => new Promise(() => undefined));
});

const ACTION_LABELS = [
  'Available today',
  "Today's appointments",
  'Weekly availability',
  'Doctor schedule',
  'Next available',
  "Today's revenue",
  'Weekly revenue',
  "Today's expenses",
  'Financial summary',
  'Appointment summary',
  'Queue status',
  'Patients served today',
  'Weekly appointments',
];

function tile(label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}`);
}

describe('Quick Actions permission filtering', () => {
  it('shows all 13 actions to an account with every permission', () => {
    setUser(user('ADMIN', ALL_PERMISSIONS_FIXTURE));
    render(<QuickActionsPage />);
    for (const label of ACTION_LABELS) {
      expect(screen.getByRole('button', { name: tile(label) })).toBeTruthy();
    }
    expect(screen.getByText('Available appointments today')).toBeTruthy();
  });

  it('hides finance actions from receptionist and clinical-only actions from doctor', () => {
    setUser(user('RECEPTIONIST'));
    const receptionist = render(<QuickActionsPage />);
    expect(screen.getByRole('button', { name: tile('Available today') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: tile("Today's revenue") })).toBeNull();
    expect(screen.queryByRole('button', { name: tile('Financial summary') })).toBeNull();
    receptionist.unmount();

    setUser(user('DOCTOR', ROLE_PERMISSIONS.DOCTOR.filter((p) => p !== 'FINANCE_READ')));
    render(<QuickActionsPage />);
    expect(screen.getByRole('button', { name: tile('Available today') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: tile("Today's revenue") })).toBeNull();
  });

  it('swaps the panel when another action is selected', async () => {
    const interaction = userEvent.setup();
    setUser(user('ADMIN', ALL_PERMISSIONS_FIXTURE));
    render(<QuickActionsPage />);
    expect(screen.getByText('Available appointments today')).toBeTruthy();

    await interaction.click(screen.getByRole('button', { name: tile("Today's revenue") }));
    expect(
      screen.getAllByText("Today's revenue").some((el) => el.closest('#quick-action-panel')),
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: tile("Today's revenue") }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('renders an empty state when the account has no matching permissions', () => {
    setUser(user('DOCTOR', []));
    render(<QuickActionsPage />);
    expect(screen.getByText('No quick actions available')).toBeTruthy();
  });
});
