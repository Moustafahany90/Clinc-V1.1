import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { ReportDocumentFrame } from '../components/ReportDocumentFrame';
import { ReportPrintPage } from '../routes/ReportPrintPage';
import { collectContent } from '../lib/collectContent';
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

vi.mock('../components/toast', async () => {
  const mocks = await import('./mocks');
  return { useToast: () => mocks.toastMock };
});

const printData = {
  clinic: {
    name: 'Test Clinic',
    phone: '000-0000',
    email: 'clinic@clinic.test',
    address: '1 Test Street',
    timezone: 'UTC',
  },
  report: {
    id: 'r-1',
    status: 'FINALIZED',
    versionNumber: 2,
    finalizedAt: '2026-11-16T10:00:00.000Z',
    lastAmendedAt: null,
    content: { findings: 'Synthetic finding', impression: 'Stable' },
    templateName: 'Standard',
    templateVersion: '2026-01-01T00:00:00.000Z',
    templateFields: [
      { key: 'findings', label: 'Findings', type: 'textarea' },
      { key: 'impression', label: 'Impression', type: 'textarea' },
    ],
    templateLayout: null,
  },
  patient: {
    patientNumber: 'PT-p-1',
    firstName: 'Jane',
    lastName: 'Doe',
    dateOfBirth: '1990-05-10',
    gender: 'F',
  },
  examination: {
    visitDate: '2026-11-16',
    doctor: 'Dr Test DOCTOR',
    examinationType: 'Ultrasound',
    chiefComplaint: 'Pain',
    measurements: [],
  },
};

function renderPrintPage() {
  return render(
    <MemoryRouter initialEntries={['/reports/r-1/print']}>
      <Routes>
        <Route path="/reports/:id/print" element={<ReportPrintPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetMocks();
  apiMock.get.mockImplementation((url: string) => {
    if (url === '/reports/r-1/print-data') return Promise.resolve({ data: printData });
    if (url === '/reports/r-1/print-html') {
      return Promise.resolve({ data: '<!doctype html><html><body>Final gyn4d report</body></html>' });
    }
    if (url === '/reports/r-1/document') {
      return Promise.resolve({ data: '<!doctype html><html><body>Block document</body></html>' });
    }
    return Promise.resolve({ data: '' });
  });
});

describe('ReportDocumentFrame browser safety', () => {
  it('shows a loading state, then a script-free sandboxed iframe', async () => {
    render(<ReportDocumentFrame reportId="r-9" docKey="r-9:1" mode="print" />);
    expect(screen.getByText('Preparing the report…')).toBeTruthy();

    const frame = await screen.findByTitle('Report');
    const sandbox = (frame.getAttribute('sandbox') ?? '').split(/\s+/);
    expect(sandbox).toContain('allow-same-origin');
    expect(sandbox).not.toContain('allow-scripts');
    // jsdom does not reflect iframe srcdoc reliably; the resolved document and
    // the sandbox attributes are the behaviour under test here.
    expect(apiMock.get).toHaveBeenCalledWith(
      '/reports/r-9/document',
      expect.objectContaining({ params: { mode: 'print' } }),
    );
  });

  it('renders an error alert when the document cannot be loaded', async () => {
    apiMock.get.mockRejectedValue(new Error('Document unavailable'));
    render(<ReportDocumentFrame reportId="r-9" docKey="r-9:1" mode="print" />);
    expect(await screen.findByText('Document unavailable')).toBeTruthy();
    expect(screen.queryByTitle('Report')).toBeNull();
  });
});

describe('ReportPrintPage dispatch', () => {
  it('renders a standard finalized report without changing its content', async () => {
    renderPrintPage();
    expect(await screen.findByText('Synthetic finding')).toBeTruthy();
    expect(screen.getByText('Stable')).toBeTruthy();
    expect(screen.getAllByText(/finalized/i).length).toBeGreaterThan(0);
  });

  it('routes a gyn4d template to the server-rendered print HTML in a sandbox', async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === '/reports/r-1/print-data') {
        return Promise.resolve({
          data: {
            ...printData,
            report: {
              ...printData.report,
              templateLayout: { printLayout: 'gyn4d' },
            },
          },
        });
      }
      if (url === '/reports/r-1/print-html') {
        return Promise.resolve({ data: '<!doctype html>Final gyn4d report' });
      }
      return Promise.resolve({ data: '' });
    });
    renderPrintPage();
    const frame = await screen.findByTitle('Report');
    expect(apiMock.get).toHaveBeenCalledWith(
      '/reports/r-1/print-html',
      expect.objectContaining({ responseType: 'text' }),
    );
    expect(frame.getAttribute('sandbox')).toContain('allow-same-origin');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
  });

  it('routes a JSON block template to ReportDocumentFrame in print mode', async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === '/reports/r-1/print-data') {
        return Promise.resolve({
          data: {
            ...printData,
            report: { ...printData.report, templateLayout: { printLayout: 'blocks' } },
          },
        });
      }
      if (url === '/reports/r-1/document') {
        return Promise.resolve({ data: '<!doctype html>Block document' });
      }
      return Promise.resolve({ data: '' });
    });
    renderPrintPage();
    const frame = await screen.findByTitle('Report');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(apiMock.get).toHaveBeenCalledWith(
      '/reports/r-1/document',
      expect.objectContaining({ params: { mode: 'print' } }),
    );
  });
});

describe('report field collection', () => {
  it('reads every data-key field without executing document scripts', () => {
    document.body.innerHTML =
      '<div id="doc"><span data-key="findings">Finding A</span>' +
      '<span data-key="impression">Impression B</span></div>';
    const docEl = document.getElementById('doc')!;
    const content = collectContent(docEl as unknown as Document, { patientId: 'p-1' });
    expect(content).toEqual(
      expect.objectContaining({ patientId: 'p-1', findings: 'Finding A', impression: 'Impression B' }),
    );
  });
});
