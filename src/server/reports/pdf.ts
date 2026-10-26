import path from "node:path";
import PDFDocument from "pdfkit";
import { formatDayKey, formatIST } from "@/lib/dates";
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  activitySentence,
  dayHeading,
  dayHeadingLong,
  formatMinutes,
  newestWholeDays,
  periodLabel,
  type LogEntry,
  type WorkReport,
} from "@/lib/reports";
import { linkText } from "@/lib/task-links";

/**
 * Geist, the face the app itself is set in, embedded rather than relying on
 * the PDF base fonts: those only know Windows-1252, so a ₹ or a curly quote in
 * a task title would come out as garbage. Read from disk at request time;
 * next.config.ts traces the folder into the export route's bundle.
 */
const FONT_DIR = path.join(process.cwd(), "src/server/reports/fonts");
const REGULAR = path.join(FONT_DIR, "Geist-Regular.ttf");
const SEMIBOLD = path.join(FONT_DIR, "Geist-SemiBold.ttf");

const INK = "#1a1a1e";
const MUTED = "#6b6b76";
const FAINT = "#9a9aa3";
const LINE = "#e4e4ea";
const HEADER_FILL = "#f4f3f8";
const BAND_FILL = "#efebff";
const ACCENT = "#7c5cff";
const LINK = "#2b5fd9";

const STATUS_INK: Record<string, string> = {
  DONE: "#2f7a55",
  IN_PROGRESS: "#2b6c94",
  IN_REVIEW: "#7a52a8",
  BLOCKED: "#b83a35",
  CANCELLED: FAINT,
  TODO: MUTED,
  BACKLOG: MUTED,
};

const MARGIN = { top: 40, bottom: 46, left: 36, right: 36 };

/**
 * Daily log lines the PDF will draw: around a thousand pages, and well under
 * the 4.5 MB a Vercel function may send back. Past it the log keeps the newest
 * days and the header says where it starts; the spreadsheet has every line.
 */
const PDF_LOG_LINES = 5000;

/** Emoji have no glyph in Geist and would print as empty boxes. */
function clean(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    .replace(/ {2,}/g, " ")
    .replace(/\s+\n/g, "\n")
    .trim();
}

type Cell = {
  text: string;
  /** A second, quieter line under the first: a subtask's parent. */
  sub?: string;
  color?: string;
  bold?: boolean;
  /** One per line under the text, each a clickable link in the PDF. A line
      with no url is plain text: the "+3 more" note. */
  links?: { text: string; url?: string }[];
};

type Column = {
  header: string;
  width: number;
  align?: "left" | "right";
};

const BODY_SIZE = 8.5;
const SUB_SIZE = 7.5;
const PAD_X = 5;
const PAD_Y = 4;
/** Long cells are clipped with an ellipsis; the spreadsheet has them whole. */
const MAX_ROW = 96;
/** Links drawn in a cell before the rest are summed up. Seven lines fit MAX_ROW. */
const PDF_LINKS = 6;

class Writer {
  doc: PDFKit.PDFDocument;
  width: number;
  left: number;
  y: number;

  constructor(doc: PDFKit.PDFDocument) {
    this.doc = doc;
    this.left = MARGIN.left;
    this.width = doc.page.width - MARGIN.left - MARGIN.right;
    this.y = MARGIN.top;
  }

  get bottom() {
    return this.doc.page.height - MARGIN.bottom;
  }

  newPage() {
    this.doc.addPage();
    this.y = MARGIN.top;
  }

  /** Start a new page unless `height` still fits on this one. */
  ensure(height: number) {
    if (this.y + height > this.bottom) {
      this.newPage();
      return true;
    }
    return false;
  }

  text(
    value: string,
    options: {
      x?: number;
      width?: number;
      size?: number;
      bold?: boolean;
      color?: string;
      gap?: number;
    } = {}
  ) {
    const { doc } = this;
    const width = options.width ?? this.width;
    doc
      .font(options.bold ? "bold" : REGULAR)
      .fontSize(options.size ?? BODY_SIZE)
      .fillColor(options.color ?? INK);
    const h = doc.heightOfString(value, { width });
    this.ensure(h);
    doc.text(value, options.x ?? this.left, this.y, { width });
    this.y += h + (options.gap ?? 0);
  }

