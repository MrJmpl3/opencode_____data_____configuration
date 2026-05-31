/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from 'solid-js';
import type { TuiPluginModule, TuiPluginApi } from '@opencode-ai/plugin/tui';

import { detailLine, eventSessionId, formatCompactNumber, formatPercentRatio, slotSessionId } from './runtime/tui.js';
import { summarizeCacheMessages } from './runtime/summary.js';

// Cache sidebar plugin for OpenCode TUI.
// Shows hit ratio, tokens saved by reads, input/output totals,
// and cache writes (when the provider reports them).

// --- View: renders cache stats in the sidebar ---
const View = (props: {
  hasData: () => boolean;
  ratio: () => number;
  read: () => number;
  write: () => number;
  hasWriteData: () => boolean;
  input: () => number;
  output: () => number;
  api: TuiPluginApi;
}) => {
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
      {/* "No data" while no provider has reported cache info */}
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

// --- plugin definition ---
const plugin: TuiPluginModule & { id: string } = {
  id: 'cache',

  // --- tui() lifecycle: signals, events, refresh ---
  tui: async (api) => {
    const { slots, event: evt, lifecycle } = api;
    const [hasData, setHasData] = createSignal(false);
    const [ratio, setRatio] = createSignal(0);
    const [read, setRead] = createSignal(0);
    const [write, setWrite] = createSignal(0);
    const [hasWriteData, setHasWriteData] = createSignal(false);
    const [output, setOutput] = createSignal(0);
    const [inp, setInp] = createSignal(0);
    let disposed = false;
    let currentSessionId = '';
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let inFlightVersion = 0;
    // Refresh immediately on session switch; re-accumulate on session idle
    const IMMEDIATE_REFRESH_EVENTS = ['tui.session.select'] as const;
    const COMPLETION_REFRESH_EVENTS = ['session.idle'] as const;

    // --- refresh(): accumulate tokens across all messages ---
    const refresh = (sessionId?: string) => {
      if (disposed) return;

      const sid = sessionId || currentSessionId;
      if (!sid) {
        setHasData(false);
        setRatio(0);
        setRead(0);
        setWrite(0);
        setHasWriteData(false);
        return;
      }

      // Fetch every message in the current session
      const currentVersion = ++inFlightVersion;
      const msgs = api.state.session.messages(sid);
      // Discard stale responses from earlier concurrent calls
      if (currentVersion !== inFlightVersion) return;

      const summary = summarizeCacheMessages(msgs, (messageId) => api.state.part(messageId) as readonly unknown[]);

      // No cache data at all: keep the plugin invisible
      if (!summary.hasData) {
        setHasData(false);
        setRatio(0);
        setRead(0);
        setWrite(0);
        setHasWriteData(false);
        setInp(0);
        setOutput(0);
        // Retry when TUI loads messages into memory
        if (!retryTimer && msgs.length === 0) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            if (!disposed) refresh(sid);
          }, 1500);
        }
        return;
      }

      setHasData(true);
      setRatio(summary.ratio);
      setRead(summary.read);
      setWrite(summary.write);
      setHasWriteData(summary.hasWriteData);
      setInp(summary.input);
      setOutput(summary.output);
    };

    // --- subscribe to events that trigger refresh ---
    const unsubs: (() => void)[] = [];
    for (const eventName of [...IMMEDIATE_REFRESH_EVENTS, ...COMPLETION_REFRESH_EVENTS]) {
      unsubs.push(
        evt.on(eventName, (event) => {
          const sid = eventSessionId(event, currentSessionId);
          if (sid) refresh(sid);
        }),
      );
    }

    lifecycle.onDispose(() => {
      disposed = true;
      clearTimeout(retryTimer);
      for (const fn of unsubs) fn();
    });

    // --- register sidebar slot ---
    // order: 140 places this plugin mid-list in the sidebar
    slots.register({
      order: 140,
      slots: {
        sidebar_content: (_ctx: unknown, slotInput: unknown) => {
          const sid = slotSessionId(slotInput);
          if (sid && sid !== currentSessionId) {
            clearTimeout(retryTimer);
            retryTimer = undefined;
            currentSessionId = sid;
            refresh(sid);
          } else if (sid && !hasData()) {
            refresh(sid);
          }
          return (
            <View
              hasData={hasData}
              ratio={ratio}
              read={read}
              write={write}
              hasWriteData={hasWriteData}
              input={inp}
              output={output}
              api={api}
            />
          );
        },
      },
    });
  },
};

export default plugin;
