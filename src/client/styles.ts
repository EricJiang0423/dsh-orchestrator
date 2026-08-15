/**
 * The board's stylesheet — layout only.
 *
 * Every colour is a `--dsw-alias-*` token, so the board follows whatever theme
 * the harness is in and keeps following it when the user switches. Nothing here
 * defines a colour value of its own; the original board shipped 240KB of CSS,
 * and almost all of it was re-stating things the host already knows.
 *
 * There is no bundler in this package's build (see docs/spike-findings.md), so
 * the sheet is a string injected at mount rather than a CSS import.
 * @module dsh-orchestrator/client/styles
 */

/** Stylesheet text, injected once per page by {@link installStyles}. */
const CSS = `
/* The composer floats over the bottom of the session body (the chat view lives
   with the same thing), so the board reserves room for it rather than letting
   its last cards sit under it. */
.tb-root {
  display: flex; flex-direction: column; gap: 12px;
  padding: 16px 16px 220px; height: 100%; overflow: auto;
}
.tb-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tb-bar-end { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.tb-waiting { font-size: 12px; color: var(--dsw-alias-state-warn-primary); }
.tb-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }

/* Scheduler row: the one thing on the board that RUNS work, so it reads like
   a control strip, not a status line. */
.tb-sched { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.tb-toggle {
  font-size: 12px; padding: 2px 8px; cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  background: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
}
.tb-toggle[data-on] {
  color: var(--dsw-alias-brand-on-primary);
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.tb-sched-field { display: flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); }
.tb-sched-field input {
  width: 48px; padding: 2px 6px; font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
}
.tb-sched-state { color: var(--dsw-alias-label-secondary); }

.tb-columns { display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; padding-bottom: 8px; }
.tb-column { flex: 0 0 260px; display: flex; flex-direction: column; gap: 8px; }
.tb-column-head {
  display: flex; align-items: center; gap: 6px; margin: 0;
  font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary);
}
.tb-count { color: var(--dsw-alias-label-secondary); opacity: 0.6; }
/* The approval queue is the one column that should catch the eye. */
.tb-column[data-status="proposed"] .tb-column-head { color: var(--dsw-alias-state-warn-primary); }

.tb-card {
  display: flex; flex-direction: column; gap: 6px; padding: 10px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
}
.tb-card[data-expanded] { background: var(--dsw-alias-bg-layer-2); }
.tb-card-title {
  text-align: left; background: none; border: 0; padding: 0; cursor: pointer;
  font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary);
}
.tb-card-title:hover { color: var(--dsw-alias-brand-primary); }
.tb-priority { color: var(--dsw-alias-state-warn-primary); margin-right: 4px; }

.tb-decide { display: flex; align-items: center; gap: 6px; }
.tb-proposer { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.tb-bound { font-size: 11px; color: var(--dsw-alias-brand-primary); }
.tb-reason {
  flex: 1; min-width: 120px; padding: 3px 6px; font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
}
.tb-detail { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.tb-comment { border-left: 2px solid var(--dsw-alias-border-l2); padding-left: 8px; }
.tb-comment-author { color: var(--dsw-alias-label-secondary); }
.tb-activity { margin: 0; padding-left: 16px; color: var(--dsw-alias-label-secondary); }
.tb-empty { font-size: 13px; color: var(--dsw-alias-label-secondary); }
`

/** Marker so a remount does not stack duplicate sheets. */
const STYLE_ID = 'dsh-orchestrator/client'

/**
 * Inject the stylesheet once.
 * @returns a disposer that removes it.
 */
export function installStyles(): () => void {
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.pluginCss = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}
