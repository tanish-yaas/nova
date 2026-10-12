import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";

const PRIORITY_WEIGHT: Record<string, number> = {
  LOW: 5,
  MEDIUM: 15,
  HIGH: 30,
  URGENT: 45,
};

export function computePriorityScore(
  priority: string,
  dueAt: Date | null
): number {
  let score = PRIORITY_WEIGHT[priority] ?? 15;

  if (dueAt) {
    const hours = (dueAt.getTime() - Date.now()) / 3_600_000;
    if (hours < 0) score += 40;
    else if (hours < 24) score += 30;
    else if (hours < 72) score += 20;
    else if (hours < 168) score += 10;
  }

  return Math.round(score * 10) / 10;
}

/**
 * When a task starts if nobody said: the moment it was made, never later than
 * its own deadline. A task logged after the fact is then a point on the day it
 * was due rather than a bar running backwards.
 *
 * This is the rule the calendar already drew a start-less task by, so storing
 * it moves no bar. What it adds is a start date you can see and edit on the
 * task, and one the reports can count from.
 */
export function defaultStartAt(dueAt: Date | null, now = new Date()): Date {
  return dueAt && dueAt < now ? dueAt : now;
}

/**
 * Tasks that stand behind a meeting.
 *
 * Every meeting has a task of its own, linked through CalendarEvent.taskId:
 * that is what puts a meeting on the board, lets it be dragged between
 * columns and labelled, and carries its comments. Lists that already show the
 * meeting itself (the Tasks tab, the calendar, Reports) leave these out so a
 * meeting never appears twice. The organizer row is what marks an event as a
 * meeting; a plain event linked to a task does not count.
 */
export const MEETING_TASK: Prisma.TaskWhereInput = {
  events: { some: { deletedAt: null, attendees: { some: { isOrganizer: true } } } },
};

export const NOT_MEETING_TASK: Prisma.TaskWhereInput = {
  events: { none: { deletedAt: null, attendees: { some: { isOrganizer: true } } } },
};

/** The live meeting a task stands behind, if it is one. */
export async function meetingForTask(taskId: string) {
  return prisma.calendarEvent.findFirst({
    where: { taskId, deletedAt: null, attendees: { some: { isOrganizer: true } } },
    select: { id: true, startAt: true },
  });
}

export async function buildTaskScope(
  orgId: string,
  userId: string,
  permissions: Set<string>
): Promise<Prisma.TaskWhereInput> {
  const base: Prisma.TaskWhereInput = {
    organizationId: orgId,
    deletedAt: null,
  };

  if (permissions.has("task.view_any")) return base;

  const or: Prisma.TaskWhereInput[] = [
    { createdById: userId },
    { assignments: { some: { userId } } },
  ];

  if (permissions.has("task.view_team")) {
    const teams = await prisma.teamMember.findMany({
      where: { userId, organizationId: orgId },
      select: { teamId: true },
    });
    if (teams.length > 0) {
      or.push({ teamId: { in: teams.map((t) => t.teamId) } });
    }
  }

  return { ...base, OR: or };
}

export async function canMutateTask(
  taskId: string,
  orgId: string,
  userId: string,
  permissions: Set<string>
) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, organizationId: orgId, deletedAt: null },
    include: { assignments: { select: { userId: true } } },
  });

  if (!task) return null;
  if (permissions.has("task.edit_any")) return task;

  const isOwn =
    task.createdById === userId ||
    task.assignments.some((a) => a.userId === userId);

  return isOwn && permissions.has("task.edit_own") ? task : null;
}