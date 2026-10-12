"use server";

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { requirePermission, requireContext, revalidateWorkspace } from "@/server/rbac/guard";
import { meetingInputSchema, rsvpSchema, type MeetingInput } from "@/lib/validators/meeting";
import { canMutateEvent, getWritableCalendar } from "@/server/services/calendar";
import { canMutateTask, computePriorityScore } from "@/server/services/tasks";
import { formatIST, fromLocalInput } from "@/lib/dates";
import { ONLINE_PLACE, normaliseMeetingUrl } from "@/lib/meetings";
import { APP_CONFIG } from "@/config/app";

type Result = { ok: true; id: string } | { ok: false; error: string };
type Tx = Prisma.TransactionClient;

function refresh() {
  revalidateWorkspace("/calendar", "/tasks", "/");
}

const when = (d: Date) =>
  formatIST(d, { weekday: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) ?? "";

/**
 * Turn the form into what is stored. Shared by schedule and update, so the
 * two cannot disagree about what "online with no link" means.
 */
async function readInput(orgId: string, input: MeetingInput) {
  const parsed = meetingInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the meeting details" } as const;
  }
  const d = parsed.data;

  const startAt = fromLocalInput(d.startAt);
  const endAt = fromLocalInput(d.endAt);
  if (!startAt || !endAt) return { error: "Pick a valid start and end" } as const;
  if (endAt <= startAt) return { error: "It has to end after it starts" } as const;
  if (endAt.getTime() - startAt.getTime() > 12 * 3_600_000) {
    return { error: "A meeting can run for 12 hours at most" } as const;
  }

  let meetingUrl: string | null = null;
  if (d.mode === "online" && d.link) {
    meetingUrl = normaliseMeetingUrl(d.link);
    if (!meetingUrl) return { error: "That link doesn't look like a web address" } as const;
  }

  // Online keeps a place of its own so it reads as online before the link
  // lands. In the office, a blank place is just "the office".
  const location = d.mode === "online" ? ONLINE_PLACE : d.place || "Office";

  // Only people actually in this workspace and active, only this
  // workspace's labels.
  const wanted = [...new Set(d.attendeeIds)];
  const labelIds = [...new Set(d.labelIds)];
  const [members, labels] = await Promise.all([
    wanted.length
      ? prisma.organizationMember.findMany({
          where: { organizationId: orgId, userId: { in: wanted }, status: "ACTIVE" },
          select: { userId: true },
        })
      : Promise.resolve([]),
    labelIds.length
      ? prisma.label.findMany({
          where: { organizationId: orgId, id: { in: labelIds } },
          select: { id: true },
        })
      : Promise.resolve([]),
  ]);

  return {
    data: {
      title: d.title,
      description: d.agenda || null,
      startAt,
      endAt,
      location,
      meetingUrl,
      attendeeIds: members.map((m) => m.userId),
      labelIds: labels.map((l) => l.id),
    },
  } as const;
}

/** Labels on a meeting's task, replaced as a set. */
async function setLabels(tx: Tx, orgId: string, taskId: string, labelIds: string[]) {
  await tx.taskLabel.deleteMany({ where: { taskId, labelId: { notIn: labelIds } } });
  if (labelIds.length > 0) {
    await tx.taskLabel.createMany({
      data: labelIds.map((labelId) => ({ organizationId: orgId, taskId, labelId })),
      skipDuplicates: true,
    });
  }
}

/**
 * The people on a meeting's task, kept to match who is coming: the organizer
 * owns it, everyone invited who has not declined is on it. That is what puts
 * the meeting on each of their boards and takes it off when they say no.
 */
async function syncPeople(
  tx: Tx,
  orgId: string,
  taskId: string,
  organizerId: string,
  coming: string[],
  assignedById: string
) {
  const keep = new Set([organizerId, ...coming]);
  await tx.taskAssignment.deleteMany({ where: { taskId, userId: { notIn: [...keep] } } });
  await tx.taskAssignment.createMany({
    data: [...keep].map((userId) => ({
      organizationId: orgId,
      taskId,
      userId,
      role: userId === organizerId ? ("OWNER" as const) : ("COLLABORATOR" as const),
      assignedById,
    })),
    skipDuplicates: true,
  });
}

