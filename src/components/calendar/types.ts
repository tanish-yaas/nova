import type { TaskRowData } from "@/components/tasks/task-row";
import type { AttendeeStatus, MeetingMode } from "@/lib/meetings";

export const CALENDAR_VIEWS = ["month", "week", "day", "agenda"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export type EventItem = {
  id: string;
  title: string;
  description: string;
  location: string;
  meetingUrl: string;
  /** ISO instants — every view re-reads them in IST. */
  startAt: string;
  endAt: string;
  allDay: boolean;
  calendarId: string;
  calendarName: string;
  color: string;
  ownerName: string;
  isOwnCalendar: boolean;
  taskId: string | null;
  taskTitle: string | null;
  attendees: EventPerson[];
  canEdit: boolean;
  /** Has an organizer row: drawn filled, opened as a meeting. */
  isMeeting: boolean;
  /** Meetings only. */
  mode: MeetingMode | null;
  organizerName: string | null;
  /** The viewer's own answer, when they are invited and not organizing. */
  myStatus: AttendeeStatus | null;
  /** Someone else's private event: a block of busy time, no details. */
  busy: boolean;
  /** A meeting's labels, carried by its task. */
  labels: { id: string; name: string; color: string }[];
  /** Where the meeting's card sits on the board: TODO, IN_PROGRESS, DONE... */
  taskStatus: string | null;
};

export type EventPerson = {
  id: string;
  userId: string | null;
  name: string;
  avatarUrl: string | null;
  image: string | null;
  status: AttendeeStatus;
  isOrganizer: boolean;
};

/** Someone whose calendar is on screen, and the colour they are drawn in. */
export type CalendarPerson = {
  userId: string;
  name: string;
  avatarUrl: string | null;
  image: string | null;
  color: string;
};

/** A task on the calendar, carried alongside the row data TaskRow already speaks. */
export type TaskItem = {
  id: string;
  /** ISO. The deadline, or null for a task with none. */
  dueAt: string | null;
  /** ISO. Where the bar ends: the deadline; with no deadline, the day it was
      finished, or today while it is still open. */
  endAt: string;
  /** No deadline and still open: worked on every day until it is done. */
  ongoing: boolean;
  /** Inside the viewer's own task scope, so it can be opened and edited.
      Other people's tasks outside it draw read-only. */
  canOpen: boolean;
  /** ISO, when the task has one. An explicit start wins over createdAt. */
  startAt: string | null;
  /** ISO. When the task appeared — where its bar starts if nothing else says. */
  createdAt: string;
  /** The IST day the bar ends on. */
  dayKey: string;
  row: TaskRowData;
};

export type CalendarShareRow = {
  id: string;
  userId: string;
  name: string;
  accessLevel: string;
};

export type CalendarOption = {
  id: string;
  name: string;
  color: string;
  ownerName: string;
  isOwn: boolean;
  canEdit: boolean;
  canShare: boolean;
  shares: CalendarShareRow[];
};

/** A slot the user clicked in a grid, ready to seed a new event. */
export type DraftSlot = {
  dayKey: string;
  startMinutes: number;
  endMinutes: number;
};
