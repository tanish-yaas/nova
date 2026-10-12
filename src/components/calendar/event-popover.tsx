"use client";
import { DateTimeField } from "@/components/ui/datetime-field";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import {
  CalendarDays,
  Clock,
  Link2,
  MapPin,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { formatIST, toLocalInput } from "@/lib/dates";
import type { EventPatch } from "@/lib/validators/event";
import type { EventItem } from "./types";
import { viewportSize, type AnchorRect } from "@/lib/ui-scale";
import { MeetingDetails } from "@/components/meetings/meeting-details";

const WIDTH = 340;
const MARGIN = 12;

const ghostField =
  "w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[13px] outline-none transition-colors hover:border-[color-mix(in_oklab,white_11%,transparent)] focus:border-[color-mix(in_oklab,var(--primary)_45%,transparent)] focus:bg-[color-mix(in_oklab,white_4%,transparent)] disabled:hover:border-transparent";

export function EventPopover({
  event,
  anchor,
  openTasks,
  onClose,
  onPatch,
  onDelete,
  onEditMeeting,
  onChanged,
}: {
  event: EventItem;
  anchor: AnchorRect;
  openTasks: { id: string; title: string }[];
  onClose: () => void;
  /** Meetings edit in the full meeting form, not inline. */
  onEditMeeting: (event: EventItem) => void;
  /** After an answer or a cancel from the meeting view. */
  onChanged: () => void;
  onPatch: (eventId: string, patch: EventPatch) => Promise<string | null>;
  onDelete: (eventId: string) => Promise<string | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState({ left: -9999, top: -9999 });
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState(event.title);
  const [location, setLocation] = useState(event.location);
  const [description, setDescription] = useState(event.description);
  const [startAt, setStartAt] = useState(toLocalInput(event.startAt));
  const [endAt, setEndAt] = useState(toLocalInput(event.endAt));

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    setTitle(event.title);
    setLocation(event.location);
    setDescription(event.description);
    setStartAt(toLocalInput(event.startAt));
    setEndAt(toLocalInput(event.endAt));
    setError(null);
    setConfirming(false);
  }, [event]);

  useLayoutEffect(() => {
    if (!mounted) return;
    const height = ref.current?.offsetHeight ?? 240;
    // Measured in the scaled root's space, to match the anchor and offsetHeight.
    const view = viewportSize(ref.current);

    let left = anchor.right + 8;
    if (left + WIDTH > view.width - MARGIN) {
      left = anchor.left - WIDTH - 8;
    }
    if (left < MARGIN) {
      left = Math.min(
        Math.max(MARGIN, anchor.left),
        view.width - WIDTH - MARGIN
      );
    }

    const top = Math.max(
      MARGIN,
      Math.min(anchor.top, view.height - height - MARGIN)
    );

    setPosition({ left, top });
  }, [anchor, mounted, description, error]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };

    window.addEventListener("keydown", onKey);
    // Deferred so the click that opened this popover doesn't close it.
    const id = window.setTimeout(
      () => window.addEventListener("pointerdown", onPointer),
      0
    );

    return () => {
      window.clearTimeout(id);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose]);

  if (!mounted) return null;

  async function patch(next: EventPatch, revert: () => void) {
    setSaving(true);
    setError(null);
    const message = await onPatch(event.id, next);
    setSaving(false);
    if (message) {
      setError(message);
      revert();
    }
  }

  const readOnly = !event.canEdit;

  const meetingCard = (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
      onPointerDown={(e) => e.stopPropagation()}
      className="overlay fixed z-[95] overflow-hidden"
      style={{ left: position.left, top: position.top, width: WIDTH }}
    >
      {/* The meeting's colour across the top: the same fill it has on the grid. */}
      <div
        className="flex items-start gap-2 px-3.5 pb-2.5 pt-3 text-white"
        style={{ backgroundColor: `color-mix(in oklab, ${event.color} 72%, #000)` }}
      >
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-[0.14em] text-white/70">
            Meeting{event.organizerName && ` · ${event.organizerName}`}
          </p>
          <p className="mt-0.5 text-[15px] font-semibold leading-snug">{event.title}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded p-1 text-white/70 transition-colors hover:text-white"
        >
          <X size={13} />
        </button>
      </div>
      <div className="max-h-[calc(0.6*var(--vh))] overflow-y-auto p-3.5">
        <MeetingDetails
          event={event}
          onEdit={() => onEditMeeting(event)}
          onChanged={() => {
            onChanged();
          }}
        />
      </div>
    </motion.div>
  );

  // Someone else's private time: that it is taken, and nothing else.
  const busyCard = (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
      onPointerDown={(e) => e.stopPropagation()}
      className="overlay fixed z-[95] p-3"
      style={{ left: position.left, top: position.top, width: WIDTH }}
    >
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-medium">Busy</p>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-faint hover:text-foreground">
          <X size={13} />
        </button>
      </div>
      <p className="mt-1 text-[12px] tabular-nums text-muted-foreground">
        {formatIST(new Date(event.startAt), { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
        {" – "}
        {formatIST(new Date(event.endAt), { hour: "2-digit", minute: "2-digit" })}
      </p>
      <p className="mt-2 text-[11px] text-faint">
        {event.ownerName} marked this private, so only the time shows.
      </p>
    </motion.div>
  );

  if (event.isMeeting) return createPortal(meetingCard, document.body);
  if (event.busy) return createPortal(busyCard, document.body);

  const card = (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
      onPointerDown={(e) => e.stopPropagation()}
      className="overlay fixed z-[95] p-3"
      style={{ left: position.left, top: position.top, width: WIDTH }}
    >
      <div className="mb-2 flex items-start gap-2">
        <span
          className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: event.color }}
        />
        <input
          value={title}
          disabled={readOnly || saving}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title.trim() === event.title) return;
            patch({ title }, () => setTitle(event.title));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className={`${ghostField} font-medium`}
        />
        <button
          type="button"
          onClick={onClose}
          className="mt-1 shrink-0 rounded p-1 text-faint transition-colors hover:text-foreground"
        >
          <X size={13} />
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <Line icon={<Clock size={12} />}>
          {readOnly ? (
            <span className="px-1.5 text-[13px] text-muted-foreground">
              {formatIST(new Date(event.startAt), {
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
              {" – "}
              {formatIST(new Date(event.endAt), {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          ) : (
            <div className="flex w-full items-center gap-1">
              <DateTimeField
                value={startAt}
                disabled={saving}
                onChange={setStartAt}
                defaultHour={9}
                onCommit={(next) => {
                  if (next === toLocalInput(event.startAt)) return;
                  patch({ startAt: next }, () =>
                    setStartAt(toLocalInput(event.startAt))
                  );
                }}
              />
              <span className="text-[13px] text-faint">→</span>
              <DateTimeField
                value={endAt}
                disabled={saving}
                onChange={setEndAt}
                defaultHour={10}
                onCommit={(next) => {
                  if (next === toLocalInput(event.endAt)) return;
                  patch({ endAt: next }, () =>
                    setEndAt(toLocalInput(event.endAt))
                  );
                }}
                className={ghostField}
              />
            </div>
          )}
        </Line>

        <Line icon={<MapPin size={12} />}>
          <input
            value={location}
            disabled={readOnly || saving}
            placeholder={readOnly ? "No location" : "Add a location"}
            onChange={(e) => setLocation(e.target.value)}
            onBlur={() => {
              if (location === event.location) return;
              patch({ location }, () => setLocation(event.location));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className={ghostField}
          />
        </Line>

        <Line icon={<CalendarDays size={12} />}>
          <span className="px-1.5 text-[13px] text-muted-foreground">
            {event.calendarName}
            {!event.isOwnCalendar && ` · ${event.ownerName}`}
          </span>
        </Line>

        <Line icon={<Link2 size={12} />}>
          {readOnly ? (
            <span className="px-1.5 text-[13px] text-muted-foreground">
              {event.taskTitle ?? "No linked task"}
            </span>
          ) : (
            <select
              value={event.taskId ?? ""}
              disabled={saving}
              onChange={(e) => patch({ taskId: e.target.value || null }, () => {})}
              className={ghostField}
            >
              <option value="">No linked task</option>
              {event.taskId && event.taskTitle && !openTasks.some((t) => t.id === event.taskId) && (
                <option value={event.taskId}>{event.taskTitle}</option>
              )}
              {openTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          )}
        </Line>

        {event.attendees.length > 0 && (
          <Line icon={<Users size={12} />}>
            <span className="px-1.5 text-[13px] text-muted-foreground">
              {event.attendees.map((a) => a.name).join(", ")}
            </span>
          </Line>
        )}

        <textarea
          value={description}
          disabled={readOnly || saving}
          rows={2}
          placeholder={readOnly ? "" : "Add a description"}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => {
            if (description === event.description) return;
            patch({ description }, () => setDescription(event.description));
          }}
          className={`${ghostField} mt-1 resize-none`}
        />
      </div>

      {error && (
        <p className="mt-2 px-1.5 text-[12px] text-[var(--status-red)]">
          {error}
        </p>
      )}

      {event.canEdit && (
        <div className="mt-3 flex items-center justify-between border-t border-[color-mix(in_oklab,white_7%,transparent)] pt-2.5">
          <span className="px-1 text-[11px] text-faint">
            {saving ? "Saving…" : "Changes save as you go"}
          </span>
          <button
            type="button"
            disabled={saving}
            onClick={async () => {
              if (!confirming) {
                setConfirming(true);
                window.setTimeout(() => setConfirming(false), 3000);
                return;
              }
              const message = await onDelete(event.id);
              if (message) setError(message);
              else onClose();
            }}
            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] transition-colors ${
              confirming
                ? "bg-[color-mix(in_oklab,var(--status-red)_18%,transparent)] text-[var(--status-red)]"
                : "text-faint hover:text-[var(--status-red)]"
            }`}
          >
            <Trash2 size={12} />
            {confirming ? "Delete for good?" : "Delete"}
          </button>
        </div>
      )}
    </motion.div>
  );

  return createPortal(card, document.body);
}

function Line({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
