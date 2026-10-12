"use client";

import { useState, useTransition } from "react";
import {
  Building2,
  Check,
  CircleHelp,
  Clock,
  ExternalLink,
  Pencil,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { useToast } from "@/components/ui/toast";
import { cancelMeeting, respondToMeeting } from "@/server/actions/meetings";
import { formatIST } from "@/lib/dates";
import { RSVP_LABELS, placeLabel, type AttendeeStatus } from "@/lib/meetings";
import type { EventItem } from "@/components/calendar/types";

const STATUS_STYLE: Record<AttendeeStatus, { color: string; Icon: typeof Check }> = {
  ACCEPTED: { color: "var(--status-green)", Icon: Check },
  TENTATIVE: { color: "var(--status-amber)", Icon: CircleHelp },
  DECLINED: { color: "var(--status-red)", Icon: X },
  NEEDS_ACTION: { color: "var(--text-faint)", Icon: Clock },
};

export function meetingTimeLabel(event: EventItem): string {
  const start = new Date(event.startAt);
  const end = new Date(event.endAt);
  const day = formatIST(start, { weekday: "short", day: "2-digit" });
  const t = (d: Date) => formatIST(d, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${day} · ${t(start)}–${t(end)}`;
}

/**
 * A meeting, read: when, where (with the link one click away), who is coming
 * and what they said, the agenda, and the viewer's own answer. Shared by the
 * calendar popover and the Tasks list, so a meeting reads the same wherever
 * it is opened.
 */
export function MeetingDetails({
  event,
  onEdit,
  onChanged,
}: {
  event: EventItem;
  /** Organizer only. */
  onEdit?: () => void;
  /** After an answer or a cancel, so the page can refresh. */
  onChanged: () => void;
}) {
  const { push } = useToast();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState(event.myStatus);
  const [confirming, setConfirming] = useState(false);

  const ended = new Date(event.endAt) < new Date();
  const going = event.attendees.filter((a) => a.status === "ACCEPTED").length;

  function answer(next: Exclude<AttendeeStatus, "NEEDS_ACTION">) {
    const before = status;
    setStatus(next);
    startTransition(async () => {
      const result = await respondToMeeting(event.id, next);
      if (!result.ok) {
        setStatus(before);
        push(result.error, "error");
        return;
      }
      onChanged();
    });
  }

  function cancel() {
    if (!confirming) {
      setConfirming(true);
      window.setTimeout(() => setConfirming(false), 3000);
      return;
    }
    startTransition(async () => {
      const result = await cancelMeeting(event.id);
      if (!result.ok) {
        push(result.error, "error");
        return;
      }
      push("Meeting cancelled");
      onChanged();
    });
  }

  const PlaceIcon = event.mode === "online" ? Video : Building2;

  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <div className="flex flex-col gap-1.5">
        <p className="flex items-center gap-2 text-muted-foreground">
          <Clock size={13} className="shrink-0" />
          <span className="tabular-nums">{meetingTimeLabel(event)}</span>
          {ended && <span className="text-[11px] text-faint">· ended</span>}
        </p>
        <p className="flex items-center gap-2 text-muted-foreground">
          <PlaceIcon size={13} className="shrink-0" />
          <span className="min-w-0 truncate">
            {placeLabel(event.mode ?? "office", event.location, event.meetingUrl)}
          </span>
        </p>
      </div>

      {event.mode === "online" && event.meetingUrl && !ended && (
        <a
          href={event.meetingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-9 items-center justify-center gap-2 rounded-full text-[13px] font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: `color-mix(in oklab, ${event.color} 72%, #000)` }}
        >
          <Video size={14} />
          Join meeting
          <ExternalLink size={11} className="opacity-70" />
        </a>
      )}

      {event.myStatus !== null && !ended && (
        <div>
          <p className="mb-1.5 text-[11px] uppercase tracking-[0.12em] text-faint">Are you going?</p>
          <div className="flex gap-1">
            {(["ACCEPTED", "TENTATIVE", "DECLINED"] as const).map((s) => (
              <button
                key={s}
                type="button"
                disabled={pending}
                data-on={status === s}
                aria-pressed={status === s}
                onClick={() => answer(s)}
                className="pill pill-sm flex-1 justify-center"
              >
                {RSVP_LABELS[s]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <p className="mb-1.5 text-[11px] uppercase tracking-[0.12em] text-faint">
          People <span className="tabular-nums">{event.attendees.length}</span>
          {going > 0 && <span className="ml-1 normal-case tracking-normal">· {going} going</span>}
        </p>
        <ul className="flex flex-col gap-1">
          {event.attendees.map((a) => {
            const shown = a.status as AttendeeStatus;
            const { color, Icon } = STATUS_STYLE[shown] ?? STATUS_STYLE.NEEDS_ACTION;
            return (
              <li key={a.id} className="flex items-center gap-2">
                {/* The answer sits off the avatar's corner, not on it: on top it
                    hid the leg of an "R" and made Rahul read as a "P". */}
                <span className="relative mr-1">
                  <Avatar avatarUrl={a.avatarUrl} image={a.image} name={a.name} size={22} />
                  <span
                    className="absolute -bottom-1 -right-1.5 flex h-3 w-3 items-center justify-center rounded-full ring-2 ring-[var(--popover)]"
                    style={{ backgroundColor: color }}
                  >
                    <Icon size={7} strokeWidth={3} className="text-white" />
                  </span>
                </span>
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <span className="shrink-0 text-[11px] text-faint">
                  {a.isOrganizer ? "Organizer" : RSVP_LABELS[shown]}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {event.description && (
        <div>
          <p className="mb-1 text-[11px] uppercase tracking-[0.12em] text-faint">Agenda</p>
          <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">{event.description}</p>
        </div>
      )}

      {event.canEdit && (
        <div className="flex items-center gap-2 border-t border-[color-mix(in_oklab,white_7%,transparent)] pt-2.5">
          {onEdit && (
            <button type="button" onClick={onEdit} disabled={pending} className="pill pill-sm">
              <Pencil size={12} />
              Edit
            </button>
          )}
          <button
            type="button"
            onClick={cancel}
            disabled={pending}
            className={`ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] transition-colors ${
              confirming
                ? "bg-[color-mix(in_oklab,var(--status-red)_18%,transparent)] text-[var(--status-red)]"
                : "text-faint hover:text-[var(--status-red)]"
            }`}
          >
            <Trash2 size={12} />
            {confirming
              ? ended
                ? "Remove it?"
                : "Cancel for everyone?"
              : ended
                ? "Remove"
                : "Cancel meeting"}
          </button>
        </div>
      )}
    </div>
  );
}
