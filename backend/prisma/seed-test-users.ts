/**
 * Seeds or updates development & testing user accounts across all roles.
 *
 * The password is never hard-coded or committed. Supply it through the
 * environment; each run generates a fresh scrypt hash:
 *
 *   SEED_TEST_PASSWORD='<strong local password>' npm run seed:test-users
 *   SEED_TEMP_PASSWORD='<strong local password>' npm run seed:test-users
 *
 * Refuses to run when NODE_ENV=production unless ALLOW_TEST_SEED=true. This
 * command is for local development and CI only; never seed shared clinic data.
 */

import { prisma } from '../src/lib/prisma.js';
import { checkPasswordStrength, hashPassword } from '../src/lib/password.js';
import { defaultPermissionsForRole } from '../src/lib/permissions.js';
import { ensureDefaults } from '../src/lib/defaults.js';

const testPassword = process.env.SEED_TEST_PASSWORD ?? '';
const tempPassword = process.env.SEED_TEMP_PASSWORD ?? '';

if (!testPassword || !tempPassword) {
  throw new Error(
    'SEED_TEST_PASSWORD and SEED_TEMP_PASSWORD are required. Passwords are never committed; export them for this command only.',
  );
}
const strength = checkPasswordStrength(testPassword);
if (!strength.ok) {
  throw new Error(strength.message ?? 'SEED_TEST_PASSWORD is too weak.');
}
const tempStrength = checkPasswordStrength(tempPassword);
if (!tempStrength.ok) {
  throw new Error(tempStrength.message ?? 'SEED_TEMP_PASSWORD is too weak.');
}
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_TEST_SEED !== 'true') {
  throw new Error('Refusing to seed test accounts in production.');
}

export const TEST_USERS = [
  {
    email: 'admin@ultrasound.clinic',
    firstName: 'Amina',
    lastName: 'Hassan',
    phone: '+20 100 123 4567',
    role: 'ADMIN' as const,
    permissions: defaultPermissionsForRole('ADMIN'),
    mustChangePassword: false,
    password: testPassword,
  },
  {
    email: 'doctor@ultrasound.clinic',
    firstName: 'Youssef',
    lastName: 'Kamal',
    phone: '+20 100 345 6789',
    role: 'DOCTOR' as const,
    permissions: defaultPermissionsForRole('DOCTOR'),
    mustChangePassword: false,
    password: testPassword,
  },
  {
    email: 'doctor2@ultrasound.clinic',
    firstName: 'Mariam',
    lastName: 'Farouk',
    phone: '+20 100 456 7890',
    role: 'DOCTOR' as const,
    permissions: defaultPermissionsForRole('DOCTOR'),
    mustChangePassword: false,
    password: testPassword,
  },
  {
    email: 'reception@ultrasound.clinic',
    firstName: 'Nour',
    lastName: 'Reception',
    phone: '+20 100 234 5678',
    role: 'RECEPTIONIST' as const,
    permissions: defaultPermissionsForRole('RECEPTIONIST'),
    mustChangePassword: false,
    password: testPassword,
  },
  {
    email: 'temp.user@ultrasound.clinic',
    firstName: 'Tarek',
    lastName: 'Ibrahim',
    phone: '+20 100 567 8901',
    role: 'RECEPTIONIST' as const,
    permissions: defaultPermissionsForRole('RECEPTIONIST'),
    mustChangePassword: true,
    password: tempPassword,
  },
];

export async function seedTestUsers(): Promise<void> {
  await ensureDefaults();

  // Ensure clinic settings record exists
  const clinic = await prisma.clinicSettings.findFirst();
  if (!clinic) {
    await prisma.clinicSettings.create({
      data: {
        id: 1,
        name: 'Ultrasound Clinic',
        timezone: 'Africa/Cairo',
        currency: 'EGP',
        defaultAppointmentMinutes: 15,
        slotIntervalMinutes: 15,
      },
    });
  }

  const standardHash = await hashPassword(testPassword);
  const tempHash = await hashPassword(tempPassword);

  console.log('\n======================================================');
  console.log('Seeding / Updating Test Users for All Roles:');
  console.log('======================================================');

  for (const u of TEST_USERS) {
    const passwordHash = u.mustChangePassword ? tempHash : standardHash;
    const record = await prisma.user.upsert({
      where: { email: u.email },
      create: {
        email: u.email,
        passwordHash,
        firstName: u.firstName,
        lastName: u.lastName,
        phone: u.phone,
        role: u.role,
        permissions: u.permissions,
        mustChangePassword: u.mustChangePassword,
        isActive: true,
      },
      update: {
        passwordHash,
        firstName: u.firstName,
        lastName: u.lastName,
        phone: u.phone,
        role: u.role,
        permissions: u.permissions,
        mustChangePassword: u.mustChangePassword,
        isActive: true,
        lockedUntil: null,
        failedLoginCount: 0,
        tokenVersion: { increment: 1 },
      },
    });

    console.log(
      `[${record.role.padEnd(12)}] ${record.email.padEnd(30)} | mustChangePassword: ${record.mustChangePassword}`,
    );
  }

  console.log('======================================================\n');
}

async function main() {
  await seedTestUsers();
}

if (process.argv[1]?.endsWith('seed-test-users.ts') || process.argv[1]?.endsWith('seed-test-users.js')) {
  main()
    .catch((err) => {
      console.error('Failed to seed test users:', err instanceof Error ? err.message : err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
