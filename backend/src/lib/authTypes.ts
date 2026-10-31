import type { Role } from '@prisma/client';

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  permissions: string[];
  isActive: boolean;
  mustChangePassword: boolean;
  tokenVersion: number;
}

export const AUTH_USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  permissions: true,
  isActive: true,
  mustChangePassword: true,
  tokenVersion: true,
} as const;

/** Public shape returned to the client - no hashes, no permissions internals. */
export function publicUser(user: AuthUser) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    permissions: user.permissions,
    mustChangePassword: user.mustChangePassword,
  };
}
