import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';
import { createOpaqueToken } from './tokens.js';
import { env } from '../config/env.js';

const TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

/**
 * Creates a single-use, expiring password setup link.
 * The raw token is never written to logs or audit metadata.
 */
export async function issuePasswordSetup(
  userId: string,
  createdById: string | null,
): Promise<{ url: string }> {
  // Invalidate any previous unused links for this user.
  await prisma.passwordSetupToken.updateMany({
    where: { userId, usedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  const { token, tokenHash } = createOpaqueToken();
  await prisma.passwordSetupToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + TTL_MS),
      createdById,
    },
  });

  const url = `${env.APP_ORIGIN.replace(/\/$/, '')}/set-password?token=${encodeURIComponent(token)}`;
  return { url };
}

export function newTokenFamily(): string {
  return randomUUID();
}
