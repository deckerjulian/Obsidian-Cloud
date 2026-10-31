/**
 * The plugin's CSS, injected at load (keeps the install a single main.js).
 * Everything is built on Obsidian's CSS variables, so themes apply.
 */
export const PLUGIN_CSS = `
@keyframes oc-spin { to { transform: rotate(360deg); } }
.oc-spin { animation: oc-spin 1s linear infinite; display: inline-flex; }

/* status bar */
.oc-statusbar { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.oc-statusbar .oc-sb-icon { display: inline-flex; }
.oc-statusbar .oc-sb-icon svg { width: 14px; height: 14px; }
.oc-statusbar.is-ok .oc-sb-icon { color: var(--text-muted); }
.oc-statusbar.is-busy .oc-sb-icon { color: var(--text-accent); }
.oc-statusbar.is-warn .oc-sb-icon { color: var(--color-orange); }
.oc-statusbar.is-error .oc-sb-icon { color: var(--color-red); }
.oc-statusbar.is-off .oc-sb-icon { color: var(--text-faint); }

/* tones shared by cards and badges */
.oc-tone-ok { --oc-tone: var(--color-green); }
.oc-tone-busy { --oc-tone: var(--interactive-accent); }
.oc-tone-warn { --oc-tone: var(--color-orange); }
.oc-tone-error { --oc-tone: var(--color-red); }
.oc-tone-off { --oc-tone: var(--text-faint); }

/* settings: status card */
.oc-status-card {
  display: flex; gap: 14px; align-items: flex-start;
  padding: 14px 16px; margin: 4px 0 18px;
  border: 1px solid var(--background-modifier-border);
  border-left: 4px solid var(--oc-tone);
  border-radius: var(--radius-m, 8px);
  background: var(--background-secondary);
}
.oc-status-card .oc-card-icon {
  flex: none; display: flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; border-radius: 50%;
  color: var(--oc-tone);
  background: color-mix(in srgb, var(--oc-tone) 14%, transparent);
}
.oc-status-card .oc-card-icon svg { width: 20px; height: 20px; }
.oc-status-card .oc-card-body { flex: 1; min-width: 0; }
.oc-status-card .oc-card-title { font-weight: var(--font-semibold, 600); font-size: var(--font-ui-medium, 15px); }
.oc-status-card .oc-card-detail { color: var(--text-muted); font-size: var(--font-ui-small, 13px); margin-top: 2px; overflow-wrap: anywhere; }
.oc-status-card .oc-card-meta { color: var(--text-faint); font-size: var(--font-ui-smaller, 12px); margin-top: 6px; }
.oc-status-card .oc-card-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }

/* settings: setup checklist */
.oc-steps { display: flex; gap: 4px; margin: 10px 0 0; flex-wrap: wrap; }
.oc-step {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: var(--font-ui-smaller, 12px); color: var(--text-faint);
  padding: 2px 8px 2px 4px; border-radius: 999px; background: var(--background-primary);
}
.oc-step .oc-step-dot {
  width: 16px; height: 16px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--background-modifier-border); font-size: 10px;
}
.oc-step .oc-step-dot svg { width: 11px; height: 11px; }
.oc-step.is-done { color: var(--text-muted); }
.oc-step.is-done .oc-step-dot { background: var(--color-green); border-color: var(--color-green); color: var(--text-on-accent, #fff); }
.oc-step.is-current { color: var(--text-normal); font-weight: var(--font-semibold, 600); }
.oc-step.is-current .oc-step-dot { border-color: var(--interactive-accent); color: var(--interactive-accent); }

/* inline status lines + badges */
.oc-inline-status { display: flex; align-items: center; gap: 5px; margin-top: 4px; font-size: var(--font-ui-smaller, 12px); color: var(--oc-tone, var(--text-muted)); }
.oc-inline-status svg { width: 13px; height: 13px; }
.oc-badge {
  display: inline-block; font-size: var(--font-ui-smaller, 11px); line-height: 1.6;
  padding: 0 7px; border-radius: 999px; margin-left: 6px; vertical-align: middle;
  color: var(--oc-tone, var(--text-muted)); background: color-mix(in srgb, var(--oc-tone, var(--text-muted)) 14%, transparent);
}
.oc-badge.is-icon { display: inline-flex; padding: 2px 5px; }
.oc-badge.is-icon svg { width: 12px; height: 12px; }
.oc-badge.is-leading { margin: 0 6px 0 0; }
.oc-note { font-size: var(--font-ui-smaller, 12px); color: var(--text-muted); margin-top: 4px; }

/* excluded paths */
.oc-excluded { margin: 0 0 12px; border: 1px solid var(--background-modifier-border); border-radius: var(--radius-s, 4px); }
.oc-excluded-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 4px 4px 10px; font-family: var(--font-monospace); font-size: var(--font-ui-smaller, 12px); }
.oc-excluded-row + .oc-excluded-row { border-top: 1px solid var(--background-modifier-border); }

/* sync log */
.oc-log-toolbar { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.oc-log-toolbar .oc-spacer { flex: 1; }
.oc-chip { font-size: var(--font-ui-smaller, 12px); padding: 2px 10px; border-radius: 999px; cursor: pointer; color: var(--text-muted); background: var(--background-modifier-hover); }
.oc-chip.is-active { color: var(--text-on-accent, #fff); background: var(--interactive-accent); }
.oc-log {
  max-height: 280px; overflow: auto;
  border: 1px solid var(--background-modifier-border); border-radius: var(--radius-m, 8px);
  background: var(--background-primary-alt, var(--background-secondary));
  font-size: var(--font-ui-smaller, 12px); line-height: 1.45;
}
.oc-log.is-tall { max-height: 60vh; }
.oc-log-row { display: flex; gap: 8px; padding: 4px 10px; align-items: flex-start; }
.oc-log-row + .oc-log-row { border-top: 1px solid var(--background-modifier-border); }
.oc-log-row .oc-log-icon { flex: none; display: inline-flex; margin-top: 1px; }
.oc-log-row .oc-log-icon svg { width: 13px; height: 13px; }
.oc-log-row .oc-log-time { flex: none; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.oc-log-row .oc-log-msg { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--text-normal); }
.oc-log-row.is-info .oc-log-icon { color: var(--text-faint); }
.oc-log-row.is-info .oc-log-msg { color: var(--text-muted); }
.oc-log-row.is-success .oc-log-icon { color: var(--color-green); }
.oc-log-row.is-error .oc-log-icon { color: var(--color-red); }
.oc-log-row.is-error { background: color-mix(in srgb, var(--color-red) 6%, transparent); }
.oc-log-empty { padding: 16px; text-align: center; color: var(--text-faint); }

/* modals */
.oc-modal .modal-title { display: flex; align-items: center; gap: 8px; }
.oc-modal .oc-modal-icon { display: inline-flex; color: var(--interactive-accent); }
.oc-modal .oc-modal-icon svg { width: 20px; height: 20px; }
.oc-modal .oc-lead { color: var(--text-muted); margin: 0 0 12px; }
.oc-form { display: flex; flex-direction: column; gap: 12px; }
.oc-field { display: flex; flex-direction: column; gap: 4px; }
.oc-field > label { font-size: var(--font-ui-small, 13px); font-weight: var(--font-semibold, 600); color: var(--text-normal); }
.oc-field input[type=text], .oc-field input[type=password], .oc-field input[type=email], .oc-field input[type=url] { width: 100%; }
.oc-input-wrap { position: relative; display: flex; }
.oc-input-wrap input { padding-right: 34px; }
.oc-input-wrap .oc-eye { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); }
.oc-check { display: flex; align-items: center; gap: 6px; font-size: var(--font-ui-small, 13px); color: var(--text-muted); cursor: pointer; }
.oc-error-box {
  padding: 8px 10px; border-radius: var(--radius-s, 4px); font-size: var(--font-ui-small, 13px);
  color: var(--text-error, var(--color-red)); background: color-mix(in srgb, var(--color-red) 10%, transparent);
}
.oc-callout {
  display: flex; gap: 8px; padding: 10px 12px; border-radius: var(--radius-s, 4px); font-size: var(--font-ui-small, 13px);
  background: color-mix(in srgb, var(--oc-tone, var(--color-orange)) 10%, transparent);
  border-left: 3px solid var(--oc-tone, var(--color-orange));
}
.oc-callout svg { flex: none; width: 16px; height: 16px; color: var(--oc-tone, var(--color-orange)); margin-top: 1px; }
.oc-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
.oc-buttons.is-stacked { flex-direction: column; align-items: stretch; }
.oc-buttons button[disabled] { opacity: 0.6; cursor: default; }
.oc-meter { height: 4px; border-radius: 2px; background: var(--background-modifier-border); overflow: hidden; }
.oc-meter > div { height: 100%; transition: width 0.15s, background 0.15s; }
.oc-list { margin: 6px 0 0; padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.oc-list li { display: flex; gap: 8px; align-items: flex-start; }
.oc-list li svg { flex: none; width: 15px; height: 15px; margin-top: 2px; color: var(--color-green); }
.oc-details { max-height: 180px; overflow: auto; font-family: var(--font-monospace); font-size: var(--font-ui-smaller, 12px); margin: 8px 0 0; padding: 8px 8px 8px 24px; border-radius: var(--radius-s, 4px); background: var(--background-secondary); }

/* vault picker */
.oc-choices { display: flex; flex-direction: column; gap: 6px; max-height: 45vh; overflow: auto; padding: 2px; }
.oc-choice {
  display: flex; gap: 10px; align-items: center; padding: 10px 12px; cursor: pointer;
  border: 1px solid var(--background-modifier-border); border-radius: var(--radius-m, 8px);
}
.oc-choice:hover { background: var(--background-modifier-hover); }
.oc-choice.is-selected { border-color: var(--interactive-accent); box-shadow: 0 0 0 1px var(--interactive-accent); background: color-mix(in srgb, var(--interactive-accent) 8%, transparent); }
.oc-choice .oc-choice-icon { flex: none; display: inline-flex; color: var(--text-muted); }
.oc-choice.is-selected .oc-choice-icon { color: var(--interactive-accent); }
.oc-choice .oc-choice-body { flex: 1; min-width: 0; }
.oc-choice .oc-choice-title { font-weight: var(--font-semibold, 600); }
.oc-choice .oc-choice-desc { font-size: var(--font-ui-smaller, 12px); color: var(--text-muted); }
.oc-choice input[type=text] { margin-top: 6px; width: 100%; }

/* first sync */
.oc-progress { display: flex; align-items: center; gap: 10px; padding: 12px 0; }
.oc-progress .oc-spin svg { width: 20px; height: 20px; color: var(--interactive-accent); }
.oc-progress-line { font-family: var(--font-monospace); font-size: var(--font-ui-smaller, 12px); color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.oc-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; margin: 12px 0 0; }
.oc-stat { padding: 10px; border-radius: var(--radius-m, 8px); background: var(--background-secondary); text-align: center; }
.oc-stat .oc-stat-n { font-size: 22px; font-weight: var(--font-bold, 700); }
.oc-stat .oc-stat-l { font-size: var(--font-ui-smaller, 12px); color: var(--text-muted); }
.oc-stat.is-error .oc-stat-n { color: var(--color-red); }
`;
