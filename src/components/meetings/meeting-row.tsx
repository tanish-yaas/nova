"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, ChevronDown, Video } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { useToast } from "@/components/ui/toast";
import { updateMeeting } from "@/server/actions/meetings";
import { formatIST } from "@/lib/dates";
import { RSVP_LABELS, placeLabel } from "@/lib/meetings";
import type { EventItem } from "@/components/calendar/types";
import { MeetingDetails } from "./meeting-details";
import { MeetingDialog, meetingValues } from "./meeting-dialog";
import { toMeetingInput, type MeetingPerson } from "./meeting-form";

const t = (iso: string) =>
  formatIST(new Date(iso), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * A meeting in the task list. Tasks are quiet rows with a checkbox; a
 * meeting is the whole row filled with its colour, time first, so a day's
 * fixed points stand out from the work around them. Click to open it in
 * place: join link, who is coming, the agenda, your answer.
 */
export function MeetingRow({
  event,
  people,
  selfId,
  showDay = false,
}: {
  event: EventItem;
  people: MeetingPerson[];
  selfId: string;
  /** In "Upcoming", the day matters as much as the time. */
  showDay?: boolean;
}) {
  const router = useRouter();
  const { push } = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  // Read once per mount; the page refreshes often enough to move "Now" along.
  const [now] = useState(() => Date.now());
  const ended = new Date(event.endAt).getTime() < now;
  const live = !ended && new Date(event.startAt).getTime() <= now;
  const declined = event.myStatus === "DECLINED";
  const fill = `color-mix(in oklab, ${event.color} 72%, #000)`;

  const others = event.attendees.filter((a) => a.userId !== selfId);

  return (
    <div className={`my-1 overflow-hidden rounded-xl ${ended || declined ? "opacity-55" : ""}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-2.5 py-2 text-left text-white transition-[filter] hover:brightness-110"
        style={{ backgroundColor: fill }}
      >
        <span className="flex w-[3.25rem] shrink-0 flex-col items-center rounded-lg bg-black/20 py-1 leading-tight">
          {showDay && (
            <span className="text-[9px] uppercase tracking-[0.1em] text-white/70">
              {formatIST(new Date(event.startAt), { weekday: "short" })}
            </span>
          )}
          <span className="text-[12px] font-semibold tabular-nums">{t(event.startAt)}</span>
        </span>

        <span className="min-w-0 flex-1">
          <span className={`block truncate text-[13px] font-medium ${declined ? "line-through" : ""}`}>
            {event.title}
          </span>
          <span className="flex items-center gap-1.5 truncate text-[11px] text-white/75">
            {event.mode === "online" ? <Video size={11} /> : <Building2 size={11} />}
            <span className="truncate">
              {placeLabel(event.mode ?? "office", event.location, event.meetingUrl)} · until {t(event.endAt)}
              {showDay && ` · ${formatIST(new Date(event.startAt), { day: "2-digit" })}`}
            </span>
          </span>
        </span>

        {live && (
          <span className="shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em]">
            Now
          </span>
        )}
        {!live && event.myStatus === "NEEDS_ACTION" && !ended && (
          <span className="shrink-0 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-medium">
            Reply
          </span>
        )}
        {event.myStatus && event.myStatus !== "NEEDS_ACTION" && event.myStatus !== "ACCEPTED" && (
          <span className="shrink-0 text-[11px] text-white/80">{RSVP_LABELS[event.myStatus]}</span>
        )}

        {others.length > 0 && (
          <span className="hidden shrink-0 -space-x-1.5 sm:flex">
            {others.slice(0, 3).map((a) => (
              <span key={a.id} className="rounded-full ring-2" style={{ ["--tw-ring-color" as string]: fill }}>
                <Avatar avatarUrl={a.avatarUrl} image={a.image} name={a.name} size={20} />
              </span>
            ))}
            {others.length > 3 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-black/30 px-1 text-[10px] tabular-nums">
                +{others.length - 3}
              </span>
            )}
          </span>
        )}

        <ChevronDown size={14} className={`shrink-0 text-white/70 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          className="border-x border-b px-3.5 py-3"
          style={{
            borderColor: `color-mix(in oklab, ${event.color} 40%, transparent)`,
            backgroundColor: `color-mix(in oklab, ${event.color} 7%, var(--card))`,
          }}
        >
          <MeetingDetails
            event={event}
            onEdit={() => setEditing(true)}
            onChanged={() => router.refresh()}
          />
        </div>
      )}

      <MeetingDialog
        open={editing}
        heading="Edit meeting"
        initial={meetingValues(event)}
        people={people}
        selfId={selfId}
        submitLabel="Save changes"
        note="Anyone you add gets an invite. If the time or place changes, everyone already on it is told."
        onSubmit={async (values) => {
          const result = await updateMeeting(event.id, toMeetingInput(values));
          if (!result.ok) return result.error;
          push("Meeting updated");
          setEditing(false);
          router.refresh();
          return null;
        }}
        onClose={() => setEditing(false)}
      />
    </div>
  );
}
