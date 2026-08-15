/**
 * Model-facing board tools.
 *
 * These replace dashi-taskboard's `taskctl` CLI outright: the original taught an
 * agent to shell out to a binary that spoke HTTP to a second server, where dsh
 * lets the same capability be five registered tools whose schemas join prompt
 * assembly automatically.
 *
 * There is deliberately NO `taskboard_create`. An agent may only
 * {@link https://example.invalid | propose}; creating work outright is a human
 * act. That fence and the `done` fence in `canTransition` are the whole
 * permission model, and they are enforced in the service, not here — a tool is
 * a caller like any other.
 * @module dsh-orchestrator/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { agentActor } from './actors.ts'
import { TASK_PRIORITIES, TASK_STATUSES, type Actor, type Task } from './domain.ts'

/** Compact issue projection: what a model needs to decide, and nothing else. */
interface TaskBrief {
  id: string
  title: string
  status: string
  priority: string
  version: number
  labels: string[]
  sessionId?: string
}

/** Project one issue for the model. @param task - Stored issue. @returns the brief. */
function brief(task: Task): TaskBrief {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    version: task.version,
    labels: task.labels,
    ...(task.sessionId !== undefined ? { sessionId: task.sessionId } : {}),
  }
}

/** Shape of {@link brief}, for tool output schemas. `sessionId` is the only optional field. */
const briefSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    status: { type: 'string', required: true },
    priority: { type: 'string', required: true },
    version: { type: 'integer', required: true },
    labels: { type: 'array', items: { type: 'string' }, required: true },
    sessionId: { type: 'string' },
  },
  additionalProperties: false,
} as const

/**
 * Who a tool call is attributed to.
 *
 * A call without a live agent still gets an `agent` actor, never a `user` one:
 * the fences exist to stop a model from approving its own work, and an unknown
 * caller must not be the way around them.
 * @param exec - The execution.
 * @returns the actor.
 */
function callerOf(exec: ToolExecution): Actor {
  return agentActor(exec.agent?.id ?? 'unknown-agent')
}

/**
 * Register the board's model-facing tools.
 * @param ctx - Context that already has `tools` and `taskboard`.
 */
