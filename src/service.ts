/**
 * `ctx.taskboard` — the board service every other half of this plugin talks to:
 * the RPC routes, the model-facing tools, and the planning loop.
 *
 * Reads are synchronous (the domain serves authoritative in-memory state);
 * writes queue on the domain's single write chain, reach the backend first, and
 * only then touch memory. Ordering and filtering happen here in memory because
 * the domain layer has no secondary indexes — fine at local-board scale, called
 * out in the README.
 * @module dsh-orchestrator/service
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-storage-domain'
import {
  canTransition,
  taskboardDomain,
  SCHEDULER_SETTINGS_KEY,
  type Activity,
  type ActivityId,
  type Actor,
  type Comment,
  type CommentId,
  type Project,
  type ProjectId,
  type SchedulerSettings,
  type SettingsKey,
  type Task,
  type TaskId,
  type TaskStatus,
} from './domain.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    taskboard: Taskboard
  }
}

/** Why a board write was refused. */
export type TaskboardErrorCode =
  | 'not-found'
  | 'version-conflict'
  | 'forbidden-transition'
  | 'invalid-input'

/** A refused board write. Carries a code the RPC and tool layers map to their own shapes. */
export class TaskboardError extends Error {
  /**
   * @param code - Machine-readable reason.
   * @param message - Human-readable detail.
   */
  constructor(readonly code: TaskboardErrorCode, message: string) {
    super(message)
    this.name = 'TaskboardError'
  }
}

/** Filter for {@link Taskboard.listTasks}; omitted fields do not constrain. */
export interface TaskFilter {
  projectId?: string
  status?: TaskStatus | readonly TaskStatus[]
  /** Only issues bound to this dsh session. */
  sessionId?: string
}

/** Fields a caller may set when creating an issue. */
export interface CreateTaskInput {
  projectId: string
  title: string
  description?: string
  status?: TaskStatus
  priority?: Task['priority']
  labels?: string[]
  assignee?: Actor
  dueDate?: string
  startDate?: string
  origin?: Task['origin']
  proposedBy?: Task['proposedBy']
}

/** Fields a caller may change on an issue. `version` is managed, not patched. */
export type UpdateTaskPatch = Partial<
  Pick<
    Task,
    | 'title'
    | 'description'
    | 'status'
    | 'priority'
    | 'labels'
    | 'assignee'
    | 'dueDate'
    | 'startDate'
    | 'relations'
    | 'sessionId'
    | 'sortKey'
  >
>

/** Gap between adjacent sort keys handed out for appends. */
const SORT_STEP = 1024

/**
 * Task fields a patch may clear (set to undefined/null); the rest must stay
 * set, so a null/undefined for them is dropped instead of persisted — the
 * domain validates every record at open, and a required field missing from a
 * stored record would take the whole board down on the next boot.
 */
const CLEARABLE_TASK_FIELDS = new Set([
  'description',
  'priority',
  'labels',
  'assignee',
  'dueDate',
  'startDate',
  'relations',
  'sessionId',
  'proposedBy',
  'origin',
])

/**
 * The board.
 *
 * Opens its domain in {@link Service.init} and closes it through a `ctx.effect`
 * disposer, so unloading the plugin releases the backend unit.
 */
export class Taskboard extends Service {
  static inject = ['storageDomain']

  private projects!: KvTable<ProjectId, Project>
  private tasks!: KvTable<TaskId, Task>
  private comments!: KvTable<CommentId, Comment>
  private activities!: KvTable<ActivityId, Activity>
  private settings!: KvTable<SettingsKey, SchedulerSettings>

  /** @param ctx - Plugin context carrying the domain facility. */
  constructor(ctx: Context) {
    super(ctx, 'taskboard')
  }

  /** Open the board domain and bind its five table handles. */
  async [Service.init](): Promise<void> {
    const domain: Domain<typeof taskboardDomain> = await this.ctx.storageDomain.open(taskboardDomain)
    this.ctx.effect(() => () => void domain.close(), 'taskboard: domain close')
    this.projects = domain.table('projects')
    this.tasks = domain.table('tasks')
    this.comments = domain.table('comments')
    this.activities = domain.table('activities')
    this.settings = domain.table('settings')
  }

  // ── projects ──────────────────────────────────────────────────────────────

