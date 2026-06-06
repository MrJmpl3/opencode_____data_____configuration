import type { SubagentState } from '../domain/types.ts';

import { buildTuiSnapshot, type TuiSnapshot } from './snapshot.ts';

export type SnapshotPersistenceSource = 'startup' | 'event' | 'load' | 'refresh';

export type PersistSnapshotMeta = {
  source: SnapshotPersistenceSource;
  lastEventType?: string;
  bufferedEventCount?: number;
};

export type PersistedSnapshotArtifacts = {
  statusText: string;
  debugSnapshot: string;
};

function serializeDebugSnapshot(state: SubagentState, snapshot: TuiSnapshot, meta: PersistSnapshotMeta): string {
  return JSON.stringify(
    {
      persistedAt: new Date().toISOString(),
      source: meta.source,
      lastEventType: meta.lastEventType,
      bufferedEventCount: meta.bufferedEventCount ?? 0,
      stateUpdatedAt: state.updatedAt,
      totalExecuted: state.totalExecuted,
      ...snapshot.debug,
    },
    null,
    2,
  );
}

export function formatPersistedSnapshot(state: SubagentState, meta: PersistSnapshotMeta): PersistedSnapshotArtifacts {
  const snapshot = buildTuiSnapshot(state);

  return {
    statusText: snapshot.statusSnapshotLine,
    debugSnapshot: serializeDebugSnapshot(state, snapshot, meta),
  };
}
