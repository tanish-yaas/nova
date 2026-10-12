"use client";

import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { toLocalInput, localInputFromKey } from "@/lib/dates";
import { meetingMode } from "@/lib/meetings";
import type { EventItem } from "@/components/calendar/types";
import type { LabelOption } from "@/components/tasks/label-picker";
import {
  MeetingForm,
  minutesBetween,
  type MeetingFormValues,
  type MeetingPerson,
} from "./meeting-form";

/** A blank meeting starting at a given IST day and minute. */
export function blankMeeting(dayKey: string, startMinutes: number, durationMinutes = 30): MeetingFormValues {
  return {
    title: "",
    agenda: "",
    startAt: localInputFromKey(dayKey, startMinutes),
    durationMinutes,
    mode: "office",
    place: "",
    link: "",
    attendeeIds: [],
    labelIds: [],
  };
}

/** The next half hour from now, in IST: where a meeting starts by default. */
export function nextHalfHour(todayKey: string): { dayKey: string; minutes: number } {
  const now = toLocalInput(new Date());
  const [, time] = now.split("T");
  const [h, m] = time.split(":").map(Number);
  const minutes = Math.ceil((h * 60 + m + 1) / 30) * 30;
  return minutes >= 24 * 60 - 30
    ? { dayKey: todayKey, minutes: 10 * 60 }
    : { dayKey: todayKey, minutes };
}

/** An existing meeting, back into the form's shape for editing. */
export function meetingValues(event: EventItem): MeetingFormValues {
  const mode = event.mode ?? meetingMode(event.location, event.meetingUrl);
  const start = toLocalInput(event.startAt);
  const place = mode === "office" && event.location !== "Office" ? event.location : "";
  return {
    title: event.title,
    agenda: event.description,
    startAt: start,
    durationMinutes: Math.max(5, minutesBetween(start, toLocalInput(event.endAt))),
    mode,
    place,
    link: event.meetingUrl,
    attendeeIds: event.attendees.filter((a) => !a.isOrganizer && a.userId).map((a) => a.userId!),
    labelIds: event.labels.map((l) => l.id),
  };
}

/**
 * The meeting form in a dialog over whatever page asked for it. Portalled to
 * the body: the calendar and the task sheet both sit inside backdrop-filter
 * parents, which would trap a fixed overlay.
 */
export function MeetingDialog({
  open,
  heading,
  initial,
  people,
  labels,
  selfId,
  submitLabel,
  note,
  onSubmit,
  onClose,
}: {
  open: boolean;
  heading: string;
  initial: MeetingFormValues;
  people: MeetingPerson[];
  labels?: LabelOption[];
  selfId: string;
  submitLabel: string;
  /** A line under the heading, e.g. what happens to the task being converted. */
  note?: string;
  onSubmit: (values: MeetingFormValues) => Promise<string | null>;
  onClose: () => void;
}) {
  // True once on the client, without a render-then-effect round trip.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A dropdown open inside the form (labels) takes this Escape for itself.
      if (document.querySelector('[data-layer="dropdown"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={onClose}
          className="fixed inset-0 z-[97] flex items-start justify-center overflow-y-auto bg-black/55 px-4 py-[calc(0.08*var(--vh))]"
        >
          <motion.div
            role="dialog"
            aria-label={heading}
            data-layer="dialog"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="overlay w-full max-w-lg px-5 py-4"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.12em] text-faint">{heading}</p>
                {note && <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{note}</p>}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="rounded p-1 text-faint transition-colors hover:text-foreground"
              >
                <X size={14} />
              </button>
            </div>
            <MeetingForm
              initial={initial}
              people={people}
              labels={labels}
              selfId={selfId}
              submitLabel={submitLabel}
              onSubmit={onSubmit}
              onCancel={onClose}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