/**
 * Put a meeting on the organizer's calendar, invite people to it, and give it
 * the task that puts it on everyone's board.
 *
 * With `fromTaskId`, this is "Turn into meeting": that task becomes the
 * meeting's task, keeping its status, labels, comments and history, rather
 * than being thrown away for a new one.
 */
export async function scheduleMeeting(
  input: MeetingInput,
  options: { fromTaskId?: string } = {}
): Promise<Result> {
  const ctx = await requirePermission("calendar.edit_own");
  const orgId = ctx.membership.organizationId;
  const userId = ctx.session.user.id;

  const read = await readInput(orgId, input);
  if ("error" in read) return { ok: false, error: read.error ?? "Check the meeting details" };
  const m = read.data;

  let fromTask: { id: string; title: string } | null = null;
  if (options.fromTaskId) {
    const task = await canMutateTask(options.fromTaskId, orgId, userId, ctx.permissions);
    if (!task) return { ok: false, error: "You can't change that task" };
    fromTask = { id: task.id, title: task.title };
  }

  const calendar = await getWritableCalendar(orgId, userId);
  const invitees = m.attendeeIds.filter((id) => id !== userId);

  const eventId = await prisma.$transaction(async (tx) => {
    // The meeting's task. No due date: a meeting is owed at a time, and that
    // time lives on the event, so the task never turns up "overdue".
    const taskId = fromTask
      ? (
          await tx.task.update({
            where: { id: fromTask.id },
            data: {
              title: m.title,
              description: m.description,
              startAt: m.startAt,
              dueAt: null,
            },
            select: { id: true },
          })
        ).id
      : (
          await tx.task.create({
            data: {
              organizationId: orgId,
              createdById: userId,
              title: m.title,
              description: m.description,
              status: "TODO",
              priority: "MEDIUM",
              priorityScore: computePriorityScore("MEDIUM", null),
              startAt: m.startAt,
              source: "CALENDAR",
            },
            select: { id: true },
          })
        ).id;

    await syncPeople(tx, orgId, taskId, userId, invitees, userId);
    await setLabels(tx, orgId, taskId, m.labelIds);

    const event = await tx.calendarEvent.create({
      data: {
        organizationId: orgId,
        calendarId: calendar.id,
        createdById: userId,
        title: m.title,
        description: m.description,
        location: m.location,
        meetingUrl: m.meetingUrl,
        startAt: m.startAt,
        endAt: m.endAt,
        timezone: APP_CONFIG.timezone,
        taskId,
      },
    });

    // The organizer row is what makes this a meeting. See lib/meetings.ts.
    await tx.eventAttendee.createMany({
      data: [
        {
          organizationId: orgId,
          eventId: event.id,
          userId,
          status: "ACCEPTED" as const,
          isOrganizer: true,
          respondedAt: new Date(),
        },
        ...invitees.map((id) => ({
          organizationId: orgId,
          eventId: event.id,
          userId: id,
          status: "NEEDS_ACTION" as const,
        })),
      ],
      skipDuplicates: true,
    });

    if (invitees.length > 0) {
      await tx.notification.createMany({
        data: invitees.map((id) => ({
          organizationId: orgId,
          userId: id,
          type: "EVENT_INVITE" as const,
          title: "Meeting invite",
          body: `${m.title} · ${when(m.startAt)}`,
          eventId: event.id,
          data: { actorId: userId },
        })),
      });
    }

    await tx.activityLog.create({
      data: {
        organizationId: orgId,
        userId,
        action: fromTask ? "task.converted_to_meeting" : "meeting.scheduled",
        entityType: "CalendarEvent",
        entityId: event.id,
        metadata: {
          title: m.title,
          invited: invitees.length,
          taskId,
          ...(fromTask ? { taskTitle: fromTask.title } : {}),
        },
      },
    });

    return event.id;
  });

  refresh();
  return { ok: true, id: eventId };
}

/**
 * Change a meeting. Anyone newly invited gets an invite; everyone already on
 * it hears about a new time or place, and nobody hears about a typo fix. The
 * meeting's task follows: name, agenda, start, people and labels.
 */
