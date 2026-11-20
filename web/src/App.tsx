import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './lib/api';
import { AuthProvider } from './lib/auth';
import { ClinicProvider } from './lib/clinic';
import { ToastProvider } from './components/toast';
import { AppShell } from './components/AppShell';
import {
  AuthLoading,
  PageLoading,
  RedirectIfAuthed,
  RequireAuth,
  RequirePermission,
} from './components/guards';
import { AgendaPage } from './routes/AgendaPage';
import { DashboardPage } from './routes/DashboardPage';
import { ExpensesPage } from './routes/ExpensesPage';
import { FinancePage } from './routes/FinancePage';
import { LoginPage } from './routes/LoginPage';
import { NotFoundPage } from './routes/NotFoundPage';
import { PatientDetailPage } from './routes/PatientDetailPage';
import { PatientsPage } from './routes/PatientsPage';
import { PaymentsPage } from './routes/PaymentsPage';
import { QueuePage } from './routes/QueuePage';
import { QuickActionsPage } from './routes/quick-actions/QuickActionsPage';

// Heavy, less frequently used screens are loaded on demand so the daily
// workspace (dashboard, agenda, patients, finance lists) stays in the main
// chunk. Every chunk is still gated by the same RequireAuth/RequirePermission
// wrappers below.
const AccountPage = lazy(() => import('./routes/AccountPage').then((m) => ({ default: m.AccountPage })));
const AuditPage = lazy(() => import('./routes/AuditPage').then((m) => ({ default: m.AuditPage })));
const FinanceBillPrintPage = lazy(() =>
  import('./routes/FinanceBillPrintPage').then((m) => ({ default: m.FinanceBillPrintPage })),
);
const ReportEditorPage = lazy(() =>
  import('./routes/ReportEditorPage').then((m) => ({ default: m.ReportEditorPage })),
);
const ReportPrintPage = lazy(() =>
  import('./routes/ReportPrintPage').then((m) => ({ default: m.ReportPrintPage })),
);
const ReportsPage = lazy(() => import('./routes/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const SetPasswordPage = lazy(() =>
  import('./routes/SetPasswordPage').then((m) => ({ default: m.SetPasswordPage })),
);
// SettingsPage pulls in the large block-template editors (ReportTemplatesCard).
const SettingsPage = lazy(() => import('./routes/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const SetupPage = lazy(() => import('./routes/SetupPage').then((m) => ({ default: m.SetupPage })));
const UsersPage = lazy(() => import('./routes/UsersPage').then((m) => ({ default: m.UsersPage })));
const VisitDetailPage = lazy(() =>
  import('./routes/VisitDetailPage').then((m) => ({ default: m.VisitDetailPage })),
);
const VisitsPage = lazy(() => import('./routes/VisitsPage').then((m) => ({ default: m.VisitsPage })));

interface SetupStatus {
  setupRequired: boolean;
  hasAnyUser: boolean;
}

function AppRoutes() {
  const location = useLocation();
  const [status, setStatus] = useState<SetupStatus | null>(null);

  useEffect(() => {
    let active = true;
    api
      .get<SetupStatus>('/setup/status')
      .then((res) => {
        if (active) setStatus(res.data);
      })
      .catch(() => {
        // If the backend is unreachable, let the normal auth flow surface it.
        if (active) setStatus({ setupRequired: false, hasAnyUser: true });
      });
    return () => {
      active = false;
    };
  }, []);

  if (!status) return <AuthLoading />;

  const onSetup = location.pathname === '/setup';
  const onSetPassword = location.pathname === '/set-password';

  // Until the first administrator exists, everything else is redirected to the
  // setup wizard. Password links stay reachable so invited staff are not locked out.
  if (status.setupRequired && !onSetup && !onSetPassword) {
    return <Navigate to="/setup" replace />;
  }

  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route
          path="/setup"
        element={
          <SetupPage
            onComplete={() => setStatus((prev) => (prev ? { ...prev, setupRequired: false } : prev))}
          />
        }
      />
      <Route
        path="/login"
        element={
          <RedirectIfAuthed>
            <LoginPage />
          </RedirectIfAuthed>
        }
      />
      <Route path="/set-password" element={<SetPasswordPage />} />

      <Route
        path="/reports/:id/print"
        element={
          <RequireAuth>
            <RequirePermission anyOf={['CLINICAL_READ']}>
              <ReportPrintPage />
            </RequirePermission>
          </RequireAuth>
        }
      />

      <Route
        path="/finance/print"
        element={
          <RequireAuth>
            <RequirePermission anyOf={['FINANCE_READ', 'FINANCE_EXPORT']}>
              <FinanceBillPrintPage />
            </RequirePermission>
          </RequireAuth>
        }
      />

      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route
          path="/agenda"
          element={
            <RequirePermission permission="APPOINTMENTS_READ">
              <AgendaPage />
            </RequirePermission>
          }
        />
        <Route
          path="/quick-actions"
          element={
            <RequirePermission
              anyOf={['APPOINTMENTS_READ', 'PAYMENTS_READ', 'EXPENSES_READ', 'FINANCE_READ']}
            >
              <QuickActionsPage />
            </RequirePermission>
          }
        />
        <Route
          path="/queue"
          element={
            <RequirePermission permission="QUEUE_READ">
              <QueuePage />
            </RequirePermission>
          }
        />
        <Route
          path="/patients"
          element={
            <RequirePermission permission="PATIENTS_READ">
              <PatientsPage />
            </RequirePermission>
          }
        />
        <Route
          path="/patients/:id"
          element={
            <RequirePermission permission="PATIENTS_READ">
              <PatientDetailPage />
            </RequirePermission>
          }
        />
        <Route
          path="/visits"
          element={
            <RequirePermission permission="CLINICAL_READ">
              <VisitsPage />
            </RequirePermission>
          }
        />
        <Route
          path="/visits/:id"
          element={
            <RequirePermission permission="CLINICAL_READ">
              <VisitDetailPage />
            </RequirePermission>
          }
        />
        <Route
          path="/reports"
          element={
            <RequirePermission permission="CLINICAL_READ">
              <ReportsPage />
            </RequirePermission>
          }
        />
        <Route
          path="/reports/new"
          element={
            <RequirePermission permission="CLINICAL_WRITE">
              <ReportEditorPage />
            </RequirePermission>
          }
        />
        <Route
          path="/reports/:id"
          element={
            <RequirePermission permission="CLINICAL_READ">
              <ReportEditorPage />
            </RequirePermission>
          }
        />
        <Route
          path="/payments"
          element={
            <RequirePermission permission="PAYMENTS_READ">
              <PaymentsPage />
            </RequirePermission>
          }
        />
        <Route
          path="/expenses"
          element={
            <RequirePermission anyOf={['EXPENSES_READ', 'FINANCE_READ']}>
              <ExpensesPage />
            </RequirePermission>
          }
        />
        <Route
          path="/finance"
          element={
            <RequirePermission permission="FINANCE_READ">
              <FinancePage />
            </RequirePermission>
          }
        />
        <Route
          path="/users"
          element={
            <RequirePermission permission="USERS_MANAGE">
              <UsersPage />
            </RequirePermission>
          }
        />
        <Route
          path="/settings"
          element={
            <RequirePermission permission="SETTINGS_MANAGE">
              <SettingsPage />
            </RequirePermission>
          }
        />
        <Route
          path="/audit"
          element={
            <RequirePermission permission="AUDIT_READ">
              <AuditPage />
            </RequirePermission>
          }
        />
        <Route path="/account" element={<AccountPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      </Routes>
    </Suspense>
  );
}

export function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <ClinicProvider>
          <AppRoutes />
        </ClinicProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
