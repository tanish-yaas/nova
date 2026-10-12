import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { addDaysToKey, istKeyToDate, istTodayKey } from "@/lib/dates";
import { NOT_MEETING_TASK } from "@/server/services/tasks";

/**
 * Which tasks an insight is talking about. The text says "3 tasks are overdue";
 * this is how the panel can then show you which three.
 *
 * `null` is for the all-clear line, which describes an absence and has nothing
 * to open.
 */
export type InsightFilter =
  | "overdue"
  | "due-today"
  | "undated"
  | "unassigned"
  | "done-week"
  | null;

export type Insight = {
  key: string;
  type: string;
  text: string;
  filter: InsightFilter;
};

/**
 * Always-on observations for the dashboard, derived live from the current task
 * rows rather than stored.
 *
 * The AISuggestion table only fills from runIntelligence, which runs once a
 * night, and a row leaves the feed the moment it is accepted or dismissed. So
 * the panel empties out within a day of being read and stays empty until the
 * next 02:00 — which is what it does today. These fill that gap.
 *
 * They are observations, not proposals: nothing here writes, so there is no
 * accept or dismiss and no conflict with "AI proposes, users confirm". Real
 * suggestions still take precedence when any are pending.
 */
export async function getDashboardInsights(
  orgId: string,
  userId: string
): Promise<Insight[]> {
  const todayKey = istTodayKey();
  const startOfDay = istKeyToDate(todayKey);
  const endOfDay = istKeyToDate(addDaysToKey(todayKey, 1));
  const weekAgo = istKeyToDate(addDaysToKey(todayKey, -7));

  // Annotated rather than inferred: pulled out of a query call these lose the
  // contextual typing that narrows "DONE" to the TaskStatus enum.
  const mine: Prisma.TaskWhereInput = {
    organizationId: orgId,
    deletedAt: null,
    assignments: { some: { userId } },
  };
  const open: Prisma.TaskWhereInput = {
    ...mine,
    status: { notIn: ["DONE", "CANCELLED"] },
  };

  const [overdue, oldest, dueToday, undated, unassigned, doneThisWeek, openCount] =
    await Promise.all([
      prisma.task.count({ where: { ...open, dueAt: { lt: startOfDay } } }),
      prisma.task.findFirst({
        where: { ...open, dueAt: { lt: startOfDay } },
        orderBy: { dueAt: "asc" },
        select: { title: true, dueAt: true },
      }),
      prisma.task.count({
        where: { ...open, dueAt: { gte: startOfDay, lt: endOfDay } },
      }),
      // A meeting's task has no due date on purpose: its time is the meeting's.
      prisma.task.count({ where: { ...open, dueAt: null, ...NOT_MEETING_TASK } }),
      prisma.task.count({
        where: {
          organizationId: orgId,
          deletedAt: null,
          status: { notIn: ["DONE", "CANCELLED"] },
          assignments: { none: {} },
        },
      }),
      prisma.task.count({
        where: { ...mine, status: "DONE", completedAt: { gte: weekAgo } },
      }),
      prisma.task.count({ where: open }),
    ]);

  const out: Insight[] = [];

  if (overdue > 0 && oldest?.dueAt) {
    const days = Math.floor(
      (startOfDay.getTime() - oldest.dueAt.getTime()) / 86_400_000
    );
    out.push({
      key: "overdue",
      filter: "overdue",
      type: "DEADLINE_ADJUSTMENT",
      text: `${overdue} ${overdue === 1 ? "task is" : "tasks are"} overdue. The oldest, "${oldest.title}", is ${days} ${days === 1 ? "day" : "days"} past due.`,
    });
  }

  if (dueToday > 0) {
    out.push({
      key: "due-today",
      filter: "due-today",
      type: "TASK_PRIORITY",
      text: `${dueToday} ${dueToday === 1 ? "task is" : "tasks are"} due today.`,
    });
  }

  if (undated > 0) {
    out.push({
      key: "undated",
      filter: "undated",
      type: "DEADLINE_ADJUSTMENT",
      text: `${undated} open ${undated === 1 ? "task has" : "tasks have"} no due date, so ${undated === 1 ? "it will" : "they will"} never surface in a digest.`,
    });
  }

  if (unassigned > 0) {
    out.push({
      key: "unassigned",
      filter: "unassigned",
      type: "WORKLOAD_REBALANCE",
      text: `${unassigned} open ${unassigned === 1 ? "task is" : "tasks are"} unassigned and belong to nobody's board.`,
    });
  }

  if (doneThisWeek > 0) {
    out.push({
      key: "done-week",
      filter: "done-week",
      type: "TASK_BREAKDOWN",
      text: `You closed ${doneThisWeek} ${doneThisWeek === 1 ? "task" : "tasks"} in the last seven days.`,
    });
  }

  // The panel should never read as broken, so say something even when the
  // board is spotless.
  if (out.length === 0) {
    out.push({
      key: "clear",
      filter: null,
      type: "TASK_PRIORITY",
      text:
        openCount === 0
          ? "No open tasks. Nothing needs your attention."
          : `${openCount} open ${openCount === 1 ? "task" : "tasks"}, none overdue or due today. You are ahead.`,
    });
  }

  return out;
}
