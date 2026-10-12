"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Building2, CalendarPlus, MapPin, Trash2, Users, Video, X } from "lucide-react";
import {
  formatIST,
  istKeyToDate,
  localInputFromKey,
  toLocalInput,
} from "@/lib/dates";
import { TaskRow } from "@/components/tasks/task-row";
import { RSVP_LABELS, placeLabel } from "@/lib/meetings";
import { toZoomed, type AnchorRect } from "@/lib/ui-scale";
import { EventForm, type EventFormValues } from "./event-form";
import type { CalendarOption, EventItem, TaskItem } from "./types";

/** Bottom sheet on phones, side sheet from the right on desktop. */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const sync = () => setIsDesktop(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return isDesktop;
}

export function DayPanel({
  dayKey,
  events,
  tasks,
  calendars,
  openTasks,
  canCreate,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
  onSelectEvent,
  onScheduleMeeting,
}: {
  dayKey: string | null;
  events: EventItem[];
  tasks: TaskItem[];
  calendars: CalendarOption[];
  openTasks: { id: string; title: string }[];
  canCreate: boolean;
  onClose: () => void;
  onCreate: (values: EventFormValues) => Promise<string | null>;
  onUpdate: (eventId: string, values: EventFormValues) => Promise<string | null>;
  onDelete: (eventId: string) => Promise<string | null>;
  /** Opens a meeting's details over the panel. */
  onSelectEvent: (event: EventItem, rect: AnchorRect) => void;
  onScheduleMeeting: (dayKey: string) => void;
}) {
  const isDesktop = useIsDesktop();
  const [mounted, setMounted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    setCreating(false);
    setEditingId(null);
    setError(null);
  }, [dayKey]);

  useEffect(() => {
    if (!dayKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dayKey, onClose]);

  if (!mounted) return null;

  const defaultCalendarId =
    calendars.find((c) => c.canEdit && c.isOwn)?.id ??
    calendars.find((c) => c.canEdit)?.id ??
    "";

  const sorted = [...events].sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
  });
  const dayMeetings = sorted.filter((e) => e.isMeeting);
  const dayEvents = sorted.filter((e) => !e.isMeeting);

  // Deadlines first in the order they fall, then the ongoing work.
  const dayTasks = [...tasks].sort(
    (a, b) =>
      Number(a.ongoing) - Number(b.ongoing) ||
      new Date(a.endAt).getTime() - new Date(b.endAt).getTime()
  );

  async function run(fn: () => Promise<string | null>, onDone: () => void) {
    setPending(true);
    setError(null);
    const message = await fn();
    setPending(false);
    if (message) {
      setError(message);
      return;
    }
    onDone();
  }

  const panel = (
    <AnimatePresence>
      {dayKey && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 z-[90] bg-black/50"
          />

          <motion.aside
            initial={isDesktop ? { x: "100%" } : { y: "100%" }}
            animate={isDesktop ? { x: 0 } : { y: 0 }}
            exit={isDesktop ? { x: "100%" } : { y: "100%" }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="overlay fixed inset-x-0 bottom-0 z-[91] flex max-h-[calc(0.85*var(--vh))] flex-col md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[26rem]"
          >
            <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[color-mix(in_oklab,white_7%,transparent)] px-5 py-4">
              <div>
                <p className="text-[17px] font-semibold tracking-tight">
                  {formatIST(istKeyToDate(dayKey, 12), {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                  })}
                </p>
                <p className="mt-0.5 text-[12px] text-faint">
                  {[
                    dayMeetings.length > 0 &&
                      `${dayMeetings.length} ${dayMeetings.length === 1 ? "meeting" : "meetings"}`,
                    dayEvents.length > 0 &&
                      `${dayEvents.length} ${dayEvents.length === 1 ? "event" : "events"}`,
                    `${dayTasks.length} ${dayTasks.length === 1 ? "task" : "tasks"}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded p-1 text-faint transition-colors hover:text-foreground"
              >
                <X size={16} />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {canCreate && (
                <div className="mb-4">
                  {creating ? (
                    <div className="rounded-xl border border-[color-mix(in_oklab,var(--primary)_35%,transparent)] bg-[color-mix(in_oklab,var(--primary)_6%,transparent)] px-3 py-3">
                      <EventForm
                        initial={{
                          title: "",
                          description: "",
                          location: "",
                          startAt: localInputFromKey(dayKey, 9 * 60),
                          endAt: localInputFromKey(dayKey, 10 * 60),
                          allDay: false,
                          taskId: "",
                          calendarId: defaultCalendarId,
                        }}
                        calendars={calendars}
                        tasks={openTasks}
                        submitLabel="Create event"
                        pending={pending}
                        error={error}
                        onSubmit={(values) =>
                          run(
                            () => onCreate(values),
                            () => setCreating(false)
                          )
                        }
                        onCancel={() => setCreating(false)}
                      />
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => onScheduleMeeting(dayKey)}
                        className="inline-flex h-[34px] flex-1 items-center justify-center gap-2 rounded-full bg-primary px-3.5 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
                      >
                        <Users size={14} />
                        Schedule meeting
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setError(null);
                          setCreating(true);
                        }}
                        title="Something on the calendar with nobody invited: leave, a launch, a reminder"
                        className="pill"
                      >
                        <CalendarPlus size={14} />
                        Event
                      </button>
                    </div>
                  )}
                </div>
              )}

              {dayMeetings.length > 0 && (
                <section className="mb-5">
                  <h3 className="mb-2 px-1 text-[11px] uppercase tracking-[0.12em] text-faint">
                    Meetings
                  </h3>
                  <div className="flex flex-col gap-1.5">
                    {dayMeetings.map((event) => (
                      <button
                        key={event.id}
                        type="button"
                        onClick={(e) =>
                          onSelectEvent(event, toZoomed(e.currentTarget.getBoundingClientRect(), e.currentTarget))
                        }
                        className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-white transition-[filter] hover:brightness-110 ${
                          event.myStatus === "DECLINED" ? "opacity-50" : ""
                        }`}
                        style={{ backgroundColor: `color-mix(in oklab, ${event.color} 72%, #000)` }}
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-black/20">
                          {event.mode === "online" ? <Video size={14} /> : <Building2 size={14} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium">{event.title}</span>
                          <span className="block truncate text-[11px] tabular-nums text-white/75">
                            {formatIST(new Date(event.startAt), { hour: "2-digit", minute: "2-digit" })}
                            {" – "}
                            {formatIST(new Date(event.endAt), { hour: "2-digit", minute: "2-digit" })}
                            {" · "}
                            {placeLabel(event.mode ?? "office", event.location, event.meetingUrl)}
                          </span>
                        </span>
                        <span className="shrink-0 text-right text-[11px] text-white/80">
                          {event.myStatus && event.myStatus !== "ACCEPTED"
                            ? RSVP_LABELS[event.myStatus]
                            : `${event.attendees.length} ${event.attendees.length === 1 ? "person" : "people"}`}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {dayEvents.length > 0 && (
                <section className="mb-5">
                  <h3 className="mb-2 px-1 text-[11px] uppercase tracking-[0.12em] text-faint">
                    Events
                  </h3>
                  <div className="flex flex-col gap-1.5">
                    {dayEvents.map((event) =>
                      editingId === event.id ? (
                        <div
                          key={event.id}
                          className="rounded-xl border border-[color-mix(in_oklab,var(--primary)_35%,transparent)] bg-[color-mix(in_oklab,var(--primary)_6%,transparent)] px-3 py-3"
                        >
                          <EventForm
                            initial={{
                              title: event.title,
                              description: event.description,
                              location: event.location,
                              startAt: toLocalInput(event.startAt),
                              endAt: toLocalInput(event.endAt),
                              allDay: event.allDay,
                              taskId: event.taskId ?? "",
                              calendarId: event.calendarId,
                            }}
                            calendars={calendars}
                            tasks={openTasks}
                            submitLabel="Save"
                            pending={pending}
                            error={error}
                            onSubmit={(values) =>
                              run(
                                () => onUpdate(event.id, values),
                                () => setEditingId(null)
                              )
                            }
                            onCancel={() => setEditingId(null)}
                          />
                        </div>
                      ) : (
                        <div
                          key={event.id}
                          className="group flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-[color-mix(in_oklab,white_4%,transparent)]"
                        >
                          <span
                            className="mt-1 h-8 w-0.5 shrink-0 rounded-full"
                            style={{ backgroundColor: event.color }}
                          />
                          <button
                            type="button"
                            onClick={() =>
                              event.canEdit ? setEditingId(event.id) : undefined
                            }
                            className="min-w-0 flex-1 text-left"
                          >
                            <p className="truncate text-[13px]">{event.title}</p>
                            <p className="truncate text-[11px] tabular-nums text-faint">
                              {event.allDay
                                ? "All day"
                                : `${formatIST(new Date(event.startAt), {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })} – ${formatIST(new Date(event.endAt), {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}`}
                              {!event.isOwnCalendar && ` · ${event.ownerName}`}
                            </p>
                            {event.location && (
                              <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-faint">
                                <MapPin size={10} />
                                {event.location}
                              </p>
                            )}
                            {event.taskTitle && (
                              <p
                                className="mt-0.5 truncate text-[11px]"
                                style={{ color: "var(--primary)" }}
                              >
                                ↳ {event.taskTitle}
                              </p>
                            )}
                          </button>

                          {event.canEdit && (
                            <button
                              type="button"
                              onClick={() => {
                                if (confirmingId !== event.id) {
                                  setConfirmingId(event.id);
                                  window.setTimeout(
                                    () =>
                                      setConfirmingId((id) =>
                                        id === event.id ? null : id
                                      ),
                                    3000
                                  );
                                  return;
                                }
                                run(
                                  () => onDelete(event.id),
                                  () => setConfirmingId(null)
                                );
                              }}
                              disabled={pending}
                              className={`shrink-0 rounded px-1.5 py-1 text-[10px] ${
                                confirmingId === event.id
                                  ? "text-[var(--status-red)]"
                                  : "hover-action"
                              }`}
                            >
                              {confirmingId === event.id ? (
                                "Sure?"
                              ) : (
                                <Trash2 size={13} />
                              )}
                            </button>
                          )}
                        </div>
                      )
                    )}
                  </div>
                </section>
              )}

              {dayTasks.length > 0 && (
                <section>
                  <h3 className="mb-2 px-1 text-[11px] uppercase tracking-[0.12em] text-faint">
                    Tasks
                  </h3>
                  <div className="list">
                    {/* One child, so .list's own separators stay out of the way
                        of the hairlines TaskRow already draws. */}
                    <div className="px-1.5">
                      {dayTasks.map((task) =>
                        task.canOpen ? (
                          <TaskRow
                            key={task.id}
                            task={task.ongoing ? { ...task.row, dueAtLabel: "Ongoing" } : task.row}
                          />
                        ) : (
                          // Someone else's task outside what this viewer can
                          // open: what it is and whose, nothing to click.
                          <div
                            key={task.id}
                            className="flex min-h-8 items-center gap-2.5 border-b border-border px-2 py-1.5 last:border-0"
                            title="Someone else's task. Ask them, or an admin, to share it."
                          >
                            <span className="h-3.5 w-3.5 shrink-0 rounded-sm border border-dashed border-[var(--border-strong)]" />
                            <span className="min-w-0 flex-1">
                              <span
                                className={`block truncate text-[13px] ${
                                  task.row.status === "DONE" ? "text-faint line-through" : ""
                                }`}
                              >
                                {task.row.title}
                              </span>
                              <span className="block truncate text-[11px] text-faint">
                                {task.row.assignees.join(", ") || "Unassigned"}
                              </span>
                            </span>
                            <span className="shrink-0 text-[11px] tabular-nums text-faint">
                              {task.ongoing ? "Ongoing" : task.row.dueAtLabel}
                            </span>
                          </div>
                        )
                      )}
                    </div>
                  </div>
                </section>
              )}

              {dayMeetings.length === 0 && dayEvents.length === 0 && dayTasks.length === 0 && (
                <p className="px-1 py-8 text-center text-[13px] text-muted-foreground">
                  Nothing on this day yet.
                </p>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );

  return createPortal(panel, document.body);
}
