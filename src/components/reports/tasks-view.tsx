"use client";

import { useState } from "react";
import { ListChecks } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { formatIST } from "@/lib/dates";
import type { ReportTask } from "@/lib/reports";
import { linkText } from "@/lib/task-links";
import { LabelChips, PriorityTag, StatusTag } from "./report-bits";

const FIRST_PAINT = 300;

/** dd/mm/yyyy in IST. formatIST pins the zone, so server and browser agree. */
const day = (iso: string | null) => (iso ? formatIST(new Date(iso), { day: "2-digit" }) : null);

export function TasksView({
  tasks,
  onOpenTask,
}: {
  tasks: ReportTask[];
  onOpenTask: (taskId: string) => void;
}) {
  const [limit, setLimit] = useState(FIRST_PAINT);

  if (tasks.length === 0) {
    return (
      <div className="panel">
        <EmptyState
          icon={ListChecks}
          title="No tasks in this period"
          description="Nothing assigned to these people was open at any point in this range."
        />
      </div>
    );
  }

  return (
    <section className="panel overflow-x-auto">
      <p className="border-b border-[color-mix(in_oklab,white_7%,transparent)] px-4 py-2.5 text-[12px] text-faint">
        Every task that was open at some point in the period, blocked and in progress first. The
        Excel download has every field, descriptions included. Deliverable links open in a new tab,
        here and in both downloads.
      </p>
      <table className="w-full min-w-[1020px] text-[13px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-faint">
            <th className="px-4 py-2.5 font-medium">Task</th>
            <th className="px-3 py-2.5 font-medium">Assignees</th>
            <th className="px-3 py-2.5 font-medium">Status</th>
            <th className="px-3 py-2.5 font-medium">Priority</th>
            <th className="px-3 py-2.5 font-medium">Start</th>
            <th className="px-3 py-2.5 font-medium">Due</th>
            <th className="px-3 py-2.5 font-medium">Completed</th>
            <th className="px-3 py-2.5 font-medium">Labels</th>
            <th className="px-3 py-2.5 font-medium">Deliverables</th>
          </tr>
        </thead>
        <tbody>
          {tasks.slice(0, limit).map((t) => (
            <tr
              key={t.id}
              className="border-t border-[color-mix(in_oklab,white_6%,transparent)] align-top hover:bg-[color-mix(in_oklab,white_3%,transparent)]"
            >
              <td className="max-w-[22rem] px-4 py-2">
                <button
                  type="button"
                  onClick={() => onOpenTask(t.id)}
                  className="text-left leading-snug decoration-[color-mix(in_oklab,white_30%,transparent)] underline-offset-2 hover:underline"
                >
                  {t.title}
                </button>
                {t.parentTitle && (
                  <span className="block text-[11px] text-faint">in {t.parentTitle}</span>
                )}
              </td>
              <td className="px-3 py-2 text-[12px] text-muted-foreground">
                {t.assignees.length ? t.assignees.join(", ") : <span className="text-faint">Unassigned</span>}
              </td>
              <td className="px-3 py-2">
                <StatusTag status={t.status} />
              </td>
              <td className="px-3 py-2">
                <PriorityTag priority={t.priority} />
              </td>
              <td className="px-3 py-2 text-[12px] tabular-nums text-muted-foreground">
                {day(t.startAt) ?? <span className="text-faint">–</span>}
              </td>
              <td
                className="px-3 py-2 text-[12px] tabular-nums"
                style={{ color: t.overdue ? "var(--status-red)" : "var(--muted-foreground)" }}
              >
                {day(t.dueAt) ?? <span className="text-faint">–</span>}
              </td>
              <td className="px-3 py-2 text-[12px] tabular-nums text-muted-foreground">
                {day(t.completedAt) ?? <span className="text-faint">–</span>}
              </td>
              <td className="px-3 py-2">
                <LabelChips labels={t.labels} />
              </td>
              <td className="max-w-[14rem] px-3 py-2 text-[12px]">
                {t.links.length === 0 ? (
                  <span className="text-faint">–</span>
                ) : (
                  <ul className="flex flex-col gap-0.5">
                    {t.links.map((link, i) => (
                      <li key={i} className="truncate">
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={link.url}
                          className="text-primary underline-offset-2 hover:underline"
                        >
                          {linkText(link, 36)}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tasks.length > limit && (
        <div className="flex justify-center border-t border-[color-mix(in_oklab,white_6%,transparent)] py-3">
          <button type="button" onClick={() => setLimit(tasks.length)} className="pill pill-sm">
            Show all {tasks.length} tasks
          </button>
        </div>
      )}
    </section>
  );
}
