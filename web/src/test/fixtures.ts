import type {
  AuthUser,
  Clinic,
  Patient,
  Appointment,
  PaymentMethod,
  Role,
  Visit,
  Report,
} from '../lib/types';

/** Synthetic data only — no production identifiers or real patient information. */

export function user(role: Role, permissions?: string[]): AuthUser {
  return {
    id: `user-${role.toLowerCase()}`,
    email: `${role.toLowerCase()}@clinic.test`,
    firstName: role === 'DOCTOR' ? 'Test' : 'Ada',
    lastName: role,
    role,
    permissions: permissions === undefined ? ROLE_PERMISSIONS[role] : permissions,
  };
}

export const ROLE_PERMISSIONS: Record<Role, string[]> = {
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

export const ALL_PERMISSIONS_FIXTURE = Array.from(
  new Set(Object.values(ROLE_PERMISSIONS).flat()),
);

export const clinic: Clinic = {
  name: 'Test Clinic',
  legalName: 'Test Clinic LLC',
  phone: '000-0000',
  email: 'clinic@clinic.test',
  address: '1 Test Street',
  timezone: 'UTC',
  currency: 'USD',
  defaultAppointmentMinutes: 15,
  slotIntervalMinutes: 15,
  setupCompletedAt: '2026-01-01T00:00:00.000Z',
};

export function patient(id = 'p-1', overrides: Partial<Patient> = {}): Patient {
  return {
    id,
    patientNumber: `PT-${id}`,
    firstName: 'Jane',
    lastName: 'Doe',
    phone: '5550101',
    referringDoctor: null,
    dateOfBirth: '1990-05-10',
    gender: 'F',
    nationalId: null,
    address: null,
    notes: null,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function appointment(id = 'a-1', overrides: Partial<Appointment> = {}): Appointment {
  return {
    id,
    patientId: 'p-1',
    doctorId: 'user-doctor',
    serviceId: 'svc-1',
    startAt: '2026-11-20T09:00:00.000Z',
    endAt: '2026-11-20T09:15:00.000Z',
    durationMinutes: 15,
    status: 'BOOKED',
    reason: 'Follow-up',
    notes: null,
    cancellationReason: null,
    isManualOverride: false,
    overrideReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    patient: {
      id: 'p-1',
      patientNumber: 'PT-p-1',
      firstName: 'Jane',
      lastName: 'Doe',
      phone: '5550101',
    },
    doctor: { id: 'user-doctor', firstName: 'Test', lastName: 'DOCTOR' },
    ...overrides,
  };
}

export const paymentMethods: PaymentMethod[] = [
  {
    id: 'pm-1',
    key: 'CASH',
    label: 'Cash',
    requiresReference: false,
    isActive: true,
    sortOrder: 1,
  },
  {
    id: 'pm-2',
    key: 'BANK',
    label: 'Bank transfer',
    requiresReference: true,
    isActive: true,
    sortOrder: 2,
  },
  {
    id: 'pm-3',
    key: 'OLD',
    label: 'Legacy',
    requiresReference: false,
    isActive: false,
    sortOrder: 3,
  },
];

export function visit(id = 'v-1', overrides: Partial<Visit> = {}): Visit {
  return {
    id,
    patientId: 'p-1',
    doctorId: 'user-doctor',
    appointmentId: 'a-1',
    visitDate: '2026-11-20',
    status: 'DRAFT',
    chiefComplaint: 'Pain',
    examinationType: 'Ultrasound',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function report(id = 'r-1', overrides: Partial<Report> = {}): Report {
  return {
    id,
    visitId: 'v-1',
    doctorId: 'user-doctor',
    templateId: 't-1',
    serviceId: null,
    status: 'DRAFT',
    versionNumber: 1,
    currentContent: { findings: 'Synthetic finding' },
    finalizedAt: null,
    lastAmendedAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    versions: [],
    files: [],
    visit: {
      ...visit(),
      patient: patient(),
      doctor: { id: 'user-doctor', firstName: 'Test', lastName: 'DOCTOR' },
    },
    ...overrides,
  };
}
