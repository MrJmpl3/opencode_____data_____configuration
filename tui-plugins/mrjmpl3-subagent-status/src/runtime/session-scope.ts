import { createEmptyState } from '../domain/state.ts';
import type { SubagentState } from '../domain/types.ts';
import type { PersistSnapshotMeta } from './persisted-snapshot.ts';

export function createRuntimeSessionScopeHelpers(input: {
  getSessionId: () => string;
  setSessionId: (sessionID: string) => void;
  syncState: (state: SubagentState, meta: PersistSnapshotMeta) => Promise<void>;
  createRefreshMeta: () => PersistSnapshotMeta;
}) {
  let activeSessionToken = 0;
  let bufferingStartupScopedEvents = true;
  const deferredStartupScopedEvents = new Map<string, unknown[]>();

  const currentSessionToken = (): number => activeSessionToken;

  const invalidateSessionScope = (): number => {
    activeSessionToken += 1;
    return activeSessionToken;
  };

  const persistEmptyScopedState = (): void => {
    void input.syncState(createEmptyState(), input.createRefreshMeta());
  };

  const resetSessionScope = (): void => {
    invalidateSessionScope();
    input.setSessionId('');
    persistEmptyScopedState();
  };

  const beginSessionScope = (sessionID: string): number => {
    const token = invalidateSessionScope();
    input.setSessionId(sessionID);
    persistEmptyScopedState();
    return token;
  };

  const bufferStartupScopedEvent = (sessionID: string, event: unknown): void => {
    const events = deferredStartupScopedEvents.get(sessionID);
    if (events) {
      events.push(event);
      return;
    }

    deferredStartupScopedEvents.set(sessionID, [event]);
  };

  const replayDeferredStartupScopedEvents = async (
    sessionID: string,
    sessionToken: number,
    replayEvent: (event: unknown) => Promise<void>,
    isDisposed: () => boolean,
  ): Promise<void> => {
    if (!sessionID) return;

    const events = deferredStartupScopedEvents.get(sessionID);
    if (!events || events.length === 0) return;

    deferredStartupScopedEvents.delete(sessionID);

    for (const event of events) {
      if (isDisposed() || sessionToken !== activeSessionToken || input.getSessionId() !== sessionID) return;
      await replayEvent(event);
    }
  };

  return {
    beginSessionScope,
    bufferStartupScopedEvent,
    currentSessionToken,
    finishStartupScopedEventBuffering: (): void => {
      bufferingStartupScopedEvents = false;
    },
    invalidateSessionScope,
    isBufferingStartupScopedEvents: (): boolean => bufferingStartupScopedEvents,
    replayDeferredStartupScopedEvents,
    resetSessionScope,
  };
}
