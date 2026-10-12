"use client";
import {
  useWorkspaceLink,
  useWorkspaceKey,
} from "@/components/workspace/use-workspace";

import { useEffect, useMemo, useOptimistic, useState, useTransition } from "react";
import Link from "next/link";
import { Building2, Check, ChevronRight, Flag, Plus, Users, Video } from "lucide-react";
import dynamic from "next/dynamic";
import { useToast } from "@/components/ui/toast";
import { setTaskStatus } from "@/server/actions/tasks";
import {
  PeopleFilter,
  UNASSIGNED_ID,
  type BoardMember,
} from "./people-filter";

const PEOPLE_KEY = "yaas.board.people";

// Deferred: the sheet is the largest component in the app and the dashboard is
// the first page after login, so its JS should not be in that payload. It only
// mounts once a card is opened.
const TaskDetailSheet = dynamic(
  () =>
    import("@/components/tasks/task-detail-sheet").then(
      (m) => m.TaskDetailSheet
    ),
  { ssr: false }
);
import {
  accentFor,
  BOARD_COLUMNS,
  columnForStatus,
  type BoardTask,
} from "./board-columns";

/**
 * Status board for the dashboard. Cards drag between columns and the drop
 * writes straight through to setTaskStatus.
 *
 * Dates arrive pre-formatted from the server. The app is pinned to IST and the
 * browser is not, so formatting here would both drift and mismatch on hydration.
 */
