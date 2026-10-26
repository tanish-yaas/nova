"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  Download,
  ExternalLink,
  Link2,
  Loader2,
  MessageSquare,
  Mic,
  Paperclip,
  Pause,
  Play,
  Plus,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { scheduleMeeting } from "@/server/actions/meetings";
import { MeetingDialog, nextHalfHour } from "@/components/meetings/meeting-dialog";
import { toMeetingInput, type MeetingFormValues } from "@/components/meetings/meeting-form";
import { fromLocalInput, istTodayKey, localInputFromKey } from "@/lib/dates";
import { relativeTime } from "@/lib/relative-time";
import { DateTimeField } from "@/components/ui/datetime-field";
import { APP_CONFIG } from "@/config/app";
import { useToast } from "@/components/ui/toast";
import { updateTask } from "@/server/actions/tasks";
import {
  addComment,
  addSubtask,
  addTaskLink,
  attachmentLink,
  deleteAttachment,
  deleteComment,
  deleteSubtask,
  editComment,
  loadTaskDetail,
  removeTaskLink,
  setTaskAssignees,
  setSubtaskDone,
  uploadTaskAttachment,
} from "@/server/actions/task-detail";
import { setTaskLabels } from "@/server/actions/labels";
import { setTaskTeam } from "@/server/actions/teams";
import { normalizeLink, shortLink, type TaskLinkItem } from "@/lib/task-links";
import { DependencySection } from "./dependency-section";
import { LabelPicker } from "./label-picker";
import {
  VoiceRecorder,
  uploadVoiceClip,
  type VoiceClip,
} from "./voice-recorder";
import type {
  CommentNode,
  TaskDetailData,
} from "@/server/services/task-detail";

type AttachmentFile = TaskDetailData["attachments"][number];

const STATUSES = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "BLOCKED",
  "IN_REVIEW",
  "DONE",
  "CANCELLED",
];

const PRIORITY_COLOR: Record<string, string> = {
  URGENT: "#FF4D6D",
  HIGH: "#F5B544",
  MEDIUM: "#22D3EE",
  LOW: "#8B8B9E",
};

