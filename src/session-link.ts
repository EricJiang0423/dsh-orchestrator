/**
 * Issues, the sessions that work them, and the scheduler that keeps N running.
 *
 * Three decisions shape this module, and they are the difference between a board
 * that displays work and one that runs it:
 *
 * **A board belongs to a workspace, not a conversation.** The board surface is
 * session-scoped because it renders as a conversation view, but what it shows is
 * resolved from that session's working directory: same repository, same board.
 * Two sessions in one repo share a board; a session in another repo gets its own.
 *
 * **Every issue gets its own session.** Handing an issue to whatever conversation
 * happened to be open mixes unrelated work into one context and makes "what did
 * this issue cost" unanswerable. A fresh session per issue keeps each one's
 * history and transcript its own, and it is what lets several run at once.
 *
 * **The scheduler pulls, it does not push.** It keeps at most `concurrency`
 * issues in flight and takes the next one only when a slot frees. It cannot
 * widen the human fences: it draws exclusively from `todo`, which only a human
 * can put an issue into.
 * @module dsh-orchestrator/session-link
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-workspace'
import { LOCAL_USER } from './actors.ts'
import { byPriority } from './plan-loop.ts'
import { TaskboardError, type Taskboard } from './service.ts'
import type { Project, Task } from './domain.ts'

/** What the model is told when an issue is handed to a fresh session. */
function briefFor(task: Task): string {
  return [
    `You are working board issue ${task.id}: **${task.title}**`,
    task.description.trim() === '' ? '' : `\n${task.description.trim()}`,
    '',
    'This session exists for this issue alone, and the issue is now in_progress.',
    'Follow the manage-taskboard skill: comment as you go, move it to in_review when the',
    'work is done and verified, and use taskboard_propose for anything else you find',
    'rather than widening this issue. You cannot mark it done — a human accepts the work.',
  ].filter(Boolean).join('\n')
}

/**
 * The board a session should be looking at.
 *
 * Resolution is by directory: the session's `cwd` identifies the workspace, and
 * the workspace identifies the board. The main conversation lives in the
 * session store; a spawned issue session lives in the agent registry — either
 * one carries the cwd that says which repository this board belongs to. A
 * session with no cwd, or a harness with no workspace registry, falls back to a
 * default board so the surface still works rather than rendering empty.
 * @param ctx - Context; `sessions` and `agents` are read optionally.
 * @param board - The board service.
 * @param sessionId - The viewing session.
 * @returns the project this session's work belongs to.
 */
export async function resolveProject(
  ctx: Context,
  board: Taskboard,
  sessionId: string,
): Promise<Project> {
  const sid = SessionId(sessionId)
  const cwd = ctx.reflect.get('sessions')?.get(sid)?.header.cwd
    ?? ctx.reflect.get('agents')?.get(sid)?.session.header.cwd
  // Non-strict: the workspace registry's providing fiber can sit outside the
  // active tree (lazy/optional mounts), and this is a read-only consultation —
  // a moment of staleness during teardown is harmless.
  const workspaces = ctx.reflect.get('workspaceRegistry', false)
  if (cwd !== undefined && workspaces !== undefined) {
    const workspace = await workspaces.resolveByPath(cwd).catch(() => undefined)
      ?? await workspaces.create(cwd).catch(() => undefined)
    if (workspace !== undefined) {
      return board.projectForWorkspace(workspace.id, workspace.path, workspace.title)
    }
  }
  return board.getProject('default') ?? board.createProject({ id: 'default', name: 'Tasks' })
}

/**
 * Open a fresh session for one issue and hand it the work.
 *
 * The actor is the local user: starting work is a human act, or the scheduler
 * acting on a `todo` state only a human can set. That distinction is what the
 * status fences rest on.
 * @param ctx - Context with `agents`.
 * @param board - The board service.
 * @param taskId - Issue to start.
 * @returns the updated issue, now bound to its own session.
 */
