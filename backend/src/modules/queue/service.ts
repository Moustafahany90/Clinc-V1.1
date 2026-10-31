import type { AppointmentStatus, Prisma } from '@prisma/client';
import { clinicDateString } from '../../lib/time.js';

export type Tx = Prisma.TransactionClient;

interface AppointmentRef {
  id: string;
  patientId: string;
  doctorId: string;
  startAt: Date;
}

/**
 * Keeps the waiting queue in step with appointment status changes without
 * requiring reception to duplicate work.
 */
export async function syncQueueForStatus(
  tx: Tx,
  appointment: AppointmentRef,
  status: AppointmentStatus,
  actorId: string | null,
): Promise<void> {
  if (status === 'ARRIVED') {
    await tx.queueEntry.upsert({
      where: { appointmentId: appointment.id },
      create: {
        appointmentId: appointment.id,
        patientId: appointment.patientId,
        doctorId: appointment.doctorId,
        queueDate: new Date(`${clinicDateString(appointment.startAt)}T00:00:00.000Z`),
        status: 'WAITING',
        arrivedAt: new Date(),
        createdById: actorId,
      },
      update: {
        status: 'WAITING',
        arrivedAt: new Date(),
        skipReason: null,
      },
    });
    return;
  }

  const existing = await tx.queueEntry.findUnique({ where: { appointmentId: appointment.id } });
  if (!existing) return;

  if (status === 'WAITING') {
    await tx.queueEntry.update({
      where: { id: existing.id },
      data: { status: 'WAITING', arrivedAt: existing.arrivedAt ?? new Date() },
    });
  } else if (status === 'IN_EXAM') {
    await tx.queueEntry.update({
      where: { id: existing.id },
      data: { status: 'IN_EXAM', calledAt: existing.calledAt ?? new Date(), examStartedAt: new Date() },
    });
  } else if (status === 'DONE') {
    await tx.queueEntry.update({
      where: { id: existing.id },
      data: { status: 'DONE', examEndedAt: existing.examEndedAt ?? new Date() },
    });
  } else if (status === 'CANCELLED' || status === 'NO_SHOW') {
    await tx.queueEntry.update({
      where: { id: existing.id },
      data: {
        status: 'SKIPPED',
        skipReason: status === 'CANCELLED' ? 'Appointment cancelled' : 'Patient did not arrive',
      },
    });
  }
}
