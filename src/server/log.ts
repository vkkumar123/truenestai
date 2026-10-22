import "server-only";

/**
 * Minimal structured logger. Callers must pass only non-personal data (ids, statuses, counts).
 * Lead data must go through redactLeadForLog (src/leads/retention.ts) first.
 */
type Fields = Record<string, string | number | boolean | null | undefined | string[]>;

function emit(level: "info" | "warn" | "error", event: string, fields: Fields = {}) {
  if (process.env.NODE_ENV === "test" && !process.env.TN_LOG_IN_TESTS) return;
  const line = JSON.stringify({ level, event, ...fields, at: new Date().toISOString() });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export const log = {
  info: (event: string, fields?: Fields) => emit("info", event, fields),
  warn: (event: string, fields?: Fields) => emit("warn", event, fields),
  error: (event: string, fields?: Fields) => emit("error", event, fields),
};
