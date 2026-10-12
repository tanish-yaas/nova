import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { buildTaskScope } from "@/server/services/tasks";
import { getVisibleCalendarIds, readableEventFor } from "@/server/services/calendar";
import {
  addDaysToKey,
  formatIST,
  istDayKey,
  istKeyToDate,
} from "@/lib/dates";
import {
  ACTIVITY_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  tasksOnly,
  weekdayOf,
  type ActivityKind,
  type LogActivity,
  type LogEntry,
  type PersonSummary,
  type ReportEvent,
  type ReportFilters,
  type ReportLabel,
  type ReportPerson,
  type ReportTask,
  type ReportTeam,
  type TaskPriorityKey,
  type TaskStatusKey,
  type WorkReport,
} from "@/lib/reports";

/**
 * Rows read per query. Well past what a workspace produces in a year; a guard
 * against a runaway range, not a page size. Hitting one sets `truncated`, and
 * the screen says so rather than quietly showing less.
 */
const TASK_CAP = 4000;
const COMMENT_CAP = 10000;
const EVENT_CAP = 4000;

/** Statuses that mean someone has the task in hand. */
const IN_HAND = new Set<string>(["IN_PROGRESS", "IN_REVIEW", "BLOCKED"]);
const FINISHED = new Set<string>(["DONE", "CANCELLED"]);

const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];

/**
 * How long a task keeps showing up as ongoing after anything last happened on
 * it. A card left In progress for a month is not a month of work, it is a
 * card nobody moved, and thirty "Still in progress" lines would bury what was
 * actually done. It stays on the task list as In progress either way.
 */
const ONGOING_FOR_DAYS = 7;

type Viewer = { orgId: string; userId: string; permissions: Set<string> };

export type ReportAudience = {
  /** Everyone this viewer may report on, viewer included. */
  people: ReportPerson[];
  teams: ReportTeam[];
  labels: ReportLabel[];
  /** Whether the picker should offer anyone but the viewer. */
  canSeeOthers: boolean;
  workingDays: Map<string, number[]>;
};

function displayName(user: {
  name: string | null;
  email: string | null;
  profile?: { displayName: string | null } | null;
}) {
  return user.profile?.displayName ?? user.name ?? user.email ?? "Member";
}

/**
 * Who this viewer may ask for a report about.
 *
 * report.view_any is the whole workspace, report.view_team is the viewer and
 * the people in their teams, report.view_own is the viewer alone. Deactivated
 * members stay in: someone who left in August still did July's work, and a
 * report on July should say so.
 *
 * This only decides whose names are on offer. What rows come back is still
 * buildTaskScope's call, and a report permission never widens it.
 */