export function TaskBoard({
  tasks,
  members = [],
  selfId,
}: {
  tasks: BoardTask[];
  /** Empty unless the viewer's scope reaches other people's tasks. */
  members?: BoardMember[];
  selfId: string;
}) {
  const link = useWorkspaceLink();
  const peopleKey = useWorkspaceKey(PEOPLE_KEY);
  const { push } = useToast();
  const [, startTransition] = useTransition();

  // Defaults to just you, so the board opens the same as it did before the
  // filter existed. Persisted per viewer, like the calendar's hidden set.
  const [people, setPeople] = useState<Set<string>>(() => new Set([selfId]));

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(peopleKey);
      if (stored) {
        const ids = JSON.parse(stored) as string[];
        if (Array.isArray(ids) && ids.length > 0) setPeople(new Set(ids));
      }
    } catch {
      // A corrupt store just means the default selection stands.
    }
  }, [peopleKey]);

  function persist(next: Set<string>) {
    setPeople(next);
    try {
      window.localStorage.setItem(peopleKey, JSON.stringify([...next]));
    } catch {
      // Non-fatal — the selection still applies for this session.
    }
  }

  function togglePerson(userId: string) {
    const next = new Set(people);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    // Never leave the board with nothing selected and no way to tell why.
    if (next.size === 0) next.add(userId);
    persist(next);
  }

  // Optimistic so a drop lands instantly. revalidatePath inside the action
  // refreshes the server copy underneath, and this unwinds onto it.
  const [optimistic, moveOptimistic] = useOptimistic(
    tasks,
    (current: BoardTask[], move: { id: string; status: string }) =>
      current.map((t) => {
        if (t.id !== move.id) return t;

        // The chips follow the card into its new column, or a task dropped on
        // Completed keeps saying when it was due until the server copy lands.
        // The real labels arrive with revalidatePath a moment later.
        const done = move.status === "DONE";
        return {
          ...t,
          status: move.status,
          dueLabel: done ? null : t.dueLabel,
          doneLabel: done ? "Done today" : null,
        };
      })
  );

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const byColumn = useMemo(() => {
    const map = new Map<string, BoardTask[]>(
      BOARD_COLUMNS.map((c) => [c.key, []])
    );

    for (const task of optimistic) {
      // No filter for viewers without one. With it on, a task shows if any of
      // its assignees is selected — a shared task belongs on both boards — and
      // an unassigned one rides under its own entry rather than matching
      // nobody and vanishing.
      if (members.length > 0) {
        const shown =
          task.assigneeIds.length === 0
            ? people.has(UNASSIGNED_ID)
            : task.assigneeIds.some((id) => people.has(id));
        if (!shown) continue;
      }

      const column = columnForStatus(task.status);
      if (column) map.get(column)!.push(task);
    }

    return map;
  }, [optimistic, members.length, people]);

  function drop(columnKey: string) {
    const id = draggingId;
    setDraggingId(null);
    setOverColumn(null);
    if (!id) return;

    const task = optimistic.find((t) => t.id === id);
    if (!task) return;

    // Same column is a no-op rather than a write. It also preserves BLOCKED,
    // which shares the In progress column and would otherwise be flattened.
    if (columnForStatus(task.status) === columnKey) return;

    const nextStatus = BOARD_COLUMNS.find((c) => c.key === columnKey)?.writes;
    if (!nextStatus) return;

    startTransition(async () => {
      moveOptimistic({ id, status: nextStatus });
      const result = await setTaskStatus(id, nextStatus);
      if (result?.error) push(result.error, "error");
    });
  }

  return (
    <>
    {members.length > 0 && (
      <div className="mb-1.5 flex justify-end">
        <PeopleFilter
          members={members}
          selected={people}
          selfId={selfId}
          onToggle={togglePerson}
          onOnly={(userId) => persist(new Set([userId]))}
        />
      </div>
    )}

    {/* items-start so each column is as tall as its own cards. Stretching them
        to a common height is what left the dead space under the board. */}
    <div className="-mx-1 flex items-start gap-2.5 overflow-x-auto px-1 pb-1">
      {BOARD_COLUMNS.map((column) => {
        const items = byColumn.get(column.key) ?? [];
        const active = overColumn === column.key;

        return (
          <section
            key={column.key}
            // Highlight is driven off dragOver rather than enter/leave pairs:
            // those also fire for every card inside the column, and a counter
            // shared across columns desyncs as the pointer crosses between them.
            // dragOver repeats while the pointer is here, so it cannot drift.
            onDragOver={(e) => {
              e.preventDefault();
              if (overColumn !== column.key) setOverColumn(column.key);
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop(column.key);
            }}
            className={`flex w-[260px] shrink-0 flex-col rounded-xl border p-2 transition-colors ${
              active
                ? "border-[color-mix(in_oklab,var(--primary)_45%,transparent)] bg-[color-mix(in_oklab,var(--primary)_7%,transparent)]"
                : "border-[color-mix(in_oklab,white_7%,transparent)] bg-[color-mix(in_oklab,white_2%,transparent)]"
            }`}
          >
            <header className="mb-2 flex items-center gap-2 px-1">
              <span
                className="chip"
                style={{
                  backgroundColor: `color-mix(in oklab, ${column.color} 20%, transparent)`,
                  borderColor: `color-mix(in oklab, ${column.color} 42%, transparent)`,
                  color: `color-mix(in oklab, ${column.color} 55%, white)`,
                }}
              >
                {column.label}
              </span>
              <span className="text-[11px] tabular-nums text-faint">
                {items.length}
              </span>
            </header>

            {/* min-h keeps an empty column a big enough drop target to aim at. */}
            <div className="flex min-h-[52px] flex-col gap-1.5">
              {items.map((task) => (
                <Card
                  key={task.id}
                  task={task}
                  dragging={draggingId === task.id}
                  onDragStart={() => setDraggingId(task.id)}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setOverColumn(null);
                  }}
                  onOpen={() => setOpenId(task.id)}
                />
              ))}

              {items.length === 0 && (
                <p className="px-1 py-5 text-center text-[11px] text-faint">
                  {active ? "Drop here" : "Nothing here"}
                </p>
              )}
            </div>

            <Link
              href={link("/tasks")}
              className="mt-1.5 flex items-center gap-1.5 rounded-lg px-1.5 py-1.5 text-[12px] text-faint transition-colors hover:bg-[color-mix(in_oklab,white_5%,transparent)] hover:text-foreground"
            >
              <Plus size={12} />
              New task
            </Link>
          </section>
        );
      })}
    </div>

    {/* Same sheet the tasks page uses — it loads its own detail from the id,
        so opening a card here needs nothing extra passed down. Kept out of the
        tree until first open so the deferred chunk is not fetched on load. */}
    {openId && (
      <TaskDetailSheet taskId={openId} onClose={() => setOpenId(null)} />
    )}
    </>
  );
}

