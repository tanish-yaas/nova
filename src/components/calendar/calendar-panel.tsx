"use client";

import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Check, Eye, EyeOff, Share2, UserPlus, X } from "lucide-react";
import { useToast } from "@/components/ui/toast";
import {
  revokeCalendarShare,
  shareCalendar,
} from "@/server/actions/calendar-shares";
import type { CalendarOption } from "./types";
import { viewportSize, type AnchorRect } from "@/lib/ui-scale";

const WIDTH = 300;

const ACCESS_LABEL: Record<string, string> = {
  VIEW: "Can view",
  COMMENT: "Can comment",
  EDIT: "Can edit",
  FULL_ACCESS: "Full access",
};

const field = "field";

export function CalendarPanel({
  anchor,
  calendars,
  hidden,
  members,
  canShare,
  showTasks,
  taskCount,
  onToggleTasks,
  onToggle,
  onClose,
}: {
  anchor: AnchorRect;
  calendars: CalendarOption[];
  hidden: Set<string>;
  members: { userId: string; name: string }[];
  canShare: boolean;
  showTasks: boolean;
  taskCount: number;
  onToggleTasks: () => void;
  onToggle: (calendarId: string) => void;
  onClose: () => void;
}) {
  const { push } = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState({ left: -9999, top: -9999 });
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [level, setLevel] = useState("VIEW");
  const [pending, startTransition] = useTransition();

  useEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    if (!mounted) return;
    const height = ref.current?.offsetHeight ?? 320;
    // Measured in the scaled root's space, to match the anchor and offsetHeight.
    const view = viewportSize(ref.current);

    setPosition({
      left: Math.max(
        12,
        Math.min(anchor.right - WIDTH, view.width - WIDTH - 12)
      ),
      top: Math.min(anchor.bottom + 8, view.height - height - 12),
    });
  }, [anchor, mounted, sharingId, calendars]);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    const id = window.setTimeout(
      () => window.addEventListener("pointerdown", onPointer),
      0
    );
    window.addEventListener("keydown", onKey);

    return () => {
      window.clearTimeout(id);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!mounted) return null;

  function share(calendarId: string) {
    if (!target) return;
    startTransition(async () => {
      const result = await shareCalendar(calendarId, target, level);
      if (!result.ok) {
        push(result.error, "error");
        return;
      }
      setTarget("");
      push("Calendar shared");
    });
  }

  function revoke(shareId: string) {
    startTransition(async () => {
      const result = await revokeCalendarShare(shareId);
      if (!result.ok) {
        push(result.error, "error");
        return;
      }
      push("Access revoked");
    });
  }

  const panel = (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className="overlay fixed z-[94] max-h-[calc(0.7*var(--vh))] overflow-y-auto p-3"
      style={{ left: position.left, top: position.top, width: WIDTH }}
    >
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-[0.12em] text-faint">
          Calendars
        </p>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-faint transition-colors hover:text-foreground"
        >
          <X size={13} />
        </button>
      </div>

      <div className="flex flex-col gap-0.5">
        {calendars.map((calendar) => {
          const visible = !hidden.has(calendar.id);

          return (
            <div key={calendar.id}>
              <div className="group flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-[color-mix(in_oklab,white_5%,transparent)]">
                <button
                  type="button"
                  onClick={() => onToggle(calendar.id)}
                  title={visible ? "Hide from views" : "Show in views"}
                  className="flex shrink-0 items-center"
                >
                  <span
                    className="flex h-3.5 w-3.5 items-center justify-center rounded border transition-colors"
                    style={{
                      backgroundColor: visible ? calendar.color : "transparent",
                      borderColor: calendar.color,
                    }}
                  >
                    {visible && <Check size={9} className="text-white" />}
                  </span>
                </button>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px]">{calendar.name}</p>
                  {!calendar.isOwn && (
                    <p className="truncate text-[11px] text-faint">
                      {calendar.ownerName}
                    </p>
                  )}
                </div>

                <span className="hover-action shrink-0">
                  {visible ? <Eye size={12} /> : <EyeOff size={12} />}
                </span>

                {canShare && calendar.canShare && (
                  <button
                    type="button"
                    onClick={() =>
                      setSharingId((id) => (id === calendar.id ? null : calendar.id))
                    }
                    title="Share this calendar"
                    className={`shrink-0 rounded p-1 transition-colors ${
                      sharingId === calendar.id
                        ? "text-[var(--primary)]"
                        : "text-faint hover:text-foreground"
                    }`}
                  >
                    <Share2 size={12} />
                  </button>
                )}
              </div>

              {sharingId === calendar.id && (
                <div className="mb-1 ml-6 rounded-xl border border-[color-mix(in_oklab,var(--primary)_35%,transparent)] bg-[color-mix(in_oklab,var(--primary)_6%,transparent)] px-2 py-2">
                  {calendar.shares.length > 0 && (
                    <div className="mb-2 flex flex-col gap-1">
                      {calendar.shares.map((row) => (
                        <div
                          key={row.id}
                          className="flex items-center gap-2 text-[11px]"
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {row.name}
                          </span>
                          <span className="shrink-0 text-[10px] text-faint">
                            {ACCESS_LABEL[row.accessLevel] ?? row.accessLevel}
                          </span>
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => revoke(row.id)}
                            className="shrink-0 text-faint transition-colors hover:text-[var(--status-red)]"
                            aria-label={`Revoke ${row.name}`}
                          >
                            <X size={11} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-col gap-1.5">
                    <select
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                      className={field}
                    >
                      <option value="">Share with…</option>
                      {members
                        .filter(
                          (m) =>
                            !calendar.shares.some((s) => s.userId === m.userId)
                        )
                        .map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {m.name}
                          </option>
                        ))}
                    </select>

                    <select
                      value={level}
                      onChange={(e) => setLevel(e.target.value)}
                      className={field}
                    >
                      {Object.entries(ACCESS_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      disabled={pending || !target}
                      onClick={() => share(calendar.id)}
                      className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-primary px-3 text-[12px] font-medium text-primary-foreground disabled:opacity-40"
                    >
                      <UserPlus size={11} />
                      Share it
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Tasks are drawn on the calendar but live on no calendar, so they need
          their own switch — otherwise hiding every calendar leaves the grid
          full of task chips and the checkboxes look broken. */}
      <div className="mt-1 border-t border-[color-mix(in_oklab,white_7%,transparent)] pt-1">
        <div className="group flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-[color-mix(in_oklab,white_5%,transparent)]">
          <button
            type="button"
            onClick={onToggleTasks}
            title={showTasks ? "Hide task chips" : "Show task chips"}
            className="flex shrink-0 items-center"
          >
            <span
              className="flex h-3.5 w-3.5 items-center justify-center rounded border transition-colors"
              style={{
                backgroundColor: showTasks ? "var(--primary)" : "transparent",
                borderColor: "var(--primary)",
              }}
            >
              {showTasks && <Check size={9} className="text-white" />}
            </span>
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px]">Tasks</p>
            <p className="truncate text-[11px] text-faint">
              {taskCount} in view
            </p>
          </div>

          <span className="hover-action shrink-0">
            {showTasks ? <Eye size={12} /> : <EyeOff size={12} />}
          </span>
        </div>
      </div>

      {calendars.some((c) => !c.isOwn) && (
        <p className="mt-2 border-t border-[color-mix(in_oklab,white_7%,transparent)] pt-2 text-[11px] text-faint">
          Events are coloured by whose calendar they live on.
        </p>
      )}
    </motion.div>
  );

  return createPortal(panel, document.body);
}
