import { PrismaClient } from '@prisma/client';

// Prisma's built-in error/warn lines can include the failing query and bound
// parameters. Operational errors are emitted through lib/logger.ts instead,
// which is allowlist-based and redacts PHI/secrets by default.
export const prisma = new PrismaClient({
  log: [],
});

export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
