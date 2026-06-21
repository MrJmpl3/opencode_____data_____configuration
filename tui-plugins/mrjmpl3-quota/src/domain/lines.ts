import { fmtDuration } from '../infrastructure/providers/format.ts';
import { formatPaceLineText } from './format.ts';
import type { PercentWindow, QuotaLineTone } from './types.ts';

export type QuotaLine =
  | { kind: 'heading'; text: string }
  | { kind: 'detail'; text: string; tone?: QuotaLineTone }
  | { kind: 'window'; label: string; value: string; resetAtMs: number; usedPct?: number; tone?: QuotaLineTone }
  | { kind: 'pace'; usedPct: number; resetAtMs: number; windowSeconds: number };

const resetAtMsFromSeconds = (resetSec: number, capturedAtMs: number): number =>
  capturedAtMs + Math.max(0, Math.floor(resetSec)) * 1000;

const indentQuotaLine = (text: string): string => `  ${text}`;

const indentPaceLine = (text: string): string => `    ${text}`;

export const usageColor = (usedPct: number): string => {
  if (usedPct <= 50) return 'green';
  if (usedPct <= 80) return 'yellow';
  return 'red';
};

export const remainingSeconds = (resetAtMs: number, nowMs: number): number =>
  Math.max(0, Math.ceil((resetAtMs - nowMs) / 1000));

export const headingLine = (text: string): QuotaLine => ({ kind: 'heading', text });
export const detailTextLine = (text: string, tone: QuotaLineTone = 'neutral'): QuotaLine => ({
  kind: 'detail',
  text,
  tone,
});

export const windowLine = (
  label: string,
  value: string,
  resetSec: number,
  capturedAtMs: number,
  tone: QuotaLineTone = 'neutral',
  usedPct?: number,
): QuotaLine => ({
  kind: 'window',
  label,
  value,
  resetAtMs: resetAtMsFromSeconds(resetSec, capturedAtMs),
  tone,
  usedPct: usedPct !== undefined && Number.isFinite(usedPct) ? usedPct : undefined,
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
      return `● ${line.text}`;
    case 'detail':
      return indentQuotaLine(line.text);
    case 'window': {
      const resetSec = remainingSeconds(line.resetAtMs, nowMs);
      return indentQuotaLine(`${line.label} ${line.value} · ${fmtDuration(resetSec)}`);
    }
    case 'pace': {
      const resetSec = remainingSeconds(line.resetAtMs, nowMs);
      const { paceText, recoverySeconds } = formatPaceLineText(
        {
          usedPct: line.usedPct,
          resetSec,
        },
        line.windowSeconds,
      );
      const projection = recoverySeconds !== undefined ? ` · ~${fmtDuration(recoverySeconds)}` : '';
      return indentPaceLine(`${paceText}${projection}`);
    }
  }
};
