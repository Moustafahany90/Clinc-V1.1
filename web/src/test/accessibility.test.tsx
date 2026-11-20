import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { Field, Table, THead, TBody, TR, TH, TD } from '../components/ui';
import { PatientSearch } from '../components/PatientSearch';
import { patient } from './fixtures';
import { apiMock, resetMocks } from './mocks';

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
});

describe('accessible form fields', () => {
  it('associates hint and error text with the control and marks invalid fields', () => {
    render(
      <Field label="Phone" hint="Used to find duplicates." error="Phone number is required." htmlFor="phone">
        <input id="phone" />
      </Field>,
    );
    const input = screen.getByLabelText(/Phone/);
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy!);
    expect(description?.textContent).toContain('Phone number is required.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('associates hint text when there is no error', () => {
    render(
      <Field label="Notes" hint="Administrative only." htmlFor="notes">
        <input id="notes" />
      </Field>,
    );
    const input = screen.getByLabelText('Notes');
    const description = document.getElementById(input.getAttribute('aria-describedby')!);
    expect(description?.textContent).toContain('Administrative only.');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });
});

describe('keyboard access to interactive table rows', () => {
  it('focuses a clickable row and activates it with Enter without double-firing links', () => {
    const onClick = vi.fn();
    render(
      <MemoryRouter>
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
            </TR>
          </THead>
          <TBody>
            <TR interactive onClick={onClick}>
              <TD>
                <a href="/patients/p-1">Jane Doe</a>
              </TD>
            </TR>
          </TBody>
        </Table>
      </MemoryRouter>,
    );
    const row = screen.getByText('Jane Doe').closest('tr')!;
    expect(row.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('patient combobox keyboard navigation', () => {
  it('exposes active options via aria-activedescendant and selects with Enter', async () => {
    apiMock.get.mockResolvedValue({
      data: { patients: [patient('p-1'), patient('p-2', { firstName: 'John' })] },
    });
    const onChange = vi.fn();
    render(<PatientSearch value={null} onChange={onChange} />);
    const input = screen.getByRole('combobox');

    fireEvent.change(input, { target: { value: 'Do' } });
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0].getAttribute('id')).toBeTruthy();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].getAttribute('id'));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1].getAttribute('id'));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ firstName: 'John' }));
  });

  it('closes the list on Escape', async () => {
    apiMock.get.mockResolvedValue({ data: { patients: [patient('p-1')] } });
    render(<PatientSearch value={null} onChange={vi.fn()} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Ja' } });
    await screen.findAllByRole('option');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });
});
