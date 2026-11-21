/**
 * Structured JSON logging (M19).
 *
 * One shared logger for the whole backend — no new dependency (the log volume here
 * does not justify pino/winston, and both would need a working `npm install` plus a
 * transport for Vercel's stdout-only log capture). Every line is a single JSON
 * object on stdout: `{ time, level, msg, ...fields }`. No secrets, PII, or full
 * error stacks are ever logged — errors are reduced to a short message string by
 * the caller (see `errorMessage`).
 *
 * Log level comes from `LOG_LEVEL` (validated in env.ts, default `info`); it is
 * read from `process.env` on every call so tests can change it without re-importing
 * this module. `setLogSink` exists only so tests can capture lines without
 * hijacking `process.stdout`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

type LogSink = (line: string) => void;

let sink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

/** Test-only hook: capture log lines instead of writing them to stdout. Pass `null` to restore the default. */
export function setLogSink(next: LogSink | null): void {
  sink =
    next ??
    ((line) => {
      process.stdout.write(`${line}\n`);
    });
}

export type LogFields = Record<string, string | number | boolean | null | undefined>;

function write(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel()]) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...fields });
  sink(line);
}

export const logger = {
  debug(message: string, fields: LogFields = {}): void {
    write('debug', message, fields);
  },
  info(message: string, fields: LogFields = {}): void {
    write('info', message, fields);
  },
  warn(message: string, fields: LogFields = {}): void {
    write('warn', message, fields);
  },
  error(message: string, fields: LogFields = {}): void {
    write('error', message, fields);
  },
};

/** Reduce an unknown thrown value to a one-line message — never log a whole error object (stacks can contain paths and payloads). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
