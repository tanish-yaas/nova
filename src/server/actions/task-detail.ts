"use server";

import { prisma } from "@/lib/prisma";
import { requireContext, requirePermission, revalidateWorkspace } from "@/server/rbac/guard";
import { getTaskDetail, type TaskDetailData } from "@/server/services/task-detail";
import { buildTaskScope, canMutateTask, meetingForTask } from "@/server/services/tasks";
import {
  MAX_ATTACHMENT_BYTES,
  isStorageConfigured,
  removeObject,
  signedUrl,
  uploadAttachment as uploadToStorage,
} from "@/lib/storage";

function refresh() {
  revalidateWorkspace("/tasks", "/", "/calendar");
}

/** Confirm the task is inside the caller's scope before touching anything. */
async function requireVisibleTask(taskId: string) {
  const ctx = await requireContext();
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  const scope = await buildTaskScope(orgId, userId, ctx.permissions);
  const task = await prisma.task.findFirst({
    where: { ...scope, id: taskId },
    select: { id: true, title: true },
  });

  return task ? { ctx, orgId, userId, task } : null;
}

export async function loadTaskDetail(
  taskId: string
): Promise<{ ok: true; detail: TaskDetailData } | { ok: false; error: string }> {
  const ctx = await requireContext();

  const detail = await getTaskDetail(
    taskId,
    ctx.membership!.organizationId,
    ctx.session.user.id,
    ctx.permissions
  );

  if (!detail) return { ok: false as const, error: "Task not found" };
  return { ok: true as const, detail };
}

// ---------------------------------------------------------------------------
// Subtasks
// ---------------------------------------------------------------------------

export async function addSubtask(parentTaskId: string, rawTitle: string) {
  const ctx = await requirePermission("task.create");
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  const title = rawTitle.trim();
  if (!title) return { ok: false as const, error: "Give the subtask a title" };
  if (title.length > 200) {
    return { ok: false as const, error: "That title is too long" };
  }

  const parent = await canMutateTask(parentTaskId, orgId, userId, ctx.permissions);
  if (!parent) return { ok: false as const, error: "Not allowed" };
  if (parent.parentTaskId) {
    return { ok: false as const, error: "Subtasks only nest one level deep" };
  }

  const siblings = await prisma.task.count({
    where: { parentTaskId, deletedAt: null },
  });

  await prisma.task.create({
    data: {
      organizationId: orgId,
      createdById: userId,
      parentTaskId,
      teamId: parent.teamId,
      title,
      startAt: new Date(),
      status: "TODO",
      priority: parent.priority,
      position: siblings,
      source: "MANUAL",
    },
  });

  refresh();
  return { ok: true as const };
}

export async function setSubtaskDone(subtaskId: string, done: boolean) {
  const ctx = await requirePermission("task.edit_own");
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  const task = await canMutateTask(subtaskId, orgId, userId, ctx.permissions);
  if (!task) return { ok: false as const, error: "Not allowed" };

  const next = done ? ("DONE" as const) : ("TODO" as const);
  if (task.status === next) return { ok: true as const };

  await prisma.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: subtaskId },
      data: { status: next, completedAt: done ? new Date() : null },
    });

    await tx.taskStatusHistory.create({
      data: {
        organizationId: orgId,
        taskId: subtaskId,
        fromStatus: task.status,
        toStatus: next,
        changedById: userId,
      },
    });
  });

  refresh();
  return { ok: true as const };
}

