// Pure, UI-agnostic log parsing and colour classification.
// Mirrors the colour scheme used by the original LogBoard logView component.

// hex colours matching the LWC viewer (Monokai-ish palette)
export const COLORS = {
  unit: '#e6db74', // CODE_UNIT_* / METHOD_*  (yellow)
  callout: '#ae81ff', // CALLOUT_*             (purple)
  soql: '#66d9ef', // SOQL_EXECUTE_*           (cyan)
  debug: '#a6e22e', // USER_DEBUG              (green)
  error: '#ff5555', // EXCEPTION_THROWN / FATAL_ERROR (red)
  none: null,
};

/** Classify a single log line, returning a hex colour or null. */
export function classifyLine(line) {
  if (line.includes('CODE_UNIT_') || line.includes('METHOD_')) return COLORS.unit;
  if (line.includes('CALLOUT_')) return COLORS.callout;
  if (line.includes('SOQL_EXECUTE_')) return COLORS.soql;
  if (line.includes('USER_DEBUG')) return COLORS.debug;
  if (line.includes('EXCEPTION_THROWN') || line.includes('FATAL_ERROR')) return COLORS.error;
  return COLORS.none;
}

/**
 * Turn a raw log body into an array of { text, color } segments (one per line).
 * @param {string} body
 * @param {{debugOnly?: boolean}} [opts]
 */
export function formatLog(body, { debugOnly = false } = {}) {
  const lines = (body || '').split('\n');

  if (debugOnly) {
    const out = lines
      .filter((l) => l.includes('USER_DEBUG'))
      .map((l) => ({ text: l, color: COLORS.debug }));
    if (!out.length) return [{ text: 'Nothing to show', color: COLORS.debug }];
    return out;
  }

  return lines.map((l) => ({ text: l, color: classifyLine(l) }));
}

/**
 * Search across multiple log bodies, returning each matching line with one
 * line of context above and below (matching the original LogBoard behaviour).
 * @param {Array<{id:string, operation?:string, body:string}>} logs
 * @param {string} term
 * @returns {Array<{logId:string, operation:string, lineIndex:number, context: Array<{text,color}>}>}
 */
export function searchLogs(logs, term) {
  const results = [];
  if (!term) return results;
  const needle = term.toLowerCase();

  for (const log of logs) {
    const lines = (log.body || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        const from = Math.max(0, i - 1);
        const to = Math.min(lines.length - 1, i + 1);
        const context = [];
        for (let j = from; j <= to; j++) {
          context.push({ text: lines[j], color: classifyLine(lines[j]), match: j === i });
        }
        results.push({
          logId: log.id,
          operation: log.operation || '',
          lineIndex: i,
          context,
        });
      }
    }
  }
  return results;
}

// --- Renderers ---------------------------------------------------------------

/** Render segments as blessed markup tags (escaping content braces). */
export function toBlessed(segments) {
  return segments
    .map(({ text, color }) => {
      const safe = String(text).replace(/[{}]/g, (c) => (c === '{' ? '{open}' : '{close}'));
      return color ? `{${color}-fg}${safe}{/}` : safe;
    })
    .join('\n');
}

const ANSI = {
  '#e6db74': '\x1b[38;5;185m',
  '#ae81ff': '\x1b[38;5;141m',
  '#66d9ef': '\x1b[38;5;81m',
  '#a6e22e': '\x1b[38;5;148m',
  '#ff5555': '\x1b[38;5;203m',
};
const RESET = '\x1b[0m';

/** Render segments with raw ANSI escape codes (for plain output / piping). */
export function toAnsi(segments) {
  return segments
    .map(({ text, color }) => (color && ANSI[color] ? ANSI[color] + text + RESET : text))
    .join('\n');
}
