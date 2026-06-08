import type { TuiThemeCurrent } from '@opencode-ai/plugin/tui';
import { useTerminalDimensions } from '@opentui/solid';
import { createMemo, For } from 'solid-js';

import { selectLogoLines } from '../domain/logo-layout.ts';

export interface LogoProps {
  theme: TuiThemeCurrent;
}

export const Logo = (props: LogoProps) => {
  const dimensions = useTerminalDimensions();
  const lines = createMemo(() => selectLogoLines(dimensions()));

  return (
    <box flexDirection="column" alignItems="center">
      <For each={lines()}>{(line) => <text fg={props.theme.accent}>{line}</text>}</For>
    </box>
  );
};
