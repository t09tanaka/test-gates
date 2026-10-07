import type { Violation } from '../core/types.js';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** `file:line: message`, or `file: message` when the finding has no line. */
export function formatViolation(violation: Violation): string {
  const where =
    violation.line === undefined ? violation.file : `${violation.file}:${violation.line}`;
  return `${where}: ${violation.message}`;
}

export function printViolations(io: Io, title: string, violations: Violation[]): void {
  io.err(`sekisho ${title}: ${violations.length} violation(s)`);
  for (const violation of violations) {
    io.err(`  - ${formatViolation(violation)}`);
  }
}
