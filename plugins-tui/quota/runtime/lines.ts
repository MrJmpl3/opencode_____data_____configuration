import { fmtDuration } from '../providers.js';
import { formatResponsibleUsagePace } from './format.js';

export type PercentWindow = {
  usedPct: number;
  resetSec: number;
  limitWindowSec?: number;
};

export type QuotaLine =
  | { kind: 'heading'; text: string }
  | { kind: 'detail'; text: string }
  | { kind: 'window'; label: string; value: string; resetAtMs: number }
  | { kind: 'pace'; usedPct: number; resetAtMs: number; windowSeconds: number };

const detailLine = (text: string): string => `  ${text}`;

const resetAtMsFromSeconds = (resetSec: number, capturedAtMs: number): number =>
  capturedAtMs + Math.max(0, Math.floor(resetSec)) * 1000;

export const remainingSeconds = (resetAtMs: number, nowMs: number): number =>
  Math.max(0, Math.ceil((resetAtMs - nowMs) / 1000));

export const headingLine = (text: string): QuotaLine => ({ kind: 'heading', text });
export const detailTextLine = (text: string): QuotaLine => ({ kind: 'detail', text });

export const windowLine = (label: string, value: string, resetSec: number, capturedAtMs: number): QuotaLine => ({
  kind: 'window',
  label,
  value,
  resetAtMs: resetAtMsFromSeconds(resetSec, capturedAtMs),
});

export const paceLine = (window: PercentWindow, windowSeconds: number, capturedAtMs: number): QuotaLine => ({
  kind: 'pace',
  usedPct: window.usedPct,
  resetAtMs: resetAtMsFromSeconds(window.resetSec, capturedAtMs),
  windowSeconds,
});

export const renderQuotaLine = (line: QuotaLine, nowMs: number): string => {
  switch (line.kind) {
    case 'heading':
      return line.text;
    case 'detail':
      return detailLine(line.text);
    case 'window':
      return detailLine(`${line.label} · ${line.value} · ${fmtDuration(remainingSeconds(line.resetAtMs, nowMs))} left`);
    case 'pace':
      return detailLine(
        `Usage pace · ${formatResponsibleUsagePace(
          {
            usedPct: line.usedPct,
            resetSec: remainingSeconds(line.resetAtMs, nowMs),
          },
          line.windowSeconds,
        )}`,
      );
  }
};
