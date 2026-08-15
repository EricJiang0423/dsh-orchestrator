/**
 * Board logic checks: the two status fences and the optimistic-version CAS.
 *
 * Runs the real service against a fake domain facility that reproduces the
 * storage-domain contract we depend on — synchronous reads and a single
 * serialized write chain, so `update` sees the value current at its slot.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { Taskboard, TaskboardError, canTransition } from '../lib/index.js'
import {
  Scheduler, reconcileOrphans, resolveProject, selectionRefFor, startNextTask, startTask,
} from '../lib/session-link.js'
import { nextRunAtMs } from '../lib/schedule.js'

/** One table over a Map, with the domain's write-chain semantics. */
function fakeTable() {
  const records = new Map()
  let chain = Promise.resolve()
  const enqueue = fn => {
    const next = chain.then(fn, fn)
    chain = next.then(() => {}, () => {})
    return next
  }
  return {
    get: key => records.get(key),
    entries: () => [...records.entries()][Symbol.iterator](),
    keys: () => [...records.keys()][Symbol.iterator](),
    get size() { return records.size },
    put: (key, value) => enqueue(() => { records.set(key, value) }),
    delete: key => enqueue(() => records.delete(key)),
    update: (key, fn) => enqueue(() => {
      if (!records.has(key)) throw new Error('missing-key')
      const next = fn(records.get(key))
      records.set(key, next)
      return next
    }),
  }
}

/**
 * A board wired to fake storage.
 * @param options.withAgents - also provide a fake agent registry and goal
 *   service, so the session-binding path can run without a model.
 * @returns the service and its context.
 */
async function boardFixture(options = {}) {
  const ctx = new Context()
  const tables = new Map()
  ctx.reflect.provide('storageDomain', {
    open: async spec => ({
      name: spec.name,
      table: name => {
        if (!tables.has(name)) tables.set(name, fakeTable())
        return tables.get(name)
      },
      close: async () => {},
    }),
  })
  if (options.withAgents === true) {
    // A registry whose sessions exist only while the test says so: `create`
    // hands out fresh agents, `get` answers the live ones, `kill` makes one
    // vanish the way a closed/crashed session does — no board write involved.
    class Agents extends Service {
      constructor(context) { super(context, 'agents') }
      entries = []
      create(options) {
        const agent = { id: String(options.sessionId), followups: [] }
        agent.followup = message => { agent.followups.push(message) }
        this.entries.push({ options, agent })
        return { agent }
      }
      get(id) { return this.entries.find(entry => entry.agent.id === id)?.agent }
      kill(id) { this.entries = this.entries.filter(entry => entry.agent.id !== id) }
    }
    class Goals extends Service {
      constructor(context) { super(context, 'goals') }
      created = []
      create(_agent, request) { this.created.push(request) }
    }
    // The harness's default model selection — spawned issue sessions must
    // inherit it (provider, model, AND reasoning effort), or their request
    // routing falls back to the adapter default instead of the user's choice.
    class DefaultModel extends Service {
      constructor(context) { super(context, 'agentDefaultModel') }
      currentSelection() { return { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' } }
    }
    // The default agent preset — without it a spawned session has no working
    // tool kit (no file tools, no shell), so it cannot do the work.
    class Presets extends Service {
      constructor(context) { super(context, 'agentPresets') }
      mounts = []
      async resolve() { return { id: 'standard' } }
      async mount(ctx, id) { this.mounts.push({ ctx, id }) }
    }
    ctx.plugin(Agents)
    ctx.plugin(Goals)
    ctx.plugin(DefaultModel)
    ctx.plugin(Presets)
  }
  if (options.withSessions === true) {
    // The session store (main conversations) and the workspace registry, so the
    // workspace-resolution path runs without a real harness.
    class Sessions extends Service {
      constructor(context) { super(context, 'sessions') }
      get(id) { return id === 'session-view' ? { header: { cwd: '/repo' } } : undefined }
    }
    class Workspaces extends Service {
      constructor(context) { super(context, 'workspaceRegistry') }
      async resolveByPath(path) {
        return path === '/repo' ? { id: 'ws-1', path: '/repo', title: 'Sample Repo' } : undefined
      }
      async create(path) { return { id: 'ws-2', path, title: 'Other' } }
    }
    ctx.plugin(Sessions)
    ctx.plugin(Workspaces)
  }
  ctx.plugin(Taskboard)
  await ctx.start?.()
  // Service.init is async; wait until the table handles are bound.
  for (let i = 0; i < 100 && ctx.taskboard === undefined; i += 1) await new Promise(r => setImmediate(r))
  assert.ok(ctx.taskboard, 'taskboard service did not register')
  await new Promise(r => setImmediate(r))
  return { board: ctx.taskboard, ctx }
}

const human = { type: 'user', id: 'u1', name: 'Eric' }
const robot = { type: 'agent', id: 'a1', name: 'planner' }

test('an agent cannot approve its own proposal, a human can', () => {
  // The approval queue is a queue only because leaving it is a human act.
  assert.equal(canTransition('proposed', 'backlog', 'agent'), false)
  assert.equal(canTransition('proposed', 'todo', 'agent'), false)
  assert.equal(canTransition('proposed', 'backlog', 'user'), true)
  assert.equal(canTransition('proposed', 'canceled', 'user'), true)
  // Approving means backlog or canceled — not straight into the work columns.
  assert.equal(canTransition('proposed', 'in_progress', 'user'), false)
})

test('an agent cannot declare its own work accepted', () => {
  assert.equal(canTransition('in_review', 'done', 'agent'), false)
  assert.equal(canTransition('in_review', 'done', 'user'), true)
  // Reporting work finished is its call; accepting it is not.
  assert.equal(canTransition('in_progress', 'in_review', 'agent'), true)
})

test('nothing moves back into the approval queue', () => {
  for (const from of ['backlog', 'todo', 'in_progress', 'done']) {
    assert.equal(canTransition(from, 'proposed', 'user'), false)
    assert.equal(canTransition(from, 'proposed', 'agent'), false)
  }
})

test('a stale write is refused instead of overwriting', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'First' }, human)
  assert.equal(task.version, 0)

  const updated = await board.updateTask(task.id, { title: 'Renamed' }, { actor: human, expectedVersion: 0 })
  assert.equal(updated.version, 1)
  assert.equal(updated.title, 'Renamed')

  // Second writer still holding version 0 loses, and the record is untouched.
  await assert.rejects(
    () => board.updateTask(task.id, { title: 'Clobbered' }, { actor: human, expectedVersion: 0 }),
    err => err instanceof TaskboardError && err.code === 'version-conflict',
  )
  assert.equal(board.getTask(task.id).title, 'Renamed')
})

