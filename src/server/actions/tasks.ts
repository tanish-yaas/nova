"use server";

import { prisma } from "@/lib/prisma";
import { requirePermission, revalidateWorkspace } from "@/server/rbac/guard";
import { createTaskSchema, statusSchema } from "@/lib/validators/task";
import {
  computePriorityScore,
  canMutateTask,
  defaultStartAt,
  meetingForTask,
} from "@/server/services/tasks";
import { fromLocalInput } from "@/lib/dates";

function refresh() {
  revalidateWorkspace("/tasks", "/", "/calendar");
}

export async function createTask(formData: FormData) {
  const ctx = await requirePermission("task.create");
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  const parsed = createTaskSchema.safeParse({
    title: formData.get("title") ?? "",
    description: formData.get("description") ?? "",
    priority: formData.get("priority") ?? "MEDIUM",
    startAt: formData.get("startAt") ?? "",
    dueAt: formData.get("dueAt") ?? "",
    estimatedMinutes: formData.get("estimatedMinutes") || undefined,
    assigneeIds: formData.getAll("assigneeIds").map(String),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const d = parsed.data;
  const dueAt = fromLocalInput(d.dueAt);
  // A start after its own deadline is not a stretch of work, so it is dropped
  // rather than stored as a bar running backwards across the calendar, and the
  // task starts when it was made instead, like one given no start at all.
  const rawStart = fromLocalInput(d.startAt);
  const startAt =
    rawStart && !(dueAt && rawStart > dueAt) ? rawStart : defaultStartAt(dueAt);

  const assigneeIds = d.assigneeIds.length > 0 ? d.assigneeIds : [userId];

  const validMembers = await prisma.organizationMember.findMany({
    where: {
      organizationId: orgId,
      userId: { in: assigneeIds },
      status: "ACTIVE",
    },
    select: { userId: true },
  });

  const finalAssignees = validMembers.map((m) => m.userId);
  if (finalAssignees.length === 0) finalAssignees.push(userId);

  const requestedTeamId = String(formData.get("teamId") ?? "");
  const team = requestedTeamId
    ? await prisma.team.findFirst({
        where: {
          id: requestedTeamId,
          organizationId: orgId,
          deletedAt: null,
        },
        select: { id: true },
      })
    : null;

  const labelIds = formData.getAll("labelIds").map(String).filter(Boolean);
  const validLabels =
    labelIds.length > 0
      ? await prisma.label.findMany({
          where: { organizationId: orgId, id: { in: labelIds } },
          select: { id: true },
        })
      : [];

  // Returned so the composer can attach a voice note to the row it just made.
  const created = await prisma.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        organizationId: orgId,
        createdById: userId,
        teamId: team?.id ?? null,
        title: d.title,
        description: d.description || null,
        priority: d.priority,
        priorityScore: computePriorityScore(d.priority, dueAt),
        startAt,
        dueAt,
        estimatedMinutes: d.estimatedMinutes ?? null,
        status: "TODO",
        source: "MANUAL",
      },
    });

    await tx.taskAssignment.createMany({
      data: finalAssignees.map((id, i) => ({
        organizationId: orgId,
        taskId: task.id,
        userId: id,
        role: i === 0 ? ("OWNER" as const) : ("COLLABORATOR" as const),
        assignedById: userId,
      })),
      skipDuplicates: true,
    });

    if (validLabels.length > 0) {
      await tx.taskLabel.createMany({
        data: validLabels.map((l) => ({
          organizationId: orgId,
          taskId: task.id,
          labelId: l.id,
        })),
        skipDuplicates: true,
      });
    }

    await tx.activityLog.create({
      data: {
        organizationId: orgId,
        userId,
        action: "task.created",
        entityType: "Task",
        entityId: task.id,
        metadata: { title: task.title },
      },
    });

    const others = finalAssignees.filter((id) => id !== userId);
    if (others.length > 0) {
      await tx.notification.createMany({
        data: others.map((id) => ({
          organizationId: orgId,
          userId: id,
          type: "TASK_ASSIGNED" as const,
          title: "New task assigned",
          body: task.title,
          taskId: task.id,
          data: { actorId: userId },
        })),
      });
    }

    return task.id;
  });

  refresh();
  return { ok: true, taskId: created };
}

export async function updateTask(
  taskId: string,
  input: {
    title: string;
    description: string;
    priority: string;
    status: string;
    startAt: string;
    dueAt: string;
    estimatedMinutes: string;
  }
) {
  const ctx = await requirePermission("task.edit_own");
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  const task = await canMutateTask(taskId, orgId, userId, ctx.permissions);
  if (!task) return { ok: false as const, error: "Not allowed" };

  const title = input.title.trim();
  if (!title) return { ok: false as const, error: "Title can't be empty" };

  const parsedStatus = statusSchema.safeParse(input.status);
  if (!parsedStatus.success) return { ok: false as const, error: "Bad status" };

  // A meeting's task takes its time from the meeting, so the sheet's date
  // fields cannot pull the two apart.
  const meeting = await meetingForTask(taskId);
  const dueAt = meeting ? null : fromLocalInput(input.dueAt);
  const rawStart = meeting ? meeting.startAt : fromLocalInput(input.startAt);
  const startAt = rawStart && dueAt && rawStart > dueAt ? null : rawStart;

  const estimate = input.estimatedMinutes
    ? Number(input.estimatedMinutes)
    : null;

  await prisma.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: taskId },
      data: {
        title,
        description: input.description.trim() || null,
        priority: input.priority as "LOW" | "MEDIUM" | "HIGH" | "URGENT",
        status: parsedStatus.data,
        startAt,
        dueAt,
        estimatedMinutes:
          estimate !== null && Number.isFinite(estimate) ? estimate : null,
        priorityScore: computePriorityScore(input.priority, dueAt),
        // Only a change of status moves completedAt. The detail sheet saves
        // every field on every edit, so renaming a task done last week used to
        // re-stamp it as done today, and the report credited it to today.
        completedAt:
          parsedStatus.data !== "DONE"
            ? null
            : task.status === "DONE"
              ? (task.completedAt ?? new Date())
              : new Date(),
      },
    });

    if (parsedStatus.data !== task.status) {
      await tx.taskStatusHistory.create({
        data: {
          organizationId: orgId,
          taskId,
          fromStatus: task.status,
          toStatus: parsedStatus.data,
          changedById: userId,
        },
      });
    }
  });

  refresh();
  return { ok: true as const };
}

export async function setTaskStatus(taskId: string, nextStatus: string) {
  const ctx = await requirePermission("task.edit_own");
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  const status = statusSchema.safeParse(nextStatus);
  if (!status.success) return { error: "Unknown status" };

  const task = await canMutateTask(taskId, orgId, userId, ctx.permissions);
  if (!task) return { error: "Not allowed" };
  if (task.status === status.data) return { ok: true };

  await prisma.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: taskId },
      data: {
        status: status.data,
        completedAt: status.data === "DONE" ? new Date() : null,
      },
    });

    await tx.taskStatusHistory.create({
      data: {
        organizationId: orgId,
        taskId,
        fromStatus: task.status,
        toStatus: status.data,
        changedById: userId,
      },
    });
  });

  refresh();
  return { ok: true };
}

export async function deleteTask(taskId: string) {
  const ctx = await requirePermission("task.delete_own");
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  const task = await canMutateTask(taskId, orgId, userId, ctx.permissions);
  if (!task) return { error: "Not allowed" };

  await prisma.task.update({
    where: { id: taskId },
    data: { deletedAt: new Date() },
  });

  refresh();
  return { ok: true };
}