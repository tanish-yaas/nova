"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search, Users } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { toZoomed, viewportSize, type AnchorRect } from "@/lib/ui-scale";
import type { CalendarPerson } from "./types";

const WIDTH = 288;

/**
 * Whose calendars are on screen. Every member can look at every calendar;
 * this only picks which ones to draw. Each person is listed with the colour
 * their events are drawn in, which makes this the legend as well as the
 * filter.
 *
 * Changes are held until the panel closes, so ticking four people is one
 * trip to the server rather than four.
 */
export function CalendarPeoplePicker({
  people,
  inView,
  selfId,
  onChange,
}: {
  people: CalendarPerson[];
  /** "all" for everyone. */
  inView: string[] | "all";
  selfId: string;
  onChange: (next: string[] | "all") => void;
}) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);

  const ids = inView === "all" ? people.map((p) => p.userId) : inView;
  const solo = ids.length === 1 ? people.find((p) => p.userId === ids[0]) : undefined;
  const text =
    inView === "all"
      ? "Everyone"
      : solo
        ? solo.userId === selfId
          ? "My calendar"
          : solo.name
        : `${ids.length} people`;

  return (
    <>
      <button
        type="button"
        data-on={!(solo && solo.userId === selfId)}
        onClick={(e) => {
          const rect = toZoomed(e.currentTarget.getBoundingClientRect(), e.currentTarget);
          setAnchor((current) => (current ? null : rect));
        }}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        title="Look at anyone's calendar"
        className="pill max-w-[14rem]"
      >
        {solo ? (
          <Avatar avatarUrl={solo.avatarUrl} image={solo.image} name={solo.name} size={18} />
        ) : (
          <span className="flex -space-x-1.5">
            {people
              .filter((p) => ids.includes(p.userId))
              .slice(0, 3)
              .map((p) => (
                <span
                  key={p.userId}
                  className="h-3 w-3 rounded-full ring-2 ring-[var(--card)]"
                  style={{ backgroundColor: p.color }}
                />
              ))}
          </span>
        )}
        <span className="truncate">{text}</span>
        <ChevronDown size={13} className="shrink-0 opacity-60" />
      </button>

      {anchor && (
        <Panel
          anchor={anchor}
          people={people}
          inView={inView}
          selfId={selfId}
          onChange={onChange}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}

function Panel({
  anchor,
  people,
  inView,
  selfId,
  onChange,
  onClose,
}: {
  anchor: AnchorRect;
  people: CalendarPerson[];
  inView: string[] | "all";
  selfId: string;
  onChange: (next: string[] | "all") => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: -9999, top: -9999 });
  const [query, setQuery] = useState("");
  const initial = inView === "all" ? people.map((p) => p.userId) : inView;
  const [draft, setDraft] = useState<string[]>(initial);
  const draftRef = useRef(initial);

  // The panel only exists after a click, so there is always a document.
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 360;
    const view = viewportSize(ref.current);
    setPosition({
      left: Math.max(12, Math.min(anchor.left, view.width - WIDTH - 12)),
      top: Math.min(anchor.bottom + 8, view.height - height - 12),
    });
  }, [anchor]);

  useEffect(() => {
    const close = () => {
      const next = draftRef.current;
      const all = next.length === people.length;
      const before = inView === "all" ? people.map((p) => p.userId) : inView;
      const same = next.length === before.length && next.every((id) => before.includes(id));
      if (!same) onChange(all && people.length > 1 ? "all" : next.length ? next : [selfId]);
      onClose();
    };
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") close();
    };
    const id = window.setTimeout(() => window.addEventListener("pointerdown", onPointer), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [inView, onChange, onClose, people, selfId]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? people.filter((p) => p.name.toLowerCase().includes(q)) : people;
  }, [people, query]);

  const apply = (next: string[]) => {
    draftRef.current = next;
    setDraft(next);
  };
  const toggle = (id: string) => {
    const d = draftRef.current;
    apply(d.includes(id) ? d.filter((x) => x !== id) : [...d, id]);
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Whose calendars to show"
      className="overlay fixed z-[94] flex max-h-[calc(0.7*var(--vh))] flex-col p-2"
      style={{ left: position.left, top: position.top, width: WIDTH }}
    >
      <div className="mb-1.5 flex gap-1">
        <button
          type="button"
          data-on={draft.length === 1 && draft[0] === selfId}
          onClick={() => apply([selfId])}
          className="pill pill-sm flex-1 justify-center"
        >
          Just me
        </button>
        <button
          type="button"
          data-on={draft.length === people.length}
          onClick={() => apply(people.map((p) => p.userId))}
          className="pill pill-sm flex-1 justify-center"
        >
          <Users size={12} />
          Everyone
        </button>
      </div>

      {people.length > 7 && (
        <label className="mb-1 flex items-center gap-2 rounded-lg border border-[color-mix(in_oklab,white_9%,transparent)] px-2.5 py-1.5">
          <Search size={12} className="shrink-0 text-faint" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find someone"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
          />
        </label>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.map((p) => {
          const on = draft.includes(p.userId);
          return (
            <div
              key={p.userId}
              className="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-[color-mix(in_oklab,white_5%,transparent)]"
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(p.userId)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span
                  className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors"
                  style={{ backgroundColor: on ? p.color : "transparent", borderColor: p.color }}
                >
                  {on && <Check size={9} className="text-white" />}
                </span>
                <Avatar avatarUrl={p.avatarUrl} image={p.image} name={p.name} size={18} />
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {p.name}
                  {p.userId === selfId && <span className="text-faint"> · you</span>}
                </span>
              </button>
              <button
                type="button"
                onClick={() => apply([p.userId])}
                className="hover-action shrink-0 text-[11px]"
                title={`Only ${p.name}`}
              >
                Only
              </button>
            </div>
          );
        })}
      </div>

      <p className="mt-1.5 border-t border-[color-mix(in_oklab,white_7%,transparent)] px-2 pt-1.5 text-[11px] leading-relaxed text-faint">
        Everyone in the workspace can see everyone&apos;s calendar. Private events show as busy.
      </p>
    </div>,
    document.body
  );
}
