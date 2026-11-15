// Ring buffer of recent app events and errors, used by the debug report.
// Nothing leaves the browser: the report is a file the user saves and sends on purpose.

const MAX_ENTRIES = 400;
const MAX_TEXT = 600;

const clip = (v) => {
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
};

export class DebugLog {
  /** @param {number} max maximum number of entries kept (oldest are dropped) */
  constructor(max = MAX_ENTRIES) { this.max = max; this.entries = []; this.t0 = Date.now(); }

  /** @param {'info'|'warn'|'error'} level @param {string} kind short category, e.g. 'detect' @param {*} [data] */
  push(level, kind, data) {
    this.entries.push({ t: Date.now() - this.t0, level, kind, data: data === undefined ? undefined : clip(data) });
    if (this.entries.length > this.max) this.entries.shift();
  }
  info(kind, data) { this.push('info', kind, data); }
  warn(kind, data) { this.push('warn', kind, data); }
  error(kind, data) { this.push('error', kind, data); }

  /** Capture console warnings/errors and uncaught errors (call once, early). Returns an uninstall function. */
  install(target = globalThis) {
    const con = target.console, orig = { warn: con.warn, error: con.error };
    const hook = (level) => (...args) => { this.push(level, 'console', args.map(clip).join(' ')); orig[level].apply(con, args); };
    con.warn = hook('warn'); con.error = hook('error');
    const onError = (e) => this.push('error', 'window.error', `${e.message} @ ${e.filename || ''}:${e.lineno || ''}`);
    const onRejection = (e) => this.push('error', 'unhandledrejection', e.reason?.stack || e.reason?.message || e.reason);
    target.addEventListener?.('error', onError);
    target.addEventListener?.('unhandledrejection', onRejection);
    return () => { con.warn = orig.warn; con.error = orig.error; target.removeEventListener?.('error', onError); target.removeEventListener?.('unhandledrejection', onRejection); };
  }
}

export const debugLog = new DebugLog();
