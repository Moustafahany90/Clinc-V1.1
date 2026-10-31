import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../lib/errors.js';
import {
  dateOnlySchema,
  paginationSchema,
  parseBody,
  parseParams,
  parseQuery,
  uuidSchema,
} from '../../lib/validate.js';
import { authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import { auditFromRequest } from '../../lib/audit.js';
import { dateOnlyToDb } from '../../lib/time.js';

export const expensesRouter = Router();
expensesRouter.use(authenticate);

const dateRangeQuery = paginationSchema.extend({
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  categoryId: uuidSchema.optional(),
  includeVoid: z.coerce.boolean().default(false),
});

expensesRouter.get(
  '/',
  requirePermission('EXPENSES_READ', 'FINANCE_READ'),
  asyncHandler(async (req, res) => {
    const query = parseQuery(dateRangeQuery, req);
    const where = {
      categoryId: query.categoryId,
      ...(query.includeVoid ? {} : { status: 'RECORDED' }),
      ...(query.from || query.to
        ? {
            expenseDate: {
              ...(query.from ? { gte: dateOnlyToDb(query.from) } : {}),
              ...(query.to ? { lte: dateOnlyToDb(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, expenses, aggregate] = await prisma.$transaction([
      prisma.expense.count({ where }),
      prisma.expense.findMany({
        where,
        include: {
          category: { select: { id: true, name: true } },
          method: { select: { key: true, label: true } },
          recordedBy: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.expense.aggregate({ where, _sum: { amountMinor: true } }),
    ]);

    res.json({
      expenses,
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalAmountMinor: aggregate._sum.amountMinor ?? 0,
    });
  }),
);

const createExpenseSchema = z.object({
  expenseDate: dateOnlySchema,
  amountMinor: z.number().int().min(1).max(1_000_000_000),
  categoryId: uuidSchema,
  description: z.string().trim().min(2).max(300),
  methodKey: z.string().trim().max(40).optional().or(z.literal('')),
  reference: z.string().trim().max(120).optional().or(z.literal('')),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});

expensesRouter.post(
  '/',
  requirePermission('EXPENSES_WRITE'),
  asyncHandler(async (req, res) => {
    const payload = parseBody(createExpenseSchema, req);
    const me = currentUser(req);

    const category = await prisma.expenseCategory.findFirst({
      where: { id: payload.categoryId, isActive: true },
    });
    if (!category) throw badRequest('Select an active expense category.');

    if (payload.methodKey) {
      const method = await prisma.paymentMethod.findFirst({
        where: { key: payload.methodKey, isActive: true },
      });
      if (!method) throw badRequest('Select a valid payment method.');
    }

    if (payload.idempotencyKey) {
      const duplicate = await prisma.expense.findUnique({
        where: { idempotencyKey: payload.idempotencyKey },
        select: { id: true },
      });
      if (duplicate) throw badRequest('This expense was already recorded.');
    }

    const expense = await prisma.expense.create({
      data: {
        expenseDate: dateOnlyToDb(payload.expenseDate),
        amountMinor: payload.amountMinor,
        categoryId: category.id,
        description: payload.description,
        methodKey: payload.methodKey || null,
        reference: payload.reference || null,
        idempotencyKey: payload.idempotencyKey ?? null,
        recordedById: me.id,
      },
      include: { category: { select: { id: true, name: true } } },
    });

    await auditFromRequest(req, {
      action: 'expense.created',
      entityType: 'Expense',
      entityId: expense.id,
      metadata: {
        amountMinor: expense.amountMinor,
        category: expense.category.name,
        date: payload.expenseDate,
      },
    });

    res.status(201).json({ expense });
  }),
);

/** Corrections are auditable; history is never deleted. */
expensesRouter.post(
  '/:id/void',
  requirePermission('EXPENSES_WRITE'),
  asyncHandler(async (req, res) => {
    const { id } = parseParams(z.object({ id: uuidSchema }), req);
    const payload = parseBody(z.object({ reason: z.string().trim().min(3).max(300) }), req);

    const expense = await prisma.expense.findUnique({ where: { id } });
    if (!expense) throw notFound('Expense not found');
    if (expense.status === 'VOID') throw badRequest('This expense is already void.');

    const updated = await prisma.expense.update({
      where: { id },
      data: { status: 'VOID', voidReason: payload.reason, voidedAt: new Date() },
    });

    await auditFromRequest(req, {
      action: 'expense.voided',
      entityType: 'Expense',
      entityId: id,
      metadata: { reason: payload.reason, amountMinor: expense.amountMinor },
    });

    res.json({ expense: updated });
  }),
);
