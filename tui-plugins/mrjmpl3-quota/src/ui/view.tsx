/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';
import { Show } from 'solid-js';

import { computePaceStatus } from '../domain/format.ts';
import { remainingSeconds, renderQuotaLine, usageColor } from '../domain/lines.ts';
import type { QuotaLine } from '../domain/lines.ts';
import type { QuotaLineTone } from '../domain/types.ts';
import { fmtDuration } from '../infrastructure/providers/format.ts';

const toneColor = (tone: QuotaLineTone | undefined): string => {
  switch (tone) {
    case 'success':
      return 'green';
    case 'warning':
      return 'yellow';
    case 'error':
      return 'red';
    case 'neutral':
    default:
      return 'gray';
  }
};

const lineFg = (line: QuotaLine, nowMs: number): string => {
  switch (line.kind) {
    case 'heading':
      return 'white';
    case 'window':
      return toneColor(line.tone);
    case 'pace': {
      const resetSec = remainingSeconds(line.resetAtMs, nowMs);
      const status = computePaceStatus({ usedPct: line.usedPct, resetSec }, line.windowSeconds);
      return status.isOverPace ? 'yellow' : 'green';
    }
    case 'detail':
      return toneColor(line.tone);
  }
};

const renderWindowLine = (line: Extract<QuotaLine, { kind: 'window' }>, nowMs: number) => {
  const resetSec = remainingSeconds(line.resetAtMs, nowMs);
  const color = line.usedPct !== undefined ? usageColor(line.usedPct) : toneColor(line.tone);

  return (
    <text wrapMode="none">
      {/* @ts-expect-error SpanProps doesn't expose fg in the OpenTUI type definitions */}
      <span fg="gray"> {line.label} </span>
      {/* @ts-expect-error SpanProps doesn't expose fg in the OpenTUI type definitions */}
      <span fg={color}>{line.value}</span>
      {/* @ts-expect-error SpanProps doesn't expose fg in the OpenTUI type definitions */}
      <span fg="gray"> · </span>
      {/* @ts-expect-error SpanProps doesn't expose fg in the OpenTUI type definitions */}
      <span fg={color}>{fmtDuration(resetSec)}</span>
    </text>
  );
};

export const View = (props: { getLines: () => QuotaLine[]; getNowMs: () => number; api: TuiPluginApi }) => {
  return (
    <box gap={0}>
      <text fg="white">Quota</text>
      <Show
        when={props.getLines().length > 0}
        fallback={
          <text fg="gray" wrapMode="none">
            No data
          </text>
        }
      >
        {props.getLines().map((line) => {
          if (line.kind === 'window') {
            return renderWindowLine(line, props.getNowMs());
          }
          return (
            <text fg={lineFg(line, props.getNowMs())} wrapMode="none">
              {renderQuotaLine(line, props.getNowMs())}
            </text>
          );
        })}
      </Show>
    </box>
  );
};
