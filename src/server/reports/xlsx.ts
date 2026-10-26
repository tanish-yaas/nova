import ExcelJS from "exceljs";
import { formatIST, istFields } from "@/lib/dates";
import {
  PRIORITY_LABELS,
  SOURCE_LABELS,
  STATUS_LABELS,
  WEEKDAYS,
  activitySentence,
  formatMinutes,
  periodLabel,
  weekdayOf,
  type WorkReport,
} from "@/lib/reports";

const INK = "FF1A1A1E";
const MUTED = "FF6B6B76";
const HEADER_FILL = "FFEFEBFF";
const LINE = "FFE4E4EA";
const LINK = "FF2B5FD9";

/**
 * A spreadsheet has no timezones: a cell holds a wall-clock time. So an
 * instant is written as its IST wall clock dressed up as UTC, which is what
 * makes 17:40 in Nova read 17:40 in Excel rather than 12:10.
 */
function wallClock(iso: string | null, withTime = true): Date | null {
  if (!iso) return null;
  const f = istFields(new Date(iso));
  return new Date(
    Date.UTC(f.year, f.month - 1, f.day, withTime ? f.hour : 0, withTime ? f.minute : 0)
  );
}

function dayCell(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const DATE_FMT = "dd/mm/yyyy";
const DATETIME_FMT = "dd/mm/yyyy hh:mm";

type Column = {
  header: string;
  key: string;
  width: number;
  numFmt?: string;
  wrap?: boolean;
};

/** A sheet with a styled, frozen, filterable header row. */
function sheetWithTable(
  workbook: ExcelJS.Workbook,
  name: string,
  columns: Column[],
  rows: Record<string, unknown>[]
) {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width,
    style: {
      ...(c.numFmt ? { numFmt: c.numFmt } : {}),
      alignment: { vertical: "top", wrapText: !!c.wrap },
    },
  }));

  for (const row of rows) sheet.addRow(row);

  const header = sheet.getRow(1);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: INK } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: "middle" };
    cell.border = { bottom: { style: "thin", color: { argb: LINE } } };
  });

  if (rows.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columns.length },
    };
  }

  return sheet;
}

/**
 * The report as a workbook: a summary to read, then the same data laid flat
 * on sheets you can sort and filter. Dates are real date cells, not text, so
 * "sort by date" and "filter to last Tuesday" work the way a sheet should.
 */
