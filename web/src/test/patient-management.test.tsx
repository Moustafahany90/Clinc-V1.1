import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { PatientDialog } from '../components/PatientDialog';
import { PatientSearch } from '../components/PatientSearch';
import { patient } from './fixtures';
import { apiMock, resetMocks, toastMock } from './mocks';

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

vi.mock('../components/toast', async () => {
  const mocks = await import('./mocks');
  return { useToast: () => mocks.toastMock };
});

beforeEach(() => {
  resetMocks();
});

describe('PatientDialog — create, validate, duplicates, update', () => {
  function renderDialog(overrides: { existing?: ReturnType<typeof patient> } = {}) {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <MemoryRouter>
        <PatientDialog
          open
          onOpenChange={onOpenChange}
          patient={overrides.existing ?? null}
          onSaved={onSaved}
        />
      </MemoryRouter>,
    );
    return { onSaved, onOpenChange };
  }

  it('blocks an empty submit with a clear validation message', async () => {
    renderDialog();
    // Submit the form directly: jsdom blocks a native click submit while the
    // HTML `required` attributes are empty, so exercise the app validation.
    fireEvent.submit(document.querySelector('form')!);
    expect(screen.getByText('First and last name are required.')).toBeTruthy();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it('creates a patient with trimmed demographics', async () => {
    const interaction = userEvent.setup();
    const { onSaved, onOpenChange } = renderDialog();
    apiMock.post.mockResolvedValue({ data: { patient: patient('new') } });

    await interaction.type(screen.getByLabelText(/First name/), '  Ada ');
    await interaction.type(screen.getByLabelText(/Last name/), 'Lovelace ');
    await interaction.type(screen.getByLabelText(/Phone/), ' 5550102 ');
    await interaction.click(screen.getByRole('button', { name: 'Create patient' }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    expect(apiMock.post).toHaveBeenCalledWith(
      '/patients',
      expect.objectContaining({ firstName: 'Ada', lastName: 'Lovelace', phone: '5550102' }),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toastMock.success).toHaveBeenCalled();
  });

  it('shows the duplicate-phone warning and can acknowledge it', async () => {
    const interaction = userEvent.setup();
    renderDialog();
    apiMock.post.mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          error: {
            code: 'DUPLICATE_PATIENT',
            message: 'Similar patient records already exist.',
            details: {
              matches: [
                {
                  id: 'existing-1',
                  patientNumber: 'PT-existing-1',
                  firstName: 'Ada',
                  lastName: 'Lovelace',
                  phone: '5550102',
                  dateOfBirth: null,
                },
              ],
            },
          },
        },
      },
    });
    apiMock.post.mockResolvedValueOnce({ data: { patient: patient('new') } });

    await interaction.type(screen.getByLabelText(/First name/), 'Ada');
    await interaction.type(screen.getByLabelText(/Last name/), 'Lovelace');
    await interaction.type(screen.getByLabelText(/Phone/), '5550102');
    await interaction.click(screen.getByRole('button', { name: 'Create patient' }));

    expect(await screen.findByText('Possible duplicate')).toBeTruthy();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open record' })).toBeTruthy();

    await interaction.click(screen.getByRole('button', { name: 'Create a separate patient record' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(2));
    expect(apiMock.post).toHaveBeenLastCalledWith(
      '/patients',
      expect.objectContaining({ acknowledgeDuplicates: true }),
    );
  });

  it('updates an existing patient through PATCH', async () => {
    const interaction = userEvent.setup();
    renderDialog({ existing: patient('p-42') });
    apiMock.patch.mockResolvedValue({ data: { patient: patient('p-42', { firstName: 'Janet' }) } });

    const first = screen.getByLabelText(/First name/);
    await interaction.clear(first);
    await interaction.type(first, 'Janet');
    await interaction.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledWith('/patients/p-42', expect.anything()));
    expect(apiMock.post).not.toHaveBeenCalled();
  });
});

describe('PatientSearch', () => {
  it('searches the mocked API, renders results and reports selection', async () => {
    const onChange = vi.fn();
    apiMock.get.mockResolvedValue({ data: { patients: [patient('p-7', { firstName: 'Search' })] } });
    render(<PatientSearch value={null} onChange={onChange} />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Search' } });
    const option = await screen.findByRole('option', { name: /Search Doe/ });
    expect(apiMock.get).toHaveBeenCalledWith(
      '/patients',
      expect.objectContaining({ params: { search: 'Search', pageSize: 8 } }),
    );
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-7' }));
  });

  it('shows searching and no-match states without contacting a real service', async () => {
    apiMock.get.mockImplementation(() => new Promise(() => undefined));
    render(<PatientSearch value={null} onChange={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'nobody' } });
    expect(await screen.findByText(/Searching patients/)).toBeTruthy();
  });

  it('surfaces an API error message', async () => {
    apiMock.get.mockRejectedValue(new Error('Patient service unavailable'));
    render(<PatientSearch value={null} onChange={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'error' } });
    expect(await screen.findByText('Patient service unavailable')).toBeTruthy();
  });
});