test('a null patch value clears the field instead of poisoning storage', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Do the thing' }, human)

  // A wire caller sending null (as my reset once did) must not persist null:
  // the domain validates every record at open and a null sessionId would take
  // the whole board down on the next boot.
  const cleared = await board.updateTask(task.id, { sessionId: null }, { actor: human })
  assert.equal(cleared.sessionId, undefined)
  assert.equal(board.getTask(task.id).sessionId, undefined)

  // Clearing a required field is refused the same way — dropped, not persisted.
  const kept = await board.updateTask(task.id, { status: null }, { actor: human })
  assert.equal(kept.status, 'backlog')
})

test('a forbidden transition is refused at the service boundary', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const proposal = await board.createTask(
    { projectId: 'p1', title: 'Agent idea', status: 'proposed' },
    robot,
  )
  await assert.rejects(
    () => board.updateTask(proposal.id, { status: 'todo' }, { actor: robot }),
    err => err instanceof TaskboardError && err.code === 'forbidden-transition',
  )
  assert.equal(board.getTask(proposal.id).status, 'proposed')

  const approved = await board.updateTask(proposal.id, { status: 'backlog' }, { actor: human })
  assert.equal(approved.status, 'backlog')
})

test('approving records who did it', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const proposal = await board.createTask(
    { projectId: 'p1', title: 'Agent idea', status: 'proposed' },
    robot,
  )
  await board.updateTask(proposal.id, { status: 'backlog' }, { actor: human })
  const kinds = board.listActivity(proposal.id).map(row => row.kind)
  assert.deepEqual(kinds, ['proposed', 'status'])
  assert.equal(board.listActivity(proposal.id)[1].actor.type, 'user')
})

