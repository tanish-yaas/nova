import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { getCurrentContext } from "@/server/auth/session";
import { eventsInvolving, getCalendarsForUser } from "@/server/services/calendar";
import { NOT_MEETING_TASK, buildTaskScope } from "@/server/services/tasks";
import { EVENT_INCLUDE, getWorkspacePeople, toEventItem } from "@/server/services/meetings";
import { CalendarShell } from "@/components/calendar/calendar-shell";
import {
  CALENDAR_VIEWS,
  type CalendarView,
  type TaskItem,
} from "@/components/calendar/types";
import {
  addDaysToKey,
  formatIST,
  isDayKey,
  istDayKey,
  istKeyToDate,
  istMonthStartKey,
  istTodayKey,
  istWeekStartKey,
  toLocalInput,
} from "@/lib/dates";

/** How many days of data each view needs, anchored on a day key. */
function resolveRange(view: CalendarView, anchorKey: string) {
  if (view === "month") {
    return { startKey: istWeekStartKey(istMonthStartKey(anchorKey)), days: 42 };
  }
  if (view === "week") return { startKey: istWeekStartKey(anchorKey), days: 7 };
  if (view === "day") return { startKey: anchorKey, days: 1 };
  return { startKey: anchorKey, days: 30 };
}

/** Statuses that mean the work is underway or lined up, not parked or over. */
const OPEN_STATUSES = ["TODO", "IN_PROGRESS", "IN_REVIEW", "BLOCKED"] as const;

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string; people?: string }>;
}) {
  const params = await searchParams;
  const ctx = await getCurrentContext();
  if (!ctx?.membership || !ctx.profile) return null;

  const orgId = ctx.membership.organizationId;
  const userId = ctx.session.user.id;

  const view: CalendarView = CALENDAR_VIEWS.includes(params.view as CalendarView)
    ? (params.view as CalendarView)
    : "month";

  const anchorKey = isDayKey(params.date) ? params.date : istTodayKey();

  const { startKey, days } = resolveRange(view, anchorKey);
  const rangeStart = istKeyToDate(startKey);
  const rangeEnd = istKeyToDate(addDaysToKey(startKey, days));
  const now = new Date();

  const [people, taskScope] = await Promise.all([
    getWorkspacePeople(orgId),
    buildTaskScope(orgId, userId, ctx.permissions),
  ]);
  const peopleById = new Map(people.map((p) => [p.userId, p]));

  // Whose calendars are on screen. Yours unless you asked for others; "all"
  // is everyone. Ids nobody in the workspace has are simply dropped.
  const everyone = params.people === "all";
  const asked = (params.people ?? "").split(",").filter((id) => peopleById.has(id));
  const inView = everyone
    ? people.map((p) => p.userId)
    : asked.length > 0
      ? asked
      : [userId];

  const allCalendars = await getCalendarsForUser(orgId, userId, ctx.permissions);
  const calendarIds = allCalendars.map((c) => c.id);
  const calendarById = new Map(allCalendars.map((c) => [c.id, c]));

  // Task bars for the people in view. Tasks that run to a deadline overlap the
  // window between their start and their due date. Tasks with no deadline are
  // work going on every day: an open one runs from its start to today, a
  // finished one to the day it was done. Only top-level tasks get that
  // treatment, and not Backlog: a subtask or a parked idea with no date is not
  // something anyone is doing today.
  const startsBeforeEnd: Prisma.TaskWhereInput = {
    OR: [{ startAt: { lt: rangeEnd } }, { startAt: null, createdAt: { lt: rangeEnd } }],
  };
  const theirs: Prisma.TaskWhereInput = everyone
    ? { organizationId: orgId, deletedAt: null }
    : { organizationId: orgId, deletedAt: null, assignments: { some: { userId: { in: inView } } } };

  const [events, tasks, openTasks, shareRows, labels] = await Promise.all([
    calendarIds.length > 0
      ? prisma.calendarEvent.findMany({
          where: {
            organizationId: orgId,
            calendarId: { in: calendarIds },
            deletedAt: null,
            // Anything overlapping the window, not just starting inside it.
            startAt: { lt: rangeEnd },
            endAt: { gt: rangeStart },
            ...(everyone ? {} : eventsInvolving(inView)),
          },
          orderBy: { startAt: "asc" },
          include: EVENT_INCLUDE,
        })
      : Promise.resolve([]),
    prisma.task.findMany({
      where: {
        // AND, not more keys on the object: a sibling OR here would collide
        // with the ones below and widen the query.
        AND: [
          theirs,
          startsBeforeEnd,
          // The meeting itself is on the calendar; its task would be a copy.
          NOT_MEETING_TASK,
          {
            OR: [
              { dueAt: { gte: rangeStart } },
              {
                dueAt: null,
                parentTaskId: null,
                status: { in: [...OPEN_STATUSES] },
              },
              {
                dueAt: null,
                parentTaskId: null,
                status: "DONE",
                completedAt: { gte: rangeStart },
              },
            ],
          },
        ],
      },
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
      take: 600,
      include: {
        assignments: { include: { user: { select: { name: true } } } },
        labels: {
          include: { label: { select: { id: true, name: true, color: true } } },
        },
      },
    }),
    prisma.task.findMany({
      where: { ...taskScope, status: { notIn: ["DONE", "CANCELLED"] } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, title: true },
    }),
    ctx.permissions.has("calendar.share")
      ? prisma.calendarShare.findMany({
          where: {
            organizationId: orgId,
            calendarId: {
              in: allCalendars
                .filter((c) => c.isOwn || ctx.permissions.has("calendar.edit_any"))
                .map((c) => c.id),
            },
          },
          include: { user: { select: { name: true, email: true } } },
          orderBy: { createdAt: "asc" },
        })
      : Promise.resolve([]),
    prisma.label.findMany({
      where: { organizationId: orgId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    }),
  ]);

  // Which of those tasks this viewer could already open. The rest are other
  // people's work outside the viewer's task scope: drawn, but read-only.
  const openable = new Set(
    tasks.length > 0
      ? (
          await prisma.task.findMany({
            where: { AND: [taskScope, { id: { in: tasks.map((t) => t.id) } }] },
            select: { id: true },
          })
        ).map((t) => t.id)
      : []
  );

  const canEditOwn = ctx.permissions.has("calendar.edit_own");
  const canShare = ctx.permissions.has("calendar.share");
  const canShareAny = ctx.permissions.has("calendar.edit_any");

  const eventItems = events.map((e) =>
    toEventItem(
      e,
      { userId, canEditOwn },
      peopleById,
      inView,
      calendarById.get(e.calendarId)?.canEdit ?? false
    )
  );

  const taskItems: TaskItem[] = tasks.map((t) => {
    const finished = t.status === "DONE" || t.status === "CANCELLED";
    const ongoing = !t.dueAt && !finished;
    const end = t.dueAt ?? (finished ? (t.completedAt ?? t.updatedAt) : now);

    return {
      id: t.id,
      dueAt: t.dueAt ? t.dueAt.toISOString() : null,
      endAt: end.toISOString(),
      ongoing,
      canOpen: openable.has(t.id),
      startAt: t.startAt ? t.startAt.toISOString() : null,
      createdAt: t.createdAt.toISOString(),
      dayKey: istDayKey(end),
      row: {
        id: t.id,
        title: t.title,
        description: t.description ?? "",
        status: t.status,
        priority: t.priority,
        dueAtInput: toLocalInput(t.dueAt),
        dueAtLabel: t.dueAt ? formatIST(t.dueAt) : null,
        estimatedMinutes: t.estimatedMinutes ? String(t.estimatedMinutes) : "",
        overdue: !!t.dueAt && t.dueAt < now && !finished,
        assignees: t.assignments.map((a) => a.user.name ?? "").filter(Boolean),
        labels: t.labels.map((tl) => tl.label),
      },
    };
  });

  const sharesByCalendar = new Map<
    string,
    { id: string; userId: string; name: string; accessLevel: string }[]
  >();
  for (const share of shareRows) {
    const list = sharesByCalendar.get(share.calendarId) ?? [];
    list.push({
      id: share.id,
      userId: share.userId,
      name: share.user.name ?? share.user.email ?? "Member",
      accessLevel: share.accessLevel,
    });
    sharesByCalendar.set(share.calendarId, list);
  }

  // The show/hide panel lists the calendars of the people on screen.
  const viewSet = new Set(inView);
  const calendars = allCalendars
    .filter((c) => viewSet.has(c.ownerId) || c.isOwn)
    .map((c) => ({
      id: c.id,
      name: c.name,
      color: peopleById.get(c.ownerId)?.color ?? c.color,
      ownerName: peopleById.get(c.ownerId)?.name ?? c.ownerName,
      isOwn: c.isOwn,
      canEdit: c.canEdit,
      canShare: canShare && (c.isOwn || canShareAny),
      shares: sharesByCalendar.get(c.id) ?? [],
    }));

  return (
    <CalendarShell
      view={view}
      anchorKey={anchorKey}
      events={eventItems}
      tasks={taskItems}
      calendars={calendars}
      openTasks={openTasks}
      people={people}
      labels={labels}
      inView={everyone ? "all" : inView}
      selfId={userId}
      members={people.filter((p) => p.userId !== userId).map((p) => ({ userId: p.userId, name: p.name }))}
      workingHoursStart={ctx.profile.workingHoursStart}
      workingHoursEnd={ctx.profile.workingHoursEnd}
      canCreate={canEditOwn || canShareAny}
      canShare={canShare}
    />
  );
}