const field =
  "w-full rounded-lg border border-border bg-secondary/50 px-2.5 py-1.5 text-xs outline-none transition-colors focus:border-brand-violet";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Avatar({
  name,
  image,
  size = 24,
}: {
  name: string;
  image: string | null;
  /** Smaller inside a 28px pill, where the default would fill it edge to edge. */
  size?: number;
}) {
  const box = { width: size, height: size };

  if (image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={image}
        alt=""
        style={box}
        className="shrink-0 rounded-full border border-border object-cover"
      />
    );
  }
  return (
    <span
      style={{ ...box, fontSize: Math.round(size * 0.42) }}
      className="flex shrink-0 items-center justify-center rounded-full bg-brand-violet/20 font-medium text-brand-violet"
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

function Section({
  title,
  count,
  icon,
  children,
}: {
  title: string;
  count?: number;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <h3 className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        {icon}
        {title}
        {count !== undefined && count > 0 && ` · ${count}`}
      </h3>
      {children}
    </section>
  );
}

/**
 * A task's details as a meeting. It starts when the task is due, since that
 * is the time someone already picked; failing that, at a start that has not
 * passed yet; failing that, at the next half hour. It runs for the task's
 * estimate when there is a sensible one, and everyone on the task is invited.
 */
function meetingFromTask(detail: TaskDetailData): MeetingFormValues {
  const todayKey = istTodayKey();
  const startIsAhead =
    !!detail.startAtInput && (fromLocalInput(detail.startAtInput)?.getTime() ?? 0) > Date.now();
  const fallback = nextHalfHour(todayKey);
  const startAt =
    detail.dueAtInput ||
    (startIsAhead ? detail.startAtInput : localInputFromKey(fallback.dayKey, fallback.minutes));
  const estimate = Number(detail.estimatedMinutes);

  return {
    title: detail.title,
    agenda: detail.description,
    startAt,
    durationMinutes: estimate >= 15 && estimate <= 480 ? estimate : 60,
    mode: "office",
    place: "",
    link: "",
    attendeeIds: detail.assignees.map((a) => a.id).filter((id) => id !== detail.viewerId),
    labelIds: detail.labels.map((l) => l.id),
  };
}

export function TaskDetailSheet({
  taskId,
  onClose,
}: {
  taskId: string | null;
  onClose: () => void;
}) {
  const { push } = useToast();
  const [mounted, setMounted] = useState(false);
  const [detail, setDetail] = useState<TaskDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();
  const [converting, setConverting] = useState(false);
  const router = useRouter();

  useEffect(() => setMounted(true), []);

  const reload = useCallback(async () => {
    if (!taskId) return;
    const result = await loadTaskDetail(taskId);
    if (result.ok) setDetail(result.detail);
    else push(result.error, "error");
  }, [taskId, push]);

  useEffect(() => {
    if (!taskId) {
      setDetail(null);
      return;
    }
    setLoading(true);
    loadTaskDetail(taskId).then((result) => {
      setLoading(false);
      if (result.ok) setDetail(result.detail);
    });
  }, [taskId]);

  useEffect(() => {
    if (!taskId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Something open on top of the sheet (the meeting dialog, a dropdown)
      // takes this Escape; the sheet closes on the next one.
      if (document.querySelector("[data-layer]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [taskId, onClose]);

  if (!mounted) return null;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok && result.error) {
        push(result.error, "error");
        return;
      }
      await reload();
    });
  }

  const doneSubtasks = detail?.subtasks.filter((s) => s.done).length ?? 0;
  const totalSubtasks = detail?.subtasks.length ?? 0;

  const sheet = (
    <AnimatePresence>
      {taskId && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 z-[92] bg-black/50"
          />

          <motion.aside
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-y-0 right-0 z-[93] flex w-full flex-col border-l border-border bg-card sm:w-[30rem]"
          >
            <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border/60 px-5 py-4">
              <div className="min-w-0">
                {/* Says whose subtask this is when it is one — opened on its
                    own, a line like "Book venue" means nothing without it. */}
                <p className="truncate text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  {detail?.parent
                    ? `Subtask of ${detail.parent.title}`
                    : detail?.meeting
                      ? "Meeting"
                      : "Task"}
                </p>
                <p className="mt-0.5 truncate text-sm">
                  {detail?.title ?? "Loading…"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* Some "tasks" are really a time to get people in a room.
                    This makes it one: same name, notes and people, on the
                    calendar with invites, and the task goes away. */}
                {detail?.canEdit && !detail.parent && !detail.meeting && (
                  <button
                    type="button"
                    onClick={() => setConverting(true)}
                    title="Make this a meeting: on the calendar, with invites"
                    className="pill pill-sm"
                  >
                    <Users size={12} />
                    Turn into meeting
                  </button>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X size={16} />
                </button>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {loading && !detail && (
                <div className="flex items-center gap-2 py-10 text-xs text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" />
                  Loading task…
                </div>
              )}

              {detail && (
                <>
                  <Fields detail={detail} onSaved={reload} />

                  <Section
                    title="Deliverables"
                    count={detail.links.length}
                    icon={<Link2 size={11} />}
                  >
                    <DeliverableLinks
                      taskId={detail.id}
                      links={detail.links}
                      canEdit={detail.canEdit}
                      onChanged={reload}
                    />
                  </Section>

                  <Section title="Subtasks" count={totalSubtasks}>
                    {totalSubtasks > 0 && (
                      <div className="mb-2">
                        <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                          <span>
                            {doneSubtasks} of {totalSubtasks} done
                          </span>
                          <span className="tabular-nums">
                            {Math.round((doneSubtasks / totalSubtasks) * 100)}%
                          </span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-secondary">
                          <div
                            className="h-full rounded-full bg-brand-violet transition-all"
                            style={{
                              width: `${(doneSubtasks / totalSubtasks) * 100}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}

                    <div className="flex flex-col">
                      {detail.subtasks.map((sub) => (
                        <div
                          key={sub.id}
                          className="group flex items-center gap-2.5 rounded-lg px-1 py-1.5 transition-colors hover:bg-secondary/40"
                        >
                          <button
                            type="button"
                            disabled={pending || !detail.canEdit}
                            onClick={() =>
                              run(() => setSubtaskDone(sub.id, !sub.done))
                            }
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-all active:scale-90 ${
                              sub.done
                                ? "border-brand-violet bg-brand-violet text-white"
                                : "border-border hover:border-brand-violet"
                            }`}
                          >
                            {sub.done && <Check size={10} />}
                          </button>
                          <span
                            className={`min-w-0 flex-1 truncate text-xs ${
                              sub.done
                                ? "text-muted-foreground line-through"
                                : ""
                            }`}
                          >
                            {sub.title}
                          </span>
                          {detail.canEdit && (
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() => run(() => deleteSubtask(sub.id))}
                              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-all hover:text-destructive group-hover:opacity-100"
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>

                    {detail.canEdit && (
                      <AddSubtask
                        pending={pending}
                        onAdd={(title) => run(() => addSubtask(detail.id, title))}
                      />
                    )}
                  </Section>

                  {detail.readyToStart && (
                    <div className="mt-5 flex items-center gap-2 rounded-lg border border-[#4ADE80]/30 bg-[#4ADE80]/10 px-3 py-2">
                      <Check size={13} className="shrink-0 text-[#4ADE80]" />
                      <p className="text-xs text-[#4ADE80]">
                        Every blocker is done, so this is ready to start.
                      </p>
                    </div>
                  )}

                  <Section title="Blocked by" count={detail.blockedBy.length}>
                    <DependencySection
                      taskId={detail.id}
                      direction="blocked-by"
                      rows={detail.blockedBy}
                      canEdit={detail.canEdit}
                      onChanged={reload}
                    />
                  </Section>

                  <Section title="Blocks" count={detail.blocks.length}>
                    <DependencySection
                      taskId={detail.id}
                      direction="blocks"
                      rows={detail.blocks}
                      canEdit={detail.canEdit}
                      onChanged={reload}
                    />
                  </Section>

                  <Section
                    title="Comments"
                    count={detail.comments.length}
                    icon={<MessageSquare size={11} />}
                  >
                    <div className="flex flex-col gap-3">
                      {detail.comments.map((node) => (
                        <Comment
                          key={node.id}
                          node={node}
                          depth={0}
                          pending={pending}
                          onReply={(parentId, body) =>
                            run(() => addComment(detail.id, body, parentId))
                          }
                          onEdit={(id, body) => run(() => editComment(id, body))}
                          onDelete={(id) => run(() => deleteComment(id))}
                        />
                      ))}
                    </div>

                    <CommentBox
                      pending={pending}
                      placeholder="Add a comment…"
                      onSubmit={(body) => run(() => addComment(detail.id, body))}
                    />
                  </Section>

                  <Section
                    title="Attachments"
                    count={detail.attachments.length}
                    icon={<Paperclip size={11} />}
                  >
                    <div className="flex flex-col gap-1.5">
                      {detail.attachments.map((file) => (
                        <AttachmentItem
                          key={file.id}
                          file={file}
                          pending={pending}
                          onError={(message) => push(message, "error")}
                          onDelete={() => run(() => deleteAttachment(file.id))}
                        />
                      ))}
                    </div>

                    <div className="mt-2 flex flex-col gap-2">
                      <UploadField
                        taskId={detail.id}
                        onUploaded={reload}
                        onError={(message) => push(message, "error")}
                      />

                      {detail.storageReady && (
                        <RecordField
                          taskId={detail.id}
                          onUploaded={reload}
                          onError={(message) => push(message, "error")}
                        />
                      )}
                    </div>
                  </Section>

                  <Section title="Activity" count={detail.activity.length}>
                    {detail.activity.length === 0 ? (
                      <p className="text-xs text-muted-foreground/70">
                        Nothing has changed yet.
                      </p>
                    ) : (
                      <ol className="flex flex-col gap-0">
                        {detail.activity.map((row, i) => (
                          <li key={row.id} className="flex gap-3">
                            <div className="flex flex-col items-center">
                              <span
                                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{
                                  backgroundColor:
                                    row.kind === "priority"
                                      ? "#F5B544"
                                      : "#7C5CFF",
                                }}
                              />
                              {i < detail.activity.length - 1 && (
                                <span className="w-px flex-1 bg-border/60" />
                              )}
                            </div>
                            <div className="pb-3">
                              <p className="text-xs">
                                {row.kind === "status" ? "Status" : "Priority"}{" "}
                                {row.from ? (
                                  <>
                                    <span className="text-muted-foreground">
                                      {row.from.replace("_", " ")}
                                    </span>{" "}
                                    →{" "}
                                  </>
                                ) : (
                                  "set to "
                                )}
                                <span className="text-foreground">
                                  {row.to.replace("_", " ")}
                                </span>
                              </p>
                              <p className="text-[10px] text-muted-foreground">
                                {row.actor} · {relativeTime(row.at)}
                                {row.byAI && " · automatic"}
                              </p>
                              {row.reason && (
                                <p className="mt-0.5 text-[10px] text-muted-foreground/70">
                                  {row.reason}
                                </p>
                              )}
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </Section>

                  <p className="mt-6 border-t border-border/60 pt-3 text-[10px] text-muted-foreground/70">
                    Created by {detail.createdBy} on {detail.createdAtLabel}
                    {" · "}updated {detail.updatedAtLabel}
                  </p>
                </>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );

  return (
    <>
      {createPortal(sheet, document.body)}
      {detail && (
        <MeetingDialog
          open={converting}
          heading="Turn into meeting"
          note={`"${detail.title}" becomes a meeting with the same name, notes, labels and people. It stays on the board, as a meeting.`}
          initial={meetingFromTask(detail)}
          people={detail.allMembers.map((m) => ({
            userId: m.id,
            name: m.name,
            avatarUrl: m.image,
            image: null,
          }))}
          labels={detail.allLabels}
          selfId={detail.viewerId}
          submitLabel="Make it a meeting"
          onSubmit={async (values) => {
            const result = await scheduleMeeting(toMeetingInput(values), { fromTaskId: detail.id });
            if (!result.ok) return result.error;
            push(`"${values.title}" is a meeting now`);
            setConverting(false);
            onClose();
            // The sheet is opened from the board, the task list and the
            // calendar; whichever page is behind it has a task to lose and a
            // meeting to gain.
            router.refresh();
            return null;
          }}
          onClose={() => setConverting(false)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function Fields({
  detail,
  onSaved,
}: {
  detail: TaskDetailData;
  onSaved: () => Promise<void>;
}) {
  const { push } = useToast();
  const [description, setDescription] = useState(detail.description);
  // Every free-text field is a draft until it is committed, so typing is not
  // fighting a server round trip on each keystroke. Selects commit on change;
  // text and date inputs commit on blur or Enter.
  const [title, setTitle] = useState(detail.title);
  const [dueAt, setDueAt] = useState(detail.dueAtInput);
  const [startAt, setStartAt] = useState(detail.startAtInput);
  const [estimate, setEstimate] = useState(detail.estimatedMinutes);
  const [pending, startTransition] = useTransition();

  useEffect(() => setDescription(detail.description), [detail.description]);
  useEffect(() => setTitle(detail.title), [detail.title]);
  useEffect(() => setDueAt(detail.dueAtInput), [detail.dueAtInput]);
  useEffect(() => setStartAt(detail.startAtInput), [detail.startAtInput]);
  useEffect(
    () => setEstimate(detail.estimatedMinutes),
    [detail.estimatedMinutes]
  );

  type Patch = Partial<{
    status: string;
    priority: string;
    description: string;
    title: string;
    startAt: string;
    dueAt: string;
    estimatedMinutes: string;
  }>;

  // updateTask takes the whole row, so every call sends the current draft of
  // each field. Sending only the patch would blank whatever it omitted.
  function save(patch: Patch) {
    const nextTitle = (patch.title ?? title).trim();
    if (!nextTitle) {
      push("Title can't be empty", "error");
      setTitle(detail.title);
      return;
    }

    startTransition(async () => {
      const result = await updateTask(detail.id, {
        title: nextTitle,
        description: patch.description ?? description,
        priority: patch.priority ?? detail.priority,
        status: patch.status ?? detail.status,
        startAt: patch.startAt ?? startAt,
        dueAt: patch.dueAt ?? dueAt,
        estimatedMinutes: patch.estimatedMinutes ?? estimate,
      });

      if (!result.ok) {
        push(result.error, "error");
        return;
      }
      await onSaved();
    });
  }

  function setAssignees(ids: string[]) {
    startTransition(async () => {
      const result = await setTaskAssignees(detail.id, ids);
      if (!result.ok) {
        push(result.error, "error");
        return;
      }
      await onSaved();
    });
  }

  return (
    <div className={pending ? "opacity-70" : ""}>
      <label className="mb-3 flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Title
        </span>
        <input
          value={title}
          disabled={!detail.canEdit}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title.trim() === detail.title) return;
            save({ title });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setTitle(detail.title);
          }}
          className={`${field} text-sm`}
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Status
          </span>
          <select
            value={detail.status}
            disabled={!detail.canEdit}
            onChange={(e) => save({ status: e.target.value })}
            className={field}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Priority
          </span>
          <select
            value={detail.priority}
            disabled={!detail.canEdit}
            onChange={(e) => save({ priority: e.target.value })}
            className={field}
            style={{ color: PRIORITY_COLOR[detail.priority] }}
          >
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
            <option value="URGENT">Urgent</option>
          </select>
        </label>
      </div>

      {detail.meeting ? (
        // A meeting's time and place belong to the meeting. Shown here, changed
        // there, so the card and the calendar can never disagree.
        <div className="mt-3 rounded-lg border border-[color-mix(in_oklab,var(--primary)_35%,transparent)] bg-[color-mix(in_oklab,var(--primary)_8%,transparent)] px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Meeting</p>
          <p className="mt-1 text-[13px] tabular-nums">{detail.meeting.when}</p>
          <p className="text-[12px] text-muted-foreground">{detail.meeting.place}</p>
          <div className="mt-2 flex items-center gap-2">
            {detail.meeting.joinUrl && (
              <a
                href={detail.meeting.joinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="pill pill-sm"
              >
                Join
              </a>
            )}
            <span className="text-[11px] text-faint">
              Time, place and people change from the meeting on the calendar or Tasks tab.
            </span>
          </div>
        </div>
      ) : (
        <>
      {/* Both were read-only text before, which meant a task could be created
            with the wrong date and never corrected without deleting it. */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Due
            </span>
            {/* Still the "YYYY-MM-DDTHH:mm" that toLocalInput / fromLocalInput
                speak — the server runs in UTC and a raw value lands 5.5h out. */}
            <DateTimeField
              value={dueAt}
              disabled={!detail.canEdit}
              onChange={setDueAt}
              defaultHour={APP_CONFIG.defaultDueHour}
              onCommit={(next) => {
                if (next === detail.dueAtInput) return;
                save({ dueAt: next });
              }}
            />
          </label>
  
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Start
            </span>
            {/* Gives the task a span on the calendar instead of one day. */}
            <DateTimeField
              value={startAt}
              disabled={!detail.canEdit}
              onChange={setStartAt}
              defaultHour={9}
              onCommit={(next) => {
                if (next === detail.startAtInput) return;
                save({ startAt: next });
              }}
            />
          </label>
  
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Estimate (min)
            </span>
            <input
              type="number"
              min={0}
              value={estimate}
              disabled={!detail.canEdit}
              placeholder="Not set"
              onChange={(e) => setEstimate(e.target.value)}
              onBlur={() => {
                if (estimate === detail.estimatedMinutes) return;
                save({ estimatedMinutes: estimate });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              className={field}
            />
          </label>
        </div>
        </>
      )}

      {detail.teams.length > 0 && (
        <label className="mt-3 flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Team
          </span>
          <select
            value={detail.teamId ?? ""}
            disabled={!detail.canEdit}
            onChange={(e) =>
              startTransition(async () => {
                const result = await setTaskTeam(
                  detail.id,
                  e.target.value || null
                );
                if (!result.ok) {
                  push(result.error, "error");
                  return;
                }
                await onSaved();
              })
            }
            className={field}
          >
            <option value="">No team</option>
            {detail.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="mt-3">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Assignees
        </p>

        {detail.meeting && (
          <p className="mt-1 text-[11px] text-faint">
            Everyone invited who hasn&apos;t declined. Change who&apos;s coming from the meeting.
          </p>
        )}

        {/* A roster of toggles rather than a dropdown: the workspace is small,
            and the whole point is seeing at a glance who is on this. The first
            one selected owns the task, which is how the composers create them. */}
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {detail.allMembers.map((member) => {
            const on = detail.assignees.some((a) => a.id === member.id);
            return (
              <button
                key={member.id}
                type="button"
                data-on={on}
                disabled={!detail.canEdit || pending || !!detail.meeting}
                onClick={() =>
                  setAssignees(
                    on
                      ? detail.assignees
                          .filter((a) => a.id !== member.id)
                          .map((a) => a.id)
                      : [...detail.assignees.map((a) => a.id), member.id]
                  )
                }
                title={on ? `Remove ${member.name}` : `Assign ${member.name}`}
                className="pill pill-sm disabled:opacity-50"
              >
                <Avatar name={member.name} image={member.image} size={16} />
                {member.name}
              </button>
            );
          })}
        </div>

        {detail.assignees.length === 0 && (
          <p className="mt-1.5 text-[11px] text-faint">
            Nobody is on this, so it belongs to no one&apos;s board.
          </p>
        )}
      </div>

      <div className="mt-3">
        <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          Labels
        </p>
        <LabelPicker
          value={detail.labels.map((l) => l.id)}
          options={detail.allLabels}
          canEdit={detail.canEdit}
          onChange={(ids) =>
            startTransition(async () => {
              const result = await setTaskLabels(detail.id, ids);
              if (!result.ok) {
                push(result.error, "error");
                return;
              }
              await onSaved();
            })
          }
        />
      </div>

      <div className="mt-3">
        <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          Description
        </p>
        <textarea
          value={description}
          disabled={!detail.canEdit}
          rows={3}
          placeholder="No description yet"
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => {
            if (description === detail.description) return;
            save({ description });
          }}
          className={field}
        />
      </div>
    </div>
  );
}

type LinkDraft = { key: number; url: string; label: string };

/**
 * Where the finished work lives. Each + opens another row, so a task with a
 * reel, a thumbnail and a Drive folder takes three presses, not three trips.
 */
function DeliverableLinks({
  taskId,
  links,
  canEdit,
  onChanged,
}: {
  taskId: string;
  links: TaskLinkItem[];
  canEdit: boolean;
  onChanged: () => Promise<void>;
}) {
  const { push } = useToast();
  const [drafts, setDrafts] = useState<LinkDraft[]>([]);
  const [pending, startTransition] = useTransition();
  const nextKey = useRef(0);

  function addDraft() {
    const key = nextKey.current++;
    setDrafts((list) => [...list, { key, url: "", label: "" }]);
  }

  function updateDraft(key: number, patch: Partial<LinkDraft>) {
    setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  function dropDraft(key: number) {
    setDrafts((list) => list.filter((d) => d.key !== key));
  }

  function save(draft: LinkDraft) {
    // A column of links pasted in one go becomes one link each.
    const parts = draft.url.split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      dropDraft(draft.key);
      return;
    }
    const bad = parts.find((p) => !normalizeLink(p));
    if (bad) {
      push(`${shortLink(bad)} doesn't look like a web link`, "error");
      return;
    }

    startTransition(async () => {
      for (let i = 0; i < parts.length; i++) {
        const label = parts.length === 1 ? draft.label : undefined;
        const result = await addTaskLink(taskId, parts[i], label);
        if (!result.ok) {
          push(result.error, "error");
          // Keep only what did not save, so pressing Enter again adds no twins.
          updateDraft(draft.key, { url: parts.slice(i).join("\n") });
          await onChanged();
          return;
        }
      }
      dropDraft(draft.key);
      await onChanged();
    });
  }

  function remove(linkId: string) {
    startTransition(async () => {
      const result = await removeTaskLink(linkId);
      if (!result.ok) push(result.error, "error");
      await onChanged();
    });
  }

  return (
    <div className={pending ? "opacity-70" : ""}>
      {links.length === 0 && drafts.length === 0 && !canEdit && (
        <p className="text-xs text-muted-foreground/70">No deliverables yet.</p>
      )}

      <div className="flex flex-col">
        {links.map((link) => (
          <div
            key={link.id}
            className="group flex items-center gap-2.5 rounded-lg px-1 py-1.5 transition-colors hover:bg-secondary/40"
          >
            <ExternalLink size={12} className="shrink-0 text-muted-foreground" />
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              title={link.url}
              className="min-w-0 flex-1 truncate text-xs underline-offset-2 hover:underline"
            >
              {link.label ? (
                <>
                  {link.label}
                  <span className="text-muted-foreground"> · {shortLink(link.url, 40)}</span>
                </>
              ) : (
                shortLink(link.url, 72)
              )}
            </a>
            {canEdit && (
              <button
                type="button"
                disabled={pending}
                onClick={() => remove(link.id)}
                aria-label="Remove link"
                className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-all hover:text-destructive group-hover:opacity-100"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}
      </div>

      {drafts.map((draft) => (
        <form
          key={draft.key}
          onSubmit={(e) => {
            e.preventDefault();
            save(draft);
          }}
          className="mt-2 flex items-center gap-1.5"
        >
          {/* Text, not type="url": the browser's own check would refuse
              "drive.google.com/…", which is how people copy links. */}
          <input
            autoFocus
            inputMode="url"
            value={draft.url}
            disabled={pending}
            placeholder="Paste a link"
            onChange={(e) => updateDraft(draft.key, { url: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") dropDraft(draft.key);
            }}
            className={`${field} min-w-0 flex-1`}
          />
          <input
            value={draft.label}
            disabled={pending}
            placeholder="Name (optional)"
            maxLength={120}
            onChange={(e) => updateDraft(draft.key, { label: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") dropDraft(draft.key);
            }}
            className={`${field} w-32 shrink-0`}
          />
          <button
            type="submit"
            disabled={pending || !draft.url.trim()}
            aria-label="Save link"
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            <Check size={14} />
          </button>
          <button
            type="button"
            onClick={() => dropDraft(draft.key)}
            aria-label="Cancel"
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X size={14} />
          </button>
        </form>
      ))}

      {canEdit && (
        <button
          type="button"
          onClick={addDraft}
          disabled={pending}
          className="mt-2 flex items-center gap-1.5 rounded px-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Plus size={13} />
          Add link
        </button>
      )}
    </div>
  );
}

function AddSubtask({
  pending,
  onAdd,
}: {
  pending: boolean;
  onAdd: (title: string) => void;
}) {
  const [value, setValue] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        onAdd(value);
        setValue("");
      }}
      className="mt-2 flex items-center gap-2"
    >
      <Plus size={13} className="shrink-0 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={pending}
        placeholder="Add a subtask"
        className={field}
      />
    </form>
  );
}

function CommentBox({
  pending,
  placeholder,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  placeholder: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        onSubmit(value);
        setValue("");
      }}
      className="mt-3 flex flex-col gap-2"
    >
      <textarea
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (!value.trim()) return;
            onSubmit(value);
            setValue("");
          }
        }}
        rows={2}
        placeholder={placeholder}
        className={`${field} resize-none`}
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || !value.trim()}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Post
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function Comment({
  node,
  depth,
  pending,
  onReply,
  onEdit,
  onDelete,
}: {
  node: CommentNode;
  depth: number;
  pending: boolean;
  onReply: (parentId: string, body: string) => void;
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.body);

  return (
    <div className={depth > 0 ? "ml-6 border-l border-border/50 pl-3" : ""}>
      <div className="flex items-start gap-2">
        <Avatar name={node.authorName} image={node.authorImage} />
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-2">
            <span className="text-xs">{node.authorName}</span>
            <span className="text-[10px] text-muted-foreground">
              {relativeTime(node.createdAt)}
              {node.isEdited && " · edited"}
            </span>
          </p>

          {node.isDeleted ? (
            <p className="mt-0.5 text-xs italic text-muted-foreground/60">
              Comment deleted
            </p>
          ) : editing ? (
            <div className="mt-1 flex flex-col gap-2">
              <textarea
                value={draft}
                autoFocus
                rows={2}
                onChange={(e) => setDraft(e.target.value)}
                className={`${field} resize-none`}
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    onEdit(node.id, draft);
                    setEditing(false);
                  }}
                  className="rounded-lg bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(node.body);
                    setEditing(false);
                  }}
                  className="text-[11px] text-muted-foreground underline underline-offset-4"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="mt-0.5 whitespace-pre-wrap text-xs text-secondary-foreground">
              {node.body}
            </p>
          )}

          {!node.isDeleted && !editing && (
            <div className="mt-1 flex items-center gap-3">
              {depth === 0 && (
                <button
                  type="button"
                  onClick={() => setReplying((prev) => !prev)}
                  className="text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  Reply
                </button>
              )}
              {node.isMine && (
                <>
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onDelete(node.id)}
                    className="text-[10px] text-muted-foreground transition-colors hover:text-destructive"
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          )}

          {replying && (
            <CommentBox
              pending={pending}
              autoFocus
              placeholder={`Reply to ${node.authorName}…`}
              onSubmit={(body) => {
                onReply(node.id, body);
                setReplying(false);
              }}
              onCancel={() => setReplying(false)}
            />
          )}
        </div>
      </div>

      {node.replies.length > 0 && (
        <div className="mt-3 flex flex-col gap-3">
          {node.replies.map((reply) => (
            <Comment
              key={reply.id}
              node={reply}
              depth={depth + 1}
              pending={pending}
              onReply={onReply}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One attachment. Audio plays inline rather than opening in a tab — a voice
 * note is meant to be heard in place, and a download round trip for a
 * twelve-second clip is the wrong shape.
 *
 * The signed URL is fetched on first play, not up front: links expire in
 * minutes, so one minted at render time is likely dead by the time it is used.
 */
function AttachmentItem({
  file,
  pending,
  onError,
  onDelete,
}: {
  file: AttachmentFile;
  pending: boolean;
  onError: (message: string) => void;
  onDelete: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const isAudio = file.mimeType.startsWith("audio/");

  async function open() {
    const result = await attachmentLink(file.id);
    if (!result.ok) {
      onError(result.error);
      return;
    }
    window.open(result.url, "_blank", "noopener");
  }

  async function toggle() {
    const el = audioRef.current;
    if (el && src) {
      if (el.paused) void el.play();
      else el.pause();
      return;
    }

    setLoading(true);
    const result = await attachmentLink(file.id);
    setLoading(false);

    if (!result.ok) {
      onError(result.error);
      return;
    }
    // Playback starts from the audio element's onCanPlay once the src lands.
    setSrc(result.url);
  }

  return (
    <div className="group flex items-center gap-2.5 rounded-lg border border-border/60 px-2.5 py-2">
      {isAudio ? (
        <button
          type="button"
          onClick={toggle}
          disabled={loading}
          className="shrink-0 text-brand-violet transition-opacity hover:opacity-80 disabled:opacity-50"
          aria-label={playing ? "Pause" : "Play"}
        >
          {loading ? (
            <Loader2 size={14} className="animate-spin" />
          ) : playing ? (
            <Pause size={14} />
          ) : (
            <Play size={14} />
          )}
        </button>
      ) : (
        <Paperclip size={13} className="shrink-0 text-muted-foreground" />
      )}

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-xs">
          {isAudio && <Mic size={11} className="shrink-0 text-faint" />}
          {file.fileName}
        </p>
        <p className="truncate text-[10px] text-muted-foreground">
          {formatBytes(file.sizeBytes)} · {file.mimeType.split("/").pop()} ·{" "}
          {file.uploadedBy} · {relativeTime(file.createdAt)}
        </p>

        {src && (
          <audio
            ref={audioRef}
            src={src}
            controls
            autoPlay
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            // The link expires; if playback fails, fall back to a fresh fetch.
            onError={() => {
              setSrc(null);
              setPlaying(false);
              onError("That clip's link expired. Try again");
            }}
            className="mt-1.5 h-8 w-full"
          />
        )}
      </div>

      <button
        type="button"
        onClick={open}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
        title="Download"
      >
        <Download size={13} />
      </button>

      {file.isMine && (
        <button
          type="button"
          disabled={pending}
          onClick={onDelete}
          className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-all hover:text-destructive group-hover:opacity-100"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

/** Record a voice note straight onto an existing task. */
function RecordField({
  taskId,
  onUploaded,
  onError,
}: {
  taskId: string;
  onUploaded: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [clip, setClip] = useState<VoiceClip | null>(null);
  const [saving, setSaving] = useState(false);

  async function attach() {
    if (!clip) return;
    setSaving(true);
    const result = await uploadVoiceClip(taskId, clip, uploadTaskAttachment);
    setSaving(false);

    if (!result.ok) {
      onError(result.error ?? "Couldn't attach that voice note");
      return;
    }

    URL.revokeObjectURL(clip.url);
    setClip(null);
    await onUploaded();
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border px-2.5 py-2">
      <VoiceRecorder
        clip={clip}
        onClip={setClip}
        disabled={saving}
        compact
      />

      {clip && (
        <button
          type="button"
          onClick={attach}
          disabled={saving}
          className="flex h-8 items-center justify-center gap-1.5 rounded-lg bg-primary text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              Attaching…
            </>
          ) : (
            <>
              <Mic size={12} />
              Attach voice note
            </>
          )}
        </button>
      )}
    </div>
  );
}

function UploadField({
  taskId,
  onUploaded,
  onError,
}: {
  taskId: string;
  onUploaded: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [uploading, setUploading] = useState(false);

  return (
    <label className="flex h-9 cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border text-xs text-muted-foreground transition-colors hover:border-brand-violet hover:text-foreground">
      {uploading ? (
        <>
          <Loader2 size={13} className="animate-spin" />
          Uploading…
        </>
      ) : (
        <>
          <Paperclip size={13} />
          Attach a file
        </>
      )}
      <input
        type="file"
        className="hidden"
        disabled={uploading}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;

          setUploading(true);
          const formData = new FormData();
          formData.set("taskId", taskId);
          formData.set("file", file);

          const result = await uploadTaskAttachment(formData);
          setUploading(false);

          if (!result.ok) {
            onError(result.error);
            return;
          }
          await onUploaded();
        }}
      />
    </label>
  );
}
