"use server";

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { requirePermission, requireContext, revalidateWorkspace } from "@/server/rbac/guard";
import { meetingInputSchema, rsvpSchema, type MeetingInput } from "@/lib/validators/meeting";
import { canMutateEvent, getWritableCalendar } from "@/server/services/calendar";
import { canMutateTask } from "@/server/services/tasks";
import { formatIST, fromLocalInput } from "@/lib/dates";
import { ONLINE_PLACE, normaliseMeetingUrl } from "@/lib/meetings";
import { APP_CONFIG } from "@/config/app";

type Result = { ok: true; id: string } | { ok: false; error: string };

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
  const location =
    d.mode === "online" ? ONLINE_PLACE : d.place || "Office";

  // Only people actually in this workspace, and only active ones.
  const wanted = [...new Set(d.attendeeIds)];
  const members = wanted.length
    ? await prisma.organizationMember.findMany({
        where: { organizationId: orgId, userId: { in: wanted }, status: "ACTIVE" },
        select: { userId: true },
      })
    : [];

  return {
    data: {
      title: d.title,
      description: d.agenda || null,
      startAt,
      endAt,
      location,
      meetingUrl,
      attendeeIds: members.map((m) => m.userId),
    },
  } as const;
}

/**
 * Put a meeting on the organizer's calendar and invite people to it.
 *
 * With `fromTaskId`, this is "Turn into meeting": the task it came from is
 * soft-deleted in the same transaction, so the work is never in two places
 * and never in none.
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

    if (fromTask) {
      await tx.task.update({
        where: { id: fromTask.id },
        data: { deletedAt: new Date() },
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
          ...(fromTask ? { taskId: fromTask.id, taskTitle: fromTask.title } : {}),
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
 * it hears about a new time or place, and nobody hears about a typo fix.
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
    select: { id: true, userId: true, isOrganizer: true },
  });
  const organizerId = existing.find((a) => a.isOrganizer)?.userId ?? event.createdById;

  const keep = new Set(m.attendeeIds.filter((id) => id !== organizerId));
  const had = new Set(existing.filter((a) => !a.isOrganizer).map((a) => a.userId!));
  const added = [...keep].filter((id) => !had.has(id));
  const removed = existing.filter((a) => !a.isOrganizer && !keep.has(a.userId!));

  const moved =
    m.startAt.getTime() !== event.startAt.getTime() ||
    m.endAt.getTime() !== event.endAt.getTime() ||
    (m.location ?? "") !== (event.location ?? "") ||
    (m.meetingUrl ?? "") !== (event.meetingUrl ?? "");

  await prisma.$transaction(async (tx) => {
    await tx.calendarEvent.update({
      where: { id: eventId },
      data: {
        title: m.title,
        description: m.description,
        location: m.location,
        meetingUrl: m.meetingUrl,
        startAt: m.startAt,
        endAt: m.endAt,
      },
    });

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

/** Going, maybe, or can't make it. Only for someone actually on the meeting. */
export async function respondToMeeting(eventId: string, status: string) {
  const ctx = await requireContext();
  const orgId = ctx.membership.organizationId;
  const userId = ctx.session.user.id;

  const parsed = rsvpSchema.safeParse(status);
  if (!parsed.success) return { ok: false as const, error: "Pick going, maybe or can't go" };

  const row = await prisma.eventAttendee.findFirst({
    where: { eventId, userId, organizationId: orgId, event: { deletedAt: null } },
    select: { id: true, isOrganizer: true, event: { select: { title: true, createdById: true } } },
  });
  if (!row) return { ok: false as const, error: "You're not on this meeting" };
  if (row.isOrganizer) return { ok: false as const, error: "You're running this one" };

  await prisma.eventAttendee.update({
    where: { id: row.id },
    data: { status: parsed.data, respondedAt: new Date() },
  });

  refresh();
  return { ok: true as const };
}

/**
 * Call a meeting off. Soft, like every delete here, and everyone who was
 * still coming is told.
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

  await prisma.$transaction(async (tx) => {
    await tx.calendarEvent.update({ where: { id: eventId }, data: { deletedAt: new Date() } });
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
