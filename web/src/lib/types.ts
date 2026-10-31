export type Role = 'ADMIN' | 'RECEPTIONIST' | 'DOCTOR';

export type Permission =
  | 'PATIENTS_READ'
  | 'PATIENTS_WRITE'
  | 'APPOINTMENTS_READ'
  | 'APPOINTMENTS_WRITE'
  | 'APPOINTMENTS_OVERRIDE'
  | 'QUEUE_READ'
  | 'QUEUE_WRITE'
  | 'CLINICAL_READ'
  | 'CLINICAL_WRITE'
  | 'REPORTS_FINALIZE'
  | 'REPORTS_SEND'
  | 'VISITS_OVERRIDE'
  | 'PAYMENTS_READ'
  | 'PAYMENTS_WRITE'
  | 'REFUNDS_WRITE'
  | 'EXPENSES_READ'
  | 'EXPENSES_WRITE'
  | 'FINANCE_READ'
  | 'FINANCE_EXPORT'
  | 'USERS_MANAGE'
  | 'SETTINGS_MANAGE'
  | 'AUDIT_READ';

export const ALL_PERMISSIONS: Permission[] = [
  'PATIENTS_READ',
  'PATIENTS_WRITE',
  'APPOINTMENTS_READ',
  'APPOINTMENTS_WRITE',
  'APPOINTMENTS_OVERRIDE',
  'QUEUE_READ',
  'QUEUE_WRITE',
  'CLINICAL_READ',
  'CLINICAL_WRITE',
  'REPORTS_FINALIZE',
  'REPORTS_SEND',
  'VISITS_OVERRIDE',
  'PAYMENTS_READ',
  'PAYMENTS_WRITE',
  'REFUNDS_WRITE',
  'EXPENSES_READ',
  'EXPENSES_WRITE',
  'FINANCE_READ',
  'FINANCE_EXPORT',
  'USERS_MANAGE',
  'SETTINGS_MANAGE',
  'AUDIT_READ',
];

export const CLINICAL_PERMISSIONS: Permission[] = [
  'CLINICAL_READ',
  'CLINICAL_WRITE',
  'REPORTS_FINALIZE',
  'REPORTS_SEND',
];

export const PERMISSION_LABELS: Record<Permission, string> = {
  PATIENTS_READ: 'View patients',
  PATIENTS_WRITE: 'Create and edit patients',
  APPOINTMENTS_READ: 'View appointments',
  APPOINTMENTS_WRITE: 'Book and reschedule appointments',
  APPOINTMENTS_OVERRIDE: 'Override schedule and appointment completion rules',
  QUEUE_READ: 'View waiting queue',
  QUEUE_WRITE: 'Manage waiting queue',
  CLINICAL_READ: 'Read clinical records',
  CLINICAL_WRITE: 'Write clinical records',
  REPORTS_FINALIZE: 'Finalize and amend reports',
  REPORTS_SEND: 'Send finalized reports by WhatsApp',
  VISITS_OVERRIDE: 'Complete a visit without a finalized report',
  PAYMENTS_READ: 'View payments and ledger',
  PAYMENTS_WRITE: 'Record charges and payments',
  REFUNDS_WRITE: 'Issue refunds',
  EXPENSES_READ: 'View expenses',
  EXPENSES_WRITE: 'Record expenses',
  FINANCE_READ: 'View financial reports',
  FINANCE_EXPORT: 'Export accounting data',
  USERS_MANAGE: 'Manage staff accounts',
  SETTINGS_MANAGE: 'Manage clinic settings',
  AUDIT_READ: 'View audit log',
};

