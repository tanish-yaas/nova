"use client";

import { useEffect, useRef, useState } from "react";
import {
  formatIST,
  istDayKey,
  istKeyToDate,
  istMinutesIntoDay,
  toLocalInput,
} from "@/lib/dates";
import {
  assignLanes,
  dayKeysForEvent,
  dayKeysForTask,
  packColumns,
  slicesForDay,
} from "./layout";
import { EventChip, TaskChip, eventTitle } from "./event-chip";
import { placeLabel } from "@/lib/meetings";
import type { DraftSlot, EventItem, TaskItem } from "./types";
import { toZoomed, zoomOf, type AnchorRect } from "@/lib/ui-scale";

/** One run in the all-day strip: an all-day event, or a task's start→due bar. */
type StripBar = { id: string; keys: string[]; sortAt: number; rank: number } & (
  | { kind: "event"; event: EventItem }
  | { kind: "task"; task: TaskItem }
);

const HOUR_HEIGHT = 52;
const PX_PER_MINUTE = HOUR_HEIGHT / 60;
const SNAP_MINUTES = 15;
const SLOT_MINUTES = 30;
const MIN_EVENT_MINUTES = 15;

type Drag = {
  id: string;
  mode: "move" | "resize";
  dayDelta: number;
  minuteDelta: number;
};