function Card({
  task,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  task: BoardTask;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const accent = accentFor(task);
  const [expanded, setExpanded] = useState(false);
  const meeting = task.meeting;

  const doneSubtasks = task.subtasks.filter((s) => s.done).length;
  const totalSubtasks = task.subtasks.length;

  return (
    <article
      draggable
      onDragStart={(e) => {
        // Firefox refuses to start a drag without payload on the transfer.
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      // Browsers suppress the click that would otherwise follow a drag, so a
      // plain handler is enough to keep dragging and opening apart.
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      // A task carries its accent in a left stripe and a dot: at this card
      // size a wash flattens the text contrast. A meeting is the exception,
      // filled with its colour the way it is on the calendar, so the day's
      // fixed points read apart from the work around them.
      style={
        meeting
          ? {
              borderLeftColor: `color-mix(in oklab, ${accent} 90%, white)`,
              backgroundColor: `color-mix(in oklab, ${accent} 72%, #000)`,
              color: "#fff",
            }
          : {
              borderLeftColor: accent,
              backgroundColor: `color-mix(in oklab, ${accent} 7%, color-mix(in oklab, var(--card) 78%, transparent))`,
            }
      }
      className={`cursor-grab rounded-lg border border-l-[3px] border-[color-mix(in_oklab,white_8%,transparent)] px-2.5 py-2 transition-opacity active:cursor-grabbing ${
        dragging ? "opacity-40" : meeting?.ended && task.status !== "DONE" ? "opacity-75" : ""
      }`}
    >
      <div className="flex items-start gap-1.5">
        {meeting ? (
          meeting.mode === "online" ? (
            <Video size={12} className="mt-[3px] shrink-0 text-white/85" aria-label="Online meeting" />
          ) : (
            <Building2 size={12} className="mt-[3px] shrink-0 text-white/85" aria-label="Meeting in the office" />
          )
        ) : task.blocked ? (
          <Flag
            size={11}
            className="mt-[3px] shrink-0 text-[var(--status-red)]"
            aria-label="Blocked"
          />
        ) : (
          <span
            className="mt-[5px] h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: accent }}
          />
        )}
        <p className="min-w-0 flex-1 text-[13px] leading-snug">{task.title}</p>
        {meeting?.live && (
          <span className="shrink-0 rounded-full bg-white/20 px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.1em]">
            Now
          </span>
        )}
      </div>

      {meeting && (
        <div className="mt-1 flex flex-col gap-0.5 pl-[18px] text-[11px] leading-snug text-white/80">
          <span className="tabular-nums">{meeting.when}</span>
          <span className="flex items-center gap-1.5 truncate">
            <span className="truncate">{meeting.place}</span>
            {meeting.people > 1 && (
              <span className="flex shrink-0 items-center gap-0.5">
                · <Users size={10} /> {meeting.people}
              </span>
            )}
          </span>
          {meeting.joinUrl && (
            <a
              href={meeting.joinUrl}
              target="_blank"
              rel="noopener noreferrer"
              draggable={false}
              onClick={(e) => e.stopPropagation()}
              className="mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-white/18 px-2 py-0.5 text-[10px] font-medium text-white transition-colors hover:bg-white/28"
            >
              <Video size={10} /> Join
            </a>
          )}
        </div>
      )}

      {task.labels.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {task.labels.map((label) =>
            meeting ? (
              // On a filled card a tinted chip vanishes into the fill, so the
              // label's colour moves to a dot on a light chip.
              <span
                key={label.id}
                className="chip h-[18px] gap-1 border-white/25 bg-white/15 px-1.5 text-[10px] text-white"
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: label.color }} />
                {label.name}
              </span>
            ) : (
              <span
                key={label.id}
                className="chip h-[18px] px-1.5 text-[10px]"
                style={{
                  backgroundColor: `color-mix(in oklab, ${label.color} 20%, transparent)`,
                  borderColor: `color-mix(in oklab, ${label.color} 40%, transparent)`,
                  color: `color-mix(in oklab, ${label.color} 55%, white)`,
                }}
              >
                {label.name}
              </span>
            )
          )}
        </div>
      )}

      {/* The group's own row. Collapsed it is a count and a bar, so a parent
          card stays card-sized however many children it has; expanded it lists
          them. Toggling is stopPropagation'd — the card underneath opens the
          sheet on click, and this button is inside it. */}
      {totalSubtasks > 0 && (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((prev) => !prev);
            }}
            className="flex w-full items-center gap-1.5 rounded text-[10px] text-faint transition-colors hover:text-foreground"
          >
            <ChevronRight
              size={10}
              className={`shrink-0 transition-transform ${
                expanded ? "rotate-90" : ""
              }`}
            />
            <span className="tabular-nums">
              {doneSubtasks}/{totalSubtasks} subtasks
            </span>
            <span className="ml-1 h-1 flex-1 overflow-hidden rounded-full bg-[color-mix(in_oklab,white_10%,transparent)]">
              <span
                className="block h-full rounded-full transition-all"
                style={{
                  width: `${(doneSubtasks / totalSubtasks) * 100}%`,
                  backgroundColor: accent,
                }}
              />
            </span>
          </button>

          {expanded && (
            <ul className="mt-1.5 flex flex-col gap-1 border-l border-[color-mix(in_oklab,white_10%,transparent)] pl-2">
              {task.subtasks.map((sub) => (
                <li
                  key={sub.id}
                  className="flex items-start gap-1.5 text-[11px] leading-snug"
                >
                  <span
                    className={`mt-[2px] flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border ${
                      sub.done
                        ? "border-transparent bg-[var(--status-green)] text-black"
                        : "border-[color-mix(in_oklab,white_18%,transparent)]"
                    }`}
                  >
                    {sub.done && <Check size={8} strokeWidth={3} />}
                  </span>
                  <span
                    className={
                      sub.done ? "text-faint line-through" : "text-faint"
                    }
                  >
                    {sub.title}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(task.dueLabel || task.doneLabel || task.assignees.length > 0) && (
        <div className="mt-1.5 flex items-center gap-1.5">
          {task.dueLabel && (
            <span
              className={`chip h-[18px] px-1.5 text-[10px] ${
                task.overdue
                  ? "border-[color-mix(in_oklab,var(--status-red)_45%,transparent)] bg-[color-mix(in_oklab,var(--status-red)_18%,transparent)] text-[color-mix(in_oklab,var(--status-red)_60%,white)]"
                  : "border-[color-mix(in_oklab,white_10%,transparent)] bg-[color-mix(in_oklab,white_5%,transparent)] text-faint"
              }`}
            >
              {task.dueLabel}
            </span>
          )}

          {task.doneLabel && (
            <span className="chip h-[18px] border-[color-mix(in_oklab,var(--status-green)_35%,transparent)] bg-[color-mix(in_oklab,var(--status-green)_14%,transparent)] px-1.5 text-[10px] text-[color-mix(in_oklab,var(--status-green)_60%,white)]">
              {task.doneLabel}
            </span>
          )}

          {task.assignees.length > 0 && (
            <span className={`ml-auto truncate text-[10px] ${meeting ? "text-white/70" : "text-faint"}`}>
              {task.assignees.join(", ")}
            </span>
          )}
        </div>
      )}
    </article>
  );
}