export const ROLE_DEFAULT_PERMISSIONS: Record<Role, Permission[]> = {
  ADMIN: [
    'PATIENTS_READ',
    'PATIENTS_WRITE',
    'APPOINTMENTS_READ',
    'APPOINTMENTS_WRITE',
    'APPOINTMENTS_OVERRIDE',
    'QUEUE_READ',
    'QUEUE_WRITE',
    'PAYMENTS_READ',
    'PAYMENTS_WRITE',
    'REFUNDS_WRITE',
    'EXPENSES_READ',
    'EXPENSES_WRITE',
    'FINANCE_READ',
    'FINANCE_EXPORT',
    'USERS_MANAGE',
    'SETTINGS_MANAGE',
    'AUDIT_READ',
    'VISITS_OVERRIDE',
  ],
  RECEPTIONIST: [
    'PATIENTS_READ',
    'PATIENTS_WRITE',
    'APPOINTMENTS_READ',
    'APPOINTMENTS_WRITE',
    'QUEUE_READ',
    'QUEUE_WRITE',
    'PAYMENTS_READ',
    'PAYMENTS_WRITE',
  ],
  DOCTOR: [
    'PATIENTS_READ',
    'APPOINTMENTS_READ',
    'QUEUE_READ',
    'CLINICAL_READ',
    'CLINICAL_WRITE',
    'REPORTS_FINALIZE',
    'REPORTS_SEND',
  ],
};

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Administrator',
  RECEPTIONIST: 'Receptionist',
  DOCTOR: 'Doctor',
};

export type AppointmentStatus =
  | 'BOOKED'
  | 'CONFIRMED'
  | 'ARRIVED'
  | 'WAITING'
  | 'IN_EXAM'
  | 'REPORT_REVIEW'
  | 'DONE'
  | 'CANCELLED'
  | 'NO_SHOW';

export type QueueStatus = 'WAITING' | 'CALLED' | 'IN_EXAM' | 'SKIPPED' | 'DONE';
export type VisitStatus = 'DRAFT' | 'IN_REVIEW' | 'COMPLETED';
export type ReportStatus = 'DRAFT' | 'FINALIZED' | 'AMENDED';

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  permissions: string[];
  phone?: string | null;
  mustChangePassword?: boolean;
  createdAt?: string;
}

export interface Clinic {
  name: string;
  legalName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  timezone: string;
  currency: string;
  defaultAppointmentMinutes: number;
  slotIntervalMinutes: number;
  emailEnabled: boolean;
  emailProvider: 'smtp' | 'graph';
  emailFromAddress: string | null;
  dailyDoctorDigest: boolean;
  digestSendHour: number;
  setupCompletedAt: string | null;
}

export interface Patient {
  id: string;
  patientNumber: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  nationalId: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: { appointments: number };
}

export interface DoctorOption {
  id: string;
  firstName: string;
  lastName: string;
}

export interface Service {
  id: string;
  name: string;
  durationMinutes: number;
  priceMinor: number;
  description: string | null;
  isActive: boolean;
}