/**
 * Run a body from a fiber that injected ONLY `taskboard`, the way the RPC route
 * actually calls in. Cordis refuses `ctx.<service>` for anything the calling
 * fiber did not declare, so a root-context test would miss that entirely — it
 * did, once.
 * @param ctx - Root context.
 * @param body - Called with the restricted child context.
 * @returns the body's result.
 */
function fromRestrictedFiber(ctx, body) {
  return new Promise((resolve, reject) => {
    ctx.plugin({
      inject: ['taskboard'],
      apply: child => { Promise.resolve(body(child)).then(resolve, reject) },
    })
  })
}

test('starting an issue opens a fresh session, moves it, and hands it over', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo', workspacePath: '/repo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Do the thing' }, human)

  const started = await fromRestrictedFiber(ctx, child => startTask(child, board, task.id))

  // A brand-new session, created in the project's repository, inheriting the
  // harness's default model so it can actually run.
  assert.notEqual(started.sessionId, undefined)
  assert.equal(started.status, 'in_progress')
  assert.equal(ctx.agents.entries.length, 1)
  assert.equal(ctx.agents.entries[0].options.meta.cwd, '/repo')
  // AgentOptions has NO reasoningEffort field — the effort must NOT be dropped,
  // so it travels instead through installModelSelection in setup (below).
  assert.deepEqual(ctx.agents.entries[0].options.agentOptions, {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  assert.equal(ctx.agents.entries[0].options.meta.agentPreset, 'standard')

  // The setup callback composes the scoped world: the default preset's tools
  // AND the full model selection (effort included) through selectionRefFor.
  const setup = ctx.agents.entries[0].options.setup
  assert.equal(typeof setup, 'function')
  // A context whose event surface suppresses registration so installModelSelection
  // (the real dsh-agent helper) runs without a full agent scope.
  const fakeAgentCtx = { on: () => () => {} }
  await setup(fakeAgentCtx)
  assert.equal(ctx.agentPresets.mounts.length, 1)
  assert.equal(ctx.agentPresets.mounts[0].id, 'standard')
  // The selection ref must carry the FULL selection, reasoningEffort and all.
  assert.deepEqual(selectionRefFor({ provider: 'p', model: 'm', reasoningEffort: 'max' }), {
    current: { provider: 'p', model: 'm', reasoningEffort: 'max' },
    assembled: undefined,
  })

  // One execution record was opened and bound to the spawned session.
  assert.equal(started.executions.length, 1)
  assert.equal(started.executions[0].sessionId, started.sessionId)
  assert.equal(started.executions[0].result, undefined)
  assert.equal(started.executions[0].endedAt, undefined)

  // The agent was handed the issue, not just told about it.
  const agent = ctx.agents.get(started.sessionId)
  assert.equal(agent.followups.length, 1)
  const text = agent.followups[0].content[0].text
  assert.match(text, /Do the thing/)
  assert.match(text, /in_review/, 'the brief must tell the agent how to hand back')

  // The goal service, when present, learns what the session is for.
  assert.deepEqual(ctx.goals.created, [{ objective: `Board issue ${task.id}: Do the thing` }])

  const kinds = board.listActivity(task.id).map(row => row.kind)
  assert.deepEqual(kinds, ['created', 'status', 'session'])
})

test('an issue with a live session is not started twice', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Do the thing' }, human)

  const first = await fromRestrictedFiber(ctx, child => startTask(child, board, task.id))
  const second = await fromRestrictedFiber(ctx, child => startTask(child, board, task.id))

  assert.equal(second.sessionId, first.sessionId)
  assert.equal(ctx.agents.entries.length, 1)
})

test('a task whose session died is rebound to a fresh session', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Do the thing' }, human)
  await board.updateTask(task.id, { sessionId: 'dead-session' }, { actor: human })

  const started = await fromRestrictedFiber(ctx, child => startTask(child, board, task.id))

  assert.notEqual(started.sessionId, 'dead-session')
  assert.equal(started.status, 'in_progress')
  assert.equal(ctx.agents.entries.length, 1)
})

