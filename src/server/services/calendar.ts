import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";

/**
 * Events this person may read in full. A private or confidential event is
 * readable by whoever owns its calendar and whoever is on it; to everyone
 * else it is a block of busy time, never a title.
 */
export function readableEventFor(userId: string): Prisma.CalendarEventWhereInput {
  return {
    OR: [
      { visibility: { in: ["DEFAULT", "PUBLIC"] } },
      { calendar: { ownerId: userId } },
      { attendees: { some: { userId } } },
    ],
  };
}

/** Events that are on this person's day: their own calendar, or ones they are invited to and have not turned down. */
export function eventsInvolving(userIds: string[]): Prisma.CalendarEventWhereInput {
  return {
    OR: [
      { calendar: { ownerId: { in: userIds } } },
      { attendees: { some: { userId: { in: userIds }, status: { not: "DECLINED" } } } },
    ],
  };
}

/**
 * Every calendar in the workspace, for every active member.
 *
 * Calendars were private by default: a member saw their own, whatever was
 * shared with them, and their team's if their role allowed it. The workspace
 * runs on knowing who is busy when, so everyone can now see everyone's.
 * What stays protected is narrower and handled where events are read:
 * an event marked private shows to others as "Busy", nothing more. Editing
 * is unchanged and still follows calendar.edit_* and shares.
 *
 * `permissions` stays in the signature so callers did not have to change;
 * every caller has already passed requireContext, so membership is settled.
 */
export async function getVisibleCalendarIds(
  orgId: string,
  _userId: string,
  _permissions: Set<string>
): Promise<string[]> {
  const all = await prisma.calendar.findMany({
    where: { organizationId: orgId, deletedAt: null },
    select: { id: true },
  });
  return all.map((c) => c.id);
}

export type VisibleCalendar = {
  id: string;
  name: string;
  color: string;
  type: string;
  ownerId: string;
  ownerName: string;
  isOwn: boolean;
  isDefault: boolean;
  canEdit: boolean;
};

const PALETTE = [
  "#7C5CFF",
  "#22D3EE",
  "#FF4D8F",
  "#F5B544",
  "#4ADE80",
  "#A78BFA",
  "#FB7185",
];

/**
 * Every calendar the user can see, with display metadata and whether they may
 * write to it. Visibility still comes from getVisibleCalendarIds — this only
 * decorates that answer.
 */
export async function getCalendarsForUser(
  orgId: string,
  userId: string,
  permissions: Set<string>
): Promise<VisibleCalendar[]> {
  const ids = await getVisibleCalendarIds(orgId, userId, permissions);
  if (ids.length === 0) return [];

  const [calendars, shares] = await Promise.all([
    prisma.calendar.findMany({
      where: { organizationId: orgId, id: { in: ids }, deletedAt: null },
      include: { owner: { select: { name: true, email: true } } },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    }),
    prisma.calendarShare.findMany({
      where: { organizationId: orgId, userId, calendarId: { in: ids } },
      select: { calendarId: true, accessLevel: true },
    }),
  ]);

  const shareLevel = new Map(shares.map((s) => [s.calendarId, s.accessLevel]));

  return calendars.map((c, i) => {
    const level = shareLevel.get(c.id);
    const isOwn = c.ownerId === userId;

    return {
      id: c.id,
      name: c.name,
      color: c.color ?? PALETTE[i % PALETTE.length],
      type: c.type,
      ownerId: c.ownerId,
      ownerName: c.owner.name ?? c.owner.email ?? "Someone",
      isOwn,
      isDefault: c.isDefault,
      canEdit:
        permissions.has("calendar.edit_any") ||
        (isOwn && permissions.has("calendar.edit_own")) ||
        level === "EDIT" ||
        level === "FULL_ACCESS",
    };
  });
}

export async function getWritableCalendar(orgId: string, userId: string) {
  const existing = await prisma.calendar.findFirst({
    where: {
      organizationId: orgId,
      ownerId: userId,
      type: "PERSONAL",
      deletedAt: null,
    },
    orderBy: { isDefault: "desc" },
  });

  if (existing) return existing;

  return prisma.calendar.create({
    data: {
      organizationId: orgId,
      ownerId: userId,
      name: "My Calendar",
      type: "PERSONAL",
      isDefault: true,
      color: "#7C5CFF",
    },
  });
}

export async function canMutateEvent(
  eventId: string,
  orgId: string,
  userId: string,
  permissions: Set<string>
) {
  const event = await prisma.calendarEvent.findFirst({
    where: { id: eventId, organizationId: orgId, deletedAt: null },
    include: { calendar: { select: { ownerId: true } } },
  });

  if (!event) return null;
  if (permissions.has("calendar.edit_any")) return event;
  if (event.calendar.ownerId === userId || event.createdById === userId) {
    return permissions.has("calendar.edit_own") ? event : null;
  }

  const share = await prisma.calendarShare.findFirst({
    where: {
      calendarId: event.calendarId,
      userId,
      accessLevel: { in: ["EDIT", "FULL_ACCESS"] },
    },
  });

  return share ? event : null;
}