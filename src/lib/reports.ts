/**
 * The work report: what it can be filtered by, and the shape it comes back in.
 *
 * Shared by the page, the client filter bar and the export route, so a view on
 * screen and the file downloaded from it are the same query. Everything here
 * is plain data and day-key maths, safe to import from either side.
 */

import {
  addDaysToKey,
  addMonthsToKey,
  daysBetweenKeys,
  formatDayKey,
  isDayKey,
  istMonthStartKey,
  istWeekStartKey,
} from "@/lib/dates";
import { TASK_PRIORITIES, TASK_STATUSES } from "@/lib/validators/task";

export type TaskStatusKey = (typeof TASK_STATUSES)[number];
export type TaskPriorityKey = (typeof TASK_PRIORITIES)[number];

// ---------------------------------------------------------------------------
// Activity kinds
// ---------------------------------------------------------------------------

/**
 * What a line in the daily log can record.
 *
 * Everything but `ongoing` is something that happened at a moment: a status
 * change, a comment, a task added, a meeting. `ongoing` is the exception, and
 * the reason it exists: work that sat In progress on Tuesday with nobody
 * touching the card still happened on Tuesday. Without it a three-day task
 * reads as one day of work and two days of nothing.
 */
export const ACTIVITY_KINDS = [
  "completed",
  "progress",
  "ongoing",
  "comment",
  "added",
  "meeting",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  completed: "Completed",
  progress: "Status changes",
  ongoing: "Ongoing",
  comment: "Comments",
  added: "Added",
  meeting: "Meetings",
};

export const ACTIVITY_HINTS: Record<ActivityKind, string> = {
  completed: "Tasks marked done",
  progress: "Started, sent for review, blocked, reopened",
  ongoing:
    "Days a task sat in progress, in review or blocked with nothing new on it, for up to a week after anything last happened",
  comment: "Comments written on tasks",
  added: "Tasks someone created",
  meeting: "Calendar events they were in, all-day ones included",
};

export const STATUS_LABELS: Record<TaskStatusKey, string> = {
  BACKLOG: "Backlog",
  TODO: "To do",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  IN_REVIEW: "In review",
  DONE: "Done",
  CANCELLED: "Cancelled",
};

export const PRIORITY_LABELS: Record<TaskPriorityKey, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

export const SOURCE_LABELS: Record<string, string> = {
  MANUAL: "Nova",
  WHATSAPP: "WhatsApp",
  SLACK: "Slack",
  AI_PARSED: "AI",
  RECURRING: "Recurring",
  CALENDAR: "Calendar",
  EMAIL: "Email",
  IMPORT: "Import",
  API: "API",
};

// ---------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------

export const RANGE_PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this-week", label: "This week" },
  { key: "last-week", label: "Last week" },
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "last-30", label: "Last 30 days" },
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number]["key"];

const DEFAULT_PRESET: RangePreset = "this-week";

/** A year and a day, so "this time last year" to today still fits. */
export const MAX_RANGE_DAYS = 366;

function isPreset(value: unknown): value is RangePreset {
  return RANGE_PRESETS.some((p) => p.key === value);
}