export async function deleteSubtask(subtaskId: string) {
  const ctx = await requirePermission("task.delete_own");
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  const task = await canMutateTask(subtaskId, orgId, userId, ctx.permissions);
  if (!task) return { ok: false as const, error: "Not allowed" };

  await prisma.task.update({
    where: { id: subtaskId },
    data: { deletedAt: new Date() },
  });

  refresh();
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export async function addComment(
  taskId: string,
  rawBody: string,
  parentId?: string | null
) {
  const visible = await requireVisibleTask(taskId);
  if (!visible) return { ok: false as const, error: "Not allowed" };

  const { orgId, userId, task } = visible;

  const body = rawBody.trim();
  if (!body) return { ok: false as const, error: "Write something first" };
  if (body.length > 5000) {
    return { ok: false as const, error: "That comment is too long" };
  }

  let parent: string | null = null;
  if (parentId) {
    const existing = await prisma.taskComment.findFirst({
      where: { id: parentId, taskId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    parent = existing?.id ?? null;
  }

  await prisma.taskComment.create({
    data: {
      organizationId: orgId,
      taskId,
      authorId: userId,
      parentId: parent,
      body,
    },
  });

  const others = await prisma.taskAssignment.findMany({
    where: { taskId, userId: { not: userId } },
    select: { userId: true },
  });

  if (others.length > 0) {
    await prisma.notification.createMany({
      data: others.map((a) => ({
        organizationId: orgId,
        userId: a.userId,
        type: "TASK_COMMENT" as const,
        title: "New comment",
        // The comment alone: the task and the author ride along as taskId
        // and data, and the screen puts the sentence together.
        body: body.slice(0, 280),
        taskId,
        data: { actorId: userId },
      })),
    });
  }

  refresh();
  return { ok: true as const };
}

export async function editComment(commentId: string, rawBody: string) {
  const ctx = await requireContext();
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  const body = rawBody.trim();
  if (!body) return { ok: false as const, error: "Comment can't be empty" };
  if (body.length > 5000) {
    return { ok: false as const, error: "That comment is too long" };
  }

  const { count } = await prisma.taskComment.updateMany({
    where: {
      id: commentId,
      organizationId: orgId,
      authorId: userId,
      deletedAt: null,
    },
    data: { body, isEdited: true },
  });

  if (count === 0) return { ok: false as const, error: "Not allowed" };

  refresh();
  return { ok: true as const };
}

export async function deleteComment(commentId: string) {
  const ctx = await requireContext();
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  const { count } = await prisma.taskComment.updateMany({
    where: {
      id: commentId,
      organizationId: orgId,
      authorId: userId,
      deletedAt: null,
    },
    data: { deletedAt: new Date() },
  });

  if (count === 0) return { ok: false as const, error: "Not allowed" };

  refresh();
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Assignees
// ---------------------------------------------------------------------------

/**
 * Replace a task's assignees.
 *
 * The first id becomes OWNER and the rest COLLABORATOR, matching how the
 * composers create them. An empty list is allowed on purpose — "unassigned" is
 * a real state the board and the insights both count, so editing must be able
 * to reach it.
 */
export async function setTaskAssignees(taskId: string, userIds: string[]) {
  const ctx = await requirePermission("task.edit_own");
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  const task = await canMutateTask(taskId, orgId, userId, ctx.permissions);
  if (!task) return { ok: false as const, error: "Not allowed" };

  // A meeting's people are whoever is invited and coming; the meeting owns
  // that list, so it is changed there and not here.
  if (await meetingForTask(taskId)) {
    return { ok: false as const, error: "Change who's on a meeting from the meeting itself" };
  }

  // Membership is re-checked rather than trusted from the client: this list
  // comes back as ids from a picker, and an id that is not an active member of
  // this org must never end up on a task.
  const valid = await prisma.organizationMember.findMany({
    where: { organizationId: orgId, userId: { in: userIds }, status: "ACTIVE" },
    select: { userId: true },
  });

  // Preserve the order the picker sent, so whoever is first stays the owner.
  const ordered = userIds.filter((id) => valid.some((v) => v.userId === id));

  const before = await prisma.taskAssignment.findMany({
    where: { taskId },
    select: { userId: true },
  });
  const had = new Set(before.map((a) => a.userId));

  await prisma.$transaction(async (tx) => {
    await tx.taskAssignment.deleteMany({ where: { taskId } });

    if (ordered.length > 0) {
      await tx.taskAssignment.createMany({
        data: ordered.map((id, i) => ({
          organizationId: orgId,
          taskId,
          userId: id,
          role: i === 0 ? ("OWNER" as const) : ("COLLABORATOR" as const),
          assignedById: userId,
        })),
        skipDuplicates: true,
      });
    }

    // Only the people who were not already on it, and never yourself.
    const added = ordered.filter((id) => !had.has(id) && id !== userId);
    if (added.length > 0) {
      await tx.notification.createMany({
        data: added.map((id) => ({
          organizationId: orgId,
          userId: id,
          type: "TASK_ASSIGNED" as const,
          title: "New task assigned",
          body: task.title,
          taskId,
          data: { actorId: userId },
        })),
      });
    }
  });

  refresh();
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
}

export async function uploadTaskAttachment(formData: FormData) {
  if (!isStorageConfigured()) {
    return {
      ok: false as const,
      error: "File storage isn't configured. See the setup note in Settings",
    };
  }

  const taskId = String(formData.get("taskId") ?? "");
  const file = formData.get("file");

  if (!taskId || !(file instanceof File) || file.size === 0) {
    return { ok: false as const, error: "Pick a file first" };
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false as const, error: "Files are capped at 10 MB" };
  }

  const visible = await requireVisibleTask(taskId);
  if (!visible) return { ok: false as const, error: "Not allowed" };

  const { orgId, userId } = visible;

  const storageKey = `${orgId}/${taskId}/${crypto.randomUUID()}-${safeFileName(
    file.name
  )}`;

  const uploaded = await uploadToStorage(
    storageKey,
    await file.arrayBuffer(),
    file.type
  );

  if (!uploaded.ok) return { ok: false as const, error: uploaded.error };

  await prisma.attachment.create({
    data: {
      organizationId: orgId,
      taskId,
      uploadedById: userId,
      fileName: file.name.slice(0, 200),
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      storageKey,
    },
  });

  refresh();
  return { ok: true as const };
}

export async function attachmentLink(attachmentId: string) {
  const ctx = await requireContext();
  const orgId = ctx.membership!.organizationId;

  const attachment = await prisma.attachment.findFirst({
    where: { id: attachmentId, organizationId: orgId, deletedAt: null },
    select: { storageKey: true, taskId: true },
  });

  if (!attachment?.taskId) {
    return { ok: false as const, error: "Attachment not found" };
  }

  const visible = await requireVisibleTask(attachment.taskId);
  if (!visible) return { ok: false as const, error: "Not allowed" };

  const link = await signedUrl(attachment.storageKey);
  if (!link.ok) return { ok: false as const, error: link.error };

  return { ok: true as const, url: link.url };
}

export async function deleteAttachment(attachmentId: string) {
  const ctx = await requireContext();
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  const attachment = await prisma.attachment.findFirst({
    where: { id: attachmentId, organizationId: orgId, deletedAt: null },
    select: { id: true, storageKey: true, uploadedById: true, taskId: true },
  });

  if (!attachment) return { ok: false as const, error: "Attachment not found" };

  const owns = attachment.uploadedById === userId;
  const canManage = ctx.permissions.has("task.edit_any");
  if (!owns && !canManage) return { ok: false as const, error: "Not allowed" };

  // The row is the record of truth; the object is just bytes, so drop both.
  await prisma.attachment.update({
    where: { id: attachment.id },
    data: { deletedAt: new Date() },
  });
  await removeObject(attachment.storageKey);

  refresh();
  return { ok: true as const };
}
