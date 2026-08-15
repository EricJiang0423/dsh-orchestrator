/**
 * dsh-orchestrator browser half.
 *
 * The board is a PEER OF THE CHAT, not an overlay: it registers into
 * `conversation.view`, the additive view ring where the chat itself is just one
 * entry and ui-trajectory adds two more. The session body renders exactly one
 * ring entry at a time and the session header shows the tabs, so the board lands
 * beside Chat with no layout fight.
 *
 * Do NOT register into `conversation` or `conversation.session`: both are
 * `single` and occupied, so taking those seats replaces dsh's whole conversation
 * surface (and collapses every seat it declares) instead of adding to it.
 * @module dsh-orchestrator/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Side-effect type import: merges the slot keys we register into onto SlotMap.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BoardView } from './board.tsx'
import { installStyles } from './styles.ts'

/** Slot entry id; also the persisted active-view key. */
const VIEW_ID = 'taskboard'

/** Required client services. */
export const inject = ['slots']

/**
 * Register the board as a conversation view.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'taskboard: styles')
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: VIEW_ID,
    order: 20,
    label: () => 'Taskboard',
  }, BoardView))
}
