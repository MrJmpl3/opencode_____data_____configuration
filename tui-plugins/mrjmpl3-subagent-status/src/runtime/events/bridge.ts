import type { TuiPluginApi } from '@opencode-ai/plugin/tui';

const RELEVANT_EVENTS = new Set([
  'tui.session.select',
  'session.created',
  'session.updated',
  'session.idle',
  'session.error',
  'session.status',
  'message.part.updated',
  'message.updated',
]);

export const installEventBridge = (
  api: Pick<TuiPluginApi, 'event' | 'lifecycle'>,
  refresh: () => Promise<void>,
  onEvent?: (event: unknown) => void,
): (() => void) => {
  const unsubs: Array<() => void> = [];

  for (const eventName of RELEVANT_EVENTS) {
    unsubs.push(
      api.event.on(eventName as never, (event) => {
        onEvent?.(event);
        void refresh();
      }),
    );
  }

  const dispose = (): void => {
    for (const unsub of unsubs) {
      try {
        unsub();
      } catch {
        // Best effort cleanup.
      }
    }
  };

  api.lifecycle.onDispose(dispose);
  return dispose;
};
