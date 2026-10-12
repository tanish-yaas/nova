import { prisma } from "@/lib/prisma";
import { getCurrentContext } from "@/server/auth/session";
import { SuggestionCard } from "@/components/dashboard/suggestion-card";
import { InsightRow } from "@/components/dashboard/insight-row";
import { getDashboardInsights } from "@/server/services/insights";
import { buildTaskScope } from "@/server/services/tasks";
import { TaskBoard } from "@/components/dashboard/task-board";
import {
  columnForStatus,
  type BoardMeeting,
  type BoardSubtask,
  type BoardTask,
} from "@/components/dashboard/board-columns";
import { meetingMode, placeLabel } from "@/lib/meetings";
import {
  addDaysToKey,
  daysBetweenKeys,
  formatDateIST,
  formatIST,
  istDayKey,
  istKeyToDate,
  istTodayKey,
} from "@/lib/dates";
import type { SuggestionPayload } from "@/server/services/intelligence";

function Stat({
  label,
  value,
  total,
  color = "var(--primary)",
}: {
  label: string;
  value: number;
  total: number;
  color?: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;

  // Three stacked rows became two. The label and the number share a baseline
  // instead of sitting one above the other, and the ratio moved next to the bar
  // rather than under it — roughly half the height for the same information,
  // and the tile still fills its grid column, so no gap opens up beside it.
  return (
    <div className="stat">
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-[10px] uppercase tracking-[0.12em] text-faint">
          {label}
        </p>
        <p
          className="shrink-0 text-[20px] font-semibold leading-none tabular-nums"
          style={{ color: value > 0 ? color : "var(--foreground)" }}
        >
          {value}
        </p>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-[color-mix(in_oklab,white_8%,transparent)]">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${pct}%`, backgroundColor: color }}
          />
        </div>
        <p className="shrink-0 text-[10px] tabular-nums text-faint">
          {pct}% of {total}
        </p>
      </div>
    </div>
  );
}

/** A meeting's card line: when, where, who, and whether it is on now. */
function boardMeeting(
  event: {
    startAt: Date;
    endAt: Date;
    location: string | null;
    meetingUrl: string | null;
    _count: { attendees: number };
  } | null,
  todayKey: string,
  now: Date
): BoardMeeting | null {
  if (!event) return null;
  const mode = meetingMode(event.location, event.meetingUrl);
  const t = (d: Date) =>
    formatIST(d, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const day = daysBetweenKeys(todayKey, istDayKey(event.startAt));
  const dayLabel =
    day === 0
      ? "Today"
      : day === 1
        ? "Tomorrow"
        : day === -1
          ? "Yesterday"
          : `${formatIST(event.startAt, { weekday: "short" })} ${formatDateIST(event.startAt)}`;
  const ended = event.endAt < now;

  return {
    when: `${dayLabel} · ${t(event.startAt)}–${t(event.endAt)}`,
    mode,
    place: placeLabel(mode, event.location, event.meetingUrl),
    joinUrl: mode === "online" && !ended ? event.meetingUrl : null,
    people: event._count.attendees,
    ended,
    live: event.startAt <= now && !ended,
  };
}

export default async function DashboardPage() {
  const ctx = await getCurrentContext();
  if (!ctx?.membership || !ctx.profile) return null;

  const orgId = ctx.membership.organizationId;
  const userId = ctx.session.user.id;
  const now = new Date();

  // Day boundaries are IST wall-clock, not the server's. Vercel runs in UTC, so
  // setHours(0,0,0,0) here put "today" at 05:30–05:30 IST and quietly counted
  // the wrong tasks. Same reasoning as buildDigest in services/reminders.ts.
  const todayKey = istTodayKey();
  const startOfDay = istKeyToDate(todayKey);
  const endOfDay = istKeyToDate(addDaysToKey(todayKey, 1));
  const endOfWeek = istKeyToDate(addDaysToKey(todayKey, 7));

  // The Completed column is a recent-past window, not an archive: a card stays
  // for the day it was finished and the two days after it, then rolls off at
  // IST midnight. Everything is still on the tasks page under Done.
  const doneSince = istKeyToDate(addDaysToKey(todayKey, -2));

  const mine = {
    organizationId: orgId,
    deletedAt: null,
    assignments: { some: { userId } },
  };

  const [dueToday, dueThisWeek, overdue, completed, totalOpen] =
    await Promise.all([
      prisma.task.count({
        where: {
          ...mine,
          dueAt: { gte: startOfDay, lt: endOfDay },
          status: { not: "DONE" },
        },
      }),
      prisma.task.count({
        where: {
          ...mine,
          dueAt: { gte: startOfDay, lt: endOfWeek },
          status: { not: "DONE" },
        },
      }),
      prisma.task.count({
        where: { ...mine, dueAt: { lt: now }, status: { not: "DONE" } },
      }),
      prisma.task.count({
        where: {
          ...mine,
          status: "DONE",
          completedAt: { gte: startOfDay, lt: endOfWeek },
        },
      }),
      prisma.task.count({
        where: { ...mine, status: { notIn: ["DONE", "CANCELLED"] } },
      }),
    ]);

  const totalWeek = dueThisWeek + completed;

  // Viewers who can see past their own rows get the whole scope plus a people
  // filter; everyone else keeps the board they had. buildTaskScope is the
  // authority on what is visible — the filter only narrows what it returns.
  const canSeeOthers =
    ctx.permissions.has("task.view_any") || ctx.permissions.has("task.view_team");

  const boardScope = canSeeOthers
    ? await buildTaskScope(orgId, userId, ctx.permissions)
    : mine;

  const [boardRows, suggestions, insights, boardMembers] = await Promise.all([
    prisma.task.findMany({
      where: {
        ...boardScope,
        status: { not: "CANCELLED" },
        // AND, not a second OR: buildTaskScope already spends the OR key on
        // "created by me or assigned to me", and spreading a sibling OR here
        // would silently replace it and widen the board past the viewer.
        AND: [
          {
            OR: [
              { status: { not: "DONE" } },
              { completedAt: { gte: doneSince } },
              // Rows finished before completedAt was recorded still have an
              // updatedAt, so they age out of the column instead of sitting
              // there for good.
              { completedAt: null, updatedAt: { gte: doneSince } },
            ],
          },
        ],
      },
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      take: 120,
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        dueAt: true,
        completedAt: true,
        parentTaskId: true,
        assignments: {
          select: { userId: true, user: { select: { name: true } } },
        },
        labels: {
          select: { label: { select: { id: true, name: true, color: true } } },
        },
        // The meeting this task stands behind, if it is one.
        events: {
          where: { deletedAt: null, attendees: { some: { isOrganizer: true } } },
          take: 1,
          select: {
            startAt: true,
            endAt: true,
            location: true,
            meetingUrl: true,
            _count: { select: { attendees: true } },
          },
        },
      },
    }),
    prisma.aISuggestion.findMany({
      where: {
        organizationId: orgId,
        userId,
        status: "PENDING",
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: [{ confidence: "desc" }, { createdAt: "desc" }],
      take: 4,
    }),
    getDashboardInsights(orgId, userId),
    canSeeOthers
      ? prisma.organizationMember.findMany({
          where: { organizationId: orgId, status: "ACTIVE" },
          select: {
            userId: true,
            user: {
              select: {
                name: true,
                email: true,
                image: true,
                profile: { select: { displayName: true, avatarUrl: true } },
              },
            },
          },
          orderBy: { createdAt: "asc" },
        })
      : Promise.resolve([]),
  ]);

  // A subtask is a line item of its parent, not a task in its own right, so it
  // rides inside the parent's card instead of taking a slot on the board. One
  // whose parent is out of view stays a card of its own — better a card without
  // its group than work that vanishes.
  const visibleIds = new Set(boardRows.map((t) => t.id));
  const parentRows = boardRows.filter(
    (t) => !t.parentTaskId || !visibleIds.has(t.parentTaskId)
  );

  // Fetched separately rather than read off boardRows: the 120-row cap and the
  // Completed window both cut the list, and a card should show the whole set of
  // children or none of it.
  const subtaskRows =
    parentRows.length > 0
      ? await prisma.task.findMany({
          where: {
            organizationId: orgId,
            deletedAt: null,
            parentTaskId: { in: parentRows.map((t) => t.id) },
          },
          orderBy: [{ position: "asc" }, { createdAt: "asc" }],
          select: { id: true, title: true, status: true, parentTaskId: true },
        })
      : [];

  const subtasksByParent = new Map<string, BoardSubtask[]>();
  for (const sub of subtaskRows) {
    const list = subtasksByParent.get(sub.parentTaskId!) ?? [];
    list.push({ id: sub.id, title: sub.title, done: sub.status === "DONE" });
    subtasksByParent.set(sub.parentTaskId!, list);
  }

  // Formatted here rather than in the client board: the app is pinned to IST
  // and the browser is not, so a client-side format would drift and mismatch
  // on hydration. daysBetweenKeys is positive when the due day is behind today.
  const boardTasks: BoardTask[] = parentRows
    .filter((t) => columnForStatus(t.status) !== null)
    .map((t) => {
      const done = t.status === "DONE";

      const daysLate = t.dueAt
        ? daysBetweenKeys(istDayKey(t.dueAt), todayKey)
        : null;

      // A finished task has no deadline left to meet, so the due chip comes off
      // and the day it was completed takes its place — which is also what makes
      // the three-day window on this column legible.
      let dueLabel: string | null = null;
      if (daysLate !== null && !done) {
        if (daysLate > 0) {
          dueLabel = `Due ${daysLate} ${daysLate === 1 ? "day" : "days"} ago`;
        } else if (daysLate === 0) {
          dueLabel = "Today";
        } else if (daysLate === -1) {
          dueLabel = "Tomorrow";
        } else {
          dueLabel = formatIST(t.dueAt, { day: "numeric", month: "short" });
        }
      }

      let doneLabel: string | null = null;
      if (done) {
        const daysAgo = t.completedAt
          ? daysBetweenKeys(istDayKey(t.completedAt), todayKey)
          : null;
        doneLabel =
          daysAgo === 0
            ? "Done today"
            : daysAgo === 1
              ? "Done yesterday"
              : daysAgo !== null && daysAgo > 1
                ? `Done ${daysAgo} days ago`
                : "Done";
      }

      return {
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        blocked: t.status === "BLOCKED",
        dueLabel,
        doneLabel,
        overdue: daysLate !== null && daysLate > 0 && !done,
        labels: t.labels.map((tl) => tl.label),
        assigneeIds: t.assignments.map((a) => a.userId),
        assignees: t.assignments
          .map((a) => a.user.name?.split(" ")[0] ?? "")
          .filter(Boolean),
        subtasks: subtasksByParent.get(t.id) ?? [],
        meeting: boardMeeting(t.events[0] ?? null, todayKey, now),
      };
    });

  // One order for both kinds of card: a task by when it is due, a meeting by
  // when it starts, so a 14:00 meeting sits between the tasks around it
  // instead of trailing every dated task because it has no due date.
  const whenOf = (t: BoardTask) => {
    const row = parentRows.find((r) => r.id === t.id);
    return (row?.dueAt ?? row?.events[0]?.startAt)?.getTime() ?? Number.POSITIVE_INFINITY;
  };
  boardTasks.sort((a, b) => whenOf(a) - whenOf(b));

  // Built from whose tasks are actually in view, not from the whole roster.
  // A viewer whose scope is team-level would otherwise get a checkbox for
  // every member in the org, most of them selecting nothing.
  const presentIds = new Set(boardTasks.flatMap((t) => t.assigneeIds));
  const hasUnassigned = boardTasks.some((t) => t.assigneeIds.length === 0);

  const filterMembers = boardMembers
    .filter((m) => presentIds.has(m.userId))
    .map((m) => ({
      userId: m.userId,
      name:
        m.user.profile?.displayName ?? m.user.name ?? m.user.email ?? "Member",
      avatarUrl: m.user.profile?.avatarUrl ?? null,
      image: m.user.image ?? null,
    }));

  // Nothing to filter when it is all one person's work and nothing is loose.
  const showFilter = filterMembers.length > 1 || hasUnassigned;

  return (
    <div className="w-full">
      {/* The greeting and date moved into the topbar — they were a heading
          block and a second line for information glanced at once a session,
          and the board is what this page is for. */}

      {/* Tiles keep their own row across the top. Below them the board takes
          the width and the height that is left, with suggestions in a rail. */}
      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Due today" value={dueToday} total={totalOpen || 1} />
        <Stat
          label="This week"
          value={dueThisWeek}
          total={totalOpen || 1}
          color="var(--status-blue)"
        />
        <Stat
          label="Overdue"
          value={overdue}
          total={totalOpen || 1}
          color="var(--status-red)"
        />
        <Stat
          label="Completed"
          value={completed}
          total={totalWeek || 1}
          color="var(--status-green)"
        />
      </div>

      {/* items-start so the board and the rail each end where their content
          does, instead of both stretching to the taller one's height. */}
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start">
        <section className="panel flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-[color-mix(in_oklab,white_7%,transparent)] px-4 py-2.5">
            <h2 className="text-[11px] uppercase tracking-[0.12em] text-faint">
              Board
            </h2>
            <span className="text-[11px] text-faint">
              {boardTasks.length === 0
                ? "No tasks yet"
                : "Drag to change status · click to open"}
            </span>
          </div>

          <div className="p-3">
            <TaskBoard
              tasks={boardTasks}
              selfId={userId}
              members={showFilter ? filterMembers : []}
            />
          </div>
        </section>

        <aside className="panel flex w-full shrink-0 flex-col overflow-hidden xl:w-[320px]">
          <div className="border-b border-[color-mix(in_oklab,white_7%,transparent)] px-4 py-2.5">
            <h2 className="text-[11px] uppercase tracking-[0.12em] text-faint">
              Suggestions
            </h2>
          </div>

          {/* Stored suggestions when any are pending, otherwise live insights.
              Without the fallback this panel sits empty most of the time — the
              nightly run is the only thing that fills it, and accepting or
              dismissing a row takes it straight back out. */}
          <div className="flex flex-col gap-2 p-3">
            {suggestions.length > 0
              ? suggestions.map((s) => {
                  const payload = s.payload as SuggestionPayload | null;
                  return (
                    <SuggestionCard
                      key={s.id}
                      id={s.id}
                      type={s.type}
                      reason={s.reason ?? ""}
                      actionable={!!payload?.apply}
                    />
                  );
                })
              : insights.map((i) => (
                  <InsightRow
                    key={i.key}
                    type={i.type}
                    text={i.text}
                    filter={i.filter}
                  />
                ))}
          </div>
        </aside>
      </div>
    </div>
  );
}