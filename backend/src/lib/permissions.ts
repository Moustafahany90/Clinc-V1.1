/**
 * Capability model.
 *
 * A role is a starting point, never an authorization decision on its own.
 * Every endpoint checks an explicit permission, and clinical permissions are
 * only ever present when granted deliberately - including for ADMIN.
 */
export const PERMISSIONS = [
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
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_DEFAULT_PERMISSIONS: Record<string, Permission[]> = {
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

/** Permissions that only make sense for clinical staff. */
export const CLINICAL_PERMISSIONS: Permission[] = [
  'CLINICAL_READ',
  'CLINICAL_WRITE',
  'REPORTS_FINALIZE',
  'REPORTS_SEND',
];

export function defaultPermissionsForRole(role: string): Permission[] {
  return [...(ROLE_DEFAULT_PERMISSIONS[role] ?? [])];
}

export function hasPermission(
  user: { permissions: string[] } | null | undefined,
  permission: Permission,
): boolean {
  if (!user) return false;
  return user.permissions.includes(permission);
}

export function hasAnyPermission(
  user: { permissions: string[] } | null | undefined,
  permissions: Permission[],
): boolean {
  return permissions.some((p) => hasPermission(user, p));
}