  /** Every project, newest first. @returns the project list. */
  listProjects(): Project[] {
    return [...this.projects.entries()]
      .map(([, project]) => project)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** One project. @param id - Project id. @returns the project, or undefined. */
  getProject(id: string): Project | undefined {
    return this.projects.get(id as ProjectId)
  }

  /**
   * Create a project.
   * @param input - Identity and optional workspace path.
   * @returns the stored project.
   */
  async createProject(input: {
    id?: string
    name: string
    workspacePath?: string
    workspaceId?: string
  }): Promise<Project> {
    if (input.name.trim() === '') throw new TaskboardError('invalid-input', 'project name is empty')
    const id = (input.id ?? crypto.randomUUID()) as ProjectId
    if (this.projects.get(id) !== undefined) {
      throw new TaskboardError('invalid-input', `project "${id}" already exists`)
    }
    const project: Project = {
      id,
      name: input.name,
      ...(input.workspacePath !== undefined ? { workspacePath: input.workspacePath } : {}),
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      labels: [],
      createdAt: new Date().toISOString(),
    }
    await this.projects.put(id, project)
    return project
  }

  /**
   * The board for one workspace, created on first sight.
   *
   * A board belongs to a repository, not to a conversation, so this is the
   * lookup every session-scoped surface goes through: two sessions in the same
   * workspace see one board, and a session in another workspace sees a
   * different one.
   * @param workspaceId - Workspace id.
   * @param path - Workspace directory, stored so a per-issue session can be
   *   created with the right cwd.
   * @param title - Display title used only when the board is created.
   * @returns the existing or newly created project.
   */
  async projectForWorkspace(workspaceId: string, path: string, title: string): Promise<Project> {
    const existing = this.listProjects().find(project => project.workspaceId === workspaceId)
    if (existing !== undefined) return existing
    return this.createProject({ name: title, workspacePath: path, workspaceId })
  }

  // ── settings ───────────────────────────────────────────────────────────────

  /**
   * The stored scheduler preferences, if any have been saved yet.
   *
   * Absence means "nobody has touched the switches" — the caller keeps its own
   * defaults rather than treating a missing row as a reset to defaults.
   * @returns the stored record, or undefined on first run.
   */
  async getSchedulerSettings(): Promise<SchedulerSettings | undefined> {
    return this.settings.get(SCHEDULER_SETTINGS_KEY)
  }

  /**
   * Persist scheduler preferences so the board header's switches survive
   * restarts. A later write wins; there is no version fence on a two-knob
   * settings row written by one human.
   * @param patch - Fields to change; omitted fields keep their stored value.
   * @returns the stored record.
   */
  async setSchedulerSettings(patch: { concurrency?: number; autoPull?: boolean }): Promise<SchedulerSettings> {
    const current = await this.settings.get(SCHEDULER_SETTINGS_KEY)
    const next: SchedulerSettings = {
      concurrency: patch.concurrency ?? current?.concurrency ?? 1,
      autoPull: patch.autoPull ?? current?.autoPull ?? true,
      updatedAt: new Date().toISOString(),
    }
    await this.settings.put(SCHEDULER_SETTINGS_KEY as SettingsKey, next)
    return next
  }

  // ── tasks ─────────────────────────────────────────────────────────────────

  /**
   * Issues matching a filter, ordered by status then sort key.
   * @param filter - Optional constraints; omitted fields do not constrain.
   * @returns the matching issues.
   */
  listTasks(filter: TaskFilter = {}): Task[] {
    const statuses = filter.status === undefined
      ? undefined
      : new Set(typeof filter.status === 'string' ? [filter.status] : filter.status)
    return [...this.tasks.entries()]
      .map(([, task]) => task)
      .filter(task => (filter.projectId === undefined || task.projectId === filter.projectId)
        && (statuses === undefined || statuses.has(task.status))
        && (filter.sessionId === undefined || task.sessionId === filter.sessionId))
      .sort((a, b) => (Number(a.sortKey) - Number(b.sortKey)) || a.id.localeCompare(b.id))
  }

  /** One issue. @param id - Task id. @returns the issue, or undefined. */
  getTask(id: string): Task | undefined {
    return this.tasks.get(id as TaskId)
  }

  /**
   * Create an issue and record who asked for it.
   * @param input - Issue fields; `status` defaults to `backlog`.
   * @param creator - Who is creating it.
   * @returns the stored issue.
   */
  async createTask(input: CreateTaskInput, creator: Actor): Promise<Task> {
    if (input.title.trim() === '') throw new TaskboardError('invalid-input', 'task title is empty')
    if (this.projects.get(input.projectId as ProjectId) === undefined) {
      throw new TaskboardError('not-found', `project "${input.projectId}" does not exist`)
    }
    const now = new Date().toISOString()
    const id = crypto.randomUUID() as TaskId
    const task: Task = {
      id,
      projectId: input.projectId,
      title: input.title,
      description: input.description ?? '',
      status: input.status ?? 'backlog',
      priority: input.priority ?? 'none',
      labels: input.labels ?? [],
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      creator,
      sortKey: this.nextSortKey(),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      relations: [],
      version: 0,
      origin: input.origin ?? creator.type,
      ...(input.proposedBy !== undefined ? { proposedBy: input.proposedBy } : {}),
      createdAt: now,
      updatedAt: now,
    }
    await this.tasks.put(id, task)
    await this.record(id, task.status === 'proposed' ? 'proposed' : 'created', creator, { title: task.title })
    return task
  }

  /**
   * Change an issue, refusing stale writes and forbidden status moves.
   *
   * The compare-and-set runs inside the domain's atomic `update`, so the version
   * a caller states is checked against the value current at its slot on the
   * write chain — concurrent updates cannot interleave past each other.
   * @param id - Task id.
   * @param patch - Fields to change.
   * @param opts - Who is writing, and which version they read.
   * @returns the stored issue.
   */
  async updateTask(
    id: string,
    patch: UpdateTaskPatch,
    opts: { actor: Actor; expectedVersion?: number },
  ): Promise<Task> {
    const before = this.tasks.get(id as TaskId)
    if (before === undefined) throw new TaskboardError('not-found', `task "${id}" does not exist`)
    if (patch.status !== undefined && !canTransition(before.status, patch.status, opts.actor.type)) {
      throw new TaskboardError(
        'forbidden-transition',
        `${opts.actor.type} may not move "${before.status}" to "${patch.status}"`,
      )
    }

    // `null` must never reach the medium: the domain rejects it at open
    // (`invalid-record`), which would take the whole board down on the next
    // boot. `undefined` is the "clear this optional field" spelling — JSON
    // serialization drops it — so normalize null to undefined here, the one
    // choke point every caller passes through. Clearing a REQUIRED field is a
    // caller bug and is refused the same way (dropped from the patch).
    const cleaned = {} as UpdateTaskPatch
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) {
        if (CLEARABLE_TASK_FIELDS.has(key)) (cleaned as Record<string, unknown>)[key] = undefined
        continue
      }
      (cleaned as Record<string, unknown>)[key] = value
    }

