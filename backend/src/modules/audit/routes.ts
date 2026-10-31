import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/errors.js';
import { paginationSchema, parseQuery, uuidSchema, dateOnlySchema } from '../../lib/validate.js';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { clinicDayRange } from '../../lib/time.js';

export const auditRouter = Router();
auditRouter.use(authenticate);

auditRouter.get(
  '/',
  requirePermission('AUDIT_READ'),
  asyncHandler(async (req, res) => {
    const query = parseQuery(
      paginationSchema.extend({
        entityType: z.string().trim().max(60).optional(),
        entityId: z.string().trim().max(60).optional(),
        actorId: uuidSchema.optional(),
        from: dateOnlySchema.optional(),
        to: dateOnlySchema.optional(),
        action: z.string().trim().max(80).optional(),
      }),
      req,
    );

    const where = {
      entityType: query.entityType,
      entityId: query.entityId,
      actorId: query.actorId,
      action: query.action ? { contains: query.action } : undefined,
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: clinicDayRange(query.from).start } : {}),
              ...(query.to ? { lt: clinicDayRange(query.to).end } : {}),
            },
          }
        : {}),
    };

    const [total, entries] = await prisma.$transaction([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        include: { actor: { select: { id: true, firstName: true, lastName: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    res.json({ entries, total, page: query.page, pageSize: query.pageSize });
  }),
);
