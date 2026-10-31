import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

interface AuditInput {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  patientId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

let auditWriteFailures = 0;
let lastAuditFailureAt: string | null = null;

/**
 * Append-only audit trail. Never include secrets, tokens, passwords or full
 * report bodies in `metadata`.
 */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        patientId: input.patientId ?? null,
        metadata: input.metadata,
        ip: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, 400) ?? null,
      },
    });
  } catch (err) {
    // An audit write failure must not roll back the clinical action, but it
    // must be observable. Emit one structured line for the log shipper and
    // expose the counter on the health endpoint.
    auditWriteFailures += 1;
    lastAuditFailureAt = new Date().toISOString();
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'audit.write_failed',
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        requestId: input.requestId ?? null,
        error: (err as Error).name || 'Error',
        errorCode:
          typeof (err as { code?: unknown }).code === 'string'
            ? (err as { code: string }).code
            : null,
        at: lastAuditFailureAt,
      }),
    );
  }
}

/** Operational visibility for audit persistence problems. */
export function auditHealth(): { writeFailures: number; lastFailureAt: string | null } {
  return { writeFailures: auditWriteFailures, lastFailureAt: lastAuditFailureAt };
}

interface RequestLike {
  user?: { id: string };
  ip?: string;
  requestId?: string;
  get?: (name: string) => string | undefined;
}

export function auditFromRequest(
  req: RequestLike,
  input: Omit<AuditInput, 'actorId' | 'ip' | 'userAgent' | 'requestId'>,
): Promise<void> {
  return audit({
    ...input,
    actorId: req.user?.id ?? null,
    ip: req.ip ?? null,
    userAgent: req.get?.('user-agent') ?? null,
    requestId: req.requestId ?? null,
  });
}