export function applyTools(ctx: Context): void {
  const board = ctx.taskboard

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'taskboard_list',
    description:
      'List issues on the task board. Filter by project, status, or the session an issue is bound to. '
      + 'Returns compact briefs; use taskboard_get for the full description, comments, and history.',
    parameters: {
      projectId: { type: 'string', description: 'Only issues in this project' },
      status: {
        type: 'array',
        items: { type: 'string', enum: [...TASK_STATUSES] },
        description: 'Only issues in these columns',
      },
      sessionId: { type: 'string', description: 'Only issues bound to this session' },
    },
    output: {
      schema: { type: 'array', items: briefSchema },
      render: (_args, value) => [{
        type: 'text',
        text: value.length === 0
          ? 'No matching issues.'
          : value.map(t => `${t.status.padEnd(11)} ${t.id}  ${t.title}`).join('\n'),
      }],
    },
    // Board reads are synchronous; the tool contract is async either way.
    async execute(args) {
      return board.listTasks({
        ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
        ...(args.status !== undefined ? { status: args.status as Task['status'][] } : {}),
        ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      }).map(brief)
    },
  })), 'taskboard: tool list')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'taskboard_get',
    description:
      'Read one issue in full: description, comments, and the activity trail. '
      + 'The returned `version` is what taskboard_update needs to write safely.',
    parameters: {
      id: { type: 'string', required: true, description: 'Issue id' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          found: { type: 'boolean', required: true },
          task: briefSchema,
          description: { type: 'string' },
          comments: { type: 'array', items: { type: 'string' } },
          activity: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.found && value.task !== undefined
          ? `${value.task.title} [${value.task.status}] v${value.task.version}\n\n${value.description ?? ''}`
          : 'Issue not found.',
      }],
    },
    async execute(args) {
      const task = board.getTask(args.id)
      if (task === undefined) return { found: false }
      return {
        found: true,
        task: brief(task),
        description: task.description,
        comments: board.listComments(args.id).map(c => `${c.author.name}: ${c.body}`),
        activity: board.listActivity(args.id).map(a => `${a.createdAt} ${a.kind} by ${a.actor.name}`),
      }
    },
  })), 'taskboard: tool get')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'taskboard_update',
    description:
      'Change an issue. Pass the `version` you read from taskboard_get or taskboard_list: if the issue '
      + 'changed since, the write is refused rather than overwriting. '
      + 'You may move work to in_review to report it finished, but only a human can move an issue to '
      + 'done, and only a human can move one out of the proposed column.',
    parameters: {
      id: { type: 'string', required: true, description: 'Issue id' },
      expectedVersion: { type: 'integer', description: 'Version you read; omit to write unconditionally' },
      title: { type: 'string' },
      description: { type: 'string' },
      status: { type: 'string', enum: [...TASK_STATUSES] },
      priority: { type: 'string', enum: [...TASK_PRIORITIES] },
      labels: { type: 'array', items: { type: 'string' } },
    },
    output: {
      schema: briefSchema,
      render: (_args, value) => [{ type: 'text', text: `${value.title} → ${value.status} (v${value.version})` }],
    },
    async execute(args, exec) {
      const task = await board.updateTask(args.id, {
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.status !== undefined ? { status: args.status as Task['status'] } : {}),
        ...(args.priority !== undefined ? { priority: args.priority as Task['priority'] } : {}),
        ...(args.labels !== undefined ? { labels: [...args.labels] } : {}),
      }, {
        actor: callerOf(exec),
        ...(args.expectedVersion !== undefined ? { expectedVersion: args.expectedVersion } : {}),
      })
      return brief(task)
    },
  })), 'taskboard: tool update')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'taskboard_comment',
    description: 'Add a comment to an issue — findings, blockers, or a handoff note for the next round.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Issue id' },
      body: { type: 'string', required: true, description: 'Comment text (Markdown)' },
    },
    output: {
      schema: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
      render: () => [{ type: 'text', text: 'Comment added.' }],
    },
    async execute(args, exec) {
      if (args.body.trim() === '') throw new Error('comment body is empty')
      const comment = await board.addComment(args.taskId, args.body, callerOf(exec))
      return { id: comment.id }
    },
  })), 'taskboard: tool comment')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'taskboard_propose',
    description:
      'Propose a NEW issue for the board. It lands in the `proposed` column and does nothing until a '
      + 'human approves it — you cannot approve your own proposal, and nothing schedules it meanwhile. '
      + 'Use this for follow-up work you discovered; do not use it to give yourself the task you are '
      + 'already doing.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'Project the issue belongs to' },
      title: { type: 'string', required: true, description: 'One-line summary' },
      description: { type: 'string', description: 'Why this is worth doing, and what "done" means' },
      priority: { type: 'string', enum: [...TASK_PRIORITIES] },
      labels: { type: 'array', items: { type: 'string' } },
      round: { type: 'integer', description: 'Planning-loop round this came from, when applicable' },
    },
    output: {
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, status: { type: 'string' } },
        additionalProperties: false,
      },
      render: (args, value) => [{
        type: 'text',
        text: `Proposed "${args.title}" (${value.id}). Waiting for human approval in the proposed column.`,
      }],
    },
    // Why this queues instead of asking `ctx.approval` on the spot:
    //
    // dsh's one-shot approval seam FAILS CLOSED — an unavailable or
    // non-owning answerer resolves as a rejection — and a UI answerer only
    // answers for agents it owns. The workers in `taskboard_plan` are fresh
    // children in a worker thread that no UI owns, and they are exactly the
    // flow that produces the most proposals. Asking there would silently
    // destroy them. `ctx.approval` also requires an open turn, so a background
    // run could not ask at all.
    //
    // The column is strictly better here: durable across restarts, batchable
    // (ten proposals reviewed at once instead of ten modals), and visible
    // without stealing focus — the board is a tab beside the chat, and `/task`
    // reports the waiting count. dsh's own docs list durable out-of-turn
    // approval as unimplemented; this is the board supplying it.
    async execute(args, exec) {
      const actor = callerOf(exec)
      const task = await board.createTask({
        projectId: args.projectId,
        title: args.title,
        ...(args.description !== undefined ? { description: args.description } : {}),
        status: 'proposed',
        ...(args.priority !== undefined ? { priority: args.priority as Task['priority'] } : {}),
        ...(args.labels !== undefined ? { labels: [...args.labels] } : {}),
        origin: 'agent',
        proposedBy: { agent: actor.id, ...(args.round !== undefined ? { round: args.round } : {}) },
      }, actor)
      return { id: task.id, status: task.status }
    },
  })), 'taskboard: tool propose')
}