test('the board picks the next issue itself, highest priority first', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  await board.createTask({ projectId: 'p1', title: 'Low', status: 'todo', priority: 'low' }, human)
  const urgent = await board.createTask(
    { projectId: 'p1', title: 'Urgent', status: 'todo', priority: 'urgent' },
    human,
  )
  // Not in todo, so not eligible however urgent it looks.
  await board.createTask(
    { projectId: 'p1', title: 'Proposed and urgent', status: 'proposed', priority: 'urgent' },
    human,
  )

  const started = await fromRestrictedFiber(ctx, child => startNextTask(child, board))
  assert.equal(started.id, urgent.id)
  assert.equal(started.status, 'in_progress')
})

test('picking from an empty queue answers null instead of throwing', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  await board.createTask({ projectId: 'p1', title: 'Not scheduled', status: 'backlog' }, human)

  const started = await fromRestrictedFiber(ctx, child => startNextTask(child, board))
  assert.equal(started, null)
})

// ── workspace resolution ─────────────────────────────────────────────────────

test('a session sees the board of the workspace its cwd belongs to', async () => {
  const { board, ctx } = await boardFixture({ withSessions: true })

  // The main conversation's cwd comes from the SESSION STORE; the board must
  // bind to the workspace that path resolves to, not to the caller.
  const project = await fromRestrictedFiber(ctx, child => resolveProject(child, board, 'session-view'))

  assert.equal(project.name, 'Sample Repo')
  assert.equal(project.workspacePath, '/repo')
  assert.equal(project.workspaceId, 'ws-1')

  // Two sessions in the same workspace share ONE board.
  const again = await resolveProject(ctx, board, 'session-view')
  assert.equal(again.id, project.id)
})

test('a session without a resolvable cwd falls back to the default board', async () => {
  const { board, ctx } = await boardFixture({ withSessions: true })

  const project = await resolveProject(ctx, board, 'no-such-session')

  assert.equal(project.id, 'default')
  assert.equal(board.listProjects().length, 1)
})

// ── scheduler ────────────────────────────────────────────────────────────────

/** A scheduler wired to the fixture, without the mount-time interval. */
function schedulerFixture(ctx, config) {
  return new Scheduler(ctx, { sweepIntervalMs: 60_000, ...config })
}

test('auto-pull is on by default and can be turned off', async () => {
  const { ctx } = await boardFixture({ withAgents: true })
  const scheduler = schedulerFixture(ctx)
  assert.equal(scheduler.state().autoPull, true)
  scheduler.configure({ autoPull: false })
  assert.equal(scheduler.state().autoPull, false)
})

test('the scheduler refuses a nonsense concurrency', async () => {
  const { ctx } = await boardFixture({ withAgents: true })
  const scheduler = schedulerFixture(ctx)
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => scheduler.configure({ concurrency: bad }),
      err => err instanceof TaskboardError && err.code === 'invalid-input',
    )
  }
})

test('the scheduler fills slots up to concurrency, then stops', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  for (const title of ['A', 'B', 'C']) {
    await board.createTask({ projectId: 'p1', title, status: 'todo' }, human)
  }

  const scheduler = schedulerFixture(ctx, { concurrency: 2 })
  await scheduler.pump()

  assert.equal(board.listTasks({ status: 'in_progress' }).length, 2)
  assert.equal(board.listTasks({ status: 'todo' }).length, 1)
  const state = scheduler.state('p1')
  assert.equal(state.running, 2)
  assert.equal(state.waiting, 1)
})

test('the scheduler persists its knobs and a new instance restores them', async () => {
  const { ctx } = await boardFixture({ withAgents: true })

  const first = schedulerFixture(ctx)
  first.configure({ concurrency: 3, autoPull: false })
  // configure persists fire-and-forget on the domain write chain; let it land.
  await new Promise(resolve => setImmediate(resolve))

  // A second instance — as after a restart — reads the stored row.
  const second = schedulerFixture(ctx)
  await second.restore()
  assert.equal(second.state().concurrency, 3)
  assert.equal(second.state().autoPull, false)

  // A configure after restore wins, and wins persistently.
  second.configure({ autoPull: true })
  await new Promise(resolve => setImmediate(resolve))
  const third = schedulerFixture(ctx)
  await third.restore()
  assert.equal(third.state().autoPull, true)
})

test('a stored row never overrides a configure that raced ahead of the restore', async () => {
  const { ctx } = await boardFixture({ withAgents: true })

  const first = schedulerFixture(ctx)
  first.configure({ autoPull: false })
  // The human flips the switch before the storage read lands.
  const second = schedulerFixture(ctx)
  second.configure({ autoPull: true })
  await second.restore()
  assert.equal(second.state().autoPull, true)
})