export async function startTask(ctx: Context, board: Taskboard, taskId: string): Promise<Task> {
  const agents = ctx.reflect.get('agents')
  if (agents === undefined) throw new TaskboardError('not-found', 'no agent registry in this profile')

  const current = board.getTask(taskId)
  if (current === undefined) throw new TaskboardError('not-found', `task "${taskId}" does not exist`)
  // A live session already owns this issue; do not open a second one for it.
  if (current.sessionId !== undefined && agents.get(SessionId(current.sessionId)) !== undefined) {
    return current
  }

  // The issue's own project decides where its session runs, so work lands in the
  // repository the board belongs to. The session also inherits the harness's
  // default model selection (provider + model from `agent-default-model`
  // settings) — without it, prompt assembly fails on the `{{model}}` variable —
  // and the default agent preset, which is what gives the session its working
  // tool kit (file tools, shell, skills). A preset-less session would be a
  // board-only agent that can look at issues but not do the work.
  const cwd = board.getProject(current.projectId)?.workspacePath
  const selection = ctx.reflect.get('agentDefaultModel', false)?.currentSelection?.()
  const presets = ctx.reflect.get('agentPresets', false)
  const preset = await presets?.resolve().catch(() => undefined)
  const handle = await agents.create({
    sessionId: SessionId(crypto.randomUUID()),
    meta: {
      ...(cwd !== undefined ? { cwd } : {}),
      ...(preset !== undefined ? { agentPreset: preset.id } : {}),
    },
    ...(selection !== undefined
      ? { agentOptions: { provider: selection.provider, model: selection.model } }
      : {}),
    // The registry factory does NOT join presets by itself — the web layer
    // does it in its own setup wrapper. Without the join, the session's tool
    // registry holds only the board tools: the agent can see the issue but
    // cannot read a file or run a shell. Mount inside setup, where a broken
    // preset rolls the whole creation back.
    ...(presets !== undefined && preset !== undefined ? {
      // Void-returning on purpose: a returned value is treated as an
      // AgentSetupCommit, and a preset object has no `commit()`.
      setup: async (agentCtx: Context) => {
        await presets.mount(agentCtx, preset.id)
      },
    } : {}),
  })
  const agent: Agent = handle.agent

  const task = await board.updateTask(taskId, {
    sessionId: agent.id,
    ...(current.status === 'in_progress' ? {} : { status: 'in_progress' }),
  }, { actor: LOCAL_USER, expectedVersion: current.version })

  await board.record(taskId, 'session', LOCAL_USER, { sessionId: agent.id })

  // The goal service is the harness's own "what is this session for" state.
  // Optional: a composition without it still binds and still works the issue.
  try {
    ctx.reflect.get('goals')?.create(agent, { objective: `Board issue ${task.id}: ${task.title}` })
  } catch (error) {
    ctx.logger.warn('taskboard: could not set the session goal', error)
  }

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: briefFor(task) }],
    source: { kind: 'user' },
  }))

  return task
}

/**
 * Start the next issue the board would pick itself.
 *
 * `todo` only, highest priority first. `backlog` is not scheduled and `proposed`
 * is not work yet — reaching into either would defeat the queue that makes the
 * approval fence meaningful.
 * @param ctx - Context with `agents`.
 * @param board - The board service.
 * @param projectId - Optional project to draw from.
 * @returns the issue that was started, or null when nothing is eligible.
 */
export async function startNextTask(
  ctx: Context,
  board: Taskboard,
  projectId?: string,
): Promise<Task | null> {
  const [next] = board
    .listTasks({ ...(projectId !== undefined ? { projectId } : {}), status: 'todo' })
    .sort(byPriority)
  if (next === undefined) return null
  return startTask(ctx, board, next.id)
}

/** How many issues may run at once, and whether the board fills those slots itself. */
export interface SchedulerConfig {
  /** Issues allowed in flight at the same time. */
  concurrency?: number
  /** Whether the board pulls from `todo` on its own. */
  autoPull?: boolean
  /** Safety-net sweep interval in milliseconds. */
  sweepIntervalMs?: number
}

/** Live scheduler state, surfaced to the board so a human can see and change it. */
export interface SchedulerState {
  concurrency: number
  autoPull: boolean
  /** Issues currently in flight with a live session. */
  running: number
  /** Issues eligible to be picked up. */
  waiting: number
}

/**
 * Keeps up to `concurrency` issues running, refilling from `todo`.
 *
 * A slot is occupied by an `in_progress` issue whose bound session is still
 * live. A session that has gone away frees its slot even though the issue is
 * still `in_progress`, so a closed or crashed session cannot wedge the queue.
 *
 * It reacts to board changes rather than polling hard, with a slow sweep as the
 * safety net for transitions that produce no board write — a session
 * disappearing, most of all.
 */
export class Scheduler {
  private concurrency: number
  private autoPull: boolean
  private pumping = false
  /** A human has configured since mount; a slow restore must not overwrite it. */
  private dirty = false

  /**
   * @param ctx - Context with `taskboard`; `agents` is read optionally.
   * @param config - Initial limits.
   */
  constructor(private readonly ctx: Context, config: SchedulerConfig = {}) {
    this.concurrency = Math.max(1, config.concurrency ?? 1)
    // Pulling is the point of the orchestrator: out of the box it works the
    // todo queue by itself. The board bar shows the toggle, so turning it off
    // is one click — but nothing starts until the first trigger (a board
    // change, a configure call, or the safety-net sweep).
    this.autoPull = config.autoPull ?? true
  }

  /**
   * Current limits and queue depth.
   * @param projectId - Scope the waiting count to one board's todo.
   * @returns the state a UI renders.
   */
  state(projectId?: string): SchedulerState {
    return {
      concurrency: this.concurrency,
      autoPull: this.autoPull,
      // Slots are global — an in-flight issue holds one whether or not this
      // board can see it — so running is never project-scoped.
      running: this.runningCount(),
      waiting: this.ctx.taskboard
        .listTasks({ status: 'todo', ...(projectId !== undefined ? { projectId } : {}) })
        .length,
    }
  }