  heading(title: string, note?: string) {
    // Keep a heading with at least a header row and a line under it.
    this.ensure(64);
    this.y += 10;
    this.doc.font("bold").fontSize(12).fillColor(INK);
    this.doc.text(title, this.left, this.y, { lineBreak: false });
    if (note) {
      const w = this.doc.widthOfString(title);
      this.doc.font(REGULAR).fontSize(8.5).fillColor(MUTED);
      this.doc.text(note, this.left + w + 8, this.y + 3, { lineBreak: false });
    }
    this.y += 20;
  }

  private measure(cell: Cell, width: number) {
    const { doc } = this;
    const inner = width - PAD_X * 2;
    doc.font(cell.bold ? "bold" : REGULAR).fontSize(BODY_SIZE);
    let h = cell.text ? doc.heightOfString(cell.text, { width: inner }) : 0;
    if (cell.sub) {
      doc.font(REGULAR).fontSize(SUB_SIZE);
      h += 1 + doc.heightOfString(cell.sub, { width: inner });
    }
    if (cell.links?.length) {
      // Each link is held to one line and clipped, so a long URL costs no
      // more height than a short one.
      doc.font(REGULAR).fontSize(BODY_SIZE);
      h += (h ? 1 : 0) + cell.links.length * doc.heightOfString("A", { width: inner });
    }
    return Math.max(h, BODY_SIZE + 2);
  }

  tableHeader(columns: Column[]) {
    const { doc } = this;
    const h = 18;
    doc.rect(this.left, this.y, this.width, h).fill(HEADER_FILL);
    let x = this.left;
    doc.font("bold").fontSize(7.5).fillColor(MUTED);
    for (const col of columns) {
      const label = col.header.toUpperCase();
      // PDFKit ignores `align` once line breaking is off, so a right-aligned
      // header is placed by hand.
      const offset =
        col.align === "right"
          ? col.width - PAD_X - doc.widthOfString(label, { characterSpacing: 0.3 })
          : PAD_X;
      doc.text(label, x + offset, this.y + 5.5, {
        lineBreak: false,
        characterSpacing: 0.3,
      });
      x += col.width;
    }
    this.y += h;
  }

  /**
   * One row. Returns false without drawing when it would not fit, so the
   * caller can break the page, repeat its headers and try again.
   */
  row(columns: Column[], cells: Cell[], options: { shade?: boolean; rule?: boolean } = {}) {
    const { doc } = this;
    const content = Math.min(
      MAX_ROW,
      Math.max(...cells.map((c, i) => this.measure(c, columns[i].width)))
    );
    const h = content + PAD_Y * 2;
    if (this.y + h > this.bottom) return false;

    if (options.shade) doc.rect(this.left, this.y, this.width, h).fill("#fafafc");

    let x = this.left;
    cells.forEach((cell, i) => {
      const col = columns[i];
      const inner = col.width - PAD_X * 2;
      let cy = this.y + PAD_Y;

      if (cell.text) {
        doc
          .font(cell.bold ? "bold" : REGULAR)
          .fontSize(BODY_SIZE)
          .fillColor(cell.color ?? INK);
        const mainH = Math.min(content, doc.heightOfString(cell.text, { width: inner }));
        doc.text(cell.text, x + PAD_X, cy, {
          width: inner,
          height: mainH,
          ellipsis: true,
          align: col.align ?? "left",
        });
        cy += mainH + 1;
      }
      if (cell.sub && cy < this.y + PAD_Y + content) {
        doc.font(REGULAR).fontSize(SUB_SIZE).fillColor(FAINT);
        const subH = Math.min(
          this.y + PAD_Y + content - cy,
          doc.heightOfString(cell.sub, { width: inner })
        );
        doc.text(cell.sub, x + PAD_X, cy, {
          width: inner,
          height: subH,
          ellipsis: true,
        });
        cy += subH + 1;
      }
      if (cell.links?.length) {
        doc.font(REGULAR).fontSize(BODY_SIZE);
        const lineH = doc.heightOfString("A", { width: inner });
        for (const link of cell.links) {
          if (cy + lineH > this.y + PAD_Y + content + 0.5) break;
          doc.fillColor(link.url ? LINK : FAINT);
          doc.text(link.text, x + PAD_X, cy, {
            width: inner,
            height: lineH + 0.5,
            ellipsis: true,
            ...(link.url ? { link: link.url, underline: true } : {}),
          });
          cy += lineH;
        }
      }
      x += col.width;
    });

    if (options.rule !== false) {
      doc
        .moveTo(this.left, this.y + h)
        .lineTo(this.left + this.width, this.y + h)
        .lineWidth(0.5)
        .strokeColor(LINE)
        .stroke();
    }

    this.y += h;
    return true;
  }

