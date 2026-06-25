import { Show } from 'solid-js';
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';

import { detailLine, formatCompactNumber, formatPercentRatio } from '@mrjmpl3/tui-kit';

export type CacheViewProps = {
  hasData: () => boolean;
  ratio: () => number;
  read: () => number;
  write: () => number;
  hasWriteData: () => boolean;
  input: () => number;
  output: () => number;
  api: TuiPluginApi;
};

export const CacheView = (props: CacheViewProps) => {
  const theme = () => props.api.theme.current;
  const usageLine = () => `Hit ${formatPercentRatio(props.ratio())} · Save ${formatCompactNumber(props.read())}`;
  const trafficLines = () => {
    const lines = [`Input ${formatCompactNumber(props.input())} · Output ${formatCompactNumber(props.output())}`];
    if (props.hasWriteData()) lines.push(`Write ${formatCompactNumber(props.write())}`);
    return lines;
  };

  return (
    <box gap={0}>
      <text fg={theme().text}>Cache</text>
      <Show
        when={props.hasData()}
        fallback={
          <text fg={theme().textMuted} wrapMode="none">
            No data
          </text>
        }
      >
        <>
          <text fg={theme().textMuted} wrapMode="none">
            Usage
          </text>
          <text fg={theme().textMuted} wrapMode="none">
            {detailLine(usageLine())}
          </text>
          <text fg={theme().textMuted} wrapMode="none">
            Traffic
          </text>
          {trafficLines().map((line) => (
            <text fg={theme().textMuted} wrapMode="none">
              {detailLine(line)}
            </text>
          ))}
        </>
      </Show>
    </box>
  );
};