test('a dead session frees its slot for the next issue', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  await board.createTask({ projectId: 'p1', title: 'A', status: 'todo' }, human)
  await board.createTask({ projectId: 'p1', title: 'B', status: 'todo' }, human)

  const scheduler = schedulerFixture(ctx, { concurrency: 1 })
  await scheduler.pump()
  const first = board.listTasks({ status: 'in_progress' })[0]
  assert.equal(first.title, 'A')

  // The bound session vanishes without any board write — the silent case the
  // safety-net sweep exists for.
  ctx.agents.kill(first.sessionId)
  await scheduler.pump()

  // A is still `in_progress` on the board, but it no longer holds a slot;
  // B takes the free one.
  assert.equal(board.listTasks({ status: 'todo' }).length, 0)
  const inProgress = board.listTasks({ status: 'in_progress' })
  assert.equal(inProgress.length, 2)
  assert.equal(inProgress.filter(task => ctx.agents.get(task.sessionId) !== undefined).length, 1)
  assert.equal(scheduler.state('p1').running, 1)
})

// ── executions ────────────────────────────────────────────────────────────────

test('a re-run forces a fresh session even when a live one is idle-bound', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Do it again', status: 'todo' }, human)

  // First run binds a session; the agent stays live (idle after its turn).
  const first = await fromRestrictedFiber(ctx, child => startTask(child, board, task.id))
  assert.equal(ctx.agents.entries.length, 1)

  // A second ordinary start is refused — that is the no-double-start guard.
  const guarded = await fromRestrictedFiber(ctx, child => startTask(child, board, task.id))
  assert.equal(guarded.sessionId, first.sessionId)

  // A forced re-run opens a NEW session and a NEW execution record.
  const reran = await fromRestrictedFiber(ctx, child => startTask(child, board, task.id, { force: true }))
  assert.notEqual(reran.sessionId, first.sessionId)
  assert.equal(ctx.agents.entries.length, 2)
  assert.equal(reran.executions.length, 2)
})

test('settling an execution records the outcome and can land failed', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Do the thing', status: 'todo' }, human)

  const opened = await board.openExecution(task.id, 'sess-1', { actor: human, status: 'in_progress' })
  assert.equal(opened.executions.length, 1)
  assert.equal(opened.executions[0].result, undefined)

  const succeeded = await board.settleExecution(task.id, 'succeeded', { actor: human })
  assert.equal(succeeded.executions[0].result, 'succeeded')
  assert.ok(succeeded.executions[0].endedAt !== undefined)
  assert.equal(succeeded.status, 'in_progress', 'success leaves the status to the agent/skill')

  // A second open + failed settle lands the issue in the failed column.
  const reopened = await board.openExecution(task.id, 'sess-2', { actor: human })
  const failed = await board.settleExecution(task.id, 'failed', {
    actor: human,
    error: 'the model blew up',
    status: 'failed',
  })
  assert.equal(reopened.executions.length, 2)
  assert.equal(failed.executions.length, 2)
  assert.equal(failed.executions[1].result, 'failed')
  assert.equal(failed.executions[1].error, 'the model blew up')
  assert.equal(failed.status, 'failed')
})

test('settling a settled execution is a no-op', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Do the thing' }, human)
  await board.openExecution(task.id, 'sess-1', { actor: human, status: 'in_progress' })
  const done = await board.settleExecution(task.id, 'succeeded', { actor: human })
  const again = await board.settleExecution(task.id, 'failed', { actor: human })
  assert.equal(again.executions[0].result, 'succeeded', 'a late settle cannot flip a settled result')
  assert.equal(done.version, again.version, 'a no-op settle does not bump the version')
})

// ── schedule ──────────────────────────────────────────────────────────────────

