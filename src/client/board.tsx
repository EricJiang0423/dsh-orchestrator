/**
 * The board view — one tab in the conversation view ring, beside Chat.
 *
 * Kept deliberately light: dsh's own primitives and theme tokens do the looking,
 * so this file holds board behaviour and almost no styling. There is one view
 * (columns), not the original's four, and the detail pane is an inline
 * expansion rather than a third column.
 *
 * The board is WORKSPACE-SCOPED: the host resolves which board this session
 * belongs to (by its working directory), so opening the tab in another
 * repository shows that repository's issues, never a mixed pile. The project
 * pills switch to another board's issues for a look, but the default is always
 * this session's own.
 * @module dsh-orchestrator/client/board
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, MarkdownText, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Project, Task, TaskStatus } from '../domain.ts'
import type { SchedulerState, TaskDetail } from '../wire.ts'
import { RpcError, call, subscribe } from './rpc.ts'

/**
 * Columns, left to right.
 *
 * `canceled` is intentionally absent: rejected proposals and abandoned work go
 * there and a board that shows its own bin is noisier for it.
 */
const COLUMNS: readonly TaskStatus[] = [
  'proposed',
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
]

/** Column headings. `proposed` says what it wants from the reader. */
const COLUMN_LABEL: Record<TaskStatus, string> = {
  proposed: 'Proposed · needs you',
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
  canceled: 'Canceled',
}

/** Priorities worth a visual marker; `none` and `low` get none. */
const PRIORITY_MARK: Partial<Record<Task['priority'], string>> = {
  urgent: '!!',
  high: '!',
  medium: '·',
}

/** The workspace board this session belongs to, with live scheduler state. */
interface BoardData {
  project: Project
  tasks: Task[]
  scheduler: SchedulerState
}

/**
 * One issue card.
 * @param props.task - The issue.
 * @param props.expanded - Whether the detail is open.
 * @param props.detail - Loaded detail, when open.
 * @param props.onToggle - Open or close the detail.
 * @param props.onDecide - Approve or reject a proposal.
 * @param props.onStart - Open a fresh session for the issue.
 * @param props.onAccept - Accept finished work (in_review → done).
 * @param props.onSendBack - Send finished work back to todo, with a reason.
 * @returns the card element.
 */
