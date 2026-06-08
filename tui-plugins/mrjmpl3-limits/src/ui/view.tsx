import { Show } from 'solid-js';
import type { TuiPluginApi } from '@opencode-ai/plugin/tui';

import { detailLine, formatCompactNumber } from '../runtime/tui.ts';

export type LimitsViewProps = {
  modelLabel: () => string;
  contextLimit: () => number;
  outputLimit: () => number;
  hasData: () => boolean;
  api: TuiPluginApi;
};

export const LimitsView = (props: LimitsViewProps) => {
  const theme = () => props.api.theme.current;
  const limitLines = () => {
    const parts: string[] = [];
    if (props.contextLimit() > 0) parts.push(`Context ${formatCompactNumber(props.contextLimit())}`);
    if (props.outputLimit() > 0) parts.push(`Output ${formatCompactNumber(props.outputLimit())}`);
    return parts.length > 0 ? [parts.join(' · ')] : [];
  };

  return (
    <box gap={0}>
      <text fg={theme().text}>Limits</text>
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
            Model
          </text>
          <text fg={theme().textMuted} wrapMode="none">
            {detailLine(props.modelLabel())}
          </text>
          <Show when={limitLines().length > 0}>
            <text fg={theme().textMuted} wrapMode="none">
              Limits
            </text>
            {limitLines().map((line) => (
              <text fg={theme().textMuted} wrapMode="none">
                {detailLine(line)}
              </text>
            ))}
          </Show>
        </>
      </Show>
    </box>
  );
};