test('enabling a schedule computes the next run; disabling clears it', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Daily' }, human)
  const from = Date.parse('2026-01-01T00:00:00.000Z')

  const armed = await board.updateScheduleRule(task.id, { enabled: true, cron: '0 9 * * *' }, { actor: human }, from)
  assert.equal(armed.schedule.enabled, true)
  assert.equal(armed.schedule.cron, '0 9 * * *')
  assert.equal(armed.schedule.nextRunAt, nextRunAtMs('0 9 * * *', from))
  assert.equal(armed.schedule.lastTriggeredAt, undefined)

  // Disabling clears the due instant so a stale one can never linger.
  const disarmed = await board.updateScheduleRule(task.id, { enabled: false }, { actor: human }, from)
  assert.equal(disarmed.schedule.enabled, false)
  assert.equal(disarmed.schedule.nextRunAt, undefined)
})

test('an invalid schedule expression is refused', async () => {
  const { board } = await boardFixture()
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Daily' }, human)

  await assert.rejects(
    () => board.updateScheduleRule(task.id, { enabled: true, cron: 'not a cron' }, { actor: human }),
    err => err instanceof TaskboardError && err.code === 'invalid-input',
  )
  assert.equal(board.getTask(task.id).schedule, undefined, 'a rejected rule leaves the task untouched')
})

test('the scheduler runs a due issue for real and rolls the rule forward', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Scheduled', status: 'todo' }, human)

  // Arm with a minute-aligned rule and force nextRunAt into the past.
  const now = Date.now()
  const due = nextRunAtMs('* * * * *', now - 60_000)
  await board.updateScheduleRule(task.id, { enabled: true, cron: '* * * * *' }, { actor: human }, now)
  await board.rollSchedule(task.id, due, now - 60_000)

  const scheduler = schedulerFixture(ctx, { autoPull: false })
  await scheduler.tick()

  const stored = board.getTask(task.id)
  assert.equal(stored.status, 'in_progress', 'the due issue was executed')
  assert.equal(stored.executions.length, 1)
  assert.ok(stored.schedule.lastTriggeredAt !== undefined, 'the trigger instant is recorded')
  assert.ok(stored.schedule.nextRunAt > due, 'the rule rolled forward past the due minute')
})

test('an issue already executing at its due instant skips the run', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Scheduled' }, human)
  await board.openExecution(task.id, 'sess-1', { actor: human, status: 'in_progress' })

  // Arm "every minute" from two minutes ago, so the computed next run is
  // already in the past when the tick reads the wall clock — deterministically
  // due, without touching lastTriggeredAt.
  await board.updateScheduleRule(task.id, { enabled: true, cron: '* * * * *' }, { actor: human }, Date.now() - 120_000)
  const busy = board.getTask(task.id)
  assert.ok(busy.schedule.nextRunAt < Date.now(), 'the rule is staged due')

  const scheduler = schedulerFixture(ctx, { autoPull: false })
  await scheduler.tick()

  const stored = board.getTask(task.id)
  assert.equal(stored.executions.length, 1, 'no second execution while the issue is already running')
  assert.ok(stored.schedule.nextRunAt > Date.now() - 120_000, 'the rule rolled forward, skipping this occurrence')
  assert.equal(stored.schedule.lastTriggeredAt, undefined, 'a skipped run never records a trigger')
})

test('mount reconciliation fails an orphaned in_progress issue', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const task = await board.createTask({ projectId: 'p1', title: 'Vanished' }, human)
  await board.openExecution(task.id, 'dead-session', { actor: human, status: 'in_progress' })

  await reconcileOrphans(ctx, board)

  const stored = board.getTask(task.id)
  assert.equal(stored.status, 'failed')
  assert.equal(stored.executions[0].result, 'failed')
  assert.match(stored.executions[0].error, /no longer exists/)
})

test('reconciliation leaves a live session and plan-claimed issues alone', async () => {
  const { board, ctx } = await boardFixture({ withAgents: true })
  await board.createProject({ id: 'p1', name: 'Demo' })
  const live = await board.createTask({ projectId: 'p1', title: 'Live', status: 'todo' }, human)
  await fromRestrictedFiber(ctx, child => startTask(child, board, live.id))
  const claimed = await board.createTask({ projectId: 'p1', title: 'Claimed', status: 'in_progress' }, human)

  await reconcileOrphans(ctx, board)

  assert.equal(board.getTask(live.id).status, 'in_progress', 'a live session stays in progress')
  assert.equal(board.getTask(claimed.id).status, 'in_progress', 'a session-less claim is not an orphan')
  assert.equal(board.getTask(claimed.id).executions.length, 0)
})