/** The days a preset covers, ending no later than today. */
export function presetRange(
  preset: RangePreset,
  todayKey: string
): { from: string; to: string } {
  switch (preset) {
    case "today":
      return { from: todayKey, to: todayKey };
    case "yesterday": {
      const y = addDaysToKey(todayKey, -1);
      return { from: y, to: y };
    }
    case "this-week":
      return { from: istWeekStartKey(todayKey), to: todayKey };
    case "last-week": {
      const monday = addDaysToKey(istWeekStartKey(todayKey), -7);
      return { from: monday, to: addDaysToKey(monday, 6) };
    }
    case "this-month":
      return { from: istMonthStartKey(todayKey), to: todayKey };
    case "last-month": {
      const first = addMonthsToKey(todayKey, -1);
      return { from: first, to: addDaysToKey(istMonthStartKey(todayKey), -1) };
    }
    case "last-30":
      return { from: addDaysToKey(todayKey, -29), to: todayKey };
  }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export const REPORT_TABS = ["log", "people", "tasks"] as const;
export type ReportTab = (typeof REPORT_TABS)[number];

export const REPORT_GROUPS = ["day", "person"] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

export type ReportFilters = {
  /** Set when the range came from a preset, so a saved link stays relative:
      "this week" opened next Tuesday means next week, not this one. */
  preset: RangePreset | null;
  from: string;
  to: string;
  /** Empty means everyone the viewer may report on. */
  people: string[];
  teamId: string | null;
  labelId: string | null;
  priorities: TaskPriorityKey[];
  statuses: TaskStatusKey[];
  /** Never empty: an empty selection reads as "all", the same as no filter. */
  kinds: ActivityKind[];
  q: string;
  group: ReportGroup;
  tab: ReportTab;
};

type ParamSource =
  | URLSearchParams
  | Record<string, string | string[] | undefined>;

function read(source: ParamSource, key: string): string {
  if (source instanceof URLSearchParams) return source.get(key) ?? "";
  const value = source[key];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function list(source: ParamSource, key: string): string[] {
  return read(source, key)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** cuids and the like. Anything else is not an id this app made. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Filters from a query string, every value checked and clamped.
 *
 * The range never runs past today: this is a record of work done, and a
 * "this month" that included the next three weeks would pad the log with
 * meetings that have not happened. Ids are only shape-checked here: whether
 * the viewer may see that person is the service's call, not the parser's.
 */
export function parseReportFilters(
  source: ParamSource,
  todayKey: string
): ReportFilters {
  const rangeParam = read(source, "range");
  const fromParam = read(source, "from");
  const toParam = read(source, "to");

  let preset: RangePreset | null = null;
  let from: string;
  let to: string;

  if (isPreset(rangeParam)) {
    preset = rangeParam;
    ({ from, to } = presetRange(rangeParam, todayKey));
  } else if (isDayKey(fromParam) && isDayKey(toParam)) {
    from = fromParam;
    to = toParam;
  } else {
    preset = DEFAULT_PRESET;
    ({ from, to } = presetRange(DEFAULT_PRESET, todayKey));
  }

  if (from > to) [from, to] = [to, from];
  if (to > todayKey) to = todayKey;
  if (from > to) from = to;
  if (daysBetweenKeys(from, to) >= MAX_RANGE_DAYS) {
    from = addDaysToKey(to, -(MAX_RANGE_DAYS - 1));
  }

  const kinds = list(source, "kinds").filter((k): k is ActivityKind =>
    (ACTIVITY_KINDS as readonly string[]).includes(k)
  );

  const team = read(source, "team");
  const label = read(source, "label");
  const group = read(source, "group");
  const tab = read(source, "tab");

  return {
    preset,
    from,
    to,
    people: [...new Set(list(source, "people").filter((id) => ID.test(id)))],
    teamId: ID.test(team) ? team : null,
    labelId: ID.test(label) ? label : null,
    priorities: list(source, "priority").filter((p): p is TaskPriorityKey =>
      (TASK_PRIORITIES as readonly string[]).includes(p)
    ),
    statuses: list(source, "status").filter((s): s is TaskStatusKey =>
      (TASK_STATUSES as readonly string[]).includes(s)
    ),
    kinds: kinds.length > 0 ? [...new Set(kinds)] : [...ACTIVITY_KINDS],
    q: read(source, "q").trim().slice(0, 100),
    group: (REPORT_GROUPS as readonly string[]).includes(group)
      ? (group as ReportGroup)
      : "day",
    tab: (REPORT_TABS as readonly string[]).includes(tab)
      ? (tab as ReportTab)
      : "log",
  };
}

/** The query string for a set of filters, leaving out whatever is default. */
export function reportSearch(filters: ReportFilters): string {
  const params = new URLSearchParams();

  if (filters.preset) {
    if (filters.preset !== DEFAULT_PRESET) params.set("range", filters.preset);
  } else {
    params.set("from", filters.from);
    params.set("to", filters.to);
  }

  if (filters.people.length > 0) params.set("people", filters.people.join(","));
  if (filters.teamId) params.set("team", filters.teamId);
  if (filters.labelId) params.set("label", filters.labelId);
  if (filters.priorities.length > 0) {
    params.set("priority", filters.priorities.join(","));
  }
  if (filters.statuses.length > 0) params.set("status", filters.statuses.join(","));
  if (filters.kinds.length < ACTIVITY_KINDS.length) {
    params.set("kinds", filters.kinds.join(","));
  }
  if (filters.q) params.set("q", filters.q);
  if (filters.group !== "day") params.set("group", filters.group);
  if (filters.tab !== "log") params.set("tab", filters.tab);

  return params.toString();
}

/** Whether anything past the date range narrows the report. */
export function hasNarrowingFilters(filters: ReportFilters): boolean {
  return (
    filters.people.length > 0 ||
    !!filters.teamId ||
    !!filters.labelId ||
    filters.priorities.length > 0 ||
    filters.statuses.length > 0 ||
    filters.kinds.length < ACTIVITY_KINDS.length ||
    !!filters.q
  );
}

/**
 * Label, priority and status belong to tasks. A meeting has none of them, so
 * while any of those filters is on there is no meeting that could match.
 */
export function tasksOnly(filters: ReportFilters): boolean {
  return (
    !!filters.labelId ||
    filters.priorities.length > 0 ||
    filters.statuses.length > 0
  );
}

export function periodLabel(from: string, to: string): string {
  return from === to
    ? formatDayKey(from)
    : `${formatDayKey(from)} to ${formatDayKey(to)}`;
}

/** "3h 20m", "45m", "2h". */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export type ReportPerson = {
  userId: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  image: string | null;
  /** Deactivated: their past work still reports, marked as such. */
  left: boolean;
};

export type ReportTeam = { id: string; name: string; memberIds: string[] };
export type ReportLabel = { id: string; name: string; color: string };

export type LogActivity = {
  kind: ActivityKind;
  /** "Started", "Completed by Rahul", "Commented (2)". */
  label: string;
  /** ISO instant. Null for an ongoing day, which has no moment. */
  at: string | null;
  /** "17:40" in IST, preformatted so the browser cannot drift. */
  time: string | null;
};

/**
 * One line of the daily log: one person, one day, one task or meeting, with
 * everything they did to it that day folded together.
 */
export type LogEntry = {
  id: string;
  dayKey: string;
  userId: string;
  type: "task" | "meeting";
  /** Task id for a task line, so the screen can open the task. */
  taskId: string | null;
  title: string;
  /** The parent's title, for a subtask. */
  parentTitle: string | null;
  activities: LogActivity[];
  /** The task's status as it stands now. Null for a meeting. */
  status: TaskStatusKey | null;
  priority: TaskPriorityKey | null;
  labels: ReportLabel[];
  team: string | null;
  dueKey: string | null;
  /** "10:00–11:00" or "All day". Meetings only. */
  timeRange: string | null;
  minutes: number | null;
};

export type PersonSummary = {
  userId: string;
  completed: number;
  /** Of the completed tasks with a due date, how many landed on or before
      that day. Null when none had a due date. */
  onTimeRate: number | null;
  started: number;
  comments: number;
  added: number;
  meetings: number;
  meetingMinutes: number;
  /** Days with anything done, not counting ongoing carry-overs. */
  activeDays: number;
  /** As of now, not as of the end of the range. */
  openNow: number;
  overdueNow: number;
  /** Sum of estimates on the completed tasks. Null when none had one. */
  estimatedMinutesDone: number | null;
  /** Lines per day, keyed by day key, ongoing excluded. */
  perDay: Record<string, number>;
  completedPerDay: Record<string, number>;
};

export type ReportTask = {
  id: string;
  title: string;
  description: string;
  parentTitle: string | null;
  status: TaskStatusKey;
  priority: TaskPriorityKey;
  assignees: string[];
  createdBy: string;
  team: string | null;
  labels: ReportLabel[];
  source: string;
  createdAt: string;
  startAt: string | null;
  dueAt: string | null;
  completedAt: string | null;
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  subtasks: number;
  commentsInPeriod: number;
  overdue: boolean;
  /** Deliverable links, oldest first. Clickable in both exports. */
  links: { url: string; label: string | null }[];
};

/** One raw event, for the spreadsheet's Activity sheet. */
export type ReportEvent = {
  at: string;
  /** Who did it, by name. Null when nobody recorded it. */
  person: string | null;
  action: string;
  taskId: string;
  taskTitle: string;
  from: string | null;
  to: string | null;
  detail: string | null;
};

export type WorkReport = {
  generatedAt: string;
  workspaceName: string;
  viewerName: string;
  filters: ReportFilters;
  /** Every day in the range, oldest first. */
  days: string[];
  /** The people the report covers, after every people filter. */
  people: ReportPerson[];
  summaries: PersonSummary[];
  entries: LogEntry[];
  tasks: ReportTask[];
  events: ReportEvent[];
  totals: {
    completed: number;
    started: number;
    comments: number;
    meetingMinutes: number;
    activePeople: number;
    overdueNow: number;
  };
  /** Human-readable filter lines for the export header. */
  filterLines: string[];
  /** A cap was hit and some rows were left out. */
  truncated: boolean;
};

/** "Thu 02/10/2026" from a day key, without a Date round trip in the view. */
export function dayHeading(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${formatDayKey(key)}`;
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAYS_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function weekdayOf(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "Tuesday 02/10/2026", for section headings in the PDF. */
export function dayHeadingLong(key: string): string {
  return `${WEEKDAYS_LONG[weekdayOf(key)]} ${formatDayKey(key)}`;
}

/** The activities on a line as one sentence, for the exports. */
export function activitySentence(entry: LogEntry): string {
  if (entry.type === "meeting") {
    return entry.timeRange ?? "Meeting";
  }
  return entry.activities
    .map((a) => (a.time ? `${a.label} (${a.time})` : a.label))
    .join(", ");
}

/**
 * The newest whole days of a log that fit under `cap` lines.
 *
 * For a range too long to draw: the recent end is what people open a report
 * for, and cutting at a day boundary means no day is shown half-empty. A
 * single day over the cap is cut to its newest lines rather than dropped.
 */
export function newestWholeDays(entries: LogEntry[], cap: number): LogEntry[] {
  if (entries.length <= cap) return entries;

  let start = entries.length;
  while (start > 0) {
    const day = entries[start - 1].dayKey;
    let dayStart = start;
    while (dayStart > 0 && entries[dayStart - 1].dayKey === day) dayStart--;
    if (entries.length - dayStart > cap) break;
    start = dayStart;
  }

  return start === entries.length ? entries.slice(-cap) : entries.slice(start);
}