export interface PaymentMethod {
  id: string;
  key: string;
  label: string;
  requiresReference: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface ExpenseCategory {
  id: string;
  name: string;
  isActive: boolean;
}

export interface Appointment {
  id: string;
  patientId: string;
  doctorId: string;
  serviceId: string | null;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  status: AppointmentStatus;
  reason: string | null;
  notes: string | null;
  cancellationReason: string | null;
  isManualOverride: boolean;
  overrideReason: string | null;
  createdAt: string;
  patient?: Pick<Patient, 'id' | 'patientNumber' | 'firstName' | 'lastName' | 'phone'>;
  doctor?: DoctorOption;
  service?: Pick<Service, 'id' | 'name' | 'durationMinutes' | 'priceMinor'> | null;
  queueEntry?: { id: string; status: QueueStatus; arrivedAt: string | null } | null;
  visit?: { id: string; status: VisitStatus } | null;
  statusHistory?: AppointmentStatusHistory[];
}

export interface AppointmentStatusHistory {
  id: string;
  fromStatus: AppointmentStatus | null;
  toStatus: AppointmentStatus;
  reason: string | null;
  createdAt: string;
  changedBy?: { id: string; firstName: string; lastName: string } | null;
}

export interface Slot {
  start: string;
  end: string;
  minute: number;
  available: boolean;
  conflictWith?: string;
}

export interface Agenda {
  date: string;
  doctorId: string | null;
  durationMinutes: number;
  slotIntervalMinutes: number;
  openingHours: {
    isOpen: boolean;
    openMinute: number;
    closeMinute: number;
    breakStartMinute: number | null;
    breakEndMinute: number | null;
    source: string;
    reason?: string;
  } | null;
  slots: Slot[];
  appointments: Appointment[];
}

export interface QueueEntry {
  id: string;
  appointmentId: string;
  patientId: string;
  doctorId: string;
  queueDate: string;
  status: QueueStatus;
  position: number | null;
  arrivedAt: string | null;
  calledAt: string | null;
  examStartedAt: string | null;
  examEndedAt: string | null;
  skipReason: string | null;
  waitingSeconds: number | null;
  examSeconds: number | null;
  patient?: Pick<Patient, 'id' | 'patientNumber' | 'firstName' | 'lastName' | 'phone'>;
  doctor?: DoctorOption;
  appointment?: {
    id: string;
    startAt: string;
    endAt: string;
    status: AppointmentStatus;
    service: { name: string } | null;
  };
}

export interface Measurement {
  id: string;
  visitId: string;
  doctorId: string;
  label: string;
  value: string;
  unit: string | null;
  measuredAt: string;
}

export interface FileAsset {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  kind?: string;
}

export interface ReportSummary {
  id: string;
  visitId: string;
  doctorId: string;
  status: ReportStatus;
  versionNumber: number;
  finalizedAt: string | null;
  lastAmendedAt: string | null;
  updatedAt: string;
  visit?: {
    id: string;
    visitDate: string;
    patient: Pick<Patient, 'id' | 'patientNumber' | 'firstName' | 'lastName'>;
  };
}

export interface ReportVersion {
  id: string;
  versionNumber: number;
  isFinal: boolean;
  reason: string | null;
  createdAt: string;
  author: { id: string; firstName: string; lastName: string };
  content?: Record<string, unknown>;
}

export type ReportDeliveryStatus = 'PENDING' | 'SENT' | 'FAILED';

export type EvolutionConnectionState = 'open' | 'connecting' | 'close' | 'unconfigured';

export interface WhatsAppSettingsStatus {
  configured: boolean;
  state: EvolutionConnectionState;
  instanceName: string;
}

export interface WhatsAppConnectResult {
  base64: string | null;
  code: string | null;
  pairingCode: string | null;
  state: EvolutionConnectionState;
}

export interface ReportDelivery {
  id: string;
  reportId: string;
  versionNumber: number;
  channel: 'WHATSAPP';
  status: ReportDeliveryStatus;
  recipientLast4: string;
  provider: string;
  providerMessageId: string | null;
  errorCode: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Report {
  id: string;
  visitId: string;
  doctorId: string;
  templateId: string | null;
  templateVersion?: string | null;
  templateSnapshot?: ReportTemplateSnapshot | null;
  serviceId: string | null;
  status: ReportStatus;
  versionNumber: number;
  currentContent: Record<string, unknown>;
  finalizedAt: string | null;
  lastAmendedAt: string | null;
  updatedAt: string;
  template?: ReportTemplate | null;
  versions: ReportVersion[];
  files: FileAsset[];
  deliveries?: ReportDelivery[];
  visit: Visit & { patient: Patient; doctor: DoctorOption };
}

export interface ReportTemplateField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'date' | 'select';
  required?: boolean;
  visible?: boolean;
  placeholder?: string;
}

export interface ReportTemplateLayout {
  headerNote?: string;
  footerNote?: string;
  showMeasurements?: boolean;
  showSignature?: boolean;
}

export interface ReportTemplateSnapshot {
  id: string;
  name: string;
  description?: string | null;
  fields: ReportTemplateField[];
  layout?: ReportTemplateLayout | null;
  version: string;
}

export interface ReportTemplate {
  id: string;
  name: string;
  description: string | null;
  serviceId: string | null;
  fields: ReportTemplateField[];
  layout?: ReportTemplateLayout | null;
  isActive: boolean;
  isDefault: boolean;
  updatedAt?: string;
  _count?: { reports: number };
}

export interface Visit {
  id: string;
  patientId: string;
  doctorId: string;
  appointmentId: string | null;
  visitDate: string;
  status: VisitStatus;
  chiefComplaint: string | null;
  examinationType: string | null;
  createdAt: string;
  updatedAt: string;
  patient?: Pick<Patient, 'id' | 'patientNumber' | 'firstName' | 'lastName' | 'dateOfBirth'>;
  doctor?: DoctorOption;
  appointment?: { id: string; startAt: string; status: AppointmentStatus } | null;
  reports?: Pick<Report, 'id' | 'status' | 'versionNumber' | 'updatedAt'>[];
  measurements?: Measurement[];
  files?: FileAsset[];
  _count?: { measurements: number; files: number };
}

export interface Charge {
  id: string;
  patientId: string;
  description: string;
  amountMinor: number;
  allocatedMinor?: number;
  balanceMinor?: number;
  status: 'OPEN' | 'SETTLED' | 'VOID';
  createdAt: string;
  service?: { name: string } | null;
  patient?: Pick<Patient, 'id' | 'patientNumber' | 'firstName' | 'lastName'>;
}

export interface Payment {
  id: string;
  patientId: string;
  amountMinor: number;
  methodKey: string;
  reference: string | null;
  notes: string | null;
  status: 'COMPLETED' | 'VOIDED';
  receivedAt: string;
  method?: { key: string; label: string };
  patient?: Pick<Patient, 'id' | 'patientNumber' | 'firstName' | 'lastName'>;
  receivedBy?: DoctorOption;
  allocations?: { chargeId: string; amountMinor: number }[];
  refunds?: { id: string; amountMinor: number; refundedAt: string }[];
  created_at?: string;
}

export interface LedgerSummary {
  chargesMinor: number;
  paymentsMinor: number;
  refundsMinor: number;
  allocatedMinor: number;
  outstandingMinor: number;
  unallocatedMinor: number;
  balanceMinor: number;
}

export interface Ledger {
  patient: Pick<Patient, 'id' | 'patientNumber' | 'firstName' | 'lastName' | 'phone'>;
  summary: LedgerSummary;
  charges: (Charge & { allocatedMinor: number; balanceMinor: number })[];
  payments: {
    id: string;
    amountMinor: number;
    allocatedMinor: number;
    refundedMinor: number;
    unallocatedMinor: number;
    method: string;
    methodKey: string;
    reference: string | null;
    status: string;
    receivedAt: string;
    notes: string | null;
  }[];
  refunds: { id: string; paymentId: string; amountMinor: number; reason: string; refundedAt: string }[];
  timeline: {
    id: string;
    type: 'CHARGE' | 'PAYMENT' | 'REFUND';
    date: string;
    amountMinor: number;
    description: string;
    method?: string;
    reference?: string | null;
    status?: string;
    paymentId?: string;
  }[];
}

export interface Expense {
  id: string;
  expenseDate: string;
  amountMinor: number;
  categoryId: string;
  description: string;
  methodKey: string | null;
  reference: string | null;
  status: 'RECORDED' | 'VOID';
  voidReason: string | null;
  voidedAt: string | null;
  createdAt: string;
  category?: { id: string; name: string };
  method?: { key: string; label: string } | null;
  recordedBy?: DoctorOption;
}

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  patientId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
  actor: { id: string; firstName: string; lastName: string; role: Role } | null;
}

export interface WorkingHours {
  id?: string;
  dayOfWeek: number;
  isOpen: boolean;
  openMinute: number;
  closeMinute: number;
  breakStartMinute: number | null;
  breakEndMinute: number | null;
}

export interface DoctorAvailability {
  id?: string;
  doctorId?: string;
  dayOfWeek: number;
  isWorking: boolean;
  openMinute: number;
  closeMinute: number;
}

export interface ScheduleException {
  id: string;
  date: string;
  doctorId: string | null;
  isClosed: boolean;
  openMinute: number | null;
  closeMinute: number | null;
  reason: string | null;
  doctor?: DoctorOption | null;
}

export interface UserAccount {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  role: Role;
  permissions: string[];
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface DashboardData {
  clinic: { name: string; timezone: string; currency: string };
  date: string;
  role: Role;
  appointments: {
    total: number;
    byStatus: Record<string, number>;
    list: Appointment[];
  };
  queue: { waiting: number; called: number; inExam: number; skipped: number; done: number };
  patientsTotal: number | null;
  finance: {
    collectedTodayMinor: number;
    paymentsToday: number;
    expensesTodayMinor: number;
  } | null;
  clinical: { draftReports: number; openVisits: number } | null;
}
