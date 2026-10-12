"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckSquare, Users } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import { scheduleMeeting } from "@/server/actions/meetings";
import { MeetingForm, toMeetingInput, type MeetingPerson } from "./meeting-form";
import { blankMeeting, nextHalfHour } from "./meeting-dialog";

/**
 * The top of the Tasks tab: add a task, or schedule a meeting, from the same
 * place. The task composers arrive as children so the page keeps rendering
 * them exactly as before; the meeting form is the same one the calendar uses.
 */
export function ComposeSwitch({
  people,
  selfId,
  todayKey,
  children,
}: {
  people: MeetingPerson[];
  selfId: string;
  todayKey: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { push } = useToast();
  const [mode, setMode] = useState<"task" | "meeting">("task");
  // Bumped after each save so the form comes back empty for the next one.
  const [round, setRound] = useState(0);

  const start = nextHalfHour(todayKey);

  return (
    <div className="flex flex-col gap-2">
      <div className="inline-flex self-start rounded-full border border-[color-mix(in_oklab,white_11%,transparent)] p-0.5">
        {(
          [
            ["task", "Task", CheckSquare],
            ["meeting", "Meeting", Users],
          ] as const
        ).map(([key, text, Icon]) => (
          <button
            key={key}
            type="button"
            data-on={mode === key}
            aria-pressed={mode === key}
            onClick={() => setMode(key)}
            className={
              mode === key
                ? "pill pill-sm"
                : "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] text-faint transition-colors hover:text-foreground"
            }
          >
            <Icon size={13} />
            {text}
          </button>
        ))}
      </div>

      {mode === "task" ? (
        children
      ) : (
        <div className="glass rounded-xl px-4 py-4">
          <MeetingForm
            key={round}
            initial={blankMeeting(start.dayKey, start.minutes)}
            people={people}
            selfId={selfId}
            submitLabel="Schedule meeting"
            onSubmit={async (values) => {
              const result = await scheduleMeeting(toMeetingInput(values));
              if (!result.ok) return result.error;
              push(values.attendeeIds.length ? "Meeting scheduled, invites sent" : "Meeting scheduled");
              setRound((r) => r + 1);
              router.refresh();
              return null;
            }}
          />
        </div>
      )}
    </div>
  );
}
