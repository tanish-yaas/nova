/**
 * The board shows three columns for seven statuses.
 *
 * Every status has a home, so nothing can drop off the board: BACKLOG sits with
 * TODO, and the three middle states share In progress. BLOCKED is called out
 * with a flag on the card rather than taking a column — it is a state a task is
 * stuck in, not a stage it moves through. CANCELLED is deliberately off.
 *
 * `writes` is the status a drop into that column sets, and it is only applied
 * when the card changes column — so a folded card keeps its real status until
 * someone actually moves it somewhere else.
 *
 * Shared by the server page (which groups the rows) and the client board, so
 * the two cannot drift apart.
 */
export type BoardColumn = {
  key: string;
  label: string;
  color: string;
  /** Status written when a card is dropped here. */
  writes: string;
  /** Statuses that land in this column. */
  accepts: string[];
};

export const BOARD_COLUMNS: BoardColumn[] = [
  {
    key: "todo",
    label: "To do",
    color: "var(--status-purple)",
    writes: "TODO",
    accepts: ["BACKLOG", "TODO"],
  },
  {
    key: "doing",
    label: "In progress",
    color: "var(--status-blue)",
    writes: "IN_PROGRESS",
    accepts: ["IN_PROGRESS", "BLOCKED", "IN_REVIEW"],
  },
  {
    key: "completed",
    label: "Completed",
    color: "var(--status-green)",
    writes: "DONE",
    accepts: ["DONE"],
  },
];

const COLUMN_BY_STATUS = new Map(
  BOARD_COLUMNS.flatMap((c) => c.accepts.map((s) => [s, c.key] as const))
);

/** null for statuses the board deliberately hides, i.e. CANCELLED. */
export function columnForStatus(status: string): string | null {
  return COLUMN_BY_STATUS.get(status) ?? null;
}

/**
 * Cards are keyed to their label's colour, falling back to priority so a card
 * is never colourless. Same hue can therefore mean two things depending on
 * whether the task is tagged — the label chip below the title is what
 * disambiguates.
 */
export const PRIORITY_COLOR: Record<string, string> = {
  URGENT: "var(--status-red)",
  HIGH: "var(--status-amber)",
  MEDIUM: "var(--status-blue)",
  LOW: "#8b8b94",
};

export function accentFor(task: {
  labels: { color: string }[];
  priority: string;
}): string {
  return task.labels[0]?.color ?? PRIORITY_COLOR[task.priority] ?? "#8b8b94";
}

export type BoardSubtask = {
  id: string;
  title: string;
  done: boolean;
};

export type BoardTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  blocked: boolean;
  /** Drives the people filter. Empty for an unassigned task. */
  assigneeIds: string[];
  /** Pre-formatted in IST by the server — see TaskBoard. Null once done: a
      finished task has no deadline left to meet. */
  dueLabel: string | null;
  /** "Done today" and friends, in place of the due chip on a finished card. */
  doneLabel: string | null;
  overdue: boolean;
  labels: { id: string; name: string; color: string }[];
  assignees: string[];
  /** Children of this task, folded into the card rather than loose on the
      board. Empty for a task that has none, and for a subtask itself. */
  subtasks: BoardSubtask[];
  /** Set when this card is a meeting: drawn filled, with its time and place
      in place of a due date. Moving it moves the meeting's task. */
  meeting: BoardMeeting | null;
};

export type BoardMeeting = {
  /** "Today 14:00–14:45", "Thu 16/10 · 11:00–11:30". Formatted on the server, in IST. */
  when: string;
  mode: "office" | "online";
  place: string;
  /** Online and not over yet: the card gets a Join link. */
  joinUrl: string | null;
  people: number;
  ended: boolean;
  /** Happening right now. */
  live: boolean;
};
