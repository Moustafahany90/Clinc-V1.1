import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/errors.js';
import { dateOnlySchema, parseQuery } from '../../lib/validate.js';
import { authenticate, currentUser, requirePermission } from '../../middleware/auth.js';
import {
  getFinancialSummary,
  getTodayExpenses,
  getTodayRevenue,
  getWeeklyRevenue,
} from './financial.service.js';

export const financialQuickActionsRouter = Router();
financialQuickActionsRouter.use(authenticate);

/** Action 6 - today's revenue. */
financialQuickActionsRouter.get(
  '/revenue/today',
  requirePermission('FINANCE_READ'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    res.json(await getTodayRevenue(me));
  }),
);

/** Action 7 - weekly revenue (clinic Saturday-start week). */
financialQuickActionsRouter.get(
  '/revenue/weekly',
  requirePermission('FINANCE_READ'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const query = parseQuery(z.object({ weekStart: dateOnlySchema.optional() }), req);
    res.json(await getWeeklyRevenue(me, query));
  }),
);

/** Action 8 - today's expenses. */
financialQuickActionsRouter.get(
  '/expenses/today',
  requirePermission('FINANCE_READ'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    res.json(await getTodayExpenses(me));
  }),
);

/** Action 9 - financial summary: revenue, expenses, net. */
financialQuickActionsRouter.get(
  '/financial-summary',
  requirePermission('FINANCE_READ'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    res.json(await getFinancialSummary(me));
  }),
);
