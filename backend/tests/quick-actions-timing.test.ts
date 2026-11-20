import assert from 'node:assert/strict';
import test from 'node:test';
import { slotsForWindow } from '../src/modules/appointments/service.js';
import {
  clinicDayRange,
  clinicLocalToUtc,
  clinicWeekRange,
} from '../src/lib/time.js';

/**
 * Deterministic timing regression tests for the Quick Actions availability
 * engine. These use an injected `now` and fixed clinic-local dates, so they do
 * not depend on the wall clock or on a test database.
 *
 * They reproduce the failure mode behind the after-hours B1 report: when the
 * current instant is past today's closing time, no future slot exists. A test
 * that tries to create "today's" appointment by picking the first future slot
 * therefore creates nothing, and every later assertion about today's
 * appointment list becomes vacuous or fails.
 */

const DATE = '2026-11-20'; // A Friday; clinic week 2026-11-14 .. 2026-11-20.
const WINDOW = {
  isOpen: true,
  openMinute: 480, // 08:00
  closeMinute: 1320, // 22:00
  breakStartMinute: null,
  breakEndMinute: null,
  source: 'clinic' as const,
};

test('after-hours slot grid is empty for the configured clinic window', () => {
  const afterHours = clinicLocalToUtc(DATE, 23 * 60 + 30);
  const slots = slotsForWindow(WINDOW, DATE, 15, 15, [], afterHours);
  assert.deepEqual(slots, []);

  // This is the exact selection the old after-hours fixture relied on:
  // "first available slot starting more than 30 s from now".
  const cutoffStyle = slots.filter(
    (slot) => Date.parse(slot.start) > afterHours.getTime() + 30_000,
  );
  assert.deepEqual(cutoffStyle, []);
});

test('slot generation is anchored to injected now, not the wall clock', () => {
  const now = clinicLocalToUtc(DATE, 9 * 60);
  const slots = slotsForWindow(WINDOW, DATE, 15, 15, [], now);
  assert.ok(slots.length > 0);
  assert.equal(slots[0]!.minute, 540);
  assert.ok(slots.every((slot) => Date.parse(slot.start) >= now.getTime()));

  const later = clinicLocalToUtc(DATE, 18 * 60);
  const remaining = slotsForWindow(WINDOW, DATE, 15, 15, [], later);
  assert.ok(remaining.length > 0 && remaining.length < slots.length);
  assert.equal(remaining[0]!.minute, 1080);
  assert.ok(remaining.every((slot) => Date.parse(slot.start) >= later.getTime()));
});

test('slot at exactly "now" is still offered; earlier slots are excluded', () => {
  const boundary = clinicLocalToUtc(DATE, 12 * 60);
  const slots = slotsForWindow(WINDOW, DATE, 15, 15, [], boundary);
  assert.ok(slots.some((slot) => slot.start === boundary.toISOString()));
  assert.ok(slots.every((slot) => Date.parse(slot.start) >= boundary.getTime()));
});

test('occupied slots stay excluded and DST day boundaries stay local', () => {
  const bookedMinute = 600;
  const bookedStart = clinicLocalToUtc(DATE, bookedMinute);
  const slots = slotsForWindow(
    WINDOW,
    DATE,
    15,
    15,
    [{ id: 'booked', startAt: bookedStart, endAt: new Date(bookedStart.getTime() + 900_000) }],
    clinicLocalToUtc(DATE, 9 * 60),
  );
  const conflicting = slots.find((slot) => slot.minute === bookedMinute);
  assert.ok(conflicting, 'the occupied minute is still part of the agenda grid');
  assert.equal(conflicting!.available, false);
  assert.equal(conflicting!.conflictWith, 'booked');

  const spring = clinicWeekRange('2027-04-26');
  assert.equal(spring.start, '2027-04-24');
  assert.equal(spring.end, '2027-04-30');
  assert.equal(
    (clinicLocalToUtc('2027-04-30', 480).getTime() -
      clinicLocalToUtc('2027-04-29', 480).getTime()) /
      3_600_000,
    23,
  );
  assert.equal(
    (clinicLocalToUtc('2027-10-29', 480).getTime() -
      clinicLocalToUtc('2027-10-28', 480).getTime()) /
      3_600_000,
    25,
  );

  const day = clinicDayRange(DATE);
  assert.equal(day.start.toISOString(), clinicLocalToUtc(DATE, 0).toISOString());
  assert.equal(
    day.end.toISOString(),
    clinicLocalToUtc('2026-11-21', 0).toISOString(),
  );
});
