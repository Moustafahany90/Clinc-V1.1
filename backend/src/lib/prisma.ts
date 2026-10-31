import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

export const prisma = new PrismaClient({
  log: env.isProduction ? ['error'] : ['warn', 'error'],
});

export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