export async function updateMeeting(eventId: string, input: MeetingInput): Promise<Result> {
  const ctx = await requirePermission("calendar.edit_own");
  const orgId = ctx.membership.organizationId;
  const userId = ctx.session.user.id;

  const event = await canMutateEvent(eventId, orgId, userId, ctx.permissions);
  if (!event) return { ok: false, error: "Only the organizer can change this meeting" };

  const read = await readInput(orgId, input);
  if ("error" in read) return { ok: false, error: read.error ?? "Check the meeting details" };
  const m = read.data;

  const existing = await prisma.eventAttendee.findMany({
    where: { eventId, userId: { not: null } },
    select: { id: true, userId: true, isOrganizer: true, status: true },
  });
  const organizerId = existing.find((a) => a.isOrganizer)?.userId ?? event.createdById;

  const keep = new Set(m.attendeeIds.filter((id) => id !== organizerId));
  const had = new Set(existing.filter((a) => !a.isOrganizer).map((a) => a.userId!));
  const added = [...keep].filter((id) => !had.has(id));
  const removed = existing.filter((a) => !a.isOrganizer && !keep.has(a.userId!));
  const declined = new Set(existing.filter((a) => a.status === "DECLINED").map((a) => a.userId!));

  const moved =
    m.startAt.getTime() !== event.startAt.getTime() ||
    m.endAt.getTime() !== event.endAt.getTime() ||
    (m.location ?? "") !== (event.location ?? "") ||
    (m.meetingUrl ?? "") !== (event.meetingUrl ?? "");

  await prisma.$transaction(async (tx) => {
    // A meeting from before every meeting had a task, or a plain event being
    // given people: either way it gets its task now.
    let taskId = event.taskId;
    const linked = taskId
      ? await tx.task.findFirst({ where: { id: taskId, deletedAt: null }, select: { id: true } })
      : null;
    if (!linked) {
      taskId = (
        await tx.task.create({
          data: {
            organizationId: orgId,
            createdById: organizerId,
            title: m.title,
            status: "TODO",
            priority: "MEDIUM",
            priorityScore: computePriorityScore("MEDIUM", null),
            startAt: m.startAt,
            source: "CALENDAR",
          },
          select: { id: true },
        })
      ).id;
    }

    await tx.calendarEvent.update({
      where: { id: eventId },
      data: {
        title: m.title,
        description: m.description,
        location: m.location,
        meetingUrl: m.meetingUrl,
        startAt: m.startAt,
        endAt: m.endAt,
        taskId,
      },
    });

    await tx.task.update({
      where: { id: taskId! },
      data: { title: m.title, description: m.description, startAt: m.startAt, dueAt: null },
    });
    await syncPeople(
      tx,
      orgId,
      taskId!,
      organizerId,
      [...keep].filter((id) => !declined.has(id)),
      userId
    );
    await setLabels(tx, orgId, taskId!, m.labelIds);

    // A plain event being given people becomes a meeting: it needs its organizer.
    if (!existing.some((a) => a.isOrganizer)) {
      await tx.eventAttendee.upsert({
        where: { eventId_userId: { eventId, userId: organizerId } },
        create: {
          organizationId: orgId,
          eventId,
          userId: organizerId,
          status: "ACCEPTED",
          isOrganizer: true,
          respondedAt: new Date(),
        },
        update: { isOrganizer: true, status: "ACCEPTED" },
      });
    }

    if (removed.length > 0) {
      await tx.eventAttendee.deleteMany({ where: { id: { in: removed.map((a) => a.id) } } });
    }
    if (added.length > 0) {
      await tx.eventAttendee.createMany({
        data: added.map((id) => ({
          organizationId: orgId,
          eventId,
          userId: id,
          status: "NEEDS_ACTION" as const,
        })),
        skipDuplicates: true,
      });
    }

    const notices: Prisma.NotificationCreateManyInput[] = [
      ...added
        .filter((id) => id !== userId)
        .map((id) => ({
          organizationId: orgId,
          userId: id,
          type: "EVENT_INVITE" as const,
          title: "Meeting invite",
          body: `${m.title} · ${when(m.startAt)}`,
          eventId,
          data: { actorId: userId },
        })),
    ];
    if (moved) {
      const stayed = [...had].filter((id) => keep.has(id));
      if (organizerId !== userId) stayed.push(organizerId);
      for (const id of stayed) {
        if (id === userId) continue;
        notices.push({
          organizationId: orgId,
          userId: id,
          type: "EVENT_UPDATED",
          title: "Meeting changed",
          body: `${m.title} · now ${when(m.startAt)}`,
          eventId,
          data: { actorId: userId, change: "moved" },
        });
      }
    }
    if (notices.length > 0) await tx.notification.createMany({ data: notices });
  });

  refresh();
  return { ok: true, id: eventId };
}