function Card({ task, expanded, detail, onToggle, onDecide, onStart, onAccept, onSendBack }: {
  task: Task
  expanded: boolean
  detail: TaskDetail | undefined
  onToggle: () => void
  onDecide: (task: Task, approve: boolean) => void
  onStart: (task: Task) => void
  onAccept: (task: Task) => void
  onSendBack: (task: Task, reason: string) => void
}) {
  const [reason, setReason] = useState('')
  const startable = task.status === 'backlog' || task.status === 'todo' || task.status === 'blocked'
  return (
    <div className="tb-card" data-expanded={expanded ? 'true' : undefined}>
      <button type="button" className="tb-card-title" onClick={onToggle}>
        {PRIORITY_MARK[task.priority] !== undefined && (
          <span className="tb-priority" aria-label={`priority ${task.priority}`}>
            {PRIORITY_MARK[task.priority]}
          </span>
        )}
        {task.title}
      </button>

      {/* Being in `proposed` IS the pending state — no second condition on who
          proposed it, or a proposal that arrived another way would look
          undecidable. */}
      {task.status === 'proposed' && (
        <div className="tb-decide">
          <Button size="sm" variant="primary" onClick={() => { onDecide(task, true) }}>Approve</Button>
          <Button size="sm" variant="ghost" onClick={() => { onDecide(task, false) }}>Reject</Button>
          {task.proposedBy !== undefined && (
            <span className="tb-proposer">by {task.proposedBy.agent.slice(0, 8)}</span>
          )}
        </div>
      )}

      {/* The issue's own session — opened by the scheduler or by hand. It shows
          up in the session sidebar like any other session. */}
      {task.sessionId !== undefined && (
        <span className="tb-bound">session {task.sessionId.slice(0, 8)}</span>
      )}

      {expanded && startable && (
        <div className="tb-decide">
          <Button size="sm" variant="outline" onClick={() => { onStart(task) }}>Work on this</Button>
        </div>
      )}

      {/* The second human fence, symmetric to the proposal approval: an agent
          cannot mark its own work done, so in_review always lands here. */}
      {expanded && task.status === 'in_review' && (
        <div className="tb-decide">
          <input
            className="tb-reason"
            value={reason}
            onChange={event => { setReason(event.target.value) }}
            placeholder="reason to send back…"
          />
          <Button size="sm" variant="primary" onClick={() => { onAccept(task) }}>Accept</Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={reason.trim() === ''}
            onClick={() => { onSendBack(task, reason.trim()) }}
          >
            Send back
          </Button>
        </div>
      )}

      {expanded && (
        <div className="tb-detail">
          {task.description !== '' && <MarkdownText text={task.description} />}
          {task.labels.map(label => <Pill key={label}>{label}</Pill>)}
          {detail?.comments.map(comment => (
            <div key={comment.id} className="tb-comment">
              <span className="tb-comment-author">{comment.author.name}</span>
              <MarkdownText text={comment.body} />
            </div>
          ))}
          {detail !== undefined && detail.activity.length > 0 && (
            <ol className="tb-activity">
              {detail.activity.map(row => (
                <li key={row.id}>{row.kind} · {row.actor.name}</li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The board.
 * @returns the board element.
 */
export function BoardView({ sessionId }: PropsRuntime<'conversation.view'>) {
  const [view, setView] = useState<BoardData | undefined>(undefined)
  const [projects, setProjects] = useState<Project[]>([])
  // undefined = this session's own workspace board; a project id = that board.
  const [projectId, setProjectId] = useState<string | undefined>(undefined)
  const [tasks, setTasks] = useState<Task[]>([])
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  const [detail, setDetail] = useState<TaskDetail | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [concurrency, setConcurrency] = useState('1')

  const refresh = useCallback(async () => {
    try {
      const loaded = await call('board.view', { sessionId })
      setView(loaded)
      setConcurrency(String(loaded.scheduler.concurrency))
      setProjects(await call('project.list', {}))
      setTasks(projectId === undefined
        ? loaded.tasks
        : await call('task.list', { projectId }))
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [projectId, sessionId])

  useEffect(() => {
    void refresh()
    // One subscription for the view's lifetime; every frame is a refetch cue.
    return subscribe(() => { void refresh() })
  }, [refresh])

  // Bump the detail refetch whenever the board data changes, so an SSE refresh
  // does not leave a stale pane open.
  const dataVersion = `${view?.project.id ?? ''}:${tasks.length}`

  useEffect(() => {
    if (openId === undefined) {
      setDetail(undefined)
      return
    }
    let live = true
    void call('task.get', { id: openId }).then(loaded => {
      if (live) setDetail(loaded ?? undefined)
    })
    return () => { live = false }
  }, [openId, dataVersion])

  const decide = useCallback(async (task: Task, approve: boolean) => {
    try {
      await call('task.update', {
        id: task.id,
        patch: { status: approve ? 'backlog' : 'canceled' },
        expectedVersion: task.version,
      })
      await refresh()
    } catch (cause) {
      // A version conflict here means someone else already decided; say so
      // rather than leaving a button that looks broken.
      setError(cause instanceof RpcError && cause.code === 'version-conflict'
        ? 'That proposal was already decided — refreshing.'
        : cause instanceof Error ? cause.message : String(cause))
      await refresh()
    }
  }, [refresh])

  const start = useCallback(async (task: Task) => {
    try {
      // The host opens a FRESH session for the issue; this session is only
      // the one looking at the board.
      await call('task.start', { id: task.id })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [refresh])

  // The board knows what is next; picking a card by hand to start the obvious
  // one is busywork. With no project pill active this pulls from every board's
  // todo, exactly like the scheduler does.
  const startNext = useCallback(async () => {
    try {
      const started = await call('task.startNext', {
        ...(projectId !== undefined ? { projectId } : {}),
      })
      setError(started === null ? 'Nothing in todo to pick up.' : undefined)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [projectId, refresh])

  const accept = useCallback(async (task: Task) => {
    try {
      await call('task.accept', { id: task.id, expectedVersion: task.version })
      await refresh()
    } catch (cause) {
      setError(cause instanceof RpcError && cause.code === 'version-conflict'
        ? 'That review was already decided — refreshing.'
        : cause instanceof Error ? cause.message : String(cause))
      await refresh()
    }
  }, [refresh])

  const sendBack = useCallback(async (task: Task, reason: string) => {
    try {
      await call('task.sendBack', { id: task.id, reason, expectedVersion: task.version })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      await refresh()
    }
  }, [refresh])

  const applyConcurrency = useCallback(async () => {
    const parsed = Number.parseInt(concurrency, 10)
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      setConcurrency(String(view?.scheduler.concurrency ?? 1))
      return
    }
    try {
      const state = await call('scheduler.configure', { concurrency: parsed })
      setConcurrency(String(state.concurrency))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [concurrency, view])

  const toggleAutoPull = useCallback(async () => {
    if (view === undefined) return
    try {
      await call('scheduler.configure', { autoPull: !view.scheduler.autoPull })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [refresh, view])

  const byStatus = useMemo(() => {
    const groups = new Map<TaskStatus, Task[]>()
    for (const task of tasks) {
      const bucket = groups.get(task.status)
      if (bucket === undefined) groups.set(task.status, [task])
      else bucket.push(task)
    }
    return groups
  }, [tasks])

  const waiting = byStatus.get('proposed')?.length ?? 0
  const todoCount = byStatus.get('todo')?.length ?? 0

  return (
    <div className="tb-root">
      <div className="tb-bar">
        {view !== undefined && (
          <Pill active={projectId === undefined} onClick={() => { setProjectId(undefined) }}>
            {view.project.name}
          </Pill>
        )}
        {projects
          .filter(project => project.id !== view?.project.id)
          .map(project => (
            <Pill
              key={project.id}
              active={projectId === project.id}
              onClick={() => { setProjectId(projectId === project.id ? undefined : project.id) }}
            >
              {project.name}
            </Pill>
          ))}
        <span className="tb-bar-end">
          {waiting > 0 && <span className="tb-waiting">{waiting} waiting for you</span>}
          {todoCount > 0 && (
            <Button size="sm" variant="primary" onClick={() => { void startNext() }}>
              Work the next issue
            </Button>
          )}
        </span>
      </div>

      {view !== undefined && (
        <div className="tb-sched">
          <button
            type="button"
            className="tb-toggle"
            data-on={view.scheduler.autoPull ? 'true' : undefined}
            onClick={() => { void toggleAutoPull() }}
          >
            Auto-pull {view.scheduler.autoPull ? 'on' : 'off'}
          </button>
          <label className="tb-sched-field">
            Parallel
            <input
              type="number"
              min={1}
              value={concurrency}
              onChange={event => { setConcurrency(event.target.value) }}
              onBlur={() => { void applyConcurrency() }}
              onKeyDown={event => { if (event.key === 'Enter') void applyConcurrency() }}
            />
          </label>
          <span className="tb-sched-state">
            {view.scheduler.running} running · {view.scheduler.waiting} waiting
          </span>
        </div>
      )}

      {error !== undefined && <div className="tb-error">{error}</div>}

      <div className="tb-columns">
        {COLUMNS.map(status => {
          const column = byStatus.get(status) ?? []
          if (column.length === 0 && status !== 'todo' && status !== 'in_progress') return null
          return (
            <section key={status} className="tb-column" data-status={status}>
              <h3 className="tb-column-head">
                {COLUMN_LABEL[status]}
                <span className="tb-count">{column.length}</span>
              </h3>
              {column.map(task => (
                <Card
                  key={task.id}
                  task={task}
                  expanded={openId === task.id}
                  detail={openId === task.id ? detail : undefined}
                  onToggle={() => { setOpenId(openId === task.id ? undefined : task.id) }}
                  onDecide={(target, approve) => { void decide(target, approve) }}
                  onStart={target => { void start(target) }}
                  onAccept={target => { void accept(target) }}
                  onSendBack={(target, reason) => { void sendBack(target, reason) }}
                />
              ))}
            </section>
          )
        })}
      </div>

      {tasks.length === 0 && (
        <p className="tb-empty">
          No issues yet. Add one with <code>/task &lt;title&gt;</code> in the chat.
        </p>
      )}
    </div>
  )
}
