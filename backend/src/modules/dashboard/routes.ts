import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/errors.js';
import { authenticate, currentUser } from '../../middleware/auth.js';
import { clinicDateString, clinicDayRange, CLINIC_CURRENCY } from '../../lib/time.js';
import { getClinicSettings } from '../../lib/clinic.js';

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

dashboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const today = clinicDateString();
    const range = clinicDayRange(today);
    const isDoctor = me.role === 'DOCTOR';
    const doctorFilter = isDoctor ? { doctorId: me.id } : {};

    const [settings, appointments, queue, patientsTotal] = await Promise.all([
      getClinicSettings(),
      prisma.appointment.findMany({
        where: { ...doctorFilter, startAt: { gte: range.start, lt: range.end } },
        select: {
          id: true,
          startAt: true,
          endAt: true,
          status: true,
          patient: { select: { id: true, patientNumber: true, firstName: true, lastName: true } },
          doctor: { select: { id: true, firstName: true, lastName: true } },
          service: { select: { name: true } },
        },
        orderBy: { startAt: 'asc' },
      }),
      prisma.queueEntry.groupBy({
        by: ['status'],
        where: { queueDate: new Date(`${today}T00:00:00.000Z`), ...doctorFilter },
        _count: { _all: true },
      }),
      me.permissions.includes('PATIENTS_READ') ? prisma.patient.count({ where: { isActive: true } }) : Promise.resolve(null),
    ]);

    const queueCounts = Object.fromEntries(
      queue.map((row) => [row.status, row._count._all]),
    ) as Record<string, number>;

    let finance: Record<string, unknown> | null = null;
    if (me.permissions.includes('FINANCE_READ') || me.permissions.includes('PAYMENTS_READ')) {
      const [payments, refunds, expenses] = await Promise.all([
        prisma.payment.aggregate({
          where: { status: 'COMPLETED', receivedAt: { gte: range.start, lt: range.end } },
          _sum: { amountMinor: true },
          _count: { _all: true },
        }),
        prisma.refund.aggregate({
          where: { refundedAt: { gte: range.start, lt: range.end } },
          _sum: { amountMinor: true },
        }),
        prisma.expense.aggregate({
          where: { status: 'RECORDED', expenseDate: new Date(`${today}T00:00:00.000Z`) },
          _sum: { amountMinor: true },
        }),
      ]);
      finance = {
        collectedTodayMinor: (payments._sum.amountMinor ?? 0) - (refunds._sum.amountMinor ?? 0),
        paymentsToday: payments._count._all,
        expensesTodayMinor: expenses._sum.amountMinor ?? 0,
      };
    }

    let clinical: Record<string, number> | null = null;
    if (me.permissions.includes('CLINICAL_READ')) {
      const [draftReports, openVisits] = await Promise.all([
        prisma.report.count({ where: { ...doctorFilter, status: 'DRAFT' } }),
        prisma.visit.count({ where: { ...doctorFilter, status: { in: ['DRAFT', 'IN_REVIEW'] } } }),
      ]);
      clinical = { draftReports, openVisits };
    }

    res.json({
      clinic: { name: settings.name, timezone: settings.timezone, currency: CLINIC_CURRENCY },
      date: today,
      role: me.role,
      appointments: {
        total: appointments.length,
        byStatus: appointments.reduce<Record<string, number>>((acc, a) => {
          acc[a.status] = (acc[a.status] ?? 0) + 1;
          return acc;
        }, {}),
        list: appointments,
      },
      queue: {
        waiting: queueCounts.WAITING ?? 0,
        called: queueCounts.CALLED ?? 0,
        inExam: queueCounts.IN_EXAM ?? 0,
        skipped: queueCounts.SKIPPED ?? 0,
        done: queueCounts.DONE ?? 0,
      },
      patientsTotal,
      finance,
      clinical,
    });
  }),
);
