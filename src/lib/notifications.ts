/**
 * What a notification looks like once it reaches a screen.
 *
 * Rows in the table are thin: a type, a title, a body. That was the whole
 * problem with how they used to render: "New task assigned" in bold and the
 * task itself in grey underneath, nobody saying who did it, and digests
 * printed as the WhatsApp message they also are, asterisks and all. The
 * server now hands over who, which task and which digest, and the screen
 * builds a sentence out of them.
 *
 * Plain data and string parsing only, safe on either side.
 */

import { addDaysToKey, istDayKey } from "@/lib/dates";

export type DigestKind = "morning" | "evening" | "weekly";

export type NotificationView = {
  id: string;
  type: string;
  createdAt: string;
  read: boolean;
  /** Whoever caused it, when anyone did. */
  actor: {
    id: string;
    name: string;
    avatarUrl: string | null;
    image: string | null;
  } | null;
  /** The task as it is now, so a renamed task reads with its current name. */
  task: { id: string; title: string; deleted: boolean } | null;
  /** The meeting a meeting notification is about, as it is now. */
  event: { id: string; title: string; startAt: string; deleted: boolean } | null;
  /** For a meeting that changed: was it moved or called off. */
  change: "moved" | "cancelled" | null;
  /** The quoted part: a comment's text. */
  quote: string | null;
  title: string;
  body: string | null;
  digest: DigestKind | null;
  /** A recurring task coming due, rather than someone assigning one. */
  recurring: boolean;
  /** Where a notification with no task goes, workspace-relative. */
  href: string | null;
};

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

export type DigestItem = {
  /** "11:00", "2 days late", "Anytime". */
  meta: string | null;
  text: string;
  /** "high" or "urgent", lifted off the end of the line. */
  tag: string | null;
};

export type DigestSection = {
  title: string;
  count: number | null;
  items: DigestItem[];
  /** "…and 4 more". */
  more: string | null;
};

export type ParsedDigest = {
  /** The opening line with the greeting taken off: "3 tasks due today." */
  lead: string | null;
  facts: { label: string; value: string }[];
  sections: DigestSection[];
  notes: string[];
};

export const DIGEST_LABELS: Record<DigestKind, string> = {
  morning: "Morning digest",
  evening: "Evening review",
  weekly: "Week in review",
};

/** Schedule type as stored on new rows, or worked out from an old one's text. */
export function digestKindOf(stored: unknown, body: string | null): DigestKind {
  if (stored === "MORNING_DIGEST") return "morning";
  if (stored === "EVENING_REVIEW") return "evening";
  if (stored === "WEEKLY_REVIEW") return "weekly";
  const first = body?.trimStart() ?? "";
  if (first.startsWith("Evening")) return "evening";
  if (first.startsWith("Week in review")) return "weekly";
  return "morning";
}

const GREETING = /^(Morning|Evening)\s+[^.]*\.\s*|^Week in review,\s*[^.]*\.\s*/;

/**
 * A digest body back into its parts. The body is written for WhatsApp, where
 * `*Section*` is bold and `•` is a list; here those become real headings and
 * rows instead of punctuation on the screen.
 */
export function parseDigest(body: string | null): ParsedDigest {
  const out: ParsedDigest = { lead: null, facts: [], sections: [], notes: [] };
  if (!body) return out;

  const lines = body.split("\n").map((l) => l.trim());
  const first = lines.shift() ?? "";
  const lead = first.replace(GREETING, "").trim();
  out.lead = lead || null;

  let section: DigestSection | null = null;

  for (const line of lines) {
    if (!line) continue;

    const heading = /^\*(.+?)(?:\s*\((\d+)\))?\*$/.exec(line);
    if (heading) {
      section = {
        title: heading[1].trim(),
        count: heading[2] ? Number(heading[2]) : null,
        items: [],
        more: null,
      };
      out.sections.push(section);
      continue;
    }

    if (line.startsWith("•")) {
      const raw = line.slice(1).trim();
      if (section && /^…?and \d+ more$/.test(raw)) {
        section.more = raw.replace(/^…/, "");
        continue;
      }
      const tagMatch = /\s*\((high|urgent)\)$/i.exec(raw);
      const withoutTag = tagMatch ? raw.slice(0, tagMatch.index) : raw;
      const split = withoutTag.indexOf(" · ");
      const item: DigestItem = {
        meta: split > -1 ? withoutTag.slice(0, split) : null,
        text: split > -1 ? withoutTag.slice(split + 3) : withoutTag,
        tag: tagMatch ? tagMatch[1].toLowerCase() : null,
      };
      if (section) section.items.push(item);
      else out.notes.push(item.text);
      continue;
    }

    const fact = /^([^:]{2,40}):\s*(.+)$/.exec(line);
    if (fact && !section) {
      out.facts.push({ label: fact[1], value: fact[2] });
      continue;
    }

    out.notes.push(line);
  }

  return out;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** One line that says what is in a digest without opening it. */
export function digestSummary(kind: DigestKind, digest: ParsedDigest): string {
  const parts: string[] = [];
  const count = (s: DigestSection) => s.count ?? s.items.length;

  for (const f of digest.facts) {
    const label = f.label.toLowerCase();
    const value = f.value.split(",")[0].trim();
    if (label === "closed today") parts.push(`${value} closed`);
    else if (label.startsWith("still open")) parts.push(`${value} still open`);
    else if (label === "completed") parts.push(`${value} done`);
    else if (label === "completion rate") parts.push(`${value} completion`);
    else if (label.startsWith("productivity")) parts.push(`score ${value}`);
  }

  for (const s of digest.sections) {
    const title = s.title.toLowerCase();
    if (title.startsWith("due today")) parts.push(`${count(s)} due today`);
    else if (title.startsWith("overdue")) parts.push(`${count(s)} overdue`);
    else if (title.startsWith("calendar")) parts.push(plural(count(s), "event"));
    else if (title.startsWith("tomorrow")) parts.push(`${count(s)} due tomorrow`);
    else parts.push(`${count(s)} ${title}`);
  }

  for (const note of digest.notes) {
    if (kind === "evening" && /nothing due tomorrow/i.test(note)) parts.push("nothing due tomorrow");
    const carrying = /Carrying (\d+) overdue/i.exec(note);
    if (carrying) parts.push(`${carrying[1]} overdue`);
  }

  if (parts.length > 0) {
    const line = parts.join(" · ");
    return line.charAt(0).toUpperCase() + line.slice(1);
  }
  return digest.lead ?? digest.notes[0] ?? "";
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export type NotificationGroup = { label: string; items: NotificationView[] };

/** Today, Yesterday, This week, Earlier: IST days, newest first. */
export function groupByDay(
  items: NotificationView[],
  todayKey: string
): NotificationGroup[] {
  const yesterday = addDaysToKey(todayKey, -1);
  const weekAgo = addDaysToKey(todayKey, -6);

  const label = (iso: string) => {
    const key = istDayKey(new Date(iso));
    if (key === todayKey) return "Today";
    if (key === yesterday) return "Yesterday";
    if (key >= weekAgo) return "This week";
    return "Earlier";
  };

  const groups: NotificationGroup[] = [];
  for (const item of items) {
    const l = label(item.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === l) last.items.push(item);
    else groups.push({ label: l, items: [item] });
  }
  return groups;
}

/** "Kabir Mehta asked to join YAAS Studio." → "Kabir Mehta". */
export function joinRequester(body: string | null): string | null {
  const match = body ? /^(.+?) asked to join /.exec(body) : null;
  return match ? match[1] : null;
}
