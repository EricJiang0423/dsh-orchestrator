/**
 * Board data model: one storage domain with four tables.
 *
 * Ported from dashi-taskboard's `shared/domain.mjs` and its hand-written SQLite
 * schema (40+ ALTER statements) onto `ctx.storageDomain`, which validates every
 * record at the durable boundary and serves reads synchronously from memory.
 *
 * The one addition to the original vocabulary is the `proposed` status: the
 * intake column for issues an agent asked for but a human has not accepted.
 * @module dsh-orchestrator/domain
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Branded record keys — plain strings on the medium, distinct at compile time. */
export type ProjectId = string & { readonly __brand: 'ProjectId' }
export type TaskId = string & { readonly __brand: 'TaskId' }
export type CommentId = string & { readonly __brand: 'CommentId' }
export type ActivityId = string & { readonly __brand: 'ActivityId' }
export type SettingsKey = string & { readonly __brand: 'SettingsKey' }

/** The one settings record key: the scheduler's durable knobs. */
export const SCHEDULER_SETTINGS_KEY = 'scheduler' as SettingsKey

/**
 * Board columns, in flow order.
 *
 * `proposed` is the approval queue: an agent-proposed issue lands here and does
 * NOT participate in any automatic flow. Only a human moves it out — see
 * {@link canTransition}.
 */
export const TASK_STATUSES = [
  'proposed',
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'canceled',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Priority ladder, unchanged from the original board. */
export const TASK_PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

/** Who did something: a human at the keyboard or an agent acting on its own. */
export const ACTOR_TYPES = ['user', 'agent'] as const
export type ActorType = (typeof ACTOR_TYPES)[number]

/** Cross-issue links, kept on the task rather than in their own table. */
export const RELATION_TYPES = ['blocks', 'blocked_by', 'relates_to', 'duplicates'] as const

const actorSchema = z.object({
  type: z.enum(ACTOR_TYPES),
  id: z.string(),
  name: z.string(),
})
/** Attribution carried on tasks and comments. */
export type Actor = z.infer<typeof actorSchema>

const relationSchema = z.object({
  type: z.enum(RELATION_TYPES),
  targetId: z.string(),
})

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Absolute path of the repository this project's work happens in. */
  workspacePath: z.string().optional(),
  /**
   * The dsh workspace this board belongs to.
   *
   * One board per project, not per conversation: a workspace is the repository
   * you are working in, so binding the board to it is what makes the board
   * outlive any single session and keeps two repositories' issues apart.
   */
  workspaceId: z.string().optional(),
  labels: z.array(z.string()).default([]),
  createdAt: z.string(),
})
/** A board: one project's issues, bound to the workspace that project lives in. */
export type Project = z.infer<typeof projectSchema>

const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  description: z.string().default(''),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES).default('none'),
  labels: z.array(z.string()).default([]),
  assignee: actorSchema.optional(),
  creator: actorSchema,
  /** Lexical rank within a column; ties break on id. */
  sortKey: z.string(),
  dueDate: z.string().optional(),
  startDate: z.string().optional(),
  relations: z.array(relationSchema).default([]),
  /**
   * Optimistic concurrency counter. A writer states the version it read; a
   * mismatch rejects instead of overwriting. This is NOT a database
   * transaction — see README's Known Limitations.
   */
  version: z.number().int().nonnegative(),
  /** The dsh session doing this issue's work, once one is bound (Phase 4). */
  sessionId: z.string().optional(),
  /** Whether a human or an agent asked for this issue to exist. */
  origin: z.enum(ACTOR_TYPES).default('user'),
  /** Which agent proposed it, and on which planning round. */
  proposedBy: z.object({ agent: z.string(), round: z.number().int().optional() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
/** One issue on the board. */
export type Task = z.infer<typeof taskSchema>

const commentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  author: actorSchema,
  body: z.string(),
  createdAt: z.string(),
})
/** A note on an issue, from a human or an agent. */
export type Comment = z.infer<typeof commentSchema>

const activitySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  /** What happened: `status`, `proposed`, `approved`, `rejected`, `session`, … */
  kind: z.string(),
  actor: actorSchema,
  detail: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
})
/** An append-only audit row: who changed what, when. */
export type Activity = z.infer<typeof activitySchema>

const schedulerSettingsSchema = z.object({
  /** How many issues may run at once. */
  concurrency: z.number().int().positive(),
  /** Whether the board pulls from `todo` on its own. */
  autoPull: z.boolean(),
  updatedAt: z.string(),
})
/** Durable scheduler preferences — what the board header switches persist. */
export type SchedulerSettings = z.infer<typeof schedulerSettingsSchema>

/** The board's storage domain: five tables under one write chain. */
export const taskboardDomain = defineDomain({
  name: 'taskboard',
  version: 1,
  tables: {
    projects: domainTable<ProjectId, Project>(projectSchema),
    tasks: domainTable<TaskId, Task>(taskSchema),
    comments: domainTable<CommentId, Comment>(commentSchema),
    activities: domainTable<ActivityId, Activity>(activitySchema),
    settings: domainTable<SettingsKey, SchedulerSettings>(schedulerSettingsSchema),
  },
})

/**
 * Whether a status change is allowed for this actor.
 *
 * The board is deliberately permissive — a human drags a card anywhere — with
 * exactly two hard fences, both about not letting an agent grant itself work or
 * declare its own work accepted:
 *
 * 1. Leaving `proposed` is a human act. That is what makes the approval queue a
 *    queue rather than a formality, and it is the durable half of the approval
 *    design (dsh's own one-shot `ctx.approval` only works inside an open turn).
 * 2. Reaching `done` is a human act. An agent reports work finished by moving to
 *    `in_review`; acceptance is not its call.
 * @param from - Current status.
 * @param to - Requested status.
 * @param actor - Who is asking.
 * @returns whether the move is permitted.
 */
export function canTransition(from: TaskStatus, to: TaskStatus, actor: ActorType): boolean {
  if (from === to) return true
  // Nothing moves back into the approval queue; `proposed` is an intake state.
  if (to === 'proposed') return false
  if (from === 'proposed') return actor === 'user' && (to === 'backlog' || to === 'canceled')
  if (to === 'done') return actor === 'user'
  return true
}

/** Narrow an arbitrary string to a board status. @param value - Candidate. @returns whether it is one. */
export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value)
}

/** Narrow an arbitrary string to a priority. @param value - Candidate. @returns whether it is one. */
export function isTaskPriority(value: string): value is TaskPriority {
  return (TASK_PRIORITIES as readonly string[]).includes(value)
}
