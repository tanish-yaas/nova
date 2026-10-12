import { addDaysToKey, istDayKey, istKeyToDate } from "@/lib/dates";
import type { EventItem, TaskItem } from "./types";

export type DaySlice = {
  event: EventItem;
  /** Minutes from IST midnight, clipped to this day. */
  startMinutes: number;
  endMinutes: number;
  /** The event runs past either edge of this day. */
  continuesBefore: boolean;
  continuesAfter: boolean;
};

export type PositionedEvent = DaySlice & {
  column: number;
  columns: number;
};

const DAY_MS = 86_400_000;

/** A bar can cross a lot of days; past this it is data entry gone wrong. */
const MAX_SPAN_DAYS = 60;

/** Every IST day between two instants, inclusive of both ends. */
function spanKeys(startMs: number, endMs: number): string[] {
  const startKey = istDayKey(new Date(Math.min(startMs, endMs)));
  const endKey = istDayKey(new Date(Math.max(startMs, endMs)));

  const keys = [startKey];
  let cursor = startKey;
  while (cursor < endKey && keys.length < MAX_SPAN_DAYS) {
    cursor = addDaysToKey(cursor, 1);
    keys.push(cursor);
  }
  return keys;
}

/** Every IST day an event touches, so a multi-day event appears on each. */
export function dayKeysForEvent(event: EventItem): string[] {
  // An event ending exactly at midnight belongs to the day before, not to a
  // day it occupies no time in.
  return spanKeys(
    new Date(event.startAt).getTime(),
    new Date(event.endAt).getTime() - 1
  );
}

/**
 * Every IST day a task covers, from when the work starts to its end.
 *
 * "Complete the deck by Friday" is not a Friday problem: it is a problem from
 * the moment it exists until Friday, and the bar says so. An explicit start
 * date wins; without one the task starts when it was created.
 *
 * A task with no deadline is work that is simply going on, so it runs to
 * today and keeps running every day until it is done. One that has been open
 * for months shows its most recent stretch rather than its first, so today is
 * always on it.
 */
export function dayKeysForTask(task: TaskItem): string[] {
  const end = new Date(task.endAt).getTime();
  const start = new Date(task.startAt ?? task.createdAt).getTime();

  // A start after its own end is bad data, not a bar running backwards
  // from the deadline into next week. Fall back to the day it ends.
  if (!Number.isFinite(start) || start > end) {
    return [istDayKey(new Date(end))];
  }

  if (task.ongoing && end - start > (MAX_SPAN_DAYS - 1) * DAY_MS) {
    return spanKeys(end - (MAX_SPAN_DAYS - 1) * DAY_MS, end);
  }

  return spanKeys(start, end);
}

/**
 * The timed events touching one IST day, clipped to that day's window so a
 * meeting running past midnight draws as two blocks rather than overflowing.
 */
export function slicesForDay(events: EventItem[], dayKey: string): DaySlice[] {
  const dayStart = istKeyToDate(dayKey).getTime();
  const dayEnd = dayStart + DAY_MS;
  const slices: DaySlice[] = [];

  for (const event of events) {
    if (event.allDay) continue;

    const start = new Date(event.startAt).getTime();
    const end = new Date(event.endAt).getTime();
    if (end <= dayStart || start >= dayEnd) continue;

    slices.push({
      event,
      startMinutes: Math.max(0, (start - dayStart) / 60_000),
      endMinutes: Math.min(1440, (end - dayStart) / 60_000),
      continuesBefore: start < dayStart,
      continuesAfter: end > dayEnd,
    });
  }

  return slices;
}

/** Everything touching a day — timed and all-day alike — in start order. */
export function eventsOnDay(events: EventItem[], dayKey: string): EventItem[] {
  const dayStart = istKeyToDate(dayKey).getTime();
  const dayEnd = dayStart + DAY_MS;

  return events
    .filter((event) => {
      const start = new Date(event.startAt).getTime();
      const end = new Date(event.endAt).getTime();
      return end > dayStart && start < dayEnd;
    })
    .sort(
      (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime()
    );
}

/**
 * Pack overlapping events into side-by-side columns. Events that overlap sit
 * in adjacent columns; once a run of overlaps ends the column count resets, so
 * an isolated event still gets the full width.
 */
export function packColumns(slices: DaySlice[]): PositionedEvent[] {
  const sorted = [...slices].sort(
    (a, b) => a.startMinutes - b.startMinutes || b.endMinutes - a.endMinutes
  );

  const result: PositionedEvent[] = [];
  let cluster: PositionedEvent[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -1;

  const flush = () => {
    if (cluster.length === 0) return;
    const columns = cluster.reduce((max, p) => Math.max(max, p.column + 1), 1);
    for (const item of cluster) item.columns = columns;
    result.push(...cluster);
    cluster = [];
    columnEnds = [];
  };

  for (const slice of sorted) {
    if (cluster.length > 0 && slice.startMinutes >= clusterEnd) {
      flush();
      clusterEnd = -1;
    }

    let column = columnEnds.findIndex((end) => end <= slice.startMinutes);
    if (column === -1) column = columnEnds.length;

    columnEnds[column] = slice.endMinutes;
    cluster.push({ ...slice, column, columns: 1 });
    clusterEnd = Math.max(clusterEnd, slice.endMinutes);
  }

  flush();
  return result;
}


/**
 * Give every bar a row it keeps for the whole of its run.
 *
 * Each day used to sort its own chips, so a bar that shared Monday with two
 * finished tasks and Wednesday with none sat third, then second, then first —
 * a staircase, when the thing it is describing is one continuous stretch. A
 * lane is picked once per bar and held across every day it covers, so it reads
 * as a line.
 *
 * Greedy, in the order bars start: the lowest lane that is free on *every* day
 * the bar touches. That is what keeps two bars off each other while letting a
 * short one sit above a long one it never meets.
 */
export function assignLanes<
  T extends { id: string; keys: string[]; sortAt: number; rank?: number }
>(items: T[]): Map<string, number> {
  const ordered = [...items].sort(
    (a, b) =>
      // Fixed commitments first. A day cell shows three rows, and a meeting
      // pushed under "+3 more" by a week-long task bar is the one thing on
      // the day that cannot be missed.
      (a.rank ?? 1) - (b.rank ?? 1) ||
      // Earliest first, so a run already in progress keeps the lane it had.
      (a.keys[0] ?? "").localeCompare(b.keys[0] ?? "") ||
      // Then longest, so the bars that cross the most days settle at the top
      // and the short ones fill in around them.
      b.keys.length - a.keys.length ||
      a.sortAt - b.sortAt ||
      a.id.localeCompare(b.id)
  );

  const lanes = new Map<string, number>();
  const taken = new Map<string, Set<number>>();

  for (const item of ordered) {
    let lane = 0;
    while (item.keys.some((key) => taken.get(key)?.has(lane))) lane += 1;

    lanes.set(item.id, lane);
    for (const key of item.keys) {
      const set = taken.get(key) ?? new Set<number>();
      set.add(lane);
      taken.set(key, set);
    }
  }

  return lanes;
}
