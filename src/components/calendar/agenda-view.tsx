"use client";

import { Building2, CalendarDays, Video } from "lucide-react";
import { placeLabel } from "@/lib/meetings";
import { addDaysToKey, formatIST, istKeyToDate } from "@/lib/dates";
import { EmptyState } from "@/components/ui/empty-state";
import { dayKeysForEvent, dayKeysForTask } from "./layout";
import type { EventItem, TaskItem } from "./types";
import { toZoomed, type AnchorRect } from "@/lib/ui-scale";

type Span = { continuesBefore: boolean; continuesAfter: boolean };
type Row =
  | ({ kind: "event"; sortAt: number; event: EventItem } & Span)
  | ({ kind: "task"; sortAt: number; task: TaskItem } & Span);

const PRIORITY_COLOR: Record<string, string> = {
  URGENT: "var(--status-red)",
  HIGH: "var(--status-amber)",
  MEDIUM: "var(--status-blue)",
  LOW: "var(--text-faint)",
};

export function AgendaView({
  startKey,
  days,
  events,
  tasks,
  todayKey,
  onSelectEvent,
  onOpenDay,
}: {
  startKey: string;
  days: number;
  events: EventItem[];
  tasks: TaskItem[];
  todayKey: string;
  onSelectEvent: (event: EventItem, rect: AnchorRect) => void;
  onOpenDay: (dayKey: string) => void;
}) {
  const byDay = new Map<string, Row[]>();
  const push = (key: string, row: Row) => {
    const list = byDay.get(key);
    if (list) list.push(row);
    else byDay.set(key, [row]);
  };

  // Listed on every day it covers, not just the one it starts on: an agenda
  // that drops a three-day event after day one is telling you the next two
  // days are free.
  for (const event of events) {
    const keys = dayKeysForEvent(event);
    keys.forEach((key, i) =>
      push(key, {
        kind: "event",
        sortAt: event.allDay ? -1 : new Date(event.startAt).getTime(),
        event,
        continuesBefore: i > 0,
        continuesAfter: i < keys.length - 1,
      })
    );
  }

  for (const task of tasks) {
    const keys = dayKeysForTask(task);
    keys.forEach((key, i) =>
      push(key, {
        kind: "task",
        sortAt: new Date(task.startAt ?? task.createdAt).getTime(),
        task,
        continuesBefore: i > 0,
        continuesAfter: i < keys.length - 1,
      })
    );
  }

  const dayKeys = Array.from({ length: days }, (_, i) =>
    addDaysToKey(startKey, i)
  ).filter((key) => (byDay.get(key)?.length ?? 0) > 0);

  if (dayKeys.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center py-16">
        <EmptyState
          icon={CalendarDays}
          title="Nothing scheduled"
          description="No events or deadlines in the next 30 days. Click any day in month or week view to add something."
        />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="flex flex-col gap-5">
        {dayKeys.map((key) => {
          const rows = (byDay.get(key) ?? []).sort((a, b) => a.sortAt - b.sortAt);
          const date = istKeyToDate(key, 12);
          const isToday = key === todayKey;

          return (
            <section key={key}>
              <button
                type="button"
                onClick={() => onOpenDay(key)}
                className="mb-2 flex items-baseline gap-2 px-0.5 transition-colors hover:text-foreground"
              >
                <span
                  className="text-[13px] font-medium"
                  style={isToday ? { color: "var(--primary)" } : undefined}
                >
                  {isToday ? "Today" : formatIST(date, { weekday: "long" })}
                </span>
                <span className="text-[11px] uppercase tracking-[0.12em] text-faint">
                  {formatIST(date, {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}
                </span>
              </button>

              <ul className="list">
                {rows.map((row, i) =>
                  row.kind === "event" ? (
                    <li key={`e-${row.event.id}-${i}`}>
                      <button
                        type="button"
                        onClick={(e) =>
                          onSelectEvent(
                            row.event,
                            toZoomed(
                              e.currentTarget.getBoundingClientRect(),
                              e.currentTarget
                            )
                          )
                        }
                        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-[color-mix(in_oklab,white_4%,transparent)]"
                      >
                        {/* Meetings get a filled tile, plain events a thin rule:
                            the same solid-versus-tint rule as the grid. */}
                        {row.event.isMeeting ? (
                          <span
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white"
                            style={{ backgroundColor: `color-mix(in oklab, ${row.event.color} 72%, #000)` }}
                          >
                            {row.event.mode === "online" ? <Video size={14} /> : <Building2 size={14} />}
                          </span>
                        ) : (
                          <span
                            className="h-8 w-0.5 shrink-0 rounded-full"
                            style={{ backgroundColor: row.event.busy ? "var(--text-faint)" : row.event.color }}
                          />
                        )}
                        <span className="w-24 shrink-0 text-[11px] tabular-nums text-faint">
                          {/* On the days a run passes through, the original
                              start–end pair would be a lie about this day. Each
                              slice says what it actually is. */}
                          {row.event.allDay ||
                          (row.continuesBefore && row.continuesAfter)
                            ? "All day"
                            : row.continuesBefore
                              ? `Until ${formatIST(new Date(row.event.endAt), {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}`
                              : row.continuesAfter
                                ? `From ${formatIST(
                                    new Date(row.event.startAt),
                                    { hour: "2-digit", minute: "2-digit" }
                                  )}`
                                : `${formatIST(new Date(row.event.startAt), {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })} – ${formatIST(new Date(row.event.endAt), {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}`}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px]">
                            {row.event.title}
                          </span>
                          {row.event.isMeeting ? (
                            <span className="block truncate text-[11px] text-faint">
                              {[
                                placeLabel(row.event.mode ?? "office", row.event.location, row.event.meetingUrl),
                                `${row.event.attendees.length} ${row.event.attendees.length === 1 ? "person" : "people"}`,
                                row.event.myStatus === "NEEDS_ACTION" ? "you haven't answered" : null,
                                row.event.myStatus === "DECLINED" ? "you're not going" : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          ) : (
                            (row.event.location || !row.event.isOwnCalendar) && (
                              <span className="block truncate text-[11px] text-faint">
                                {[
                                  row.event.location,
                                  row.event.isOwnCalendar ? null : row.event.ownerName,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </span>
                            )
                          )}
                        </span>
                      </button>
                    </li>
                  ) : (
                    <li key={`t-${row.task.id}-${i}`}>
                      <button
                        type="button"
                        onClick={() => onOpenDay(row.task.dayKey)}
                        className="row w-full gap-3 text-left"
                      >
                        <span
                          className="h-4 w-0.5 shrink-0 rounded-full"
                          style={{
                            backgroundColor:
                              PRIORITY_COLOR[row.task.row.priority] ??
                              PRIORITY_COLOR.LOW,
                          }}
                        />
                        <span className="w-24 shrink-0 text-[11px] tabular-nums text-faint">
                          {/* "Due 17:00" on a day three days before the
                              deadline reads as today's problem. Only the last
                              day of the bar is the day it is owed. */}
                          {row.task.ongoing
                            ? "Ongoing"
                            : row.continuesAfter || !row.task.dueAt
                              ? "In progress"
                              : `Due ${formatIST(new Date(row.task.dueAt), {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}`}
                        </span>
                        <span
                          className={`min-w-0 flex-1 truncate text-[13px] ${
                            row.task.row.status === "DONE"
                              ? "text-faint line-through"
                              : ""
                          }`}
                        >
                          {row.task.row.title}
                        </span>
                        <span
                          className="chip shrink-0"
                          style={{
                            borderColor: `color-mix(in oklab, ${
                              PRIORITY_COLOR[row.task.row.priority] ??
                              PRIORITY_COLOR.LOW
                            } 45%, transparent)`,
                            backgroundColor: `color-mix(in oklab, ${
                              PRIORITY_COLOR[row.task.row.priority] ??
                              PRIORITY_COLOR.LOW
                            } 18%, transparent)`,
                            color: `color-mix(in oklab, ${
                              PRIORITY_COLOR[row.task.row.priority] ??
                              PRIORITY_COLOR.LOW
                            } 88%, white)`,
                          }}
                        >
                          {row.task.row.priority.toLowerCase()}
                        </span>
                      </button>
                    </li>
                  )
                )}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
