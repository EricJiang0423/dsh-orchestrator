/**
 * The board's sidebar presence.
 *
 * Two entries, one per user-facing ask:
 *
 * - `sidebar.footer.action` ("Taskboard"): the entry row directly BELOW the
 *   project-folder box (the sidebar shell renders footer actions between the
 *   workspaces region and Settings). Clicking it opens the current session's
 *   taskboard tab, or starts a session first when none is open.
 * - `sidebar.action.top` ("New taskboard"): the button directly BELOW the
 *   New Session button. This slot only exists in the PATCHED sidebar shell
 *   (`scripts/patch-ui-sidebar-client.mjs`); `slots.inject` waits for the
 *   declaration, so without the patch the entry simply never registers.
 * @module dsh-orchestrator/client/sidebar
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import {
  IconChecklistOutline14,
  IconProjectAddOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useState } from 'react'
// Side-effect type import: merges the sidebar shell's SlotMap entries.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { Project } from '../domain.ts'
import { CreateProjectModal, hintNewProject } from './create-project.tsx'
import { openTaskboardView } from './view-control.ts'

/** Dictionary keys of this package's client copy. */
export type TaskboardKey =
  | 'entry.open'
  | 'new.label'
  | 'new.tooltip'
  | 'project.new.title'
  | 'project.new.description'
  | 'project.new.namePlaceholder'
  | 'project.new.folderPlaceholder'
  | 'project.new.create'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    taskboard: TaskboardKey
  }
}

/** The slot the patched sidebar shell renders between New Session and the workspace box. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.action.top': {
      kind: 'list'
      scope: 'root'
      owner: { wide: boolean; expandSidebar: () => void }
    }
  }
}

/**
 * Open the taskboard for the current session, or start a session first.
 *
 * The board view resolves which board to show from the session's working
 * directory, so an open session is the one precondition; a no-workspace
 * session still lands on the fallback "Tasks" board on the host.
 * @param ctx - Client context.
 */
export function openTaskboardFromSidebar(ctx: ClientContext): void {
  const { sessions, workspaces } = ctx
  const current = sessions.list.getSnapshot().current
  if (current !== undefined) {
    sessions.open(current)
    openTaskboardView(ctx, current)
    return
  }
  // No session yet: start one (same action as the New Session button), then
  // jump to the board once it becomes current.
  const unsubscribe = sessions.list.subscribe(() => {
    const next = sessions.list.getSnapshot().current
    if (next === undefined) return
    unsubscribe()
    openTaskboardView(ctx, next)
  })
  workspaces.startSession()
  // The 10s ceiling only removes the subscription; it never cancels the session.
  window.setTimeout(() => {
    unsubscribe()
  }, 10_000)
}

/** Props of the footer entry: the shell's column state plus our injected opener. */
export type TaskboardSidebarEntryProps = PropsRuntime<'sidebar.footer.action'> &
  PropsLocale<'taskboard'> & {
    onOpen: () => void
  }

/**
 * The "Taskboard" row rendered below the project-folder box.
 * @returns the entry element (wide row, or icon-only on the collapsed rail).
 */
export function TaskboardSidebarEntry({ wide, t, onOpen }: TaskboardSidebarEntryProps) {
  const button = (
    <button type="button" className="tb-side-entry" onClick={onOpen} aria-label={t('entry.open')}>
      <IconChecklistOutline14 size={wide ? 14 : 18} />
      {wide && <span className="tb-side-entry-label">Taskboard</span>}
    </button>
  )
  if (wide) return button
  return (
    <Tooltip label={t('entry.open')} delayMs={500}>
      {button}
    </Tooltip>
  )
}

/** Props of the top entry: shell column state plus our injected callbacks. */
export type NewTaskboardSidebarEntryProps = PropsRuntime<'sidebar.action.top'> &
  PropsLocale<'taskboard'> & {
    /** Jump to the board after a project was created. */
    onOpen: () => void
    /** The project that was just created. */
    onCreated: (project: Project) => void
  }

/**
 * The "New taskboard" button rendered below the New Session button.
 * @returns the button (wide, or icon-only on the collapsed rail) and its modal.
 */
export function NewTaskboardSidebarEntry({
  wide,
  t,
  onOpen,
  onCreated,
}: NewTaskboardSidebarEntryProps) {
  const [creating, setCreating] = useState(false)

  const button = (
    <button
      type="button"
      className={wide ? 'tb-side-new' : 'tb-side-new tb-side-new-rail'}
      onClick={() => {
        setCreating(true)
      }}
      aria-label={t('new.tooltip')}
    >
      <IconProjectAddOutline16 size={wide ? 14 : 18} />
      {wide && <span className="tb-side-new-label">{t('new.label')}</span>}
    </button>
  )

  return (
    <>
      {wide ? (
        button
      ) : (
        <Tooltip label={t('new.tooltip')} delayMs={500}>
          {button}
        </Tooltip>
      )}
      <CreateProjectModal
        open={creating}
        onClose={() => {
          setCreating(false)
        }}
        onCreated={project => {
          // The board view may not be mounted yet (fresh session): leave the
          // hint it consumes on mount, then jump there.
          hintNewProject(project.id)
          onCreated(project)
          onOpen()
        }}
        t={t}
      />
    </>
  )
}
