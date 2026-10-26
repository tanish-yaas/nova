import { prisma } from "@/lib/prisma";
import { buildTaskScope } from "@/server/services/tasks";
import { formatIST, toLocalInput } from "@/lib/dates";
import { meetingMode, placeLabel } from "@/lib/meetings";
import { isStorageConfigured } from "@/lib/storage";
import type { TaskLinkItem } from "@/lib/task-links";

export type CommentNode = {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  authorImage: string | null;
  createdAt: string;
  isEdited: boolean;
  isDeleted: boolean;
  isMine: boolean;
  replies: CommentNode[];
};

export type AttachmentRow = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: string;
  isMine: boolean;
};

export type ActivityRow = {
  id: string;
  kind: "status" | "priority";
  at: string;
  actor: string;
  from: string | null;
  to: string;
  reason: string | null;
  byAI: boolean;
};

export type SubtaskRow = {
  id: string;
  title: string;
  status: string;
  done: boolean;
};

export type DependencyRow = {
  /** TaskDependency id, so the link can be removed without ambiguity. */
  id: string;
  taskId: string;
  title: string;
  status: string;
  done: boolean;
};

export type TaskDetailData = {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  /** "YYYY-MM-DDTHH:mm" for the editable fields; "" when unset. */
  startAtInput: string;
  dueAtInput: string;
  dueAtLabel: string | null;
  estimatedMinutes: string;
  createdAtLabel: string | null;
  updatedAtLabel: string | null;
  createdBy: string;
  assignees: { id: string; name: string; image: string | null }[];
  labels: { id: string; name: string; color: string }[];
  /** Every label in the workspace, so the picker needs no second round trip. */
  allLabels: { id: string; name: string; color: string }[];
  /** Active org members, so the assignee picker needs no second round trip. */
  allMembers: { id: string; name: string; image: string | null }[];
  teamId: string | null;
  teams: { id: string; name: string; color: string }[];
  /** Set when this task is itself a subtask, so the sheet can say whose. */
  parent: { id: string; title: string } | null;
  subtasks: SubtaskRow[];
  blockedBy: DependencyRow[];
  blocks: DependencyRow[];
  /** Every blocker is finished — the work can start. */
  readyToStart: boolean;
  comments: CommentNode[];
  attachments: AttachmentRow[];
  /** Deliverables: where the finished work lives. Oldest first. */
  links: TaskLinkItem[];
  activity: ActivityRow[];
  canEdit: boolean;
  /** Object storage is configured, so recording and uploading are available. */
  storageReady: boolean;
  /** Who is looking: the organizer if this task is turned into a meeting. */
  viewerId: string;
  /** Set when this task stands behind a meeting: its time, place and people
      belong to the meeting, so the sheet shows those instead of editing them. */
  meeting: {
    eventId: string;
    when: string;
    place: string;
    joinUrl: string | null;
  } | null;
};

const DONE_STATUSES = ["DONE", "CANCELLED"];

/** Nest a flat comment list on parentId, oldest first at every level. */
function threadComments(
  rows: {
    id: string;
    body: string;
    parentId: string | null;
    authorId: string;
    isEdited: boolean;
    deletedAt: Date | null;
    createdAt: Date;
    author: { name: string | null; email: string | null; image: string | null };
  }[],
  userId: string
): CommentNode[] {
  const nodes = new Map<string, CommentNode>();

  for (const row of rows) {
    nodes.set(row.id, {
      id: row.id,
      body: row.deletedAt ? "" : row.body,
      authorId: row.authorId,
      authorName: row.author.name ?? row.author.email ?? "Someone",
      authorImage: row.author.image,
      createdAt: row.createdAt.toISOString(),
      isEdited: row.isEdited,
      isDeleted: row.deletedAt !== null,
      isMine: row.authorId === userId,
      replies: [],
    });
  }

  const roots: CommentNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parentId ? nodes.get(row.parentId) : undefined;
    if (parent) parent.replies.push(node);
    else roots.push(node);
  }

  return roots;
}