    const next = await this.tasks.update(id as TaskId, current => {
      if (opts.expectedVersion !== undefined && current.version !== opts.expectedVersion) {
        throw new TaskboardError(
          'version-conflict',
          `task "${id}" is at version ${current.version}, not ${opts.expectedVersion}`,
        )
      }
      return { ...current, ...cleaned, version: current.version + 1, updatedAt: new Date().toISOString() }
    })

    if (patch.status !== undefined && patch.status !== before.status) {
      await this.record(id as TaskId, 'status', opts.actor, { from: before.status, to: patch.status })
    }
    return next
  }

  // ── comments and activity ─────────────────────────────────────────────────

  /** Comments on an issue, oldest first. @param taskId - Task id. @returns the comments. */
  listComments(taskId: string): Comment[] {
    return [...this.comments.entries()]
      .map(([, comment]) => comment)
      .filter(comment => comment.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * Add a comment.
   * @param taskId - Task id.
   * @param body - Comment text.
   * @param author - Who wrote it.
   * @returns the stored comment.
   */
  async addComment(taskId: string, body: string, author: Actor): Promise<Comment> {
    if (this.tasks.get(taskId as TaskId) === undefined) {
      throw new TaskboardError('not-found', `task "${taskId}" does not exist`)
    }
    const comment: Comment = {
      id: crypto.randomUUID(),
      taskId,
      author,
      body,
      createdAt: new Date().toISOString(),
    }
    await this.comments.put(comment.id as CommentId, comment)
    return comment
  }

  /** Audit rows for an issue, oldest first. @param taskId - Task id. @returns the activity. */
  listActivity(taskId: string): Activity[] {
    return [...this.activities.entries()]
      .map(([, activity]) => activity)
      .filter(activity => activity.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * Append one audit row.
   * @param taskId - Task the row belongs to.
   * @param kind - What happened.
   * @param actor - Who did it.
   * @param detail - Free-form payload.
   * @returns resolution after durability.
   */
  async record(
    taskId: string,
    kind: string,
    actor: Actor,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const activity: Activity = {
      id: crypto.randomUUID(),
      taskId,
      kind,
      actor,
      detail,
      createdAt: new Date().toISOString(),
    }
    await this.activities.put(activity.id as ActivityId, activity)
  }

  /**
   * Sort key for an append at the end of the board.
   *
   * ponytail: numeric-string ranks with midpoint inserts on reorder. ~50
   * consecutive midpoint inserts between the same pair exhaust float precision;
   * swap in fractional indexing (LexoRank-style strings) if that ever bites.
   * @returns the next key.
   */
  private nextSortKey(): string {
    let max = 0
    for (const [, task] of this.tasks.entries()) max = Math.max(max, Number(task.sortKey) || 0)
    return String(max + SORT_STEP)
  }
}
