"use client";

import { useState } from "react";
import { Building2, Check, ExternalLink, Search, Video, X } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { DateTimeField } from "@/components/ui/datetime-field";
import { localInputFromKey } from "@/lib/dates";
import {
  DURATIONS,
  durationLabel,
  meetingProvider,
  normaliseMeetingUrl,
  type MeetingMode,
} from "@/lib/meetings";
import type { MeetingInput } from "@/lib/validators/meeting";
import { LabelPicker, type LabelOption } from "@/components/tasks/label-picker";

export type MeetingPerson = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  image: string | null;
};

export type MeetingFormValues = {
  title: string;
  agenda: string;
  /** "YYYY-MM-DDTHH:mm", read as IST. */
  startAt: string;
  durationMinutes: number;
  mode: MeetingMode;
  place: string;
  link: string;
  attendeeIds: string[];
  labelIds: string[];
};

/** The form's values as the meeting actions take them. */
export function toMeetingInput(v: MeetingFormValues): MeetingInput {
  const [day, time = "09:00"] = v.startAt.split("T");
  const [h, m] = time.split(":").map(Number);
  return {
    title: v.title,
    agenda: v.agenda,
    startAt: v.startAt,
    endAt: localInputFromKey(day, h * 60 + m + v.durationMinutes),
    mode: v.mode,
    place: v.place,
    link: v.link,
    attendeeIds: v.attendeeIds,
    labelIds: v.labelIds,
  };
}

/** Minutes between two "YYYY-MM-DDTHH:mm" values; both are IST wall-clock. */
export function minutesBetween(start: string, end: string): number {
  const toMs = (s: string) => {
    const [d, t = "00:00"] = s.split("T");
    const [y, mo, da] = d.split("-").map(Number);
    const [h, mi] = t.split(":").map(Number);
    return Date.UTC(y, mo - 1, da, h, mi);
  };
  return Math.round((toMs(end) - toMs(start)) / 60000);
}

const label = "mb-1.5 block text-[11px] uppercase tracking-[0.12em] text-faint";

/**
 * Everything a meeting needs, in the order people think about it: what, when
 * and for how long, who, where. The people list and the place picker are laid
 * out inline rather than as popovers, so the form works the same inside a
 * dialog, a side sheet or the tasks page.
 */
