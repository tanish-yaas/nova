import { tool } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { buildTaskScope } from "@/server/services/tasks";
import { eventsInvolving, getVisibleCalendarIds } from "@/server/services/calendar";

export type ChatContext = {
  orgId: string;
  userId: string;
  timezone: string;
  permissions: Set<string>;
};

export type Proposal =
  | {
      kind: "create_task";
      title: string;
      description: string;
      priority: string;
      dueAt: string;
      assigneeIds: string[];
      summary: string;
    }
  | {
      kind: "update_tasks";
      taskIds: string[];
      status: string;
      priority: string;
      dueAt: string;
      summary: string;
    };

export function buildTools(ctx: ChatContext) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: ctx.timezone,
  });

  return {
    searchTasks: tool({
      description:
        "Find tasks in the workspace. Use this before answering anything about what exists, what's due, or what's overdue.",
      inputSchema: z.object({
        onlyMine: z.boolean().describe("Restrict to tasks assigned to the current user"),
        onlyOpen: z.boolean().describe("Exclude DONE and CANCELLED tasks"),
        onlyOverdue: z.boolean().describe("Only tasks past their due date"),
        dueWithinDays: z
          .number()
          .describe("Only tasks due within this many days. Use 0 for no limit."),
        titleContains: z
          .string()
          .describe("Filter by words in the title. Empty string for no filter."),
        limit: z.number().describe("Max results, 1 to 50"),
      }),
      execute: async (args) => {
        const scope = await buildTaskScope(ctx.orgId, ctx.userId, ctx.permissions);
        const now = new Date();

        const where: Record<string, unknown> = { ...scope };

        if (args.onlyMine) {
          where.assignments = { some: { userId: ctx.userId } };
        }
        if (args.onlyOpen) {
          where.status = { notIn: ["DONE", "CANCELLED"] };
        }
        if (args.onlyOverdue) {
          where.dueAt = { lt: now };
          where.status = { notIn: ["DONE", "CANCELLED"] };
        } else if (args.dueWithinDays > 0) {
          const until = new Date(now);
          until.setDate(until.getDate() + args.dueWithinDays);
          where.dueAt = { gte: now, lte: until };
        }
        if (args.titleContains.trim()) {
          where.title = { contains: args.titleContains.trim(), mode: "insensitive" };
        }

        const tasks = await prisma.task.findMany({
          where,
          orderBy: [{ priorityScore: "desc" }, { dueAt: "asc" }],
          take: Math.min(Math.max(args.limit, 1), 50),
          include: {
            assignments: { include: { user: { select: { name: true } } } },
          },
        });

        return {
          count: tasks.length,
          tasks: tasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            priority: t.priority,
            due: t.dueAt ? fmt.format(t.dueAt) : "no date",
            overdue: !!t.dueAt && t.dueAt < now && t.status !== "DONE",
            assignees: t.assignments.map((a) => a.user.name ?? "someone"),
          })),
        };
      },
    }),

    workloadSummary: tool({
      description:
        "Counts of open, overdue, due-today and completed tasks. Use for 'how am I doing' style questions.",
      inputSchema: z.object({
        scope: z.enum(["me", "everyone"]).describe("Whose workload to summarise"),
      }),
      execute: async ({ scope }) => {
        const base = await buildTaskScope(ctx.orgId, ctx.userId, ctx.permissions);
        const mine =
          scope === "me"
            ? { ...base, assignments: { some: { userId: ctx.userId } } }
            : base;

        const now = new Date();
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
        const weekAgo = new Date(now);
        weekAgo.setDate(weekAgo.getDate() - 7);

        const [open, overdue, dueToday, completedWeek] = await Promise.all([
          prisma.task.count({
            where: { ...mine, status: { notIn: ["DONE", "CANCELLED"] } },
          }),
          prisma.task.count({
            where: { ...mine, dueAt: { lt: now }, status: { notIn: ["DONE", "CANCELLED"] } },
          }),
          prisma.task.count({
            where: {
              ...mine,
              dueAt: { gte: now, lte: endOfDay },
              status: { notIn: ["DONE", "CANCELLED"] },
            },
          }),
          prisma.task.count({
            where: { ...mine, status: "DONE", completedAt: { gte: weekAgo } },
          }),
        ]);

        return { scope, open, overdue, dueToday, completedThisWeek: completedWeek };
      },
    }),

    upcomingEvents: tool({
      description: "Calendar events coming up in the next N days.",
      inputSchema: z.object({
        days: z.number().describe("How many days ahead to look, 1 to 30"),
      }),
      execute: async ({ days }) => {
        const calendarIds = await getVisibleCalendarIds(
          ctx.orgId,
          ctx.userId,
          ctx.permissions
        );
        if (calendarIds.length === 0) return { count: 0, events: [] };

        const now = new Date();
        const until = new Date(now);
        until.setDate(until.getDate() + Math.min(Math.max(days, 1), 30));

        const events = await prisma.calendarEvent.findMany({
          where: {
            organizationId: ctx.orgId,
            calendarId: { in: calendarIds },
            deletedAt: null,
            startAt: { gte: now, lte: until },
            // Every calendar is visible to everyone now, but "my upcoming
            // events" means the ones on this person's day, not the workspace's.
            ...eventsInvolving([ctx.userId]),
          },
          orderBy: { startAt: "asc" },
          take: 30,
        });

        return {
          count: events.length,
          events: events.map((e) => ({
            title: e.title,
            when: fmt.format(e.startAt),
            location: e.location ?? "",
          })),
        };
      },
    }),

    listMembers: tool({
      description: "Active people in this workspace, with their IDs for assignment.",
      inputSchema: z.object({}),
      execute: async () => {
        const members = await prisma.organizationMember.findMany({
          where: { organizationId: ctx.orgId, status: "ACTIVE" },
          include: {
            user: { select: { id: true, name: true } },
            role: { select: { name: true } },
          },
        });
        return members.map((m) => ({
          userId: m.userId,
          name: m.user.name ?? "Unnamed",
          role: m.role.name,
        }));
      },
    }),

    proposeCreateTask: tool({
      description:
        "Propose creating a task. This does NOT create it. The user must confirm. Call listMembers first if assigning to someone.",
      inputSchema: z.object({
        title: z.string(),
        description: z.string().describe("Empty string if none"),
        priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
        dueAt: z.string().describe("ISO 8601 datetime, or empty string for no due date"),
        assigneeIds: z.array(z.string()).describe("User IDs. Empty means the current user."),
        summary: z.string().describe("One plain sentence describing what will happen"),
      }),
      execute: async (args) => {
        const proposal: Proposal = { kind: "create_task", ...args };
        return { proposed: true, proposal };
      },
    }),

    proposeUpdateTasks: tool({
      description:
        "Propose changing status, priority or due date on tasks. Does NOT apply. The user confirms. Use searchTasks first to get the IDs.",
      inputSchema: z.object({
        taskIds: z.array(z.string()).describe("IDs from searchTasks"),
        status: z
          .string()
          .describe("New status, or empty string to leave unchanged"),
        priority: z
          .string()
          .describe("New priority, or empty string to leave unchanged"),
        dueAt: z
          .string()
          .describe("New ISO 8601 due date, or empty string to leave unchanged"),
        summary: z.string().describe("One plain sentence describing the change"),
      }),
      execute: async (args) => {
        const proposal: Proposal = { kind: "update_tasks", ...args };
        return { proposed: true, proposal };
      },
    }),
  };
}