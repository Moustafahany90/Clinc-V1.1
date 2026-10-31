import type { AuthUser } from './authTypes.js';
import { forbidden } from './errors.js';

/**
 * Clinical records are scoped to the responsible doctor.
 *  - DOCTOR: only rows they own.
 *  - ADMIN: only with an explicit clinical permission (checked by middleware),
 *    never implied by the role.
 *  - RECEPTIONIST: never, regardless of row ownership.
 */
export function assertClinicalRead(user: AuthUser, ownerDoctorId: string): void {
  if (user.role === 'RECEPTIONIST') {
    throw forbidden('Clinical records are not available to reception.');
  }
  if (user.role === 'DOCTOR' && user.id !== ownerDoctorId) {
    throw forbidden('This clinical record belongs to another doctor.');
  }
  if (user.role === 'ADMIN' && !user.permissions.includes('CLINICAL_READ')) {
    throw forbidden('Administrative clinical access has not been granted.');
  }
}

export function assertClinicalWrite(user: AuthUser, ownerDoctorId: string): void {
  if (user.role === 'RECEPTIONIST') {
    throw forbidden('Clinical records are not available to reception.');
  }
  if (user.role === 'DOCTOR' && user.id !== ownerDoctorId) {
    throw forbidden('This clinical record belongs to another doctor.');
  }
  if (user.role === 'ADMIN' && !user.permissions.includes('CLINICAL_WRITE')) {
    throw forbidden('Administrative clinical write access has not been granted.');
  }
  if (!user.permissions.includes('CLINICAL_WRITE')) {
    throw forbidden('This action requires clinical write permission.');
  }
}

/** The doctor id a request should be constrained to, if any. */
export function forcedDoctorId(user: AuthUser): string | undefined {
  return user.role === 'DOCTOR' ? user.id : undefined;
}
