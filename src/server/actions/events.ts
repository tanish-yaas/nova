"use server";

import { prisma } from "@/lib/prisma";
import { requirePermission, revalidateWorkspace } from "@/server/rbac/guard";
import {
  eventInputSchema,
  eventPatchSchema,
  type EventInput,
  type EventPatch,
} from "@/lib/validators/event";
import { getWritableCalendar, canMutateEvent } from "@/server/services/calendar";
import { fromLocalInput } from "@/lib/dates";
import { APP_CONFIG } from "@/config/app";

export async function createCalendarEvent(input: EventInput) {
  const ctx = await requirePermission("calendar.edit_own");
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  const parsed = eventInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false as const,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const title = parsed.data.title;
  const startAt = fromLocalInput(parsed.data.startAt);
  const endAt = fromLocalInput(parsed.data.endAt);

  if (!startAt || !endAt) {
    return { ok: false as const, error: "Pick a valid start and end time" };
  }
  if (endAt <= startAt) {
    return { ok: false as const, error: "End time must be after the start time" };
  }

  let calendarId: string | null = null;
  if (input.calendarId) {
    const target = await prisma.calendar.findFirst({
      where: { id: input.calendarId, organizationId: orgId, deletedAt: null },
      select: { id: true, ownerId: true },
    });

    if (target) {
      const writable =
        ctx.permissions.has("calendar.edit_any") ||
        target.ownerId === userId ||
        (await prisma.calendarShare.findFirst({
          where: {
            calendarId: target.id,
            userId,
            accessLevel: { in: ["EDIT", "FULL_ACCESS"] },
          },
          select: { id: true },
        })) !== null;

      if (!writable) return { ok: false as const, error: "Not allowed" };
      calendarId = target.id;
    }
  }

  if (!calendarId) {
    const fallback = await getWritableCalendar(orgId, userId);
    calendarId = fallback.id;
  }

  let taskId: string | null = null;
  if (input.taskId) {
    const task = await prisma.task.findFirst({
      where: { id: input.taskId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    taskId = task?.id ?? null;
  }

  const event = await prisma.calendarEvent.create({
    data: {
      organizationId: orgId,
      calendarId,
      createdById: userId,
      title,
      description: input.description?.trim() || null,
      location: input.location?.trim() || null,
      startAt,
      endAt,
      allDay: input.allDay ?? false,
      timezone: APP_CONFIG.timezone,
      taskId,
    },
  });

  await prisma.activityLog.create({
    data: {
      organizationId: orgId,
      userId,
      action: "event.created",
      entityType: "CalendarEvent",
      entityId: event.id,
      metadata: { title: event.title },
    },
  });

  revalidateWorkspace("/calendar");
  return { ok: true as const, id: event.id };
}

/** Inline edits from the event popover. Every field is optional. */
export async function updateCalendarEvent(eventId: string, input: EventPatch) {
  const ctx = await requirePermission("calendar.edit_own");
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  const parsed = eventPatchSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false as const,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const patch = parsed.data;

  const event = await canMutateEvent(eventId, orgId, userId, ctx.permissions);
  if (!event) return { ok: false as const, error: "Not allowed" };

  const data: {
    title?: string;
    description?: string | null;
    location?: string | null;
    meetingUrl?: string | null;
    startAt?: Date;
    endAt?: Date;
    allDay?: boolean;
    taskId?: string | null;
  } = {};

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) return { ok: false as const, error: "Title can't be empty" };
    data.title = title;
  }

  if (patch.description !== undefined) {
    data.description = patch.description.trim() || null;
  }
  if (patch.location !== undefined) {
    data.location = patch.location.trim() || null;
  }
  if (patch.meetingUrl !== undefined) {
    data.meetingUrl = patch.meetingUrl.trim() || null;
  }
  if (patch.allDay !== undefined) data.allDay = patch.allDay;

  if (patch.startAt !== undefined) {
    const startAt = fromLocalInput(patch.startAt);
    if (!startAt) return { ok: false as const, error: "Invalid start time" };
    data.startAt = startAt;
  }

  if (patch.endAt !== undefined) {
    const endAt = fromLocalInput(patch.endAt);
    if (!endAt) return { ok: false as const, error: "Invalid end time" };
    data.endAt = endAt;
  }

  const nextStart = data.startAt ?? event.startAt;
  const nextEnd = data.endAt ?? event.endAt;
  if (nextEnd <= nextStart) {
    return { ok: false as const, error: "End time must be after the start time" };
  }

  if (patch.taskId !== undefined) {
    if (!patch.taskId) {
      data.taskId = null;
    } else {
      const task = await prisma.task.findFirst({
        where: { id: patch.taskId, organizationId: orgId, deletedAt: null },
        select: { id: true },
      });
      data.taskId = task?.id ?? null;
    }
  }

  await prisma.calendarEvent.update({ where: { id: eventId }, data });

  revalidateWorkspace("/calendar");
  return { ok: true as const };
}

/** Drag the bottom edge of an event: the start stays put, the end moves. */
export async function resizeEvent(eventId: string, newEndLocal: string) {
  const ctx = await requirePermission("calendar.edit_own");
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  const event = await canMutateEvent(eventId, orgId, userId, ctx.permissions);
  if (!event) return { error: "Not allowed" };

  const newEnd = fromLocalInput(newEndLocal);
  if (!newEnd) return { error: "Invalid time" };
  if (newEnd <= event.startAt) {
    return { error: "An event has to last at least a few minutes" };
  }

  await prisma.calendarEvent.update({
    where: { id: eventId },
    data: { endAt: newEnd },
  });

  revalidateWorkspace("/calendar");
  return { ok: true };
}

export async function deleteEvent(eventId: string) {
  const ctx = await requirePermission("calendar.edit_own");
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  const event = await canMutateEvent(eventId, orgId, userId, ctx.permissions);
  if (!event) return { error: "Not allowed" };

  await prisma.calendarEvent.update({
    where: { id: eventId },
    data: { deletedAt: new Date() },
  });

  revalidateWorkspace("/calendar");
  return { ok: true };
}

export async function moveEvent(eventId: string, newStartLocal: string) {
  const ctx = await requirePermission("calendar.edit_own");
  const orgId = ctx.membership!.organizationId;
  const userId = ctx.session.user.id;

  const event = await canMutateEvent(eventId, orgId, userId, ctx.permissions);
  if (!event) return { error: "Not allowed" };

  const newStart = fromLocalInput(newStartLocal);
  if (!newStart) return { error: "Invalid time" };

  const durationMs = event.endAt.getTime() - event.startAt.getTime();

  await prisma.calendarEvent.update({
    where: { id: eventId },
    data: {
      startAt: newStart,
      endAt: new Date(newStart.getTime() + durationMs),
    },
  });

  // A meeting's task starts when the meeting does, so dragging the meeting
  // to another slot moves its card's date on the board as well.
  if (event.taskId) {
    const isMeeting = await prisma.eventAttendee.count({
      where: { eventId, isOrganizer: true },
    });
    if (isMeeting > 0) {
      await prisma.task.updateMany({
        where: { id: event.taskId, organizationId: orgId, deletedAt: null },
        data: { startAt: newStart },
      });
    }
  }

  revalidateWorkspace("/calendar", "/tasks", "/");
  return { ok: true };
}