export function TimeGrid({
  dayKeys,
  events,
  tasks,
  todayKey,
  startHour,
  endHour,
  detailed = false,
  onSelectEvent,
  onCreateSlot,
  onMoveEvent,
  onResizeEvent,
  onOpenDay,
}: {
  dayKeys: string[];
  events: EventItem[];
  tasks: TaskItem[];
  todayKey: string;
  startHour: number;
  endHour: number;
  detailed?: boolean;
  onSelectEvent: (event: EventItem, rect: AnchorRect) => void;
  onCreateSlot: (draft: DraftSlot) => void;
  onMoveEvent: (eventId: string, startLocal: string) => void;
  onResizeEvent: (eventId: string, endLocal: string) => void;
  onOpenDay: (dayKey: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    id: string;
    mode: "move" | "resize";
    event: EventItem;
    dayIndex: number;
    originX: number;
    originY: number;
    /** Captured at drag start — pointer deltas arrive in screen pixels, and
        columnWidth / PX_PER_MINUTE are layout pixels. It cannot change
        mid-drag, so reading it once beats reading it per pointermove. */
    zoom: number;
    dayDelta: number;
    minuteDelta: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const [drag, setDrag] = useState<Drag | null>(null);
  const [columnWidth, setColumnWidth] = useState(0);
  const [now, setNow] = useState<{ key: string; minutes: number } | null>(null);

  const windowStart = startHour * 60;
  const windowEnd = endHour * 60;
  const gridHeight = ((windowEnd - windowStart) / 60) * HOUR_HEIGHT;
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);

  // Rendered only after mount — the server has no business guessing "now".
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setNow({ key: istDayKey(d), minutes: istMinutesIntoDay(d) });
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;

    const measure = () => setColumnWidth(el.clientWidth / dayKeys.length);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [dayKeys.length]);

  // Open on the working day rather than at midnight.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, (9 - startHour) * HOUR_HEIGHT);
  }, [startHour]);

  useEffect(() => {
    if (!drag) return;

    function handleMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;

      if (Math.abs(e.clientX - d.originX) > 3 || Math.abs(e.clientY - d.originY) > 3) {
        d.moved = true;
      }

      const rawMinutes = (e.clientY - d.originY) / d.zoom / PX_PER_MINUTE;
      d.minuteDelta = Math.round(rawMinutes / SNAP_MINUTES) * SNAP_MINUTES;

      if (d.mode === "move" && columnWidth > 0) {
        const raw = Math.round((e.clientX - d.originX) / d.zoom / columnWidth);
        d.dayDelta = Math.max(
          -d.dayIndex,
          Math.min(dayKeys.length - 1 - d.dayIndex, raw)
        );
      } else {
        d.dayDelta = 0;
      }

      setDrag({
        id: d.id,
        mode: d.mode,
        dayDelta: d.dayDelta,
        minuteDelta: d.minuteDelta,
      });
    }

    function handleUp() {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;

      suppressClickRef.current = d.moved;
      if (!d.moved) return;

      const totalMinutes = d.dayDelta * 1440 + d.minuteDelta;

      if (d.mode === "move") {
        if (totalMinutes === 0) return;
        const next = new Date(
          new Date(d.event.startAt).getTime() + totalMinutes * 60_000
        );
        onMoveEvent(d.event.id, toLocalInput(next));
        return;
      }

      if (d.minuteDelta === 0) return;
      const nextEnd = new Date(
        new Date(d.event.endAt).getTime() + d.minuteDelta * 60_000
      );
      if (
        nextEnd.getTime() - new Date(d.event.startAt).getTime() <
        MIN_EVENT_MINUTES * 60_000
      ) {
        return;
      }
      onResizeEvent(d.event.id, toLocalInput(nextEnd));
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);

    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
    // Re-binding on every delta change would thrash; the ref carries the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.id, columnWidth, dayKeys.length]);

  function beginDrag(
    e: React.PointerEvent,
    event: EventItem,
    dayIndex: number,
    mode: "move" | "resize"
  ) {
    if (!event.canEdit) return;
    e.stopPropagation();

    dragRef.current = {
      id: event.id,
      mode,
      event,
      dayIndex,
      originX: e.clientX,
      originY: e.clientY,
      zoom: zoomOf(e.currentTarget),
      dayDelta: 0,
      minuteDelta: 0,
      moved: false,
    };
    setDrag({ id: event.id, mode, dayDelta: 0, minuteDelta: 0 });
  }

  function handleColumnClick(e: React.MouseEvent<HTMLDivElement>, dayKey: string) {
    const rect = e.currentTarget.getBoundingClientRect();
    // clientY and the rect are screen pixels; PX_PER_MINUTE is a layout
    // constant. Dividing the gap by the zoom puts both on the same ruler —
    // without it, clicking the grid lands you off by the scale factor.
    const offsetMinutes =
      (e.clientY - rect.top) / zoomOf(e.currentTarget) / PX_PER_MINUTE;
    const minutes =
      windowStart +
      Math.floor(offsetMinutes / SLOT_MINUTES) * SLOT_MINUTES;

    onCreateSlot({
      dayKey,
      startMinutes: Math.max(0, Math.min(1440 - SLOT_MINUTES, minutes)),
      endMinutes: Math.max(SLOT_MINUTES, Math.min(1440, minutes + 60)),
    });
  }

  const columns = { gridTemplateColumns: `repeat(${dayKeys.length}, minmax(0, 1fr))` };

  // The all-day strip carries the same runs the month grid does, so it gets the
  // same lanes: a bar holds one row for the whole week rather than sliding up
  // as the days around it empty out. Timed events are not in here — they are
  // positioned by the hour in the grid below.
  const stripBars: StripBar[] = [
    ...events
      .filter((event) => event.allDay)
      .map((event) => ({
        kind: "event" as const,
        id: `e-${event.id}`,
        keys: dayKeysForEvent(event),
        sortAt: -1,
        rank: 0,
        event,
      })),
    ...tasks.map((task) => ({
      kind: "task" as const,
      id: `t-${task.id}`,
      keys: dayKeysForTask(task),
      sortAt: new Date(task.startAt ?? task.createdAt).getTime(),
      rank: 2,
      task,
    })),
  ];

  const stripLanes = assignLanes(stripBars);

  const stripByDay = new Map<string, Map<number, StripBar>>();
  for (const bar of stripBars) {
    const lane = stripLanes.get(bar.id) ?? 0;
    for (const key of bar.keys) {
      const row = stripByDay.get(key) ?? new Map<number, StripBar>();
      row.set(lane, bar);
      stripByDay.set(key, row);
    }
  }

  // Only as tall as the days on screen need; a run passing outside the week
  // still reserves its lane but must not pad the strip for days nobody sees.
  const stripLaneCount = dayKeys.reduce(
    (max, key) =>
      Math.max(max, ...[...(stripByDay.get(key)?.keys() ?? [-1])].map((l) => l + 1)),
    0
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Day headers */}
      <div className="flex shrink-0 border-b border-[color-mix(in_oklab,white_6%,transparent)]">
        <div className="w-14 shrink-0" />
        <div className="grid flex-1" style={columns}>
          {dayKeys.map((key) => {
            const date = istKeyToDate(key, 12);
            const isToday = key === todayKey;

            return (
              <button
                key={key}
                type="button"
                onClick={() => onOpenDay(key)}
                className="flex flex-col items-center gap-0.5 border-l border-[color-mix(in_oklab,white_6%,transparent)] px-2 py-2 transition-colors hover:bg-[color-mix(in_oklab,white_4%,transparent)]"
              >
                <span className="text-[11px] uppercase tracking-[0.12em] text-faint">
                  {formatIST(date, { weekday: "short" })}
                </span>
                <span
                  className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-sm tabular-nums ${
                    isToday
                      ? "bg-[var(--primary)] font-medium text-white"
                      : "text-foreground"
                  }`}
                >
                  {date.getUTCDate()}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* All-day + deadlines */}
      <div className="flex shrink-0 border-b border-[color-mix(in_oklab,white_6%,transparent)] bg-[color-mix(in_oklab,white_3%,transparent)]">
        <div className="flex w-14 shrink-0 items-start justify-end px-2 py-1.5 text-[11px] uppercase tracking-[0.12em] text-faint">
          All day
        </div>
        <div className="grid flex-1" style={columns}>
          {dayKeys.map((key) => (
            <div
              key={key}
              className="flex min-h-9 flex-col gap-0.5 border-l border-[color-mix(in_oklab,white_6%,transparent)] px-1 py-1"
            >
              {Array.from({ length: stripLaneCount }, (_, lane) => {
                const bar = stripByDay.get(key)?.get(lane);

                // An empty lane holds its row, or the bars under it climb on
                // the days above them are free — the staircase again.
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
            </div>
          ))}
        </div>
      </div>

      {/* Timed grid */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex" style={{ height: gridHeight }}>
          <div className="relative w-14 shrink-0">
            {hours.map((hour) => (
              <div
                key={hour}
                className="absolute right-2 text-[10px] tabular-nums text-faint"
                style={{ top: (hour - startHour) * HOUR_HEIGHT + 2 }}
              >
                {String(hour).padStart(2, "0")}:00
              </div>
            ))}
          </div>

          <div ref={areaRef} className="relative grid flex-1" style={columns}>
            {dayKeys.map((dayKey, dayIndex) => {
              const positioned = packColumns(slicesForDay(events, dayKey));
              const showNow = now !== null && now.key === dayKey;

              return (
                <div
                  key={dayKey}
                  onClick={(e) => handleColumnClick(e, dayKey)}
                  className={`relative border-l border-[color-mix(in_oklab,white_6%,transparent)] ${
                    dayKey === todayKey
                      ? "bg-[color-mix(in_oklab,var(--primary)_5%,transparent)]"
                      : ""
                  }`}
                >
                  {hours.map((hour) => (
                    <div
                      key={hour}
                      className="border-b border-[color-mix(in_oklab,white_4%,transparent)]"
                      style={{ height: HOUR_HEIGHT }}
                    />
                  ))}

                  {positioned.map((slot) => {
                    const top =
                      (Math.max(slot.startMinutes, windowStart) - windowStart) *
                      PX_PER_MINUTE;
                    const bottom =
                      (Math.min(slot.endMinutes, windowEnd) - windowStart) *
                      PX_PER_MINUTE;

                    if (bottom <= 0 || top >= gridHeight) return null;

                    const isDragging = drag?.id === slot.event.id;
                    const offsetY =
                      isDragging && drag ? drag.minuteDelta * PX_PER_MINUTE : 0;
                    const offsetX =
                      isDragging && drag && drag.mode === "move"
                        ? drag.dayDelta * columnWidth
                        : 0;

                    const height = Math.max(
                      bottom -
                        top +
                        (isDragging && drag?.mode === "resize"
                          ? drag.minuteDelta * PX_PER_MINUTE
                          : 0) -
                        2,
                      MIN_EVENT_MINUTES * PX_PER_MINUTE
                    );

                    return (
                      <div
                        key={slot.event.id}
                        onPointerDown={(e) =>
                          beginDrag(e, slot.event, dayIndex, "move")
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          if (suppressClickRef.current) {
                            suppressClickRef.current = false;
                            return;
                          }
                          onSelectEvent(
                            slot.event,
                            toZoomed(
                              e.currentTarget.getBoundingClientRect(),
                              e.currentTarget
                            )
                          );
                        }}
                        className={`absolute overflow-hidden rounded-md border px-1.5 py-1 text-left transition-shadow ${
                          slot.event.canEdit ? "cursor-grab" : "cursor-pointer"
                        } ${
                          isDragging
                            ? "z-30 cursor-grabbing shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
                            : "z-10"
                        }`}
                        style={{
                          top: top + (drag?.mode === "resize" ? 0 : offsetY),
                          height,
                          left: `calc(${
                            (slot.column / slot.columns) * 100
                          }% + 2px)`,
                          width: `calc(${100 / slot.columns}% - 4px)`,
                          transform: offsetX ? `translateX(${offsetX}px)` : undefined,
                          // Meetings solid, plain events tinted, someone's
                          // private time grey: the same rule as the chips.
                          ...(slot.event.busy
                            ? {
                                backgroundColor: "color-mix(in oklab, var(--text-faint) 14%, var(--card))",
                                borderColor: "color-mix(in oklab, var(--text-faint) 30%, transparent)",
                              }
                            : slot.event.isMeeting
                              ? {
                                  backgroundColor: `color-mix(in oklab, ${slot.event.color} 72%, #000)`,
                                  borderColor: `color-mix(in oklab, ${slot.event.color} 85%, white)`,
                                  color: "#fff",
                                }
                              : {
                                  backgroundColor: `color-mix(in oklab, ${slot.event.color} 26%, var(--card))`,
                                  borderColor: `color-mix(in oklab, ${slot.event.color} 55%, transparent)`,
                                }),
                          opacity: slot.event.myStatus === "DECLINED" ? 0.45 : undefined,
                        }}
                        title={eventTitle(slot.event)}
                      >
                        <p className="truncate text-[11px] font-medium leading-tight">
                          {slot.event.title}
                        </p>
                        {height > 30 && (
                          <p
                            className={`truncate text-[10px] tabular-nums ${
                              slot.event.isMeeting ? "text-white/75" : "text-muted-foreground"
                            }`}
                          >
                            {formatIST(new Date(slot.event.startAt), {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                            {" – "}
                            {formatIST(new Date(slot.event.endAt), {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </p>
                        )}
                        {slot.event.isMeeting && height > 44 && (
                          <p className="truncate text-[10px] text-white/75">
                            {placeLabel(slot.event.mode ?? "office", slot.event.location, slot.event.meetingUrl)}
                            {slot.event.attendees.length > 1 && ` · ${slot.event.attendees.length} people`}
                          </p>
                        )}
                        {!slot.event.isMeeting && !slot.event.isOwnCalendar && height > 44 && (
                          <p className="truncate text-[10px] text-faint">
                            {slot.event.ownerName}
                          </p>
                        )}
                        {!slot.event.isMeeting && detailed && height > 56 && slot.event.location && (
                          <p className="truncate text-[10px] text-muted-foreground">
                            {slot.event.location}
                          </p>
                        )}
                        {detailed && height > 76 && slot.event.description && (
                          <p
                            className={`line-clamp-2 text-[10px] ${
                              slot.event.isMeeting ? "text-white/60" : "text-faint"
                            }`}
                          >
                            {slot.event.description}
                          </p>
                        )}

                        {slot.event.canEdit && !slot.continuesAfter && (
                          <div
                            onPointerDown={(e) =>
                              beginDrag(e, slot.event, dayIndex, "resize")
                            }
                            onClick={(e) => e.stopPropagation()}
                            className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize"
                            title="Drag to resize"
                          />
                        )}
                      </div>
                    );
                  })}

                  {showNow &&
                    now.minutes >= windowStart &&
                    now.minutes <= windowEnd && (
                      <div
                        className="pointer-events-none absolute inset-x-0 z-20"
                        style={{
                          top: (now.minutes - windowStart) * PX_PER_MINUTE,
                        }}
                      >
                        <div className="relative h-px bg-brand-violet">
                          <span className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-brand-violet" />
                        </div>
                      </div>
                    )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