export async function getReportAudience(viewer: Viewer): Promise<ReportAudience> {
  const { orgId, userId, permissions } = viewer;
  const seeAll = permissions.has("report.view_any");
  const seeTeam = permissions.has("report.view_team");

  const teamRows =
    seeAll || seeTeam
      ? await prisma.team.findMany({
          where: {
            organizationId: orgId,
            deletedAt: null,
            ...(seeAll ? {} : { members: { some: { userId } } }),
          },
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            members: { select: { userId: true } },
          },
        })
      : [];

  const allowedIds = seeAll
    ? null
    : seeTeam
      ? [...new Set([userId, ...teamRows.flatMap((t) => t.members.map((m) => m.userId))])]
      : [userId];

  const [members, labels] = await Promise.all([
    prisma.organizationMember.findMany({
      where: {
        organizationId: orgId,
        status: { in: ["ACTIVE", "DEACTIVATED"] },
        ...(allowedIds ? { userId: { in: allowedIds } } : {}),
      },
      select: {
        userId: true,
        status: true,
        user: {
          select: {
            name: true,
            email: true,
            image: true,
            profile: {
              select: { displayName: true, avatarUrl: true, workingDays: true },
            },
          },
        },
      },
    }),
    prisma.label.findMany({
      where: { organizationId: orgId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    }),
  ]);

  const people: ReportPerson[] = members
    .map((m) => ({
      userId: m.userId,
      name: displayName(m.user),
      email: m.user.email,
      avatarUrl: m.user.profile?.avatarUrl ?? null,
      image: m.user.image,
      left: m.status === "DEACTIVATED",
    }))
    // You first, then everyone by name, then the people who have left.
    .sort(
      (a, b) =>
        Number(b.userId === userId) - Number(a.userId === userId) ||
        Number(a.left) - Number(b.left) ||
        a.name.localeCompare(b.name)
    );

  const known = new Set(people.map((p) => p.userId));

  const workingDays = new Map(
    members.map((m) => [
      m.userId,
      m.user.profile?.workingDays?.length
        ? m.user.profile.workingDays
        : DEFAULT_WORKING_DAYS,
    ])
  );

  return {
    people,
    teams: teamRows.map((t) => ({
      id: t.id,
      name: t.name,
      memberIds: t.members.map((m) => m.userId).filter((id) => known.has(id)),
    })),
    labels,
    canSeeOthers: people.length > 1 || seeAll || seeTeam,
    workingDays,
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** What a status change reads as in someone's day. */
function transitionLabel(from: string | null, to: string): string {
  switch (to) {
    case "DONE":
      return "Completed";
    case "IN_PROGRESS":
      if (from === "DONE") return "Reopened";
      return !from || from === "TODO" || from === "BACKLOG"
        ? "Started"
        : "Back in progress";
    case "IN_REVIEW":
      return "Sent for review";
    case "BLOCKED":
      return "Blocked";
    case "CANCELLED":
      return "Cancelled";
    case "BACKLOG":
      return from === "DONE" ? "Reopened" : "Moved to backlog";
    default:
      return from === "DONE" ? "Reopened" : "Moved to To do";
  }
}

const time = (date: Date) =>
  formatIST(date, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function firstName(name: string) {
  return name.split(/\s+/)[0] || name;
}

function joinNames(names: string[]) {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

type Interval = { status: string; from: Date; to: Date };

/**
 * The statuses a task has been in, oldest first, from creation to now.
 * A task with no history has sat in its current status since it was made.
 */
function statusIntervals(
  createdAt: Date,
  currentStatus: string,
  history: { fromStatus: string | null; toStatus: string; createdAt: Date }[],
  now: Date
): Interval[] {
  const out: Interval[] = [];
  let status = history.length > 0 ? (history[0].fromStatus ?? "TODO") : currentStatus;
  let from = createdAt;

  for (const h of history) {
    out.push({ status, from, to: h.createdAt });
    status = h.toStatus;
    from = h.createdAt;
  }
  out.push({ status, from, to: now });
  return out;
}

/** Day keys from a to b inclusive. */
function daySpan(a: string, b: string): string[] {
  const out: string[] = [];
  for (let k = a; k <= b; k = addDaysToKey(k, 1)) out.push(k);
  return out;
}

type InternalActivity = LogActivity & { count: number; sortAt: number };

type InternalEntry = Omit<LogEntry, "activities"> & {
  activities: InternalActivity[];
  sortAt: number;
};

/**
 * Everything the Reports tab shows and the exports write, for one viewer and
 * one set of filters.
 *
 * Attribution, which is the part worth reading twice:
 * - A status change lands on the task's assignees: it is their work that
 *   moved. When someone else made the change it says so ("Completed by
 *   Rahul"), and the person who made it gets a line of their own ("Completed
 *   for Priya"), because reviewing and closing other people's work is work.
 * - A comment lands on its author, and a new task on whoever added it.
 * - A meeting lands on everyone in it who has not declined.
 * - A day a task sat In progress with nothing new on it lands on its
 *   assignees as an Ongoing line, on their working days only.
 */
export async function buildWorkReport(
  viewer: Viewer,
  filters: ReportFilters,
  audience: ReportAudience,
  meta: { workspaceName: string; viewerName: string }
): Promise<WorkReport> {
  const { orgId, userId, permissions } = viewer;
  const now = new Date();

  const rangeStart = istKeyToDate(filters.from);
  const dayAfter = istKeyToDate(addDaysToKey(filters.to, 1));
  // The parser already stops the range at today; this stops it at this
  // minute, so nothing scheduled for this afternoon counts as done.
  const rangeEnd = dayAfter > now ? now : dayAfter;
  const days = daySpan(filters.from, filters.to);
  const inRange = (d: Date) => d >= rangeStart && d < rangeEnd;

  // --- Whose report this is ------------------------------------------------

  const audienceIds = new Set(audience.people.map((p) => p.userId));
  let ids = filters.people.length
    ? filters.people.filter((id) => audienceIds.has(id))
    : [...audienceIds];

  const team = filters.teamId
    ? audience.teams.find((t) => t.id === filters.teamId)
    : undefined;
  if (team) ids = ids.filter((id) => team.memberIds.includes(id));

  const peopleSet = new Set(ids);
  const people = audience.people.filter((p) => peopleSet.has(p.userId));

  // Unassigned work only belongs in a report about everyone.
  const everyone =
    filters.people.length === 0 && !team && permissions.has("report.view_any");

  const label = filters.labelId
    ? audience.labels.find((l) => l.id === filters.labelId)
    : undefined;

  const filterLines = describeFilters(filters, audience, people, team, label);

  const empty: WorkReport = {
    generatedAt: now.toISOString(),
    workspaceName: meta.workspaceName,
    viewerName: meta.viewerName,
    filters,
    days,
    people,
    summaries: [],
    entries: [],
    tasks: [],
    events: [],
    totals: {
      completed: 0,
      started: 0,
      comments: 0,
      meetingMinutes: 0,
      activePeople: 0,
      overdueNow: 0,
    },
    filterLines,
    truncated: false,
  };

  if (ids.length === 0) return empty;

  // --- What the viewer may see -------------------------------------------

  // buildTaskScope spends the OR key on "created by me or assigned to me", so
  // every extra condition goes in an AND beside it. Spreading a second OR onto
  // the same object would replace the scope and widen the report to the org.
  const visible = await buildTaskScope(orgId, userId, permissions);

  const attr: Prisma.TaskWhereInput[] = [];
  if (filters.priorities.length > 0) {
    attr.push({ priority: { in: filters.priorities } });
  }
  if (filters.statuses.length > 0) attr.push({ status: { in: filters.statuses } });
  if (label) attr.push({ labels: { some: { labelId: label.id } } });
  if (filters.q) attr.push({ title: { contains: filters.q, mode: "insensitive" } });

  const taskFilter: Prisma.TaskWhereInput = { AND: [visible, ...attr] };

  const wantMeetings = !tasksOnly(filters);

  const calendarIds = wantMeetings
    ? await getVisibleCalendarIds(orgId, userId, permissions)
    : [];

  const [comments, events] = await Promise.all([
    prisma.taskComment.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        createdAt: { gte: rangeStart, lt: rangeEnd },
        task: taskFilter,
      },
      orderBy: { createdAt: "asc" },
      take: COMMENT_CAP + 1,
      select: {
        id: true,
        taskId: true,
        authorId: true,
        body: true,
        createdAt: true,
      },
    }),
    calendarIds.length > 0
      ? prisma.calendarEvent.findMany({
          where: {
            organizationId: orgId,
            calendarId: { in: calendarIds },
            deletedAt: null,
            status: { not: "CANCELLED" },
            startAt: { lt: rangeEnd },
            endAt: { gt: rangeStart },
            ...(filters.q
              ? { title: { contains: filters.q, mode: "insensitive" as const } }
              : {}),
            // Every calendar is visible now; a private event's title is not.
            AND: [readableEventFor(userId)],
            OR: [
              { calendar: { ownerId: { in: ids } } },
              {
                attendees: {
                  some: { userId: { in: ids }, status: { not: "DECLINED" } },
                },
              },
            ],
          },
          orderBy: { startAt: "asc" },
          take: EVENT_CAP + 1,
          select: {
            id: true,
            title: true,
            startAt: true,
            endAt: true,
            allDay: true,
            calendar: { select: { ownerId: true, type: true } },
            attendees: {
              where: { userId: { not: null } },
              select: { userId: true, status: true },
            },
          },
        })
      : Promise.resolve([]),
  ]);

  const commentedByPeople = [
    ...new Set(
      comments.filter((c) => peopleSet.has(c.authorId)).map((c) => c.taskId)
    ),
  ];

  const tasks = await prisma.task.findMany({
    where: {
      AND: [
        taskFilter,
        { createdAt: { lt: rangeEnd } },
        // Open at some point in the range, or touched in it. Narrowed again
        // below with the status history in hand.
        {
          OR: [
            { status: { notIn: ["DONE", "CANCELLED"] } },
            { updatedAt: { gte: rangeStart } },
            { completedAt: { gte: rangeStart } },
            ...(commentedByPeople.length ? [{ id: { in: commentedByPeople } }] : []),
          ],
        },
        // And something to do with the people in the report.
        {
          OR: [
            { assignments: { some: { userId: { in: ids } } } },
            { createdById: { in: ids } },
            {
              statusHistory: {
                some: {
                  changedById: { in: ids },
                  createdAt: { gte: rangeStart, lt: rangeEnd },
                },
              },
            },
            ...(commentedByPeople.length ? [{ id: { in: commentedByPeople } }] : []),
            ...(everyone ? [{ assignments: { none: {} } }] : []),
          ],
        },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: TASK_CAP + 1,
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      source: true,
      createdAt: true,
      updatedAt: true,
      startAt: true,
      dueAt: true,
      completedAt: true,
      estimatedMinutes: true,
      actualMinutes: true,
      createdById: true,
      parentTask: { select: { title: true } },
      team: { select: { name: true } },
      assignments: {
        orderBy: { assignedAt: "asc" },
        select: { userId: true },
      },
      labels: {
        select: { label: { select: { id: true, name: true, color: true } } },
      },
      _count: { select: { subtasks: { where: { deletedAt: null } } } },
    },
  });

  const truncated =
    tasks.length > TASK_CAP ||
    comments.length > COMMENT_CAP ||
    events.length > EVENT_CAP;
  if (tasks.length > TASK_CAP) tasks.length = TASK_CAP;
  if (comments.length > COMMENT_CAP) comments.length = COMMENT_CAP;
  if (events.length > EVENT_CAP) events.length = EVENT_CAP;

  const taskIds = tasks.map((t) => t.id);

  const [history, openNow] = await Promise.all([
    taskIds.length > 0
      ? prisma.taskStatusHistory.findMany({
          where: { organizationId: orgId, taskId: { in: taskIds } },
          orderBy: { createdAt: "asc" },
          select: {
            taskId: true,
            fromStatus: true,
            toStatus: true,
            changedById: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
    // "Open now" is a snapshot, not a slice of the range, so it is read on
    // its own rather than off the period's tasks.
    prisma.task.findMany({
      where: {
        AND: [
          taskFilter,
          { status: { notIn: ["DONE", "CANCELLED"] } },
          { assignments: { some: { userId: { in: ids } } } },
        ],
      },
      take: TASK_CAP,
      select: {
        id: true,
        dueAt: true,
        assignments: { select: { userId: true } },
      },
    }),
  ]);

  // --- Names for everyone mentioned --------------------------------------

  const names = new Map(audience.people.map((p) => [p.userId, p.name]));
  const unknown = new Set<string>();
  for (const t of tasks) {
    if (!names.has(t.createdById)) unknown.add(t.createdById);
    for (const a of t.assignments) if (!names.has(a.userId)) unknown.add(a.userId);
  }
  for (const h of history) {
    if (h.changedById && !names.has(h.changedById)) unknown.add(h.changedById);
  }
  for (const c of comments) if (!names.has(c.authorId)) unknown.add(c.authorId);

  if (unknown.size > 0) {
    const users = await prisma.user.findMany({
      where: {
        id: { in: [...unknown] },
        organizationMembers: { some: { organizationId: orgId } },
      },
      select: {
        id: true,
        name: true,
        email: true,
        profile: { select: { displayName: true } },
      },
    });
    for (const u of users) names.set(u.id, displayName(u));
  }
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? "Someone") : "Someone");

  // --- Lines ---------------------------------------------------------------

  const historyByTask = new Map<string, typeof history>();
  for (const h of history) {
    const list = historyByTask.get(h.taskId) ?? [];
    list.push(h);
    historyByTask.set(h.taskId, list);
  }

  const commentsByTask = new Map<string, typeof comments>();
  for (const c of comments) {
    const list = commentsByTask.get(c.taskId) ?? [];
    list.push(c);
    commentsByTask.set(c.taskId, list);
  }

  const entries = new Map<string, InternalEntry>();
  // Ids until the names are known, then swapped for names on the way out.
  const rawEvents: (Omit<ReportEvent, "person"> & { userId: string | null })[] = [];

  type TaskRow = (typeof tasks)[number];

  function taskEntry(dayKey: string, personId: string, task: TaskRow) {
    const key = `${dayKey}|${personId}|t:${task.id}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        id: key,
        dayKey,
        userId: personId,
        type: "task",
        taskId: task.id,
        title: task.title,
        parentTitle: task.parentTask?.title ?? null,
        activities: [],
        status: task.status as TaskStatusKey,
        priority: task.priority as TaskPriorityKey,
        labels: task.labels.map((l) => l.label),
        team: task.team?.name ?? null,
        dueKey: task.dueAt ? istDayKey(task.dueAt) : null,
        timeRange: null,
        minutes: null,
        sortAt: Number.POSITIVE_INFINITY,
      };
      entries.set(key, entry);
    }
    return entry;
  }

  function addActivity(
    dayKey: string,
    personId: string,
    task: TaskRow,
    kind: ActivityKind,
    text: string,
    at: Date | null
  ) {
    const entry = taskEntry(dayKey, personId, task);

    // A run of comments on one task in one day is one line item, counted.
    if (kind === "comment") {
      const existing = entry.activities.find((a) => a.kind === "comment");
      if (existing) {
        existing.count += 1;
        existing.label = `Commented (${existing.count})`;
        return;
      }
    }

    const sortAt = at ? at.getTime() : Number.POSITIVE_INFINITY;
    entry.activities.push({
      kind,
      label: text,
      at: at ? at.toISOString() : null,
      time: at ? time(at) : null,
      count: 1,
      sortAt,
    });
    entry.sortAt = Math.min(entry.sortAt, sortAt);
  }

  // Per-person tallies the log alone cannot give.
  const completedTasks = new Map<string, Set<string>>();
  const startedTasks = new Map<string, Set<string>>();
  const addedCount = new Map<string, number>();
  const commentCount = new Map<string, number>();
  const tally = (map: Map<string, Set<string>>, person: string, taskId: string) => {
    const set = map.get(person) ?? new Set<string>();
    set.add(taskId);
    map.set(person, set);
  };

  const reportTasks: ReportTask[] = [];
  const commentsPerTask = new Map<string, number>();
  for (const c of comments) {
    commentsPerTask.set(c.taskId, (commentsPerTask.get(c.taskId) ?? 0) + 1);
  }

  for (const task of tasks) {
    const assignees = [...new Set(task.assignments.map((a) => a.userId))];
    const onIt = assignees.filter((id) => peopleSet.has(id));
    const taskHistory = historyByTask.get(task.id) ?? [];
    const assigneeNames = assignees.map((id) => firstName(nameOf(id)));

    // Status changes.
    let completedInRange = false;
    for (const h of taskHistory) {
      if (!inRange(h.createdAt)) continue;

      const kind: ActivityKind = h.toStatus === "DONE" ? "completed" : "progress";
      const text = transitionLabel(h.fromStatus, h.toStatus);
      const day = istDayKey(h.createdAt);
      const actor = h.changedById;

      if (h.toStatus === "DONE") completedInRange = true;

      for (const person of onIt) {
        const by = actor && actor !== person ? ` by ${firstName(nameOf(actor))}` : "";
        addActivity(day, person, task, kind, `${text}${by}`, h.createdAt);
        if (h.toStatus === "IN_PROGRESS") tally(startedTasks, person, task.id);
      }

      if (actor && peopleSet.has(actor) && !assignees.includes(actor)) {
        const forWhom = assignees.length ? ` for ${joinNames(assigneeNames)}` : "";
        addActivity(day, actor, task, kind, `${text}${forWhom}`, h.createdAt);
      }

      if ((actor && peopleSet.has(actor)) || onIt.length > 0) {
        rawEvents.push({
          at: h.createdAt.toISOString(),
          userId: actor,
          action: text,
          taskId: task.id,
          taskTitle: task.title,
          from: h.fromStatus ? STATUS_LABELS[h.fromStatus as TaskStatusKey] : null,
          to: STATUS_LABELS[h.toStatus as TaskStatusKey],
          detail: null,
        });
      }
    }

    // Completions from before status history was kept, which only left a
    // completedAt behind.
    if (
      !completedInRange &&
      task.status === "DONE" &&
      task.completedAt &&
      inRange(task.completedAt)
    ) {
      for (const person of onIt) {
        addActivity(
          istDayKey(task.completedAt),
          person,
          task,
          "completed",
          "Completed",
          task.completedAt
        );
      }
      if (onIt.length > 0) {
        rawEvents.push({
          at: task.completedAt.toISOString(),
          userId: null,
          action: "Completed",
          taskId: task.id,
          taskTitle: task.title,
          from: null,
          to: STATUS_LABELS.DONE,
          detail: null,
        });
      }
    }

    if (
      task.status === "DONE" &&
      task.completedAt &&
      inRange(task.completedAt)
    ) {
      for (const person of onIt) tally(completedTasks, person, task.id);
    }

    // Added.
    if (inRange(task.createdAt) && peopleSet.has(task.createdById)) {
      const others = assignees.filter((id) => id !== task.createdById);
      const text =
        others.length > 0 && !assignees.includes(task.createdById)
          ? `Added for ${joinNames(others.map((id) => firstName(nameOf(id))))}`
          : "Added";
      addActivity(
        istDayKey(task.createdAt),
        task.createdById,
        task,
        "added",
        text,
        task.createdAt
      );
      addedCount.set(task.createdById, (addedCount.get(task.createdById) ?? 0) + 1);
      rawEvents.push({
        at: task.createdAt.toISOString(),
        userId: task.createdById,
        action: "Added",
        taskId: task.id,
        taskTitle: task.title,
        from: null,
        to: STATUS_LABELS.TODO,
        detail: assignees.length ? `Assigned to ${assignees.map(nameOf).join(", ")}` : null,
      });
    }

    // Comments.
    for (const c of commentsByTask.get(task.id) ?? []) {
      if (!peopleSet.has(c.authorId)) continue;
      addActivity(istDayKey(c.createdAt), c.authorId, task, "comment", "Commented", c.createdAt);
      commentCount.set(c.authorId, (commentCount.get(c.authorId) ?? 0) + 1);
      rawEvents.push({
        at: c.createdAt.toISOString(),
        userId: c.authorId,
        action: "Commented",
        taskId: task.id,
        taskTitle: task.title,
        from: null,
        to: null,
        detail: c.body,
      });
    }

    // Ongoing: days in hand with nothing new. Runs after everything above, so
    // a day that already has a line for this task is left alone.
    if (onIt.length > 0) {
      const intervals = statusIntervals(task.createdAt, task.status, taskHistory, now);

      // Anything that counts as someone touching the task, oldest first.
      const touches = [
        task.createdAt.getTime(),
        ...taskHistory.map((h) => h.createdAt.getTime()),
        ...(commentsByTask.get(task.id) ?? []).map((c) => c.createdAt.getTime()),
      ].sort((a, b) => a - b);
      const quietTooLong = (day: string) => {
        const dayStart = istKeyToDate(day).getTime();
        const dayEnd = dayStart + 86_400_000;
        let last = touches[0];
        for (const t of touches) {
          if (t >= dayEnd) break;
          last = t;
        }
        return dayStart - last > ONGOING_FOR_DAYS * 86_400_000;
      };

      for (const interval of intervals) {
        if (!IN_HAND.has(interval.status)) continue;
        const from = interval.from > rangeStart ? interval.from : rangeStart;
        const to = interval.to < rangeEnd ? interval.to : rangeEnd;
        if (from >= to) continue;

        const firstDay = istDayKey(from);
        const lastDay = istDayKey(new Date(to.getTime() - 1));
        for (const day of daySpan(firstDay, lastDay)) {
          for (const person of onIt) {
            const key = `${day}|${person}|t:${task.id}`;
            const existing = entries.get(key);
            if (existing && existing.activities.some((a) => a.kind !== "ongoing")) {
              continue;
            }
            const working = audience.workingDays.get(person) ?? DEFAULT_WORKING_DAYS;
            if (!working.includes(weekdayOf(day))) continue;
            if (quietTooLong(day)) continue;

            const entry = taskEntry(day, person, task);
            // A day can cross two in-hand statuses; the later one is what the
            // day ended on. "Still" keeps it from reading like the change
            // itself: "Blocked" on Tuesday, "Still blocked" on Wednesday.
            entry.activities = [
              {
                kind: "ongoing",
                label: `Still ${STATUS_LABELS[interval.status as TaskStatusKey].toLowerCase()}`,
                at: null,
                time: null,
                count: 1,
                sortAt: Number.POSITIVE_INFINITY,
              },
            ];
          }
        }
      }
    }

    // The task table: open at some point in the range.
    let finishedAt: Date | null = null;
    if (FINISHED.has(task.status)) {
      const last = [...taskHistory].reverse().find((h) => FINISHED.has(h.toStatus));
      finishedAt = last?.createdAt ?? task.completedAt ?? task.updatedAt;
    }
    const openInRange = !finishedAt || finishedAt >= rangeStart;
    const theirs = onIt.length > 0 || (everyone && assignees.length === 0);

    if (openInRange && theirs) {
      reportTasks.push({
        id: task.id,
        title: task.title,
        description: task.description ?? "",
        parentTitle: task.parentTask?.title ?? null,
        status: task.status as TaskStatusKey,
        priority: task.priority as TaskPriorityKey,
        assignees: assignees.map(nameOf),
        createdBy: nameOf(task.createdById),
        team: task.team?.name ?? null,
        labels: task.labels.map((l) => l.label),
        source: task.source,
        createdAt: task.createdAt.toISOString(),
        startAt: task.startAt?.toISOString() ?? null,
        dueAt: task.dueAt?.toISOString() ?? null,
        completedAt:
          task.status === "DONE" ? (task.completedAt?.toISOString() ?? null) : null,
        estimatedMinutes: task.estimatedMinutes,
        actualMinutes: task.actualMinutes,
        subtasks: task._count.subtasks,
        commentsInPeriod: commentsPerTask.get(task.id) ?? 0,
        overdue:
          !!task.dueAt && task.dueAt < now && !FINISHED.has(task.status),
      });
    }
  }

  // Meetings.
  const meetingTally = new Map<string, { count: number; minutes: number }>();

  for (const event of events) {
    const participants = new Set<string>();
    for (const a of event.attendees) {
      if (a.userId && a.status !== "DECLINED") participants.add(a.userId);
    }
    // Your own calendar is your own time. On a shared calendar an event with
    // no guests is its owner's.
    if (event.calendar.type === "PERSONAL" || participants.size === 0) {
      participants.add(event.calendar.ownerId);
    }

    const minutes = event.allDay
      ? null
      : Math.max(0, Math.round((event.endAt.getTime() - event.startAt.getTime()) / 60000));

    let dayKeys: string[];
    if (event.allDay) {
      const first = istDayKey(event.startAt);
      const last = istDayKey(new Date(Math.max(event.startAt.getTime(), event.endAt.getTime() - 1)));
      dayKeys = daySpan(first < filters.from ? filters.from : first, last > filters.to ? filters.to : last);
    } else {
      dayKeys = [istDayKey(event.startAt < rangeStart ? rangeStart : event.startAt)];
    }

    const timeRange = event.allDay
      ? "All day"
      : `${time(event.startAt)}–${time(event.endAt)}`;

    for (const person of participants) {
      if (!peopleSet.has(person)) continue;

      // An all-day event is a leave day or a launch date, not a meeting: it
      // goes in the log so the day reads right, but not in the meeting count.
      if (!event.allDay) {
        const t = meetingTally.get(person) ?? { count: 0, minutes: 0 };
        t.count += 1;
        t.minutes += minutes ?? 0;
        meetingTally.set(person, t);
      }

      for (const day of dayKeys) {
        const key = `${day}|${person}|m:${event.id}`;
        const sortAt = event.allDay ? 0 : event.startAt.getTime();
        entries.set(key, {
          id: key,
          dayKey: day,
          userId: person,
          type: "meeting",
          taskId: null,
          title: event.title,
          parentTitle: null,
          activities: [
            {
              kind: "meeting",
              label: event.allDay ? "All day" : "Meeting",
              at: event.startAt.toISOString(),
              time: event.allDay ? null : time(event.startAt),
              count: 1,
              sortAt,
            },
          ],
          status: null,
          priority: null,
          labels: [],
          team: null,
          dueKey: null,
          timeRange,
          minutes,
          sortAt,
        });
      }
    }
  }

  // --- Summaries -----------------------------------------------------------

  const allEntries = [...entries.values()];
  const order = new Map(people.map((p, i) => [p.userId, i]));

  const perDay = new Map<string, Record<string, number>>();
  const activeDays = new Map<string, Set<string>>();
  for (const e of allEntries) {
    if (e.activities.every((a) => a.kind === "ongoing")) continue;
    const rec = perDay.get(e.userId) ?? {};
    rec[e.dayKey] = (rec[e.dayKey] ?? 0) + 1;
    perDay.set(e.userId, rec);
    const set = activeDays.get(e.userId) ?? new Set<string>();
    set.add(e.dayKey);
    activeDays.set(e.userId, set);
  }

  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const summaries: PersonSummary[] = people.map((p) => {
    const completed = [...(completedTasks.get(p.userId) ?? [])]
      .map((id) => taskById.get(id))
      .filter((t): t is TaskRow => !!t);

    const withDue = completed.filter((t) => t.dueAt && t.completedAt);
    const onTime = withDue.filter(
      (t) => istDayKey(t.completedAt!) <= istDayKey(t.dueAt!)
    );

    const estimates = completed
      .map((t) => t.estimatedMinutes)
      .filter((m): m is number => m !== null);

    const completedPerDay: Record<string, number> = {};
    for (const t of completed) {
      const day = istDayKey(t.completedAt!);
      completedPerDay[day] = (completedPerDay[day] ?? 0) + 1;
    }

    const open = openNow.filter((t) => t.assignments.some((a) => a.userId === p.userId));
    const meetings = meetingTally.get(p.userId);

    return {
      userId: p.userId,
      completed: completed.length,
      onTimeRate: withDue.length > 0 ? onTime.length / withDue.length : null,
      started: startedTasks.get(p.userId)?.size ?? 0,
      comments: commentCount.get(p.userId) ?? 0,
      added: addedCount.get(p.userId) ?? 0,
      meetings: meetings?.count ?? 0,
      meetingMinutes: meetings?.minutes ?? 0,
      activeDays: activeDays.get(p.userId)?.size ?? 0,
      openNow: open.length,
      overdueNow: open.filter((t) => t.dueAt && t.dueAt < now).length,
      estimatedMinutesDone:
        estimates.length > 0 ? estimates.reduce((s, m) => s + m, 0) : null,
      perDay: perDay.get(p.userId) ?? {},
      completedPerDay,
    };
  });

  const allCompleted = new Set<string>();
  for (const set of completedTasks.values()) set.forEach((id) => allCompleted.add(id));
  const allStarted = new Set<string>();
  for (const set of startedTasks.values()) set.forEach((id) => allStarted.add(id));

  // --- Out -----------------------------------------------------------------

  const kinds = new Set(filters.kinds);

  const logEntries: LogEntry[] = allEntries
    .map((e) => ({
      ...e,
      activities: e.activities
        .filter((a) => kinds.has(a.kind))
        .sort((a, b) => a.sortAt - b.sortAt),
    }))
    .filter((e) => e.activities.length > 0)
    .sort(
      (a, b) =>
        a.dayKey.localeCompare(b.dayKey) ||
        (order.get(a.userId) ?? 0) - (order.get(b.userId) ?? 0) ||
        a.sortAt - b.sortAt ||
        a.title.localeCompare(b.title)
    )
    .map((e) => ({
      id: e.id,
      dayKey: e.dayKey,
      userId: e.userId,
      type: e.type,
      taskId: e.taskId,
      title: e.title,
      parentTitle: e.parentTitle,
      activities: e.activities.map((a) => ({
        kind: a.kind,
        label: a.label,
        at: a.at,
        time: a.time,
      })),
      status: e.status,
      priority: e.priority,
      labels: e.labels,
      team: e.team,
      dueKey: e.dueKey,
      timeRange: e.timeRange,
      minutes: e.minutes,
    }));

  const STATUS_ORDER: Record<string, number> = {
    BLOCKED: 0,
    IN_PROGRESS: 1,
    IN_REVIEW: 2,
    TODO: 3,
    BACKLOG: 4,
    DONE: 5,
    CANCELLED: 6,
  };

  reportTasks.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.status === "DONE"
        ? (b.completedAt ?? "").localeCompare(a.completedAt ?? "")
        : (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999")) ||
      a.title.localeCompare(b.title)
  );

  rawEvents.sort((a, b) => a.at.localeCompare(b.at));

  const overdueIds = new Set(
    openNow.filter((t) => t.dueAt && t.dueAt < now).map((t) => t.id)
  );

  return {
    ...empty,
    summaries,
    entries: logEntries,
    tasks: reportTasks,
    events: rawEvents.map(({ userId: actor, ...e }) => ({
      ...e,
      person: actor ? nameOf(actor) : null,
    })),
    totals: {
      completed: allCompleted.size,
      started: allStarted.size,
      comments: [...commentCount.values()].reduce((s, n) => s + n, 0),
      meetingMinutes: [...meetingTally.values()].reduce((s, t) => s + t.minutes, 0),
      activePeople: summaries.filter((s) => s.activeDays > 0).length,
      overdueNow: overdueIds.size,
    },
    truncated,
  };
}

function describeFilters(
  filters: ReportFilters,
  audience: ReportAudience,
  people: ReportPerson[],
  team: ReportTeam | undefined,
  label: ReportLabel | undefined
): string[] {
  const lines: string[] = [];

  if (filters.people.length > 0 || people.length < audience.people.length) {
    lines.push(
      `People: ${people.length > 0 ? people.map((p) => p.name).join(", ") : "nobody you can report on"}`
    );
  } else {
    lines.push(people.length === 1 ? `People: ${people[0].name}` : "People: everyone");
  }

  if (team) lines.push(`Team: ${team.name}`);
  if (label) lines.push(`Label: ${label.name}`);
  if (filters.priorities.length > 0) {
    lines.push(`Priority: ${filters.priorities.map((p) => PRIORITY_LABELS[p]).join(", ")}`);
  }
  if (filters.statuses.length > 0) {
    lines.push(`Status now: ${filters.statuses.map((s) => STATUS_LABELS[s]).join(", ")}`);
  }
  if (filters.q) lines.push(`Title contains: "${filters.q}"`);
  if (filters.kinds.length < Object.keys(ACTIVITY_LABELS).length) {
    lines.push(
      `Daily log shows: ${filters.kinds.map((k) => ACTIVITY_LABELS[k]).join(", ")}`
    );
  }
  if (tasksOnly(filters)) {
    lines.push("Meetings left out: they have no label, priority or status");
  }

  return lines;
}
