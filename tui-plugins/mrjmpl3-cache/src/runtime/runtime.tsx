import { createSignal } from 'solid-js';
import type { TuiPlugin } from '@opencode-ai/plugin/tui';

import { summarizeCacheMessages } from '../domain/summary.ts';
import { CacheView } from '../ui/view.tsx';
import { eventSessionId, slotSessionId } from '@mrjmpl3/tui-kit';

const IMMEDIATE_REFRESH_EVENTS = ['tui.session.select'] as const;
const COMPLETION_REFRESH_EVENTS = ['session.idle'] as const;

export const registerCacheTui: TuiPlugin = async (api) => {
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

    const currentVersion = ++inFlightVersion;
    const msgs = api.state.session.messages(sid);
    if (currentVersion !== inFlightVersion) return;

    const summary = summarizeCacheMessages(msgs, (messageId) => api.state.part(messageId) as readonly unknown[]);

    if (!summary.hasData) {
      setHasData(false);
      setRatio(0);
      setRead(0);
      setWrite(0);
      setHasWriteData(false);
      setInp(0);
      setOutput(0);
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
          <CacheView
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
};
