/**
 * Tunables for the Quick Actions module. Kept in one place so the API, the
 * tests and the UI agree on the same bounds.
 */

/** Action 5 searches this many clinic days, starting today. */
export const NEXT_AVAILABLE_HORIZON_DAYS = 60;

/** Default page size for quick-action lists (matches the API convention). */
export const DEFAULT_LIST_LIMIT = 50;

/** Hard cap for quick-action lists. */
export const MAX_LIST_LIMIT = 200;

/** Action 4 accepts an inclusive date range no longer than this. */
export const MAX_DOCTOR_SCHEDULE_DAYS = 31;
