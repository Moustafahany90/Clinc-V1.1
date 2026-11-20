import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AvailabilityTodayPanel } from '../routes/quick-actions/AvailabilityTodayPanel';
import { user } from './fixtures';
import { apiMock, resetMocks, setUser } from './mocks';

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

const successData = {
  date: '2026-11-17',
  timezone: 'UTC',
  durationMinutes: 15,
  slotIntervalMinutes: 15,
  doctorId: null,
  serviceId: null,
  totalAvailable: 2,
  doctors: [
    {
      doctor: { id: 'user-doctor', firstName: 'Test', lastName: 'DOCTOR' },
      isOpen: true,
      openingHours: { isOpen: true, openMinute: 540, closeMinute: 1020, breakStartMinute: null, breakEndMinute: null, source: 'clinic' },
      availableCount: 2,
      slots: [
        { start: '2026-11-17T09:00:00.000Z', end: '2026-11-17T09:15:00.000Z', minute: 540, available: true },
        { start: '2026-11-17T09:15:00.000Z', end: '2026-11-17T09:30:00.000Z', minute: 555, available: true },
      ],
    },
  ],
};

beforeEach(() => {
  resetMocks();
  setUser(user('ADMIN'));
});

describe('Quick Action loading / error / empty / data states', () => {
  it('shows a loading state while the API is pending', () => {
    apiMock.get.mockImplementation(() => new Promise(() => undefined));
    render(<AvailabilityTodayPanel />);
    expect(screen.getByText("Checking today's availability…")).toBeTruthy();
    expect(apiMock.get).toHaveBeenCalledWith(
      '/quick-actions/availability/today',
      expect.objectContaining({ params: expect.anything() }),
    );
  });

  it('shows a clear error message when the API rejects', async () => {
    apiMock.get.mockRejectedValue(new Error('Network down'));
    render(<AvailabilityTodayPanel />);
    expect(await screen.findByText('Could not retrieve this information')).toBeTruthy();
    expect(screen.getByText('Network down')).toBeTruthy();
  });

  it('shows an empty state when no active doctors exist', async () => {
    apiMock.get.mockResolvedValue({
      data: { ...successData, doctors: [], totalAvailable: 0 },
    });
    render(<AvailabilityTodayPanel />);
    expect(await screen.findByText('No active doctors')).toBeTruthy();
  });

  it('renders availability data after a successful response', async () => {
    apiMock.get.mockResolvedValue({ data: successData });
    render(<AvailabilityTodayPanel />);
    expect(await screen.findByText('Dr Test DOCTOR')).toBeTruthy();
    expect(screen.getByText('Open slots')).toBeTruthy();
    expect(screen.getByText('9:00 AM')).toBeTruthy();
  });

  it('scopes a doctor\'s availability request to their own id', async () => {
    setUser(user('DOCTOR'));
    apiMock.get.mockResolvedValue({ data: { ...successData, doctorId: 'user-doctor' } });
    render(<AvailabilityTodayPanel />);
    expect(await screen.findByText('Dr Test DOCTOR')).toBeTruthy();
    const [, config] = (apiMock.get.mock.calls as unknown as [string, { params: { doctorId?: string } }][]).find(
      ([url]) => url === '/quick-actions/availability/today',
    )!;
    expect(config.params.doctorId).toBe('user-doctor');
    // Doctors do not get the "all doctors" filter control.
    expect(screen.queryByLabelText('Doctor')).toBeNull();
  });

  it('re-fetches when the refresh button is pressed', async () => {
    const interaction = (await import('@testing-library/user-event')).default.setup();
    apiMock.get.mockResolvedValue({ data: successData });
    render(<AvailabilityTodayPanel />);
    expect(await screen.findByText('Dr Test DOCTOR')).toBeTruthy();
    const before = apiMock.get.mock.calls.length;
    await interaction.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(apiMock.get.mock.calls.length).toBeGreaterThan(before);
  });
});
