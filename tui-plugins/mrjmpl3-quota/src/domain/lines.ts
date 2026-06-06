import { fmtDuration } from '../infrastructure/providers/format.ts';
import { formatResponsibleUsagePace } from './format.ts';
import type { PercentWindow } from './types.ts';

export type QuotaLine =
  | { kind: 'heading'; text: string }
  | { kind: 'detail'; text: string }
  | { kind: 'window'; label: string; value: string; resetAtMs: number }
  | { kind: 'pace'; usedPct: number; resetAtMs: number; windowSeconds: number };

const resetAtMsFromSeconds = (resetSec: number, capturedAtMs: number): number =>
  capturedAtMs + Math.max(0, Math.floor(resetSec)) * 1000;

const indentQuotaLine = (text: string): string => `  ${text}`;

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
      return indentQuotaLine(line.text);
    case 'window':
      return indentQuotaLine(
        `${line.label} · ${line.value} · ${fmtDuration(remainingSeconds(line.resetAtMs, nowMs))} left`,
      );
    case 'pace':
      return indentQuotaLine(
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