export async function getTaskDetail(
  taskId: string,
  orgId: string,
  userId: string,
  permissions: Set<string>
): Promise<TaskDetailData | null> {
  const scope = await buildTaskScope(orgId, userId, permissions);

  const meetingRow = await prisma.calendarEvent.findFirst({
    where: { taskId, deletedAt: null, organizationId: orgId, attendees: { some: { isOrganizer: true } } },
    select: { id: true, startAt: true, endAt: true, location: true, meetingUrl: true },
  });

  const task = await prisma.task.findFirst({
    where: { ...scope, id: taskId },
    include: {
      createdBy: { select: { name: true, email: true } },
      parentTask: { select: { id: true, title: true } },
      assignments: {
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
        orderBy: { assignedAt: "asc" },
      },
      labels: { include: { label: true } },
      subtasks: {
        where: { deletedAt: null },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: { id: true, title: true, status: true },
      },
      comments: {
        orderBy: { createdAt: "asc" },
        include: {
          author: { select: { name: true, email: true, image: true } },
        },
      },
      attachments: {
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        include: { uploadedBy: { select: { name: true, email: true } } },
      },
      links: {
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" },
        select: { id: true, url: true, label: true },
      },
      dependencies: {
        where: { type: "BLOCKS" },
        include: {
          dependsOn: { select: { id: true, title: true, status: true } },
        },
      },
      dependents: {
        where: { type: "BLOCKS" },
        include: {
          task: { select: { id: true, title: true, status: true } },
        },
      },
      statusHistory: {
        orderBy: { createdAt: "desc" },
        take: 40,
        include: { changedBy: { select: { name: true, email: true } } },
      },
      priorityHistory: {
        orderBy: { createdAt: "desc" },
        take: 40,
        include: { changedBy: { select: { name: true, email: true } } },
      },
    },
  });

  if (!task) return null;

  const [allLabels, teams, memberRows] = await Promise.all([
    prisma.label.findMany({
      where: { organizationId: orgId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    }),
    prisma.team.findMany({
      where: { organizationId: orgId, deletedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    }),
    // The roster, so reassigning needs no second round trip — the same reason
    // allLabels rides along.
    prisma.organizationMember.findMany({
      where: { organizationId: orgId, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
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
    }),
  ]);

  const allMembers = memberRows.map((m) => ({
    id: m.userId,
    name: m.user.profile?.displayName ?? m.user.name ?? m.user.email ?? "Member",
    image: m.user.profile?.avatarUrl ?? m.user.image ?? null,
  }));

  const blockedBy: DependencyRow[] = task.dependencies.map((d) => ({
    id: d.id,
    taskId: d.dependsOn.id,
    title: d.dependsOn.title,
    status: d.dependsOn.status,
    done: DONE_STATUSES.includes(d.dependsOn.status),
  }));

  const canEdit =
    permissions.has("task.edit_any") ||
    (permissions.has("task.edit_own") &&
      (task.createdById === userId ||
        task.assignments.some((a) => a.userId === userId)));

  const activity: ActivityRow[] = [
    ...task.statusHistory.map((h) => ({
      id: `s-${h.id}`,
      kind: "status" as const,
      at: h.createdAt.toISOString(),
      actor: h.changedBy?.name ?? h.changedBy?.email ?? "Nova",
      from: h.fromStatus ?? null,
      to: h.toStatus,
      reason: h.reason,
      byAI: false,
    })),
    ...task.priorityHistory.map((h) => ({
      id: `p-${h.id}`,
      kind: "priority" as const,
      at: h.createdAt.toISOString(),
      actor: h.changedByAI
        ? "Nova"
        : h.changedBy?.name ?? h.changedBy?.email ?? "Someone",
      from: h.fromPriority ?? (h.fromScore !== null ? `${h.fromScore}` : null),
      to: h.toPriority ?? `${h.toScore}`,
      reason: h.reason,
      byAI: h.changedByAI,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return {
    id: task.id,
    title: task.title,
    description: task.description ?? "",
    status: task.status,
    priority: task.priority,
    startAtInput: toLocalInput(task.startAt),
    dueAtInput: toLocalInput(task.dueAt),
    dueAtLabel: formatIST(task.dueAt),
    estimatedMinutes: task.estimatedMinutes ? String(task.estimatedMinutes) : "",
    createdAtLabel: formatIST(task.createdAt, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
    updatedAtLabel: formatIST(task.updatedAt, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
    createdBy: task.createdBy.name ?? task.createdBy.email ?? "Someone",
    assignees: task.assignments.map((a) => ({
      id: a.user.id,
      name: a.user.name ?? a.user.email ?? "Member",
      image: a.user.image,
    })),
    labels: task.labels.map((l) => ({
      id: l.label.id,
      name: l.label.name,
      color: l.label.color,
    })),
    allLabels,
    allMembers,
    teamId: task.teamId,
    teams: teams.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color ?? "#7C5CFF",
    })),
    parent: task.parentTask
      ? { id: task.parentTask.id, title: task.parentTask.title }
      : null,
    subtasks: task.subtasks.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      done: DONE_STATUSES.includes(s.status),
    })),
    blockedBy,
    blocks: task.dependents.map((d) => ({
      id: d.id,
      taskId: d.task.id,
      title: d.task.title,
      status: d.task.status,
      done: DONE_STATUSES.includes(d.task.status),
    })),
    readyToStart:
      blockedBy.length > 0 &&
      blockedBy.every((b) => b.done) &&
      !DONE_STATUSES.includes(task.status),
    comments: threadComments(task.comments, userId),
    attachments: task.attachments.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      uploadedBy: a.uploadedBy?.name ?? a.uploadedBy?.email ?? "Someone",
      createdAt: a.createdAt.toISOString(),
      isMine: a.uploadedById === userId,
    })),
    links: task.links,
    activity,
    canEdit,
    // Carried on the detail rather than passed in: the sheet is opened from the
    // board, the task rows and the suggestion sheet, none of which are server
    // components with the env to hand.
    storageReady: isStorageConfigured(),
    viewerId: userId,
    meeting: meetingRow
      ? (() => {
          const mode = meetingMode(meetingRow.location, meetingRow.meetingUrl);
          const t = (d: Date) => formatIST(d, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
          return {
            eventId: meetingRow.id,
            when: `${formatIST(meetingRow.startAt, { weekday: "short", day: "2-digit" })} · ${t(meetingRow.startAt)}–${t(meetingRow.endAt)}`,
            place: placeLabel(mode, meetingRow.location, meetingRow.meetingUrl),
            joinUrl: mode === "online" && meetingRow.endAt > new Date() ? meetingRow.meetingUrl : null,
          };
        })()
      : null,
  };
}
