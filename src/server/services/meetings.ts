import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";
import { eventsInvolving } from "@/server/services/calendar";
import { meetingMode, type AttendeeStatus } from "@/lib/meetings";
import { personColor } from "@/lib/people-colors";
import type { CalendarPerson, EventItem } from "@/components/calendar/types";

/** Everything an event needs read alongside it to be drawn. */
export const EVENT_INCLUDE = {
  task: { select: { id: true, title: true } },
  calendar: {
    select: {
      id: true,
      name: true,
      color: true,
      ownerId: true,
      owner: { select: { name: true, email: true, profile: { select: { displayName: true } } } },
    },
  },
  attendees: {
    orderBy: [{ isOrganizer: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      userId: true,
      name: true,
      email: true,
      status: true,
      isOrganizer: true,
      user: {
        select: {
          name: true,
          email: true,
          image: true,
          profile: { select: { displayName: true, avatarUrl: true } },
        },
      },
    },
  },
} satisfies Prisma.CalendarEventInclude;

export type EventRow = Prisma.CalendarEventGetPayload<{ include: typeof EVENT_INCLUDE }>;

type NamedUser = {
  name: string | null;
  email: string | null;
  profile?: { displayName: string | null } | null;
};

export function displayName(user: NamedUser | null | undefined, fallback = "Someone") {
  return user?.profile?.displayName ?? user?.name ?? user?.email ?? fallback;
}

/**
 * Everyone active in the workspace, in roster order (who joined first), each
 * with the colour they are drawn in. The order is what fixes the colour.
 */
export async function getWorkspacePeople(orgId: string): Promise<CalendarPerson[]> {
  const members = await prisma.organizationMember.findMany({
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
  });

  return members.map((m, i) => ({
    userId: m.userId,
    name: displayName(m.user, "Member"),
    avatarUrl: m.user.profile?.avatarUrl ?? null,
    image: m.user.image,
    color: personColor(i),
  }));
}

/**
 * One stored event as the screen sees it.
 *
 * `inView` is whose calendars are on screen; an event takes the colour of
 * whoever it belongs to among them (the calendar's owner first, then the
 * first person in it). `canEditCalendar` says whether the viewer may write to
 * the calendar it lives on.
 */
export function toEventItem(
  e: EventRow,
  viewer: { userId: string; canEditOwn: boolean },
  people: Map<string, CalendarPerson>,
  inView: string[],
  canEditCalendar: boolean
): EventItem {
  const isMeeting = e.attendees.some((a) => a.isOrganizer);
  const involved =
    e.calendar.ownerId === viewer.userId || e.attendees.some((a) => a.userId === viewer.userId);
  const busy = (e.visibility === "PRIVATE" || e.visibility === "CONFIDENTIAL") && !involved;

  const colourOwner =
    (inView.includes(e.calendar.ownerId) ? e.calendar.ownerId : null) ??
    e.attendees.find((a) => a.userId && inView.includes(a.userId) && a.status !== "DECLINED")?.userId ??
    e.calendar.ownerId;
  const color = people.get(colourOwner)?.color ?? e.calendar.color ?? "#7C5CFF";

  const ownerName = people.get(e.calendar.ownerId)?.name ?? displayName(e.calendar.owner);
  const organizer = e.attendees.find((a) => a.isOrganizer);
  const mine = e.attendees.find((a) => a.userId === viewer.userId && !a.isOrganizer);

  return {
    id: e.id,
    title: busy ? "Busy" : e.title,
    description: busy ? "" : (e.description ?? ""),
    location: busy ? "" : (e.location ?? ""),
    meetingUrl: busy ? "" : (e.meetingUrl ?? ""),
    startAt: e.startAt.toISOString(),
    endAt: e.endAt.toISOString(),
    allDay: e.allDay,
    calendarId: e.calendarId,
    calendarName: e.calendar.name,
    color,
    ownerName,
    isOwnCalendar: e.calendar.ownerId === viewer.userId,
    taskId: busy ? null : (e.task?.id ?? null),
    taskTitle: busy ? null : (e.task?.title ?? null),
    attendees: busy
      ? []
      : e.attendees.map((a) => {
          const person = a.userId ? people.get(a.userId) : undefined;
          return {
            id: a.id,
            userId: a.userId,
            name: person?.name ?? displayName(a.user, a.name ?? a.email ?? "Guest"),
            avatarUrl: person?.avatarUrl ?? a.user?.profile?.avatarUrl ?? null,
            image: person?.image ?? a.user?.image ?? null,
            status: a.status as AttendeeStatus,
            isOrganizer: a.isOrganizer,
          };
        }),
    canEdit: !busy && (canEditCalendar || (e.createdById === viewer.userId && viewer.canEditOwn)),
    isMeeting: isMeeting && !busy,
    mode: isMeeting && !busy ? meetingMode(e.location, e.meetingUrl) : null,
    organizerName: organizer
      ? (organizer.userId ? people.get(organizer.userId)?.name : null) ??
        displayName(organizer.user, organizer.name ?? "Someone")
      : null,
    myStatus: mine ? (mine.status as AttendeeStatus) : null,
    busy,
  };
}

/**
 * The meetings on one person's days in a window, for the Tasks tab: ones they
 * organise or were invited to and have not turned down.
 */
export async function getMeetingsFor(
  orgId: string,
  userId: string,
  from: Date,
  to: Date,
  canEditOwn: boolean
): Promise<EventItem[]> {
  const [rows, people] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        startAt: { lt: to },
        endAt: { gt: from },
        attendees: { some: { isOrganizer: true } },
        ...eventsInvolving([userId]),
      },
      orderBy: { startAt: "asc" },
      take: 60,
      include: EVENT_INCLUDE,
    }),
    getWorkspacePeople(orgId),
  ]);

  const byId = new Map(people.map((p) => [p.userId, p]));
  return rows.map((e) =>
    toEventItem(e, { userId, canEditOwn }, byId, [userId], e.calendar.ownerId === userId && canEditOwn)
  );
}