  /** A full-width band that opens a group: a day, or a person. */
  band(title: string, note: string) {
    const { doc } = this;
    const h = 20;
    doc.rect(this.left, this.y, this.width, h).fill(BAND_FILL);
    doc.rect(this.left, this.y, 2.5, h).fill(ACCENT);
    doc.font("bold").fontSize(9).fillColor(INK);
    doc.text(title, this.left + 10, this.y + 5.5, { lineBreak: false });
    const w = doc.widthOfString(title);
    doc.font(REGULAR).fontSize(8).fillColor(MUTED);
    doc.text(note, this.left + 10 + w + 8, this.y + 6.5, { lineBreak: false });
    this.y += h;
  }

  /**
   * A table that survives page breaks: the header row comes back on every new
   * page, and so does the group band above it when there is one. A row whose
   * first cell is left blank because the row above already says it (the
   * person, in a day's block) gets that cell back when it opens a page.
   */
  table(
    columns: Column[],
    rows: { cells: Cell[]; lead?: Cell; rule?: boolean }[],
    repeat?: () => void
  ) {
    this.tableHeader(columns);
    rows.forEach((r, i) => {
      if (!this.row(columns, r.cells, { shade: i % 2 === 1, rule: r.rule })) {
        this.newPage();
        repeat?.();
        this.tableHeader(columns);
        const cells = r.lead ? [r.lead, ...r.cells.slice(1)] : r.cells;
        this.row(columns, cells, { shade: i % 2 === 1, rule: r.rule });
      }
    });
  }

  /** A new page only when what is left of this one is mostly gone. */
  section() {
    if (this.bottom - this.y < (this.bottom - MARGIN.top) * 0.4) this.newPage();
    else this.y += 14;
  }
}

/** Fractions of the content width, so the layout survives a page size change. */
function cols(width: number, spec: [string, number, ("left" | "right")?][]): Column[] {
  const total = spec.reduce((s, [, w]) => s + w, 0);
  return spec.map(([header, w, align]) => ({
    header,
    width: (w / total) * width,
    align,
  }));
}

function statusCell(status: string | null): Cell {
  if (!status) return { text: "" };
  return {
    text: STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? status,
    color: STATUS_INK[status] ?? INK,
  };
}

function titleCell(entry: { title: string; parentTitle: string | null }): Cell {
  return {
    text: clean(entry.title),
    sub: entry.parentTitle ? `in ${clean(entry.parentTitle)}` : undefined,
  };
}

/** The task's deliverables, each one clickable, the overflow counted. */
function linksCell(links: { url: string; label: string | null }[]): Cell {
  if (links.length === 0) return { text: "–", color: FAINT };
  const shown = links.slice(0, PDF_LINKS).map((link) => ({
    text: clean(linkText(link, 120)) || link.url,
    url: link.url,
  }));
  const more = links.length - shown.length;
  return {
    text: "",
    links: more > 0 ? [...shown, { text: `+${more} more in the Excel download` }] : shown,
  };
}

function whatCell(entry: LogEntry): Cell {
  if (entry.type === "meeting") {
    if (entry.minutes === null) return { text: "All day", color: MUTED };
    const length = entry.minutes ? ` · ${formatMinutes(entry.minutes)}` : "";
    return { text: `Meeting, ${entry.timeRange ?? ""}${length}` };
  }
  const ongoingOnly = entry.activities.every((a) => a.kind === "ongoing");
  return {
    text: activitySentence(entry),
    color: ongoingOnly ? MUTED : INK,
  };
}

/**
 * The report as a printable PDF: A4 landscape, a summary up front, then the
 * daily log grouped the way the screen groups it, then the task list. Page
 * numbers go on last, once the page count is known.
 */
