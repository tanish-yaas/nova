import { prisma } from "@/lib/prisma";
import { digestKindOf, type NotificationView } from "@/lib/notifications";
import { istDayKey } from "@/lib/dates";

export async function getUnreadCount(orgId: string, userId: string) {
  return prisma.notification.count({
    where: {
      organizationId: orgId,
      userId,
      readAt: null,
      archivedAt: null,
    },
  });
}

/** Comment notifications used to carry their task in the body, in brackets. */
const ON_TASK = /\s*\(on "[^"]*"\)\s*$/;

type StoredData = { actorId?: unknown; digest?: unknown; change?: unknown } | null;

/**
 * A user's notifications, ready to draw: who, which task, which digest.
 *
 * New rows store their actor in `data`. Rows written before that are filled
 * in from what the database already knows: an assignment records who made
 * it, and a comment notification lands the moment its comment does, so the
 * comment just before it on that task is the one. Nothing is backfilled; old
 * rows are read the new way.
 */
export async function getNotifications(
  orgId: string,
  userId: string,
  options: { limit?: number } = {}
): Promise<NotificationView[]> {
  const rows = await prisma.notification.findMany({
    where: { organizationId: orgId, userId, archivedAt: null },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 30,
    select: {
      id: true,
      type: true,
      title: true,
      body: true,
      data: true,
      taskId: true,
      createdAt: true,
      readAt: true,
      task: { select: { id: true, title: true, deletedAt: true } },
      event: { select: { id: true, title: true, startAt: true, deletedAt: true } },
    },
  });

  const actorOf = new Map<string, string>();
  const quoteOf = new Map<string, string>();

  for (const r of rows) {
    const actorId = (r.data as StoredData)?.actorId;
    if (typeof actorId === "string" && actorId !== userId) actorOf.set(r.id, actorId);
    if (r.type === "TASK_COMMENT" && r.body) {
      quoteOf.set(r.id, r.body.replace(ON_TASK, "").trim());
    }
  }

  const isRecurring = (r: (typeof rows)[number]) =>
    r.type === "TASK_ASSIGNED" && r.title === "Recurring task due";

  const missingAssigner = rows.filter(
    (r) => r.type === "TASK_ASSIGNED" && r.taskId && !actorOf.has(r.id) && !isRecurring(r)
  );
  const missingCommenter = rows.filter(
    (r) => r.type === "TASK_COMMENT" && r.taskId && !actorOf.has(r.id)
  );

  const [assignments, comments] = await Promise.all([
    missingAssigner.length > 0
      ? prisma.taskAssignment.findMany({
          where: {
            organizationId: orgId,
            userId,
            taskId: { in: missingAssigner.map((r) => r.taskId!) },
          },
          select: { taskId: true, assignedById: true },
        })
      : Promise.resolve([]),
    missingCommenter.length > 0
      ? prisma.taskComment.findMany({
          where: {
            organizationId: orgId,
            taskId: { in: missingCommenter.map((r) => r.taskId!) },
            authorId: { not: userId },
            createdAt: {
              lte: new Date(
                Math.max(...missingCommenter.map((r) => r.createdAt.getTime())) + 5000
              ),
            },
          },
          orderBy: { createdAt: "desc" },
          take: 500,
          select: { taskId: true, authorId: true, createdAt: true },
        })
      : Promise.resolve([]),
  ]);

  const assigner = new Map(assignments.map((a) => [a.taskId, a.assignedById]));
  for (const r of missingAssigner) {
    const id = assigner.get(r.taskId!);
    if (id && id !== userId) actorOf.set(r.id, id);
  }

  for (const r of missingCommenter) {
    // Newest first, so the first one at or before the notification is it.
    const comment = comments.find(
      (c) => c.taskId === r.taskId && c.createdAt.getTime() <= r.createdAt.getTime() + 5000
    );
    if (comment) actorOf.set(r.id, comment.authorId);
  }

  const actorIds = [...new Set(actorOf.values())];
  const users =
    actorIds.length > 0
      ? await prisma.user.findMany({
          where: {
            id: { in: actorIds },
            organizationMembers: { some: { organizationId: orgId } },
          },
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            profile: { select: { displayName: true, avatarUrl: true } },
          },
        })
      : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  return rows.map((r) => {
    const actor = userById.get(actorOf.get(r.id) ?? "");
    return {
      id: r.id,
      type: r.type,
      createdAt: r.createdAt.toISOString(),
      read: r.readAt !== null,
      actor: actor
        ? {
            id: actor.id,
            name: actor.profile?.displayName ?? actor.name ?? actor.email ?? "Someone",
            avatarUrl: actor.profile?.avatarUrl ?? null,
            image: actor.image,
          }
        : null,
      task: r.task
        ? { id: r.task.id, title: r.task.title, deleted: r.task.deletedAt !== null }
        : null,
      quote: quoteOf.get(r.id) || null,
      title: r.title,
      body: r.body,
      digest:
        r.type === "DIGEST" ? digestKindOf((r.data as StoredData)?.digest, r.body) : null,
      recurring: isRecurring(r),
      event: r.event
        ? {
            id: r.event.id,
            title: r.event.title,
            startAt: r.event.startAt.toISOString(),
            deleted: r.event.deletedAt !== null,
          }
        : null,
      change:
        (r.data as StoredData)?.change === "cancelled"
          ? "cancelled"
          : (r.data as StoredData)?.change === "moved"
            ? "moved"
            : null,
      // A meeting opens on its day in the calendar; one that was called off
      // has nowhere to go.
      href:
        r.type === "MEMBER_JOIN_REQUEST"
          ? "/admin/members"
          : r.event && !r.event.deletedAt
            ? `/calendar?view=day&date=${istDayKey(r.event.startAt)}`
            : null,
    };
  });
}
