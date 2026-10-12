"use client";

import {
  addDaysToKey,
  addMonthsToKey,
  istKeyToDate,
  istMonthStartKey,
  istWeekStartKey,
} from "@/lib/dates";
import { EventChip, TaskChip } from "./event-chip";
import { assignLanes, dayKeysForEvent, dayKeysForTask } from "./layout";
import type { EventItem, TaskItem } from "./types";
import type { AnchorRect } from "@/lib/ui-scale";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A run of days one event or task occupies, and where it sits in the stack. */
type Bar = { id: string; keys: string[]; sortAt: number; rank: number } & (
  | { kind: "event"; event: EventItem }
  | { kind: "task"; task: TaskItem }
);

/** How many lanes a day cell shows before the rest collapse into "+N more". */
const MAX_LANES = 3;

export function MonthView({
  anchorKey,
  events,
  tasks,
  todayKey,
  onOpenDay,
  onSelectEvent,
}: {
  anchorKey: string;
  events: EventItem[];
  tasks: TaskItem[];
  todayKey: string;
  onOpenDay: (dayKey: string) => void;
  onSelectEvent: (event: EventItem, rect: AnchorRect) => void;
}) {
  const monthStart = istMonthStartKey(anchorKey);
  const monthEnd = addMonthsToKey(monthStart, 1);
  const gridStart = istWeekStartKey(monthStart);

  // One bar per event and per task, with the days it covers. Lanes are handed
  // out across the whole grid rather than per week, so a run that crosses a
  // Sunday keeps its row on the other side too.
  const bars: Bar[] = [
    ...events.map((event) => ({
      kind: "event" as const,
      id: `e-${event.id}`,
      keys: dayKeysForEvent(event),
      sortAt: event.allDay ? -1 : new Date(event.startAt).getTime(),
      rank: event.isMeeting ? 0 : 1,
      event,
    })),
    // A task is a stretch of work, not a point: it draws from where it starts
    // to the day it is owed, rather than appearing only on the deadline.
    ...tasks.map((task) => ({
      kind: "task" as const,
      id: `t-${task.id}`,
      keys: dayKeysForTask(task),
      sortAt: new Date(task.startAt ?? task.createdAt).getTime(),
      rank: 2,
      task,
    })),
  ];

  const lanes = assignLanes(bars);

  // dayKey -> lane -> the bar sitting in it that day.
  const byDay = new Map<string, Map<number, Bar>>();
  for (const bar of bars) {
    const lane = lanes.get(bar.id) ?? 0;
    for (const key of bar.keys) {
      const row = byDay.get(key) ?? new Map<number, Bar>();
      row.set(lane, bar);
      byDay.set(key, row);
    }
  }

  // Only as many rows as some day actually fills. Always reserving MAX_LANES
  // would pad every cell in an empty month with rows nothing sits in.
  const laneCount = Math.min(
    MAX_LANES,
    Math.max(
      0,
      ...[...byDay.values()].flatMap((row) => [...row.keys()]).map((l) => l + 1)
    )
  );

  const days = Array.from({ length: 42 }, (_, i) => addDaysToKey(gridStart, i));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="grid shrink-0 grid-cols-7 border-b border-[color-mix(in_oklab,white_6%,transparent)]">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="px-2 py-2 text-center text-[11px] uppercase tracking-[0.12em] text-faint"
          >
            {d}
          </div>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {days.map((key, index) => {
          const row = byDay.get(key) ?? new Map<number, Bar>();
          const hidden = [...row.keys()].filter((lane) => lane >= MAX_LANES).length;
          const inMonth = key >= monthStart && key < monthEnd;
          const isToday = key === todayKey;
          const dayNumber = istKeyToDate(key, 12).getUTCDate();
          const lastColumn = (index + 1) % 7 === 0;
          const lastRow = index >= 35;

          return (
            <div
              key={key}
              role="button"
              tabIndex={-1}
              onClick={() => onOpenDay(key)}
              className={`group flex min-h-24 min-w-0 cursor-pointer flex-col overflow-hidden border-[color-mix(in_oklab,white_6%,transparent)] px-1.5 py-1.5 text-left transition-colors hover:bg-[color-mix(in_oklab,white_4%,transparent)] ${
                lastColumn ? "" : "border-r"
              } ${lastRow ? "" : "border-b"} ${inMonth ? "" : "opacity-35"}`}
            >
              <div className="mb-1 flex shrink-0 items-center justify-between">
                <span className="text-[10px] text-faint opacity-0 transition-opacity group-hover:opacity-100">
                  Open
                </span>
                <span
                  className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] tabular-nums ${
                    isToday
                      ? "bg-[var(--primary)] font-medium text-white"
                      : "text-muted-foreground"
                  }`}
                >
                  {dayNumber}
                </span>
              </div>

              {/* -mx-1.5 cancels the cell's padding so a bar reaches both
                  edges and meets its neighbour across the cell border, instead
                  of breaking into a dotted line of separate pills. */}
              <div className="-mx-1.5 flex min-h-0 flex-col gap-0.5 overflow-hidden">
                {Array.from({ length: laneCount }, (_, lane) => {
                  const bar = row.get(lane);

                  // An empty lane still takes its row, or every bar below it
                  // shifts up on the days above it happen to be free — which is
                  // the staircase this is here to prevent. Same box as a chip,
                  // so the heights cannot drift apart.
                  if (!bar) {
                    return (
                      <span
                        key={lane}
                        aria-hidden
                        className="invisible rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight"
                      >
                        &nbsp;
                      </span>
                    );
                  }

                  const at = bar.keys.indexOf(key);
                  const continuesBefore = at > 0;
                  const continuesAfter = at < bar.keys.length - 1;

                  return bar.kind === "event" ? (
                    <EventChip
                      key={lane}
                      event={bar.event}
                      onSelect={onSelectEvent}
                      continuesBefore={continuesBefore}
                      continuesAfter={continuesAfter}
                    />
                  ) : (
                    <TaskChip
                      key={lane}
                      task={bar.task}
                      dayKey={key}
                      onSelect={onOpenDay}
                      continuesBefore={continuesBefore}
                      continuesAfter={continuesAfter}
                    />
                  );
                })}

                {hidden > 0 && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenDay(key);
                    }}
                    className="cursor-pointer px-1.5 text-[10px] text-faint transition-colors hover:text-foreground"
                  >
                    +{hidden} more
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