export function MeetingForm({
  initial,
  people,
  labels = [],
  selfId,
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus = true,
}: {
  initial: MeetingFormValues;
  people: MeetingPerson[];
  /** The workspace's labels, for tagging the meeting. */
  labels?: LabelOption[];
  selfId: string;
  submitLabel: string;
  onSubmit: (values: MeetingFormValues) => Promise<string | null>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [v, setV] = useState<MeetingFormValues>(initial);
  const [query, setQuery] = useState("");
  const [finding, setFinding] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Grows when a label is made from the picker, so it shows up straight away.
  const [labelOptions, setLabelOptions] = useState<LabelOption[]>(labels);

  const set = <K extends keyof MeetingFormValues>(key: K, value: MeetingFormValues[K]) =>
    setV((prev) => ({ ...prev, [key]: value }));

  const others = people.filter((p) => p.userId !== selfId);
  const chosen = others.filter((p) => v.attendeeIds.includes(p.userId));
  const q = query.trim().toLowerCase();
  const matches = others
    .filter((p) => !v.attendeeIds.includes(p.userId))
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .slice(0, 6);

  const durations = DURATIONS.includes(v.durationMinutes as (typeof DURATIONS)[number])
    ? [...DURATIONS]
    : [...DURATIONS, v.durationMinutes].sort((a, b) => a - b);

  const endLabel = (() => {
    const [, time = ""] = v.startAt.split("T");
    if (!time) return null;
    const [h, m] = time.split(":").map(Number);
    const total = h * 60 + m + v.durationMinutes;
    const end = `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    return total >= 1440 ? `${end} next day` : end;
  })();

  const linkOk = !v.link.trim() || normaliseMeetingUrl(v.link) !== null;
  const provider = v.link.trim() ? meetingProvider(normaliseMeetingUrl(v.link)) : null;

  function add(id: string) {
    set("attendeeIds", [...v.attendeeIds, id]);
    setQuery("");
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!linkOk) {
          setError("That link doesn't look like a web address");
          return;
        }
        setPending(true);
        setError(null);
        const message = await onSubmit(v);
        setPending(false);
        if (message) setError(message);
      }}
      className="flex flex-col gap-4"
    >
      <input
        value={v.title}
        onChange={(e) => set("title", e.target.value)}
        autoFocus={autoFocus}
        required
        maxLength={200}
        placeholder="What's the meeting about?"
        className="w-full bg-transparent text-[17px] font-medium outline-none placeholder:text-faint"
      />

      {/* Stacked, not side by side: next to six duration buttons the date
          box was squeezed until the date itself was cut off. */}
      <div className="grid gap-3">
        <div className="max-w-sm">
          <span className={label}>When</span>
          <DateTimeField
            value={v.startAt}
            onChange={(next) => set("startAt", next)}
            defaultHour={10}
            required
          />
        </div>
        <div>
          <span className={label}>
            How long{endLabel && <span className="ml-1.5 normal-case tracking-normal">· ends {endLabel}</span>}
          </span>
          <div className="flex flex-wrap gap-1">
            {durations.map((d) => (
              <button
                key={d}
                type="button"
                data-on={v.durationMinutes === d}
                onClick={() => set("durationMinutes", d)}
                className="pill pill-sm"
              >
                {d < 60 ? `${d}m` : d % 60 ? `${Math.floor(d / 60)}h${d % 60}` : `${d / 60}h`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div>
        <span className={label}>
          Who&apos;s coming
          {chosen.length > 0 && <span className="ml-1.5 tabular-nums">{chosen.length + 1}</span>}
        </span>
        <div className="rounded-xl border border-[color-mix(in_oklab,white_10%,transparent)] bg-[color-mix(in_oklab,var(--card)_70%,transparent)] p-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[color-mix(in_oklab,white_6%,transparent)] pl-1 pr-2.5 text-[12px] text-muted-foreground">
              {(() => {
                const me = people.find((p) => p.userId === selfId);
                return <Avatar avatarUrl={me?.avatarUrl} image={me?.image} name={me?.name} size={20} />;
              })()}
              You · organizer
            </span>
            {chosen.map((p) => (
              <span
                key={p.userId}
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[color-mix(in_oklab,var(--primary)_16%,transparent)] pl-1 pr-1 text-[12px]"
              >
                <Avatar avatarUrl={p.avatarUrl} image={p.image} name={p.name} size={20} />
                {p.name}
                <button
                  type="button"
                  onClick={() => set("attendeeIds", v.attendeeIds.filter((id) => id !== p.userId))}
                  aria-label={`Remove ${p.name}`}
                  className="flex h-5 w-5 items-center justify-center rounded-full text-faint transition-colors hover:bg-[color-mix(in_oklab,white_10%,transparent)] hover:text-foreground"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            <label className="flex min-w-[9rem] flex-1 items-center gap-1.5 px-1.5">
              <Search size={12} className="shrink-0 text-faint" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setFinding(true)}
                onBlur={() => window.setTimeout(() => setFinding(false), 150)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && matches[0]) {
                    e.preventDefault();
                    add(matches[0].userId);
                  }
                  if (e.key === "Backspace" && !query && v.attendeeIds.length) {
                    set("attendeeIds", v.attendeeIds.slice(0, -1));
                  }
                }}
                placeholder={others.length ? "Add people" : "Nobody else in this workspace yet"}
                disabled={others.length === 0}
                className="h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
              />
            </label>
          </div>

          {finding && matches.length > 0 && (
            <ul className="mt-1.5 border-t border-[color-mix(in_oklab,white_7%,transparent)] pt-1">
              {matches.map((p) => (
                <li key={p.userId}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => add(p.userId)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-[color-mix(in_oklab,white_5%,transparent)]"
                  >
                    <Avatar avatarUrl={p.avatarUrl} image={p.image} name={p.name} size={20} />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <span className="text-[11px] text-faint">Add</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div>
        <span className={label}>Where</span>
        <div className="mb-2 inline-flex rounded-full border border-[color-mix(in_oklab,white_11%,transparent)] p-0.5">
          {(
            [
              ["office", "In office", Building2],
              ["online", "Online", Video],
            ] as const
          ).map(([mode, text, Icon]) => (
            <button
              key={mode}
              type="button"
              data-on={v.mode === mode}
              aria-pressed={v.mode === mode}
              onClick={() => set("mode", mode)}
              className={
                v.mode === mode
                  ? "pill pill-sm"
                  : "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] text-faint transition-colors hover:text-foreground"
              }
            >
              <Icon size={13} />
              {text}
            </button>
          ))}
        </div>

        {v.mode === "office" ? (
          <input
            value={v.place}
            onChange={(e) => set("place", e.target.value)}
            maxLength={200}
            placeholder="Which room? Board room, 3rd floor (optional)"
            className="field"
          />
        ) : (
          <div>
            <input
              value={v.link}
              onChange={(e) => set("link", e.target.value)}
              maxLength={500}
              inputMode="url"
              placeholder="Paste a Google Meet, Zoom or Teams link"
              className="field"
              style={!linkOk ? { borderColor: "var(--status-red)" } : undefined}
            />
            <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
              {!linkOk ? (
                <span className="text-[var(--status-red)]">That doesn&apos;t look like a link</span>
              ) : provider ? (
                <span className="inline-flex items-center gap-1 text-[var(--status-green)]">
                  <Check size={11} /> {provider} link
                </span>
              ) : (
                <span>No link yet? Add it later and everyone sees it.</span>
              )}
              <a
                href="https://meet.new"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
              >
                Make a Google Meet <ExternalLink size={10} />
              </a>
            </p>
          </div>
        )}
      </div>

      <div>
        <span className={label}>Labels</span>
        <LabelPicker
          value={v.labelIds}
          options={labelOptions}
          onChange={(ids) => set("labelIds", ids)}
          onCreated={(created) => setLabelOptions((prev) => [...prev, created])}
        />
      </div>

      <div>
        <span className={label}>Agenda</span>
        <textarea
          value={v.agenda}
          onChange={(e) => set("agenda", e.target.value)}
          rows={3}
          maxLength={5000}
          placeholder="What should people come ready to discuss?"
          className="field resize-none"
        />
      </div>

      {error && <p className="text-[12px] text-[var(--status-red)]">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || !v.title.trim()}
          className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-all hover:opacity-90 active:scale-[0.97] disabled:opacity-50"
        >
          {pending ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-[12px] text-faint transition-colors hover:text-foreground"
          >
            Cancel
          </button>
        )}
        <span className="ml-auto text-[11px] text-faint">
          {durationLabel(v.durationMinutes)}
          {chosen.length > 0 && ` · ${chosen.length} invited`}
        </span>
      </div>
    </form>
  );
}
