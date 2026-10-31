import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './lib/api';
import { AuthProvider } from './lib/auth';
import { ClinicProvider } from './lib/clinic';
import { ToastProvider } from './components/toast';
import { AppShell } from './components/AppShell';
import { AuthLoading, RedirectIfAuthed, RequireAuth, RequirePermission } from './components/guards';
import { AccountPage } from './routes/AccountPage';
import { AgendaPage } from './routes/AgendaPage';
import { AuditPage } from './routes/AuditPage';
import { DashboardPage } from './routes/DashboardPage';
import { ExpensesPage } from './routes/ExpensesPage';
import { FinanceBillPrintPage } from './routes/FinanceBillPrintPage';
import { FinancePage } from './routes/FinancePage';
import { LoginPage } from './routes/LoginPage';
import { NotFoundPage } from './routes/NotFoundPage';
import { PatientDetailPage } from './routes/PatientDetailPage';
import { PatientsPage } from './routes/PatientsPage';
import { PaymentsPage } from './routes/PaymentsPage';
import { QueuePage } from './routes/QueuePage';
import { ReportEditorPage } from './routes/ReportEditorPage';
import { ReportPrintPage } from './routes/ReportPrintPage';
import { ReportsPage } from './routes/ReportsPage';
import { SetPasswordPage } from './routes/SetPasswordPage';
import { SettingsPage } from './routes/SettingsPage';
import { SetupPage } from './routes/SetupPage';
import { UsersPage } from './routes/UsersPage';
import { VisitDetailPage } from './routes/VisitDetailPage';
import { VisitsPage } from './routes/VisitsPage';

interface SetupStatus {
  setupRequired: boolean;
  hasAnyUser: boolean;
  emailConfigured: boolean;
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
        if (active) setStatus({ setupRequired: false, hasAnyUser: true, emailConfigured: false });
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
