import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';
import { createOpaqueToken } from './tokens.js';
import { env } from '../config/env.js';
import { sendMail, emailConfigured } from './email.js';

const TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

/**
 * Creates a single-use, expiring password setup link and tries to email it.
 * The raw token is never written to logs or audit metadata.
 */
export async function issuePasswordSetup(
  userId: string,
  createdById: string | null,
): Promise<{ url: string; emailed: boolean; token?: string }> {
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
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, firstName: true },
  });

  let emailed = false;
  if (user && emailConfigured()) {
    const result = await sendMail({
      to: user.email,
      subject: 'Set up your clinic account',
      template: 'password_setup',
      text: [
        `Hello ${user.firstName},`,
        '',
        'An account has been created for you at the ultrasound clinic.',
        'Use the link below to choose your password. It expires in 72 hours and can only be used once:',
        url,
        '',
        'If you were not expecting this message, please contact the clinic administrator.',
      ].join('\n'),
    });
    emailed = result.sent;
  }

  return { url, emailed, ...(emailed ? {} : { token }) };
}

export function newTokenFamily(): string {
  return randomUUID();
}
