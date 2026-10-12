"use client";

import {
  AtSign,
  BadgeCheck,
  Bell,
  CalendarClock,
  CalendarPlus,
  CalendarX2,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  Clock3,
  MessageSquare,
  Moon,
  OctagonAlert,
  Repeat,
  Sparkles,
  Sunrise,
  TriangleAlert,
  UserPlus,
  X,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { relativeTime } from "@/lib/relative-time";
import { formatIST } from "@/lib/dates";
import {
  DIGEST_LABELS,
  digestSummary,
  joinRequester,
  parseDigest,
  type NotificationView,
} from "@/lib/notifications";

type Look = { Icon: LucideIcon; color: string };

/** One icon and one hue per kind, so a glance down the list sorts it. */
function lookOf(n: NotificationView): Look {
  switch (n.type) {
    case "TASK_ASSIGNED":
      return n.recurring
        ? { Icon: Repeat, color: "var(--status-purple)" }
        : { Icon: ClipboardCheck, color: "var(--primary)" };
    case "TASK_COMMENT":
      return { Icon: MessageSquare, color: "var(--status-blue)" };
    case "TASK_MENTION":
      return { Icon: AtSign, color: "var(--status-blue)" };
    case "TASK_DUE_SOON":
      return { Icon: Clock3, color: "var(--status-amber)" };
    case "TASK_OVERDUE":
      return { Icon: TriangleAlert, color: "var(--status-red)" };
    case "TASK_BLOCKED":
      return { Icon: OctagonAlert, color: "var(--status-red)" };
    case "TASK_COMPLETED":
      return { Icon: CheckCircle2, color: "var(--status-green)" };
    case "MEMBER_JOIN_REQUEST":
      return { Icon: UserPlus, color: "var(--status-amber)" };
    case "MEMBER_APPROVED":
      return { Icon: BadgeCheck, color: "var(--status-green)" };
    case "EVENT_INVITE":
      return { Icon: CalendarPlus, color: "var(--primary)" };
    case "EVENT_UPDATED":
      return n.change === "cancelled"
        ? { Icon: CalendarX2, color: "var(--status-red)" }
        : { Icon: CalendarClock, color: "var(--status-amber)" };
    case "AI_SUGGESTION":
      return { Icon: Sparkles, color: "var(--primary)" };
    case "DIGEST":
      return n.digest === "evening"
        ? { Icon: Moon, color: "var(--status-purple)" }
        : n.digest === "weekly"
          ? { Icon: CalendarRange, color: "var(--status-blue)" }
          : { Icon: Sunrise, color: "var(--status-amber)" };
    default:
      return { Icon: Bell, color: "var(--text-faint)" };
  }
}

/** The person when there is one, with the kind as a badge; otherwise the kind. */
function Leading({ n }: { n: NotificationView }) {
  const { Icon, color } = lookOf(n);

  if (n.actor) {
    return (
      // A fixed box, not an inline span: inline, the line height stretched
      // the wrapper and the badge hung off well below the avatar.
      <span className="relative mt-0.5 flex h-[30px] w-[30px] shrink-0">
        <Avatar avatarUrl={n.actor.avatarUrl} image={n.actor.image} name={n.actor.name} size={30} />
        <span
          className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-[var(--popover)]"
          style={{ backgroundColor: color }}
        >
          <Icon size={9} className="text-white" strokeWidth={2.5} />
        </span>
      </span>
    );
  }

  return (
    <span
      className="mt-0.5 flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full"
      style={{ backgroundColor: `color-mix(in oklab, ${color} 16%, transparent)`, color }}
    >
      <Icon size={14} />
    </span>
  );
}

/** The sentence, with the who and the what standing out from the verb. */
function Sentence({ n }: { n: NotificationView }) {
  const strong = n.read ? "text-foreground/85" : "font-medium text-foreground";
  const em = (children: React.ReactNode) => <span className={strong}>{children}</span>;
  const taskName = n.task ? (
    <span className={n.task.deleted ? "text-faint line-through" : strong}>{n.task.title}</span>
  ) : (
    em(n.body ?? "a task")
  );
  const who = n.actor ? em(n.actor.name) : null;
  const meeting = n.event ? (
    <span className={n.event.deleted && n.change !== "cancelled" ? "text-faint line-through" : strong}>
      {n.event.title}
    </span>
  ) : (
    em(n.body?.split(" · ")[0] ?? "a meeting")
  );

  switch (n.type) {
    case "EVENT_INVITE":
      return who ? <>{who} invited you to {meeting}</> : <>You were invited to {meeting}</>;
    case "EVENT_UPDATED":
      if (n.change === "cancelled") {
        return who ? <>{who} cancelled {meeting}</> : <>{meeting} was cancelled</>;
      }
      return who ? <>{who} changed the time or place of {meeting}</> : <>{meeting} changed</>;
    case "TASK_ASSIGNED":
      if (n.recurring) return <>{taskName} is due again</>;
      return who ? <>{who} assigned you {taskName}</> : <>You were assigned {taskName}</>;
    case "TASK_COMMENT":
      return who ? <>{who} commented on {taskName}</> : <>New comment on {taskName}</>;
    case "TASK_MENTION":
      return who ? <>{who} mentioned you on {taskName}</> : <>You were mentioned on {taskName}</>;
    case "TASK_DUE_SOON":
      return <>{taskName} is due soon</>;
    case "TASK_OVERDUE":
      return <>{taskName} is overdue</>;
    case "TASK_BLOCKED":
      return <>{taskName} is blocked</>;
    case "TASK_COMPLETED":
      return who ? <>{who} completed {taskName}</> : <>{taskName} was completed</>;
    case "MEMBER_JOIN_REQUEST":
      return (
        <>
          {em(n.actor?.name ?? joinRequester(n.body) ?? "Someone")} asked to join the workspace
        </>
      );
    case "MEMBER_APPROVED":
      return (
        <>
          {em("You're in.")} {n.body?.replace(/^An admin/, n.actor ? n.actor.name : "An admin")}
        </>
      );
    case "DIGEST":
      return em(DIGEST_LABELS[n.digest ?? "morning"]);
    default:
      return em(n.title);
  }
}

/** A digest opened up: numbers, then each list, laid out rather than printed. */
function DigestBody({ body }: { body: string | null }) {
  const d = parseDigest(body);

  return (
    <div className="mt-2 rounded-lg border border-[color-mix(in_oklab,white_8%,transparent)] bg-[color-mix(in_oklab,white_3%,transparent)] px-3 py-2.5 text-[12px]">
      {d.lead && d.sections.length === 0 && d.facts.length === 0 && (
        <p className="text-muted-foreground">{d.lead}</p>
      )}

      {d.facts.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {d.facts.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-faint">{f.label}</dt>
              <dd className="tabular-nums text-foreground">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {d.sections.map((s, i) => {
        const late = s.title.toLowerCase().startsWith("overdue");
        return (
          <div key={s.title} className={i > 0 || d.facts.length > 0 ? "mt-2.5" : ""}>
            <p className="mb-1 text-[10px] uppercase tracking-[0.1em] text-faint">
              {s.title}
              {s.count !== null && <span className="ml-1 tabular-nums">{s.count}</span>}
            </p>
            <ul className="flex flex-col gap-1">
              {s.items.map((item, j) => (
                <li key={j} className="flex items-baseline gap-2.5">
                  {item.meta && (
                    <span
                      className="w-[4.75rem] shrink-0 tabular-nums"
                      style={{ color: late ? "var(--status-red)" : "var(--text-faint)" }}
                    >
                      {item.meta}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 text-foreground/90">{item.text}</span>
                  {item.tag && (
                    <span
                      className="shrink-0 text-[10px] uppercase tracking-[0.06em]"
                      style={{
                        color: item.tag === "urgent" ? "var(--status-red)" : "var(--status-amber)",
                      }}
                    >
                      {item.tag}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {s.more && <p className="mt-1 text-faint">{s.more}</p>}
          </div>
        );
      })}

      {d.notes.length > 0 && (
        <p className={`text-muted-foreground ${d.sections.length || d.facts.length ? "mt-2.5" : ""}`}>
          {d.notes.join(" ")}
        </p>
      )}
    </div>
  );
}

/**
 * One notification, the same in the bell and on the page: who or what on the
 * left, a sentence, an optional quote or digest summary, and when. The dot on
 * the right is unread; hovering swaps it for dismiss.
 */
export function NotificationRow({
  n,
  expanded,
  onOpen,
  onDismiss,
  roomy = false,
}: {
  n: NotificationView;
  /** Digests only: whether the list is open underneath. */
  expanded: boolean;
  onOpen: (n: NotificationView) => void;
  onDismiss: (n: NotificationView) => void;
  /** The page has the width for longer quotes. */
  roomy?: boolean;
}) {
  const digest = n.type === "DIGEST" ? parseDigest(n.body) : null;
  const summary = digest ? digestSummary(n.digest ?? "morning", digest) : null;
  const inert = !!n.task?.deleted && n.read;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={digest ? expanded : undefined}
      onClick={() => onOpen(n)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(n);
        }
      }}
      className={`group relative flex cursor-pointer gap-3 rounded-lg px-3 py-2.5 outline-none transition-colors hover:bg-[color-mix(in_oklab,white_4%,transparent)] focus-visible:bg-[color-mix(in_oklab,white_5%,transparent)] ${
        inert ? "cursor-default" : ""
      }`}
    >
      <Leading n={n} />

      <div className="min-w-0 flex-1 pr-5">
        <p className="text-[13px] leading-snug text-muted-foreground">
          <Sentence n={n} />
        </p>

        {n.event && n.change !== "cancelled" && !n.event.deleted && (
          <p className="mt-0.5 text-[12px] tabular-nums text-muted-foreground">
            {formatIST(new Date(n.event.startAt), {
              weekday: "short",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        )}

        {n.quote && (
          <p
            className={`mt-1 border-l-2 border-[color-mix(in_oklab,white_14%,transparent)] pl-2 text-[12px] leading-relaxed text-muted-foreground ${
              roomy ? "line-clamp-3" : "line-clamp-2"
            }`}
          >
            {n.quote}
          </p>
        )}

        {summary && (
          <p className="mt-0.5 flex items-center gap-1 text-[12px] text-muted-foreground">
            <span className="truncate">{summary}</span>
            <ChevronDown
              size={12}
              className={`shrink-0 text-faint transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </p>
        )}

        {expanded && digest && <DigestBody body={n.body} />}

        {n.type === "MEMBER_JOIN_REQUEST" && (
          <p className="mt-1 text-[12px] text-[var(--primary)]">Review requests</p>
        )}

        <p className="mt-1 text-[11px] text-faint" suppressHydrationWarning>
          {relativeTime(n.createdAt)}
          {n.task?.deleted && " · task deleted"}
        </p>
      </div>

      {!n.read && (
        <span
          className="absolute right-3.5 top-4 h-2 w-2 rounded-full bg-[var(--primary)] transition-opacity group-hover:opacity-0"
          aria-label="Unread"
        />
      )}

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss(n);
        }}
        title="Dismiss"
        aria-label="Dismiss notification"
        className="absolute right-2 top-2.5 flex h-6 w-6 items-center justify-center rounded-md text-faint opacity-0 transition-opacity hover:bg-[color-mix(in_oklab,white_8%,transparent)] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X size={13} />
      </button>
    </div>
  );
}