/**
 * Going, maybe, or can't make it. Only for someone actually on the meeting.
 * Saying no takes it off your board; changing your mind puts it back.
 */
export async function respondToMeeting(eventId: string, status: string) {
  const ctx = await requireContext();
  const orgId = ctx.membership.organizationId;
  const userId = ctx.session.user.id;

  const parsed = rsvpSchema.safeParse(status);
  if (!parsed.success) return { ok: false as const, error: "Pick going, maybe or can't go" };

  const row = await prisma.eventAttendee.findFirst({
    where: { eventId, userId, organizationId: orgId, event: { deletedAt: null } },
    select: { id: true, isOrganizer: true, event: { select: { taskId: true, createdById: true } } },
  });
  if (!row) return { ok: false as const, error: "You're not on this meeting" };
  if (row.isOrganizer) return { ok: false as const, error: "You're running this one" };

  const taskId = row.event.taskId;
  await prisma.$transaction(async (tx) => {
    await tx.eventAttendee.update({
      where: { id: row.id },
      data: { status: parsed.data, respondedAt: new Date() },
    });

    if (taskId) {
      if (parsed.data === "DECLINED") {
        await tx.taskAssignment.deleteMany({ where: { taskId, userId } });
      } else {
        await tx.taskAssignment.createMany({
          data: [
            {
              organizationId: orgId,
              taskId,
              userId,
              role: "COLLABORATOR" as const,
              assignedById: row.event.createdById,
            },
          ],
          skipDuplicates: true,
        });
      }
    }
  });

  refresh();
  return { ok: true as const };
}

/**
 * Call a meeting off. Soft, like every delete here; everyone who was still
 * coming is told, and its card leaves the board as Cancelled.
 */
export async function cancelMeeting(eventId: string) {
  const ctx = await requirePermission("calendar.edit_own");
  const orgId = ctx.membership.organizationId;
  const userId = ctx.session.user.id;

  const event = await canMutateEvent(eventId, orgId, userId, ctx.permissions);
  if (!event) return { ok: false as const, error: "Only the organizer can cancel this meeting" };

  const people = await prisma.eventAttendee.findMany({
    where: { eventId, userId: { not: null }, status: { not: "DECLINED" } },
    select: { userId: true },
  });
  const task = event.taskId
    ? await prisma.task.findFirst({
        where: { id: event.taskId, deletedAt: null },
        select: { id: true, status: true },
      })
    : null;

  await prisma.$transaction(async (tx) => {
    await tx.calendarEvent.update({ where: { id: eventId }, data: { deletedAt: new Date() } });

    // A meeting that already happened and was marked done stays done; one
    // called off before then is cancelled, which takes it off the board.
    if (task && task.status !== "DONE" && task.status !== "CANCELLED") {
      await tx.task.update({
        where: { id: task.id },
        data: { status: "CANCELLED", completedAt: null },
      });
      await tx.taskStatusHistory.create({
        data: {
          organizationId: orgId,
          taskId: task.id,
          fromStatus: task.status,
          toStatus: "CANCELLED",
          changedById: userId,
          reason: "Meeting cancelled",
        },
      });
    }

    const told = people.map((p) => p.userId!).filter((id) => id !== userId);
    if (told.length > 0 && event.endAt > new Date()) {
      await tx.notification.createMany({
        data: told.map((id) => ({
          organizationId: orgId,
          userId: id,
          type: "EVENT_UPDATED" as const,
          title: "Meeting cancelled",
          body: `${event.title} · was ${when(event.startAt)}`,
          eventId,
          data: { actorId: userId, change: "cancelled" },
        })),
      });
    }
  });

  refresh();
  return { ok: true as const };
}