export async function renderReportPdf(report: WorkReport): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: MARGIN,
    bufferPages: true,
    font: REGULAR,
    info: {
      Title: `Work report · ${report.workspaceName} · ${periodLabel(report.filters.from, report.filters.to)}`,
      Author: report.viewerName,
      Creator: "Nova",
    },
  });
  // Regular is selected by its path, never by a registered alias. The
  // constructor already opened it under the path; PDFKit then finds an alias
  // by the font's internal name and returns without caching the alias, so
  // every font(REGULAR) re-read and re-parsed the TTF from disk. That was most
  // of the render time: six seconds for a month, against under one.
  doc.registerFont("bold", SEMIBOLD);

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const w = new Writer(doc);
  const log = newestWholeDays(report.entries, PDF_LOG_LINES);
  const names = new Map(report.people.map((p) => [p.userId, p.name]));
  const nameOf = (id: string) => clean(names.get(id) ?? "Member");
  const period = periodLabel(report.filters.from, report.filters.to);

  // --- Title -----------------------------------------------------------------

  doc.font("bold").fontSize(20).fillColor(INK);
  doc.text("Work report", w.left, w.y, { lineBreak: false });
  w.y += 26;
  w.text(`${clean(report.workspaceName)} · ${period}`, { size: 10.5, color: INK, gap: 2 });
  w.text(
    `Generated ${formatIST(new Date(report.generatedAt))} by ${clean(report.viewerName)}`,
    { size: 8.5, color: MUTED, gap: 2 }
  );
  for (const line of report.filterLines) {
    w.text(clean(line), { size: 8.5, color: MUTED });
  }
  if (log.length < report.entries.length) {
    w.text(
      `The daily log has ${report.entries.length} lines, so this PDF shows the newest ${log.length}, from ${dayHeading(log[0].dayKey)}. The Excel download has all of them.`,
      { size: 8.5, color: STATUS_INK.BLOCKED }
    );
  }
  if (report.truncated) {
    w.text(
      "This range was too large to read in full, so some rows are missing. Pick a shorter range.",
      { size: 8.5, color: STATUS_INK.BLOCKED }
    );
  }
  w.y += 10;

  // --- Totals ----------------------------------------------------------------

  const tiles: [string, string][] = [
    ["Completed", String(report.totals.completed)],
    ["Started", String(report.totals.started)],
    ["Comments", String(report.totals.comments)],
    ["In meetings", formatMinutes(report.totals.meetingMinutes)],
    ["Active people", `${report.totals.activePeople} of ${report.people.length}`],
    ["Overdue now", String(report.totals.overdueNow)],
  ];
  const tileGap = 8;
  const tileW = (w.width - tileGap * (tiles.length - 1)) / tiles.length;
  w.ensure(48);
  tiles.forEach(([label, value], i) => {
    const x = w.left + i * (tileW + tileGap);
    doc.roundedRect(x, w.y, tileW, 42, 5).lineWidth(0.6).strokeColor(LINE).stroke();
    doc.font("bold").fontSize(15).fillColor(INK);
    doc.text(value, x + 9, w.y + 7, { width: tileW - 18, lineBreak: false });
    doc.font(REGULAR).fontSize(7.5).fillColor(MUTED);
    doc.text(label.toUpperCase(), x + 9, w.y + 27, {
      width: tileW - 18,
      lineBreak: false,
      characterSpacing: 0.3,
    });
  });
  w.y += 50;

  // --- People ----------------------------------------------------------------

  w.heading("People", "Completed, on time and started count tasks assigned to them");
  const peopleCols = cols(w.width, [
    ["Person", 3.2],
    ["Completed", 1.2, "right"],
    ["On time", 1.1, "right"],
    ["Started", 1, "right"],
    ["Added", 1, "right"],
    ["Comments", 1.1, "right"],
    ["Meetings", 1.5, "right"],
    ["Active days", 1.2, "right"],
    ["Open now", 1.1, "right"],
    ["Overdue now", 1.3, "right"],
  ]);

  if (report.summaries.length === 0) {
    w.text("Nobody to report on with these filters.", { color: MUTED });
  } else {
    w.table(
      peopleCols,
      report.summaries.map((s) => {
        const person = report.people.find((p) => p.userId === s.userId);
        return {
          cells: [
            { text: `${nameOf(s.userId)}${person?.left ? " (left)" : ""}`, bold: true },
            { text: String(s.completed) },
            { text: s.onTimeRate === null ? "–" : `${Math.round(s.onTimeRate * 100)}%` },
            { text: String(s.started) },
            { text: String(s.added) },
            { text: String(s.comments) },
            {
              text: s.meetings
                ? `${s.meetings} · ${formatMinutes(s.meetingMinutes)}`
                : "0",
            },
            { text: `${s.activeDays} of ${report.days.length}` },
            { text: String(s.openNow) },
            {
              text: String(s.overdueNow),
              color: s.overdueNow > 0 ? STATUS_INK.BLOCKED : INK,
            },
          ],
        };
      })
    );
  }

  // --- Daily log -------------------------------------------------------------

  w.section();
  const byDay = report.filters.group === "day";
  w.heading(
    "Daily log",
    byDay ? "Grouped by day, then person" : "Grouped by person, then day"
  );

  if (log.length === 0) {
    w.text("Nothing logged in this period.", { color: MUTED });
  } else {
    const logCols = cols(w.width, [
      [byDay ? "Person" : "Date", 2],
      ["Task or meeting", 4.4],
      ["What happened", 4.6],
      ["Status now", 1.3],
      ["Priority", 1],
      ["Labels", 1.8],
    ]);

    const groups = new Map<string, LogEntry[]>();
    for (const e of log) {
      const key = byDay ? e.dayKey : e.userId;
      const list = groups.get(key) ?? [];
      list.push(e);
      groups.set(key, list);
    }

    // Person order for the by-person layout; day order is already sorted.
    const keys = byDay
      ? [...groups.keys()]
      : report.people.map((p) => p.userId).filter((id) => groups.has(id));

    for (const key of keys) {
      const list = groups.get(key)!;
      if (!byDay) list.sort((a, b) => a.dayKey.localeCompare(b.dayKey));

      const title = byDay ? dayHeadingLong(key) : nameOf(key);
      const people = new Set(list.map((e) => e.userId)).size;
      const note = byDay
        ? `${list.length} ${list.length === 1 ? "line" : "lines"} · ${people} ${people === 1 ? "person" : "people"}`
        : `${list.length} ${list.length === 1 ? "line" : "lines"}`;

      // A band with no row under it is a stranded heading.
      w.ensure(20 + 18 + 26);
      w.y += 6;
      w.band(title, note);

      let previous = "";
      const rows = list.map((e) => {
        const leadKey = byDay ? e.userId : e.dayKey;
        const first = leadKey !== previous;
        previous = leadKey;
        const lead: Cell = {
          text: byDay ? nameOf(e.userId) : formatDayKey(e.dayKey),
          bold: true,
        };
        return {
          lead,
          cells: [
            first ? lead : { text: "" },
            titleCell(e),
            whatCell(e),
            statusCell(e.status),
            { text: e.priority ? PRIORITY_LABELS[e.priority] : "" },
            { text: clean(e.labels.map((l) => l.name).join(", ")) },
          ],
        };
      });

      w.table(logCols, rows, () => w.band(title, "continued"));
    }
  }

  // --- Tasks -----------------------------------------------------------------

  w.section();
  w.heading("Tasks", "Everything open at some point in the period, for these people");

  if (report.tasks.length === 0) {
    w.text("No tasks in this period.", { color: MUTED });
  } else {
    const taskCols = cols(w.width, [
      ["Task", 3.8],
      ["Assignees", 2],
      ["Status", 1.3],
      ["Priority", 1],
      ["Created", 1.3],
      ["Due", 1.3],
      ["Completed", 1.4],
      ["Labels", 1.5],
      ["Deliverables", 3],
    ]);
    const date = (iso: string | null) =>
      iso ? (formatIST(new Date(iso), { day: "2-digit" }) ?? "") : "";

    w.table(
      taskCols,
      report.tasks.map((t) => ({
        cells: [
          titleCell(t),
          { text: clean(t.assignees.join(", ")) || "Unassigned", color: t.assignees.length ? INK : MUTED },
          statusCell(t.status),
          { text: PRIORITY_LABELS[t.priority] },
          { text: date(t.createdAt) },
          {
            text: date(t.dueAt),
            color: t.overdue ? STATUS_INK.BLOCKED : INK,
          },
          { text: date(t.completedAt) },
          { text: clean(t.labels.map((l) => l.name).join(", ")) },
          linksCell(t.links),
        ],
      }))
    );
  }

  // --- Footer on every page ----------------------------------------------------

  const range = doc.bufferedPageRange();
  const footer = `Nova · ${clean(report.workspaceName)} · Work report ${period}`;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing inside the bottom margin makes PDFKit open a new page; lifting
    // the margin for the footer is the documented way round it.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 28;
    doc.font(REGULAR).fontSize(7.5).fillColor(FAINT);
    doc.text(footer, MARGIN.left, y, { lineBreak: false });
    const pageLabel = `Page ${i - range.start + 1} of ${range.count}`;
    doc.text(pageLabel, doc.page.width - MARGIN.right - doc.widthOfString(pageLabel), y, {
      lineBreak: false,
    });
    doc.page.margins.bottom = bottom;
  }

  doc.end();
  return done;
}