export async function renderReportXlsx(report: WorkReport): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Nova";
  workbook.created = new Date();

  const names = new Map(report.people.map((p) => [p.userId, p.name]));
  const period = periodLabel(report.filters.from, report.filters.to);

  // --- Summary --------------------------------------------------------------

  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { width: 28 },
    { width: 14 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 14 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 16 },
  ];

  summary.addRow(["Work report"]).font = { bold: true, size: 16, color: { argb: INK } };
  summary.addRow([report.workspaceName]).font = { color: { argb: MUTED } };
  summary.addRow([]);
  summary.addRow(["Period", period]);
  summary.addRow([
    "Generated",
    `${formatIST(new Date(report.generatedAt))} by ${report.viewerName}`,
  ]);
  for (const line of report.filterLines) {
    const [label, ...rest] = line.split(": ");
    summary.addRow([label, rest.join(": ")]);
  }
  summary.addRow([]);

  const totalsRow = summary.addRow([
    "Completed",
    report.totals.completed,
    "",
    "Started",
    report.totals.started,
    "",
    "Comments",
    report.totals.comments,
    "",
    "Meetings",
    formatMinutes(report.totals.meetingMinutes),
  ]);
  totalsRow.font = { bold: true };
  summary.addRow([]);

  const headerRow = summary.addRow([
    "Person",
    "Completed",
    "On time",
    "Started",
    "Added",
    "Comments",
    "Meetings",
    "Meeting hours",
    "Active days",
    "Open now",
    "Overdue now",
    "Est. hours done",
  ]);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: INK } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  });

  for (const s of report.summaries) {
    const person = report.people.find((p) => p.userId === s.userId);
    const row = summary.addRow([
      `${person?.name ?? "Member"}${person?.left ? " (left)" : ""}`,
      s.completed,
      s.onTimeRate,
      s.started,
      s.added,
      s.comments,
      s.meetings,
      Math.round((s.meetingMinutes / 60) * 10) / 10,
      s.activeDays,
      s.openNow,
      s.overdueNow,
      s.estimatedMinutesDone === null
        ? null
        : Math.round((s.estimatedMinutesDone / 60) * 10) / 10,
    ]);
    row.getCell(3).numFmt = "0%";
  }

  if (report.truncated) {
    summary.addRow([]);
    summary.addRow([
      "This range was too large to read in full, so some rows are missing. Pick a shorter range.",
    ]).font = { italic: true, color: { argb: MUTED } };
  }

  // --- Days: who did something on which day ---------------------------------

  const days = workbook.addWorksheet("By day", {
    views: [{ state: "frozen", xSplit: 1, ySplit: 1 }],
  });
  days.columns = [
    { header: "Person", key: "person", width: 28 },
    ...report.days.map((d) => ({
      header: `${WEEKDAYS[weekdayOf(d)]} ${d.slice(8, 10)}/${d.slice(5, 7)}`,
      key: d,
      width: 10,
    })),
    { header: "Total", key: "total", width: 10 },
  ];
  for (const s of report.summaries) {
    const values: Record<string, unknown> = { person: names.get(s.userId) ?? "Member" };
    let total = 0;
    for (const d of report.days) {
      const n = s.perDay[d] ?? 0;
      values[d] = n || null;
      total += n;
    }
    values.total = total;
    const row = days.addRow(values);
    // Shade busy days, so the sheet reads as a calendar at a glance.
    report.days.forEach((d, i) => {
      const n = s.perDay[d] ?? 0;
      if (n === 0) return;
      const cell = row.getCell(i + 2);
      const strength = n >= 8 ? "FFC9BCFF" : n >= 4 ? "FFDCD3FF" : "FFEFEBFF";
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: strength } };
      cell.alignment = { horizontal: "center" };
    });
  }
  days.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: INK } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.alignment = { horizontal: "center" };
  });
  days.getRow(1).getCell(1).alignment = { horizontal: "left" };

  // --- Daily log ------------------------------------------------------------

  sheetWithTable(
    workbook,
    "Daily log",
    [
      { header: "Date", key: "date", width: 12, numFmt: DATE_FMT },
      { header: "Day", key: "day", width: 6 },
      { header: "Person", key: "person", width: 22 },
      { header: "Type", key: "type", width: 9 },
      { header: "Task or meeting", key: "title", width: 44, wrap: true },
      { header: "Part of", key: "parent", width: 24, wrap: true },
      { header: "What happened", key: "what", width: 44, wrap: true },
      { header: "Status now", key: "status", width: 12 },
      { header: "Priority", key: "priority", width: 10 },
      { header: "Labels", key: "labels", width: 20, wrap: true },
      { header: "Team", key: "team", width: 14 },
      { header: "Due", key: "due", width: 12, numFmt: DATE_FMT },
      { header: "Time", key: "time", width: 13 },
      { header: "Minutes", key: "minutes", width: 9 },
    ],
    report.entries.map((e) => ({
      date: dayCell(e.dayKey),
      day: WEEKDAYS[weekdayOf(e.dayKey)],
      person: names.get(e.userId) ?? "Member",
      type: e.type === "meeting" ? "Meeting" : "Task",
      title: e.title,
      parent: e.parentTitle ?? "",
      what:
        e.type === "meeting"
          ? e.minutes === null
            ? "All-day event"
            : "Meeting"
          : activitySentence(e),
      status: e.status ? STATUS_LABELS[e.status] : "",
      priority: e.priority ? PRIORITY_LABELS[e.priority] : "",
      labels: e.labels.map((l) => l.name).join(", "),
      team: e.team ?? "",
      due: e.dueKey ? dayCell(e.dueKey) : null,
      time: e.timeRange ?? "",
      minutes: e.minutes,
    }))
  );

  // --- Tasks ----------------------------------------------------------------

  // A cell holds one hyperlink, so each deliverable gets a column of its own:
  // as many as the task with the most has, and one even when none do, so the
  // column is there to be found.
  const linkColumns = Math.max(1, ...report.tasks.map((t) => t.links.length));
  const linkKey = (i: number) => `link${i}`;

  const tasks = sheetWithTable(
    workbook,
    "Tasks",
    [
      { header: "Task", key: "title", width: 44, wrap: true },
      { header: "Part of", key: "parent", width: 24, wrap: true },
      { header: "Status", key: "status", width: 12 },
      { header: "Priority", key: "priority", width: 10 },
      { header: "Assignees", key: "assignees", width: 26, wrap: true },
      { header: "Created by", key: "createdBy", width: 20 },
      { header: "Team", key: "team", width: 14 },
      { header: "Labels", key: "labels", width: 20, wrap: true },
      { header: "Source", key: "source", width: 11 },
      { header: "Created", key: "created", width: 17, numFmt: DATETIME_FMT },
      { header: "Start", key: "start", width: 17, numFmt: DATETIME_FMT },
      { header: "Due", key: "due", width: 17, numFmt: DATETIME_FMT },
      { header: "Completed", key: "completed", width: 17, numFmt: DATETIME_FMT },
      { header: "Overdue", key: "overdue", width: 9 },
      { header: "Estimate (min)", key: "estimate", width: 13 },
      { header: "Actual (min)", key: "actual", width: 12 },
      { header: "Subtasks", key: "subtasks", width: 9 },
      { header: "Comments in period", key: "comments", width: 12 },
      ...Array.from({ length: linkColumns }, (_, i) => ({
        header: linkColumns === 1 ? "Deliverable" : `Deliverable ${i + 1}`,
        key: linkKey(i),
        width: 36,
      })),
      { header: "Description", key: "description", width: 60, wrap: true },
    ],
    report.tasks.map((t) => ({
      title: t.title,
      parent: t.parentTitle ?? "",
      status: STATUS_LABELS[t.status],
      priority: PRIORITY_LABELS[t.priority],
      assignees: t.assignees.join(", "),
      createdBy: t.createdBy,
      team: t.team ?? "",
      labels: t.labels.map((l) => l.name).join(", "),
      source: SOURCE_LABELS[t.source] ?? t.source,
      created: wallClock(t.createdAt),
      start: wallClock(t.startAt),
      due: wallClock(t.dueAt),
      completed: wallClock(t.completedAt),
      overdue: t.overdue ? "Yes" : "",
      estimate: t.estimatedMinutes,
      actual: t.actualMinutes,
      subtasks: t.subtasks || null,
      comments: t.commentsInPeriod || null,
      ...Object.fromEntries(
        t.links.map((link, i) => [
          linkKey(i),
          { text: link.label || link.url, hyperlink: link.url, tooltip: link.url },
        ])
      ),
      // Excel caps a cell at 32,767 characters.
      description: t.description.slice(0, 32000),
    }))
  );

  // Blue and underlined, so a link reads as one before anyone hovers it.
  for (let i = 0; i < linkColumns; i++) {
    tasks.getColumn(linkKey(i)).eachCell((cell, row) => {
      if (row === 1 || !cell.hyperlink) return;
      cell.font = { color: { argb: LINK }, underline: true };
    });
  }

  // --- Activity -------------------------------------------------------------

  sheetWithTable(
    workbook,
    "Activity",
    [
      { header: "When", key: "when", width: 17, numFmt: DATETIME_FMT },
      { header: "Person", key: "person", width: 22 },
      { header: "Action", key: "action", width: 18 },
      { header: "Task", key: "task", width: 44, wrap: true },
      { header: "From", key: "from", width: 12 },
      { header: "To", key: "to", width: 12 },
      { header: "Detail", key: "detail", width: 60, wrap: true },
    ],
    report.events.map((e) => ({
      when: wallClock(e.at),
      person: e.person ?? "",
      action: e.action,
      task: e.taskTitle,
      from: e.from ?? "",
      to: e.to ?? "",
      detail: (e.detail ?? "").slice(0, 32000),
    }))
  );

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}
