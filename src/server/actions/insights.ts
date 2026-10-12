"use server";

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { requireContext } from "@/server/rbac/guard";
import { NOT_MEETING_TASK, buildTaskScope } from "@/server/services/tasks";
import { addDaysToKey, formatIST, istKeyToDate, istTodayKey } from "@/lib/dates";
import type { InsightFilter } from "@/server/services/insights";

export type InsightTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueLabel: string | null;
  overdue: boolean;
  assignees: string[];
};

const TITLES: Record<NonNullable<InsightFilter>, string> = {
  overdue: "Overdue",
  "due-today": "Due today",
  undated: "No due date",
  unassigned: "Unassigned",
  "done-week": "Closed this week",
};

/**
 * The tasks behind an insight row.
 *
 * Insights are counts — "3 tasks are overdue" — and a count you cannot open is
 * a dead end. The clauses here mirror getDashboardInsights exactly, so the list
 * is the same set the number came from.
 *
 * One deliberate difference: this reads through buildTaskScope, while the
 * unassigned count is org-wide. A viewer whose scope is narrower will see fewer
 * rows than the number promised, which is the right way round — the alternative
 * is listing tasks their role is not allowed to see.
 */
export async function getInsightTasks(filter: NonNullable<InsightFilter>) {
  const ctx = await requireContext();
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  if (!(filter in TITLES)) {
    return { ok: false as const, error: "Unknown insight" };
  }

  const scope = await buildTaskScope(orgId, userId, ctx.permissions);

  const todayKey = istTodayKey();
  const startOfDay = istKeyToDate(todayKey);
  const endOfDay = istKeyToDate(addDaysToKey(todayKey, 1));
  const weekAgo = istKeyToDate(addDaysToKey(todayKey, -7));

  const open: Prisma.TaskWhereInput = {
    status: { notIn: ["DONE", "CANCELLED"] },
  };

  const mine: Prisma.TaskWhereInput = { assignments: { some: { userId } } };

  const where: Prisma.TaskWhereInput = { ...scope };

  if (filter === "overdue") {
    Object.assign(where, mine, open, { dueAt: { lt: startOfDay } });
  } else if (filter === "due-today") {
    Object.assign(where, mine, open, {
      dueAt: { gte: startOfDay, lt: endOfDay },
    });
  } else if (filter === "undated") {
    Object.assign(where, mine, open, { dueAt: null, ...NOT_MEETING_TASK });
  } else if (filter === "unassigned") {
    Object.assign(where, open, { assignments: { none: {} } });
  } else {
    Object.assign(where, mine, {
      status: "DONE" as const,
      completedAt: { gte: weekAgo },
    });
  }

  const rows = await prisma.task.findMany({
    where,
    orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    take: 50,
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      dueAt: true,
      assignments: { select: { user: { select: { name: true } } } },
    },
  });

  const now = new Date();

  const tasks: InsightTask[] = rows.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    // Formatted here, not in the client: the app is pinned to IST and the
    // browser is not, so a client format would drift and mismatch on hydration.
    dueLabel: formatIST(t.dueAt, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }),
    overdue: !!t.dueAt && t.dueAt < now && t.status !== "DONE",
    assignees: t.assignments.map((a) => a.user.name ?? "").filter(Boolean),
  }));

  return { ok: true as const, title: TITLES[filter], tasks };
}
