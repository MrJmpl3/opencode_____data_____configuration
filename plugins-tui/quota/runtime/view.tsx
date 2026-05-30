/** @jsxImportSource @opentui/solid */
import { Show } from 'solid-js';
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';

import { renderQuotaLine } from './lines.js';
import type { QuotaLine } from './lines.js';

export const View = (props: { getLines: () => QuotaLine[]; getNowMs: () => number; api: TuiPluginApi }) => {
  const theme = () => props.api.theme.current;
  return (
    <box gap={0}>
      <text fg={theme().text}>Quota</text>
      <Show
        when={props.getLines().length > 0}
        fallback={
          <text fg={theme().textMuted} wrapMode="none">
            No data
          </text>
        }
      >
        {props.getLines().map((line) => (
          <text fg={theme().textMuted} wrapMode="none">
            {renderQuotaLine(line, props.getNowMs())}
          </text>
        ))}
      </Show>
    </box>
  );
};