  /**
   * Change the limits, act on them immediately, and persist the new values so
   * the switches stay where a human left them across restarts.
   * @param next - Fields to change.
   * @returns the resulting state.
   */
  configure(next: SchedulerConfig): SchedulerState {
    this.apply(next, true)
    void this.pump()
    return this.state()
  }

  /**
   * Apply stored preferences from a previous run, if any.
   *
   * Mount-time only: once a human has configured (or a configure raced ahead
   * of the storage read), the stored row is left alone.
   * @returns resolution once the stored row has been applied.
   */
  async restore(): Promise<void> {
    if (this.dirty) return
    const stored = await this.ctx.taskboard.getSchedulerSettings().catch(() => undefined)
    if (stored === undefined || this.dirty) return
    this.apply({ concurrency: stored.concurrency, autoPull: stored.autoPull }, false)
  }

  /**
   * Set the knobs; optionally persist them.
   * @param next - Fields to change.
   * @param persist - Whether to write the row for the next mount.
   */
  private apply(next: SchedulerConfig, persist: boolean): void {
    if (next.concurrency !== undefined) {
      if (!Number.isSafeInteger(next.concurrency) || next.concurrency < 1) {
        throw new TaskboardError('invalid-input', 'concurrency must be a positive integer')
      }
      this.concurrency = next.concurrency
    }
    if (next.autoPull !== undefined) this.autoPull = next.autoPull
    this.dirty = true
    if (persist) {
      void this.ctx.taskboard.setSchedulerSettings({
        concurrency: this.concurrency,
        autoPull: this.autoPull,
      }).catch((error: unknown) => {
        this.ctx.logger.warn('taskboard: could not persist scheduler settings', error)
      })
    }
  }

  /**
   * Issues holding a slot: `in_progress` AND still owned by a live session.
   *
   * Checking the session rather than trusting the status is what stops a dead
   * session from holding a slot forever.
   * @returns the occupied slot count.
   */
  private runningCount(): number {
    const agents = this.ctx.reflect.get('agents')
    return this.ctx.taskboard.listTasks({ status: 'in_progress' })
      .filter(task => task.sessionId !== undefined
        && agents?.get(SessionId(task.sessionId)) !== undefined)
      .length
  }

  /**
   * Fill free slots from `todo`, one issue at a time.
   *
   * Re-entrancy is guarded rather than queued: a concurrent trigger mid-pump
   * would double-count free slots and start the same issue twice.
   * @returns resolution once no further slot can be filled.
   */
  async pump(): Promise<void> {
    if (!this.autoPull || this.pumping) return
    this.pumping = true
    try {
      while (this.runningCount() < this.concurrency) {
        const started = await startNextTask(this.ctx, this.ctx.taskboard)
        if (started === null) return
        this.ctx.logger.info(`taskboard: picked up "${started.title}" (${started.id})`)
      }
    } catch (error) {
      // A failed pickup must not kill the scheduler; the next trigger retries.
      this.ctx.logger.warn('taskboard: scheduler could not start the next issue', error)
    } finally {
      this.pumping = false
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    taskboardScheduler: Scheduler
  }
}

/**
 * Mount the scheduler and the issue↔session trail.
 * @param ctx - Context with `taskboard` and `agents`.
 * @param config - Initial scheduler limits.
 */
export function applySessionLink(ctx: Context, config: SchedulerConfig = {}): void {
  const board = ctx.taskboard
  const scheduler = new Scheduler(ctx, config)
  ctx.effect(() => ctx.reflect.provide('taskboardScheduler', scheduler), 'taskboard: scheduler')

  // The board header's switches persist; bring the last run's knobs back and
  // let the restored settings take effect (the stored row wins over the
  // plugin defaults, and a configure that raced ahead of the read wins over
  // the stored row).
  ctx.effect(() => {
    void scheduler.restore().then(() => { void scheduler.pump() })
    return () => {}
  }, 'taskboard: scheduler restore')

  // A board write is the usual reason a slot frees or a new issue becomes
  // eligible, so it is the primary trigger.
  ctx.effect(() => ctx.on('domain/changed', change => {
    if (change.domain === 'taskboard' && change.table === 'tasks') void scheduler.pump()
  }), 'taskboard: scheduler trigger')

  // Safety net for transitions that write nothing to the board — chiefly a
  // session going away, which frees a slot silently.
  ctx.effect(() => {
    const timer = setInterval(() => { void scheduler.pump() }, config.sweepIntervalMs ?? 30_000)
    return () => { clearInterval(timer) }
  }, 'taskboard: scheduler sweep')

  // Durable evidence that a bound session is doing work, so an issue sitting in
  // `in_progress` can be told apart from a stalled one without polling.
  ctx.effect(() => ctx.on('agent/turn-stopping', ({ agent }) => {
    for (const task of board.listTasks({ sessionId: agent.id, status: 'in_progress' })) {
      void board.record(task.id, 'turn', { type: 'agent', id: agent.id, name: 'agent' })
        .catch((error: unknown) => { ctx.logger.warn(error) })
    }
  }), 'taskboard: turn trail')
}
