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
  display: flex; flex-direction: column; gap: 16px;
  padding: 16px 16px 220px; height: 100%; overflow: auto;
}
.tb-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tb-bar-end { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.tb-waiting { font-size: 12px; font-weight: 500; color: var(--dsw-alias-state-warn-primary); }
.tb-error {
  display: flex; align-items: center; gap: 6px; font-size: 12px;
  color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-state-error-secondary);
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 8px; padding: 6px 10px;
}

/* Scheduler row: the one thing on the board that RUNS work, so it reads like
   a control strip, not a status line. */
.tb-sched { display: flex; align-items: center; gap: 12px; font-size: 12px; }
.tb-toggle {
  font-size: 12px; height: 24px; padding: 0 10px; cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  background: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  transition: color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-toggle:not([data-on]):hover {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-border-l2);
  background: var(--dsw-alias-interactive-bg-hover);
}
.tb-toggle[data-on] {
  color: var(--dsw-alias-brand-primary-invert);
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.tb-sched-field { display: flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); }
.tb-sched-field input {
  box-sizing: border-box; width: 48px; height: 24px; padding: 0 6px; font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
}
.tb-sched-state { color: var(--dsw-alias-label-secondary); }

.tb-columns { display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; padding-bottom: 8px; }
.tb-column { flex: 0 0 268px; display: flex; flex-direction: column; gap: 10px; }
.tb-column-head {
  display: flex; align-items: center; gap: 6px; margin: 0; padding: 0 2px 2px;
  font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.tb-count { color: var(--dsw-alias-label-secondary); opacity: 0.6; font-weight: 400; }
/* The approval queue is the one column that should catch the eye. */
.tb-column[data-status="proposed"] .tb-column-head { color: var(--dsw-alias-state-warn-primary); }

.tb-card {
  display: flex; flex-direction: column; gap: 8px; padding: 12px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-card:not([data-expanded]):hover {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-border-l2);
}
.tb-card[data-expanded] { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
.tb-card-title {
  text-align: left; background: none; border: 0; padding: 0; cursor: pointer;
  font-size: 13px; font-weight: 500; line-height: 20px; color: var(--dsw-alias-label-primary);
}
.tb-card-title:hover { color: var(--dsw-alias-brand-primary); }
.tb-priority { color: var(--dsw-alias-state-warn-primary); margin-right: 4px; }

/* Card meta line: runs, schedule badge, relative time. */
.tb-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.tb-runs { font-weight: 500; }
.tb-runs[data-result="failed"] { color: var(--dsw-alias-state-error-primary); }
.tb-runs[data-result="succeeded"] { color: var(--dsw-alias-state-success-primary); }
.tb-sched-badge {
  padding: 2px 8px; border-radius: 999px;
  color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.tb-session-chip {
  align-self: flex-start; font-size: 11px; padding: 2px 8px; cursor: pointer;
  color: var(--dsw-alias-brand-primary); background: none;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-session-chip:hover {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

/* Board header search box. */
.tb-search {
  box-sizing: border-box; flex: 0 1 220px; min-width: 140px; height: 24px;
  padding: 0 8px; font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-search:focus, .tb-search:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-2);
}

.tb-decide { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 2px; }
.tb-proposer { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.tb-reason {
  box-sizing: border-box; flex: 1; min-width: 120px; height: 26px; padding: 0 8px; font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-reason:focus, .tb-reason:focus-visible {
  outline: none; border-color: var(--dsw-alias-brand-primary);
}
.tb-detail {
  display: flex; flex-direction: column; gap: 8px; font-size: 12px;
  padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2);
}
.tb-comment { border-left: 2px solid var(--dsw-alias-border-l2); padding: 2px 0 2px 8px; }
.tb-comment-author { color: var(--dsw-alias-label-secondary); }
.tb-activity { margin: 0; padding-left: 16px; color: var(--dsw-alias-label-secondary); }

/* Execution history and schedule editor inside the expanded card. */
.tb-executions { margin: 0; padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.tb-executions li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tb-exec-badge {
  font-size: 10px; font-weight: 500; padding: 1px 6px; border-radius: 999px;
  color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1);
}
.tb-exec-badge[data-result="failed"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.tb-exec-badge[data-result="succeeded"] { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.tb-exec-times { color: var(--dsw-alias-label-secondary); }
.tb-exec-error { color: var(--dsw-alias-state-error-primary); font-size: 11px; }
.tb-link {
  font-size: 11px; background: none; border: 0; padding: 0; cursor: pointer;
  color: var(--dsw-alias-brand-primary);
}
.tb-link:hover { text-decoration: underline; }
.tb-schedule { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.tb-schedule-toggle { display: flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary); }
.tb-cron { flex: 0 1 110px; min-width: 90px; }
.tb-preset {
  box-sizing: border-box; height: 26px; font-size: 11px; padding: 0 4px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
}
.tb-preset:hover { border-color: var(--dsw-alias-border-l2); }
.tb-empty { font-size: 13px; color: var(--dsw-alias-label-secondary); text-align: center; padding: 40px 0; }

/* Session mail: inter-session agent messages shown on the cards involved. */
.tb-msg-badge {
  display: inline-flex; align-items: center; gap: 3px; font-size: 11px; font-weight: 500;
  padding: 1px 6px; border-radius: 999px;
  color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.tb-msgs { display: flex; flex-direction: column; gap: 8px; }
.tb-msgs-head {
  font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--dsw-alias-label-secondary);
}
.tb-msg {
  display: flex; flex-direction: column; gap: 4px; padding: 8px 10px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  font-size: 12px;
}
/* A message the target session has not received yet: dashed, so "pending" reads
   even without the chip. */
.tb-msg[data-pending] { border-style: dashed; }
.tb-msg-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tb-msg-dir { font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.tb-msg-pending {
  font-size: 10px; font-weight: 500; padding: 0 6px; border-radius: 999px;
  color: var(--dsw-alias-state-warn-label);
  background: var(--dsw-alias-state-warn-tertiary);
  border: 1px solid var(--dsw-alias-state-warn-secondary);
}
.tb-msg-time { font-size: 11px; color: var(--dsw-alias-label-secondary); }

/* New-taskboard "+" in the board's project-pill bar. */
.tb-new-project {
  box-sizing: border-box; flex: none; width: 24px; height: 24px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; padding: 0;
  color: var(--dsw-alias-label-secondary);
  background: none; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px;
  transition: color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-new-project:hover {
  color: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}

/* Sidebar: the "New taskboard" button below New Session — same visual recipe
   as the shell's New Session button so the column reads as one control stack. */
.tb-side-new {
  box-sizing: border-box; width: 100%; height: 38px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-button-elevated-fill);
  color: var(--dsw-alias-label-primary);
  border-radius: 12px; flex: none;
  justify-content: center; align-items: center; gap: 6px;
  margin: 0 0 8px; padding: 8px 16px;
  font-size: 14px; font-weight: 500; line-height: 22px;
  display: flex; overflow: hidden;
  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-side-new:hover { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l3); }
.tb-side-new-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Rail form: one centred icon button, matching the shell's icon controls. */
.tb-side-new-rail { width: 36px; height: 36px; margin: 0 0 12px; padding: 0; border: none; border-radius: 50%; background: none; }
.tb-side-new-rail:hover { background: var(--dsw-alias-interactive-bg-hover); }

/* Sidebar: the "Taskboard" entry row below the project-folder box. */
.tb-side-entry {
  box-sizing: border-box; width: 100%; height: 34px; cursor: pointer;
  display: flex; align-items: center; gap: 6px; padding: 0 8px;
  color: var(--dsw-alias-label-primary);
  background: none; border: none; border-radius: 8px;
  font-size: 14px; line-height: 20px;
}
.tb-side-entry:hover { background: var(--dsw-alias-interactive-bg-hover); }
.tb-side-entry-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Create-project modal content. */
.tb-create-form { display: flex; flex-direction: column; gap: 10px; }
.tb-modal-footer {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
}
.tb-modal-footer .tb-error { flex: 1; }

/* Drag & drop: the card title is the drag handle; columns are the targets.
   The highlight is an inset dashed ring on the column, and the dragged card
   ghosts itself at half strength so what will land where stays readable. */
.tb-card-title { cursor: grab; }
.tb-card-title:active { cursor: grabbing; }
.tb-card[data-dragging] { opacity: 0.5; }
.tb-card[data-dragging] .tb-card-title { cursor: grabbing; }
.tb-column {
  border-radius: 12px;
  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    box-shadow var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-column.tb-column-over {
  background: var(--dsw-alias-interactive-bg-hover);
  box-shadow: inset 0 0 0 1.5px dashed var(--dsw-alias-brand-primary);
}
.tb-column-drop-hint {
  border: 1.5px dashed var(--dsw-alias-border-l2); border-radius: 10px;
  padding: 14px 8px; font-size: 12px; text-align: center;
  color: var(--dsw-alias-label-secondary);
}

/* Card head: title + edit pencil, so "edit" is one click without opening the
   detail. The pencil is a hover affordance like the card's own border. */
.tb-card-head { display: flex; align-items: flex-start; gap: 6px; }
.tb-card-head .tb-card-title { flex: 1; min-width: 0; }
.tb-card-edit {
  flex: 0 0 auto; width: 20px; height: 20px; padding: 0; font-size: 12px; line-height: 1;
  cursor: pointer; color: var(--dsw-alias-label-secondary);
  background: none; border: 1px solid transparent; border-radius: 6px;
  opacity: 0;
  transition: opacity var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    color var(--ds-transition-duration-fast) var(--ds-ease-in-out),
    border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-card:hover .tb-card-edit, .tb-card-edit:focus-visible { opacity: 1; }
.tb-card-edit:hover { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-border-l2); }
.tb-card-edit-on { opacity: 1; }

/* Inline title editor, styled like the other board text fields. */
.tb-title-input {
  box-sizing: border-box; flex: 1; min-width: 0; height: 26px; padding: 0 8px;
  font-size: 13px; font-weight: 500;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-title-input:focus, .tb-title-input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }

/* Description row and its editor. */
.tb-desc { display: flex; align-items: flex-start; gap: 6px; }
.tb-desc > :first-child { flex: 1; min-width: 0; }
.tb-desc-empty { color: var(--dsw-alias-label-secondary); font-style: italic; }
.tb-desc-input {
  box-sizing: border-box; width: 100%; min-height: 72px; padding: 8px; resize: vertical;
  font: inherit; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-desc-input:focus, .tb-desc-input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }

/* Priority + labels edit row. */
.tb-fields { display: flex; flex-direction: column; gap: 8px; }
.tb-field { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.tb-field-label { color: var(--dsw-alias-label-secondary); }
.tb-label-pill {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 10px;
  font-size: 11px; border-radius: 999px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
}
.tb-label-x {
  width: 14px; height: 14px; padding: 0; font-size: 11px; line-height: 1; cursor: pointer;
  color: var(--dsw-alias-label-secondary); background: none; border: 0; border-radius: 50%;
}
.tb-label-x:hover { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover); }
.tb-label-add {
  box-sizing: border-box; flex: 1; min-width: 90px; height: 24px; padding: 0 10px; font-size: 11px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  transition: border-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.tb-label-add:focus, .tb-label-add:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }

/* The delete affordance: destructive, so it borrows the error palette — but
   the actual removal still needs the card's confirm step, which is the fence
   a drag-adjacent click cannot cross. */
.tb-danger-zone { margin-top: 4px; padding-top: 8px; border-top: 1px dashed var(--dsw-alias-border-l2); }
.tb-delete {
  color: var(--dsw-alias-state-error-primary);
  border: 1px solid var(--dsw-alias-state-error-secondary);
}
.tb-delete:hover {
  color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-state-error-secondary);
}
.tb-delete-confirm {
  background: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
}
.tb-delete-ask { font-size: 12px; color: var(--dsw-alias-state-error-primary); }

/* Keyboard focus: same ring the host uses, on every board control. */
.tb-toggle:focus-visible,
.tb-search:focus-visible,
.tb-reason:focus-visible,
.tb-preset:focus-visible,
.tb-card-title:focus-visible,
.tb-session-chip:focus-visible,
.tb-link:focus-visible,
.tb-sched-field input:focus-visible,
.tb-new-project:focus-visible,
.tb-side-new:focus-visible,
.tb-side-entry:focus-visible,
.tb-title-input:focus-visible,
.tb-desc-input:focus-visible,
.tb-label-add:focus-visible,
.tb-card-edit:focus-visible,
.tb-label-x:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
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
  return () => {
    style.remove()
  }
}
